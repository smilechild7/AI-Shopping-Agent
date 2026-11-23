/**
 * 역할: 원본 상품과 실제 리뷰를 OpenAI에 전달해 상품 태그와 구매 위험 요약을 생성한다.
 * 구조화 출력 검증과 확정된 보정을 적용하고 모델·프롬프트 버전·가공 시각을 결과에 붙인다.
 */

import { AI_CONFIG } from '../../server/config/ai.js';
import {
  MODEL_ENRICHMENT_OUTPUT_SCHEMA,
  validateEnrichmentOutput,
  validateModelEnrichmentOutput,
} from './enrichmentContract.js';
import { ENRICHMENT_INSTRUCTIONS, enrichmentInput } from './enrichmentPrompt.js';
import { applyEnrichmentOverrides } from './enrichmentOverrides.js';

/**
 * OpenAI 응답에서 출력 텍스트를 찾고, 불완전한 응답·모델 거부·텍스트 누락은 오류로 처리한다.
 */
function responseText(response) {
  if (response.status === 'incomplete') {
    const reason = response.incomplete_details?.reason ?? 'unknown';
    throw new Error(`OpenAI response incomplete: ${reason}`);
  }

  for (const output of response.output ?? []) {
    for (const content of output.content ?? []) {
      if (content.type === 'refusal') {
        throw new Error(`OpenAI response refused: ${content.refusal}`);
      }
      if (content.type === 'output_text' && content.text) {
        return content.text;
      }
    }
  }

  if (typeof response.output_text === 'string' && response.output_text) {
    return response.output_text;
  }

  throw new Error('OpenAI response did not contain output text');
}

/**
 * 실제 상품·리뷰 근거를 한 번의 구조화 응답 요청으로 분석하고 결과를 검증한다.
 * 확정된 후기 보정을 적용한 뒤 상품 ID·모델·프롬프트 버전·시각을 붙여 반환하며 토큰 사용량을 전달한다.
 */
export async function enrichProduct({
  client,
  product,
  config = AI_CONFIG.enrichment,
  now = /* 시각 공급 함수를 주입하지 않았을 때 가공 완료 시각으로 현재 날짜를 사용한다. */ () => new Date(),
  onUsage = /* 사용량 수집 함수를 주입하지 않은 경우 별도 기록 없이 가공을 계속한다. */ () => {},
}) {
  const response = await client.responses.create({
    model: config.model,
    input: [
      { role: 'system', content: ENRICHMENT_INSTRUCTIONS },
      { role: 'user', content: enrichmentInput(product) },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'product_enrichment',
        strict: true,
        schema: MODEL_ENRICHMENT_OUTPUT_SCHEMA,
      },
    },
    reasoning: { effort: config.reasoningEffort },
    max_output_tokens: config.maxOutputTokens,
    store: false,
  });
  onUsage({
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
    totalTokens: response.usage?.total_tokens ?? 0,
  });

  let output;
  try {
    output = JSON.parse(responseText(response));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('OpenAI response was not valid JSON', { cause: error });
    }
    throw error;
  }

  const productId = `${product.source.shopId}:${product.source.sourceProductId}`;
  const validatedOutput = validateModelEnrichmentOutput(output, product);
  const curatedOutput = applyEnrichmentOverrides(productId, validatedOutput);
  validateEnrichmentOutput(curatedOutput, product);

  return {
    productId,
    ...curatedOutput,
    model: config.model,
    promptVersion: config.promptVersion,
    enrichedAt: now().toISOString(),
  };
}
