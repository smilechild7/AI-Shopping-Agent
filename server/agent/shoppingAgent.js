/**
 * 역할: OpenAI Responses API와 search_products 도구 호출을 반복하며 쇼핑 대화를 실행한다.
 * 검색 인자와 최종 출력 검증, 가격 의도 보정, DB 사실 정보 병합과 호출 사용량 기록을 연결한다.
 */

import { AI_CONFIG } from '../config/ai.js';
import { applyPriceIntent } from '../products/priceIntent.js';
import { normalizeSearchInput } from '../products/searchInput.js';
import { SEARCH_PRODUCTS_INPUT_SCHEMA } from '../products/searchSchema.js';
import { SHOPPING_AGENT_INSTRUCTIONS } from './instructions.js';
import { AGENT_OUTPUT_SCHEMA, validateAgentOutput } from './outputContract.js';
import { buildAgentResult } from './resultBuilder.js';

const SEARCH_PRODUCTS_TOOL = Object.freeze({
  type: 'function',
  name: 'search_products',
  description:
    'Search the local catalog using required hard constraints and preferred ranking signals. Returns at most 15 factual compact product candidates with aggregated review evidence.',
  strict: true,
  parameters: SEARCH_PRODUCTS_INPUT_SCHEMA,
});

export class AgentRuntimeError extends Error {
  /**
   * Agent 실행 실패의 코드와 원인 오류를 보관해 API 라우터가 일반 인프라 오류와 구분할 수 있게 한다.
   */
  constructor(code, message, options) {
    super(message, options);
    this.name = 'AgentRuntimeError';
    this.code = code;
  }
}

/**
 * 모델 출력 중 도구 실행을 요청하는 function_call 항목만 모아 반환한다.
 */
function toolCalls(response) {
  return (response.output ?? []).filter(/* 일반 출력·추론 항목을 제외하고 함수 호출 항목인지 확인한다. */ (item) => item.type === 'function_call');
}

/**
 * 모델 응답에서 최종 텍스트를 추출하고 불완전·거부·출력 누락을 서로 다른 Agent 오류로 변환한다.
 */
function responseText(response) {
  if (response.status === 'incomplete') {
    throw new AgentRuntimeError(
      'incomplete_response',
      `OpenAI response incomplete: ${response.incomplete_details?.reason ?? 'unknown'}`,
    );
  }

  for (const output of response.output ?? []) {
    for (const content of output.content ?? []) {
      if (content.type === 'refusal') {
        throw new AgentRuntimeError(
          'refused_response',
          'OpenAI response was refused',
        );
      }
      if (content.type === 'output_text' && content.text) {
        return content.text;
      }
    }
  }

  if (typeof response.output_text === 'string' && response.output_text) {
    return response.output_text;
  }

  throw new AgentRuntimeError(
    'missing_output',
    'OpenAI response did not contain a tool call or final output',
  );
}

/**
 * 최종 텍스트를 JSON으로 파싱한 뒤 응답 계약을 검증하며, JSON 오류와 계약 위반을 구분해 던진다.
 */
function parseFinalOutput(response) {
  let value;
  try {
    value = JSON.parse(responseText(response));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new AgentRuntimeError(
        'invalid_json',
        'OpenAI final output was not valid JSON',
        { cause: error },
      );
    }
    throw error;
  }

  try {
    return validateAgentOutput(value);
  } catch (error) {
    throw new AgentRuntimeError(
      'invalid_output',
      `OpenAI final output failed validation: ${error.message}`,
      { cause: error },
    );
  }
}

/**
 * 허용된 search_products 호출인지 확인하고 JSON 인자를 정규화한 뒤 원문의 목표 가격을 보정한다.
 * 현재 이 함수에는 사용자 필수 조건 스냅샷과 모델 인자를 비교하는 검사가 연결되어 있지 않다.
 */
function parseToolInput(toolCall, userMessage) {
  if (toolCall.name !== 'search_products') {
    throw new AgentRuntimeError(
      'unknown_tool',
      `OpenAI requested an unsupported tool: ${toolCall.name}`,
    );
  }

  let value;
  try {
    value = JSON.parse(toolCall.arguments);
  } catch (error) {
    throw new AgentRuntimeError(
      'invalid_tool_arguments',
      'search_products arguments were not valid JSON',
      { cause: error },
    );
  }

  try {
    return applyPriceIntent(normalizeSearchInput(value), userMessage);
  } catch (error) {
    throw new AgentRuntimeError(
      'invalid_tool_arguments',
      `search_products arguments failed validation: ${error.message}`,
      { cause: error },
    );
  }
}

/**
 * 한 채팅 요청에서 받은 모델 응답들의 입력·출력·전체 토큰 사용량을 합산한다.
 */
function usageTotals(responses) {
  return responses.reduce(
    /**
     * 응답의 사용량을 누적하며 사용량 필드가 없으면 0으로 계산한다.
     */
    (total, response) => ({
      inputTokens: total.inputTokens + (response.usage?.input_tokens ?? 0),
      outputTokens: total.outputTokens + (response.usage?.output_tokens ?? 0),
      totalTokens: total.totalTokens + (response.usage?.total_tokens ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
}

/**
 * 모델 설정·이전 응답 ID·지침·검색 도구·최종 출력 스키마를 Responses API 요청 옵션으로 조립한다.
 */
function requestOptions({ config, input, previousResponseId }) {
  return {
    model: config.model,
    previous_response_id: previousResponseId ?? undefined,
    instructions: SHOPPING_AGENT_INSTRUCTIONS,
    input,
    tools: [SEARCH_PRODUCTS_TOOL],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    text: {
      format: {
        type: 'json_schema',
        name: 'shopping_agent_response',
        strict: true,
        schema: AGENT_OUTPUT_SCHEMA,
      },
    },
    reasoning: { effort: config.reasoningEffort },
    max_output_tokens: config.maxOutputTokens,
    store: true,
  };
}

/**
 * OpenAI 클라이언트·검색 실행 함수·상품 저장소를 주입받아 chat 메서드를 제공한다.
 * 필수 의존성을 먼저 확인하고 실제 모델 호출은 chat 실행 시점까지 미룬다.
 */
export function createShoppingAgent({
  client,
  search,
  repository,
  config = AI_CONFIG.agent,
  logger = console,
}) {
  if (!client?.responses?.create) {
    throw new Error('Shopping Agent requires an OpenAI Responses client');
  }
  if (typeof search !== 'function') {
    throw new Error('Shopping Agent requires a search executor');
  }

  return {
    /**
     * 사용자 메시지로 모델을 호출하고 도구 요청이면 검색 결과를 다음 모델 입력으로 돌려준다.
     * 최종 출력이면 계약과 추천 근거를 검증해 DB 정보를 병합하며, 호출 반복 한도와 토큰 집계를 관리한다.
     */
    async chat({ message, previousResponseId = null }) {
      const responses = [];
      let priorId = previousResponseId;
      let nextInput = [{ role: 'user', content: message }];
      let latestSearch = null;
      let usageLogged = false;

      try {
        for (let round = 0; round < config.maxToolRounds; round += 1) {
          const response = await client.responses.create(
            requestOptions({ config, input: nextInput, previousResponseId: priorId }),
          );
          responses.push(response);

          const calls = toolCalls(response);
          if (calls.length > 1) {
            throw new AgentRuntimeError(
              'multiple_tool_calls',
              'OpenAI returned more than one tool call in a round',
            );
          }

          if (calls.length === 0) {
            const output = parseFinalOutput(response);
            let result;
            try {
              result = buildAgentResult({
                output,
                responseId: response.id,
                latestSearch,
                repository,
              });
            } catch (error) {
              throw new AgentRuntimeError(
                'factual_validation_failed',
                `Agent factual validation failed: ${error.message}`,
                { cause: error },
              );
            }

            logger.log(
              JSON.stringify({
                event: 'agent.complete',
                type: result.type,
                rounds: responses.length,
                candidateCount: latestSearch?.result.candidates.length ?? 0,
                recommendationCount: result.products?.length ?? 0,
                usage: usageTotals(responses),
              }),
            );
            usageLogged = true;
            return result;
          }

          if (round === config.maxToolRounds - 1) {
            throw new AgentRuntimeError(
              'tool_round_limit',
              `OpenAI exceeded the ${config.maxToolRounds}-round limit`,
            );
          }

          const call = calls[0];
          const normalizedInput = parseToolInput(call, message);
          const searchResult = search(normalizedInput);
          latestSearch = { input: normalizedInput, result: searchResult };
          priorId = response.id;
          nextInput = [
            {
              type: 'function_call_output',
              call_id: call.call_id,
              output: JSON.stringify(searchResult),
            },
          ];
        }

        throw new AgentRuntimeError(
          'tool_round_limit',
          `OpenAI exceeded the ${config.maxToolRounds}-round limit`,
        );
      } finally {
        if (!usageLogged && responses.length > 0) {
          logger.log(
            JSON.stringify({
              event: 'agent.failed',
              rounds: responses.length,
              usage: usageTotals(responses),
            }),
          );
        }
      }
    },
  };
}

export { SEARCH_PRODUCTS_TOOL };
