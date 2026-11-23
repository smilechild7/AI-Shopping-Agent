/**
 * 역할: OpenAI Responses API와 search_products 도구 호출을 반복하며 쇼핑 대화를 실행한다.
 * 사용자 조건 보존·최종 DB 검증·최대 1회 복구를 공통 시간·호출 예산 안에서 실행한다.
 */

import { AI_CONFIG } from '../config/ai.js';
import { randomUUID } from 'node:crypto';
import { normalizeSearchInput } from '../products/searchInput.js';
import { SEARCH_PRODUCTS_INPUT_SCHEMA } from '../products/searchSchema.js';
import { SHOPPING_AGENT_INSTRUCTIONS } from './instructions.js';
import { AGENT_OUTPUT_SCHEMA, validateAgentOutput } from './outputContract.js';
import { buildAgentResult } from './resultBuilder.js';
import { RESPONSE_ID_PATTERN } from './chatRequest.js';
import { createConstraintStore } from './constraintStore.js';
import { AgentRuntimeError, ModelValidationError } from './errors.js';
import { createExecutionBudget } from './executionBudget.js';
import { ConstraintError, assertRequiredUnchanged } from './requiredConstraints.js';
import { resolveUserConstraints } from './userConstraints.js';

const SEARCH_PRODUCTS_TOOL = Object.freeze({
  type: 'function',
  name: 'search_products',
  description:
    'Search the local catalog using required hard constraints and preferred ranking signals. Returns at most 15 factual compact product candidates with aggregated review evidence.',
  strict: true,
  parameters: SEARCH_PRODUCTS_INPUT_SCHEMA,
});

export { AgentRuntimeError } from './errors.js';

/**
 * 모델 출력 중 도구 실행을 요청하는 function_call 항목만 모아 반환한다.
 */
function toolCalls(response) {
  return (response.output ?? []).filter(/* 일반 출력·추론 항목을 제외하고 함수 호출 항목인지 확인한다. */ (item) => item.type === 'function_call');
}

/**
 * 모델 응답에서 최종 텍스트를 추출하고 불완전·거부·출력 누락을 서로 다른 Agent 오류로 변환한다.
 */
function assertCompleteResponse(response) {
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
    }
  }
}

function responseText(response) {
  assertCompleteResponse(response);
  for (const output of response.output ?? []) {
    for (const content of output.content ?? []) {
      if (content.type === 'output_text' && content.text) return content.text;
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
 * 허용된 search_products 호출인지 확인하고 JSON 인자를 정규화한다.
 * 원문에서 별도로 확정한 조건과의 비교는 검색 실행 직전에 수행한다.
 */
function parseToolInput(toolCall) {
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
    return normalizeSearchInput(value);
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
      inputTokens: total.inputTokens + (response?.usage?.input_tokens ?? 0),
      outputTokens: total.outputTokens + (response?.usage?.output_tokens ?? 0),
      totalTokens: total.totalTokens + (response?.usage?.total_tokens ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
}

/**
 * 모델 설정·이전 응답 ID·지침·검색 도구·최종 출력 스키마를 Responses API 요청 옵션으로 조립한다.
 */
function requestOptions({ config, input, previousResponseId, required, toolChoice }) {
  return {
    model: config.model,
    previous_response_id: previousResponseId ?? undefined,
    instructions: SHOPPING_AGENT_INSTRUCTIONS + '\n\nServer-authoritative required constraints: ' +
      JSON.stringify(required) + '\nCopy these required conditions exactly into every search_products call. ' +
      'Only preferred conditions may change. Never infer additional required conditions. ' +
      'If the server requests correction, correct only the specified validation failure; ' +
      'keep these constraints and use only the latest search candidates. ' +
      'Exclude a rejected product whose current DB fields do not meet the constraints. ' +
      'Return no_result if no remaining candidate can be justified.',
    input,
    tools: [SEARCH_PRODUCTS_TOOL],
    tool_choice: toolChoice,
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
 * 모델이 고칠 수 있는 명시적 검증 오류만 분류한다. DB·프로그램·인프라 오류는 원형대로 전파한다.
 */
function recoverableReason(error) {
  if (error instanceof ModelValidationError) return error.reason;
  if (error instanceof ConstraintError &&
      ['constraint_violation', 'required_product_mismatch'].includes(error.code)) return error.code;
  if (error instanceof AgentRuntimeError &&
      ['invalid_json', 'invalid_output', 'invalid_tool_arguments'].includes(error.code)) return error.code;
  return null;
}

/**
 * 의존성과 기본 설정을 조립하고 Agent 인스턴스의 응답별 조건 저장소를 유지한다.
 * 예산·후보·복구 상태는 chat 호출 안에 두어 동시 요청과 대화 분기를 격리한다.
 */
export function createShoppingAgent({
  client,
  search,
  repository,
  config = {},
  logger = console,
  constraintStore = createConstraintStore(),
  now,
}) {
  if (!client?.responses?.create) {
    throw new Error('Shopping Agent requires an OpenAI Responses client');
  }
  if (typeof search !== 'function') {
    throw new Error('Shopping Agent requires a search executor');
  }
  const settings = { ...AI_CONFIG.agent, ...config };
  if (![0, 1].includes(settings.maxRecoveryAttempts) ||
      !Number.isSafeInteger(settings.maxToolRounds) || settings.maxToolRounds < 1) {
    throw new Error('Invalid Agent round or recovery limit');
  }

  return {
    /**
     * 사용자 조건을 먼저 확정하고 검색 전·최종 DB 조회 후에 검증한다.
     * 수정 가능한 오류는 한 번만 재생성하며, 검증·예산 확인이 끝난 응답의 조건만 저장한다.
     */
    async chat({ message, previousResponseId = null, selectedFilters = {}, signal }) {
      const requestId = randomUUID();
      const budget = createExecutionBudget({
        signal, now,
        timeoutMs: settings.requestTimeoutMs,
        maxModelCalls: settings.maxModelCalls,
        maxSearchCalls: settings.maxSearchCalls,
      });
      const responses = [];
      const recovery = { attempts: 0, trigger: null, outcome: 'not_needed' };
      let recoveryStart = null;
      let modelCallsBeforeRecovery = 0;
      let initialOutcome = null;
      let result = null;
      let failure = null;
      let priorId = previousResponseId;
      let nextInput = [{ role: 'user', content: message }];
      let latestSearch = null;
      // search: 검증된 검색을 한 번 요구 / final: 추가 검색 없이 최종 응답 요구
      let correctionMode = null;

      try {
        budget.assertActive();
        const previousRequired = previousResponseId ? constraintStore.get(previousResponseId) : {};
        const { required, clarification } = resolveUserConstraints({
          message, previousRequired, selectedFilters,
        });
        if (clarification) {
          budget.assertActive();
          result = {
            type: 'clarification', responseId: previousResponseId,
            source: 'server', message: clarification,
          };
          initialOutcome = 'clarification';
          return result;
        }

        while (true) {
          if (!recovery.attempts && responses.length >= settings.maxToolRounds) {
            throw new AgentRuntimeError('tool_round_limit', 'OpenAI exceeded the normal round limit');
          }
          const toolChoice = correctionMode === 'search'
            ? { type: 'function', name: 'search_products' }
            : correctionMode === 'final' || budget.searchCalls >= settings.maxSearchCalls ||
                (!recovery.attempts && responses.length === settings.maxToolRounds - 1)
              ? 'none'
              : 'auto';
          const response = await budget.model((transport) => client.responses.create(
            requestOptions({
              config: settings, input: nextInput, previousResponseId: priorId, required, toolChoice,
            }),
            transport,
          ));
          responses.push(response);
          if (!response || typeof response.id !== 'string' || !RESPONSE_ID_PATTERN.test(response.id)) {
            throw new AgentRuntimeError('invalid_output', 'OpenAI response ID is missing or invalid');
          }
          assertCompleteResponse(response);
          const calls = toolCalls(response);

          try {
            if (calls.length > 1) {
              throw new AgentRuntimeError('multiple_tool_calls', 'OpenAI returned multiple tool calls');
            }
            if (calls.length === 1) {
              if (correctionMode === 'final' ||
                  (!recovery.attempts && responses.length === settings.maxToolRounds)) {
                throw new AgentRuntimeError(
                  recovery.attempts ? 'invalid_output' : 'tool_round_limit',
                  'A final response was required without another search',
                );
              }
              const call = calls[0];
              const normalizedInput = parseToolInput(call);
              assertRequiredUnchanged(normalizedInput.required, required);
              // 비교를 통과한 뒤 동일한 불변 스냅샷을 모든 검색에 제공한다.
              normalizedInput.required = required;
              const searchResult = await budget.search(() => search(normalizedInput));
              latestSearch = { input: normalizedInput, result: searchResult };
              priorId = response.id;
              nextInput = [{
                type: 'function_call_output', call_id: call.call_id,
                output: JSON.stringify(searchResult),
              }];
              if (recovery.attempts) correctionMode = 'final';
              continue;
            }

            if (correctionMode === 'search') {
              throw new AgentRuntimeError('invalid_output', 'Correction requires a validated search first');
            }
            const output = parseFinalOutput(response);
            result = buildAgentResult({
              output, responseId: response.id, latestSearch, repository, required,
            });
            budget.assertActive();
            constraintStore.set(response.id, required);
            initialOutcome ??= 'validated';
            if (recovery.attempts) recovery.outcome = 'succeeded';
            return result;
          } catch (error) {
            result = null;
            const reason = recoverableReason(error);
            if (!reason) throw error;
            initialOutcome ??= 'validation_rejected';
            logger.log(JSON.stringify({
              event: 'agent.validation_rejected', requestId,
              code: error.code, reason, fields: error.fields ?? [],
            }));
            if (recovery.attempts >= settings.maxRecoveryAttempts) {
              recovery.outcome = recovery.attempts ? 'failed' : 'disabled';
              throw error;
            }

            const needsSearch = calls.length === 1 || !latestSearch;
            recovery.trigger = reason;
            // 검색 인자 수정에는 수정 호출과 검색 후 최종 호출이 모두 필요하다.
            try {
              budget.reserveModelCalls(needsSearch ? 2 : 1);
              if (needsSearch) budget.reserveSearchCall();
            } catch (budgetError) {
              recovery.outcome = 'budget_exhausted';
              throw budgetError;
            }
            recovery.attempts += 1;
            recovery.outcome = 'in_progress';
            recoveryStart = responses.length;
            modelCallsBeforeRecovery = budget.modelCalls;
            correctionMode = needsSearch ? 'search' : 'final';
            priorId = response.id;
            const correction = JSON.stringify({
              error: reason, required, fields: error.fields ?? [],
              ...(error.productId ? { rejectedProductId: error.productId } : {}),
              instruction: needsSearch
                ? 'Call search_products once with the exact required constraints, correcting the invalid arguments.'
                : 'Correct the final JSON using the latest candidates and exact required constraints. Do not search again.',
            });
            nextInput = calls.length === 1
              ? [{ type: 'function_call_output', call_id: calls[0].call_id, output: correction }]
              : [{ role: 'user', content: correction }];
          }
        }
      } catch (error) {
        result = null;
        failure = error;
        if (recovery.attempts) recovery.outcome = 'failed';
        throw error;
      } finally {
        budget.dispose();
        const split = recoveryStart ?? responses.length;
        logger.log(JSON.stringify({
          event: result ? 'agent.complete' : 'agent.failed',
          requestId, type: result?.type ?? null, source: result?.source ?? 'model',
          code: failure?.code ?? failure?.name ?? null,
          initialOutcome: initialOutcome ?? 'failed',
          finalOutcome: result ? 'validated' : 'failed',
          rounds: responses.length,
          modelCalls: budget.modelCalls, searchCalls: budget.searchCalls,
          durationMs: budget.durationMs,
          candidateCount: latestSearch?.result.candidates.length ?? 0,
          recommendationCount: result?.products?.length ?? 0,
          recovery: {
            ...recovery,
            additionalModelCalls: recoveryStart === null ? 0 : budget.modelCalls - modelCallsBeforeRecovery,
          },
          usageBeforeRecovery: usageTotals(responses.slice(0, split)),
          usageRecovery: usageTotals(responses.slice(split)),
          usage: usageTotals(responses),
          usageComplete: responses.length === budget.modelCalls && responses.every((response) =>
            ['input_tokens', 'output_tokens', 'total_tokens'].every((field) =>
              Number.isFinite(response?.usage?.[field]))),
        }));
      }
    },
  };
}

export { SEARCH_PRODUCTS_TOOL };
