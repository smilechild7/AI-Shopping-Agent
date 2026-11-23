/**
 * 역할: Agent의 최종 구조화 응답과 추천 근거 유형에 대한 JSON Schema 및 검증 함수를 정의한다.
 * 응답 분기, 추천 개수·중복, 비교 항목의 대응 관계와 허용된 근거 값을 검사한다.
 */

import { CONTROLLED_VOCABULARY } from '../config/vocabulary.js';

export const EVIDENCE_TYPES = Object.freeze([
  'category',
  'price',
  'color',
  'size',
  'style',
  'occasion',
  'fit',
  'season',
  'review_appearance_match',
  'review_size_fit',
  'review_material_quality',
]);

export const EVIDENCE_VALUE_ENUMS = Object.freeze({
  category: CONTROLLED_VOCABULARY.productCategories,
  price: Object.freeze(['within_required_range']),
  style: CONTROLLED_VOCABULARY.styleTags,
  occasion: CONTROLLED_VOCABULARY.occasionTags,
  fit: CONTROLLED_VOCABULARY.fitTags,
  season: CONTROLLED_VOCABULARY.seasonTags,
  review_appearance_match: Object.freeze(['similar', 'different', 'mixed']),
  review_size_fit: Object.freeze([
    'runs_small',
    'true_to_size',
    'runs_large',
    'mixed',
  ]),
  review_material_quality: Object.freeze(['positive', 'negative', 'mixed']),
});

/**
 * 특정 근거 유형과 그 값의 스키마를 하나로 묶어 type별 구조화 출력 분기를 만든다.
 */
function evidenceVariant(type, valueSchema) {
  return {
    type: 'object',
    properties: {
      type: { type: 'string', enum: [type] },
      value: valueSchema,
    },
    required: ['type', 'value'],
    additionalProperties: false,
  };
}

const EVIDENCE_ITEM_SCHEMA = {
  anyOf: [
    ...Object.entries(EVIDENCE_VALUE_ENUMS).map(/* 근거 유형마다 허용 값 enum을 적용한 스키마 분기를 생성한다. */ ([type, values]) =>
      evidenceVariant(type, { type: 'string', enum: values }),
    ),
    evidenceVariant('color', { type: 'string', minLength: 1, maxLength: 200 }),
    evidenceVariant('size', { type: 'string', minLength: 1, maxLength: 200 }),
  ],
};

const stringArraySchema = {
  type: 'array',
  items: { type: 'string', minLength: 1, maxLength: 300 },
  minItems: 1,
  maxItems: 8,
};

export const AGENT_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: ['clarification', 'recommendation', 'no_result'],
    },
    message: { type: 'string', minLength: 1, maxLength: 500 },
    suggestion: { type: ['string', 'null'], maxLength: 500 },
    recommendations: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          productId: { type: 'string', minLength: 1, maxLength: 200 },
          reason: { type: 'string', minLength: 1, maxLength: 500 },
          evidence: {
            type: 'array',
            minItems: 1,
            maxItems: 8,
            items: EVIDENCE_ITEM_SCHEMA,
          },
          strengths: stringArraySchema,
          concerns: stringArraySchema,
        },
        required: [
          'productId',
          'reason',
          'evidence',
          'strengths',
          'concerns',
        ],
        additionalProperties: false,
      },
    },
    comparison: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          productId: { type: 'string', minLength: 1, maxLength: 200 },
          bestFor: { type: 'string', minLength: 1, maxLength: 300 },
          tradeoff: { type: 'string', minLength: 1, maxLength: 300 },
        },
        required: ['productId', 'bestFor', 'tradeoff'],
        additionalProperties: false,
      },
    },
  },
  required: ['type', 'message', 'suggestion', 'recommendations', 'comparison'],
  additionalProperties: false,
});

/**
 * 검증 대상이 null·배열·기본형이면 해당 경로를 포함한 오류를 던진다.
 */
function assertPlainObject(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
}

/**
 * 필수 키의 누락이나 예상하지 않은 키 추가가 있는지 검사한다.
 */
function assertExactKeys(value, expectedKeys, path) {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${path} has unexpected or missing fields`);
  }
}

/**
 * 값이 문자열이며 공백을 제외한 내용이 있는지 검사한다.
 */
function assertNonEmptyString(value, path) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${path} must be a non-empty string`);
  }
}

/**
 * 배열의 각 원소가 비어 있지 않은 문자열인지 검사한다.
 */
function assertStringArray(value, path) {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`);
  }
  for (const [index, item] of value.entries()) {
    assertNonEmptyString(item, `${path}[${index}]`);
  }
}

/**
 * 추천 한 건의 상품 ID·이유·근거 유형과 값·장점·확인사항을 검사하고 오류 위치에 추천 순서를 붙인다.
 */
function validateRecommendation(value, index) {
  const path = `agent.recommendations[${index}]`;
  assertPlainObject(value, path);
  assertExactKeys(
    value,
    ['productId', 'reason', 'evidence', 'strengths', 'concerns'],
    path,
  );
  assertNonEmptyString(value.productId, `${path}.productId`);
  assertNonEmptyString(value.reason, `${path}.reason`);
  if (!Array.isArray(value.evidence)) {
    throw new Error(`${path}.evidence must be an array`);
  }
  if (value.evidence.length === 0) {
    throw new Error(`${path}.evidence must contain at least one item`);
  }
  for (const [evidenceIndex, evidence] of value.evidence.entries()) {
    const evidencePath = `${path}.evidence[${evidenceIndex}]`;
    assertPlainObject(evidence, evidencePath);
    assertExactKeys(evidence, ['type', 'value'], evidencePath);
    if (!EVIDENCE_TYPES.includes(evidence.type)) {
      throw new Error(`${evidencePath}.type is invalid`);
    }
    assertNonEmptyString(evidence.value, `${evidencePath}.value`);
    const allowedValues = EVIDENCE_VALUE_ENUMS[evidence.type];
    if (allowedValues && !allowedValues.includes(evidence.value)) {
      throw new Error(`${evidencePath}.value is invalid for ${evidence.type}`);
    }
  }
  assertStringArray(value.strengths, `${path}.strengths`);
  assertStringArray(value.concerns, `${path}.concerns`);
  if (value.strengths.length === 0 || value.concerns.length === 0) {
    throw new Error(`${path} strengths and concerns must not be empty`);
  }
}

/**
 * 최종 응답의 필드·유형·추천 개수·상품 ID 중복과 비교 항목의 대응 관계를 검사한다.
 * 추가 질문과 결과 없음의 빈 상품 목록·제안 조건까지 확인한 뒤 통과한 객체를 그대로 반환한다.
 */
export function validateAgentOutput(value) {
  assertPlainObject(value, 'agent');
  assertExactKeys(
    value,
    ['type', 'message', 'suggestion', 'recommendations', 'comparison'],
    'agent',
  );
  if (!['clarification', 'recommendation', 'no_result'].includes(value.type)) {
    throw new Error('agent.type is invalid');
  }
  assertNonEmptyString(value.message, 'agent.message');
  if (value.suggestion !== null) {
    assertNonEmptyString(value.suggestion, 'agent.suggestion');
  }
  if (!Array.isArray(value.recommendations) || value.recommendations.length > 3) {
    throw new Error('agent.recommendations must contain at most 3 items');
  }
  value.recommendations.forEach(validateRecommendation);

  const recommendationIds = value.recommendations.map(/* 추천 목록의 상품 ID만 뽑아 중복과 비교 대상의 대응 여부를 검사한다. */ ({ productId }) => productId);
  if (new Set(recommendationIds).size !== recommendationIds.length) {
    throw new Error('agent.recommendations contains duplicate product IDs');
  }

  if (!Array.isArray(value.comparison) || value.comparison.length > 3) {
    throw new Error('agent.comparison must contain at most 3 items');
  }
  for (const [index, comparison] of value.comparison.entries()) {
    const path = `agent.comparison[${index}]`;
    assertPlainObject(comparison, path);
    assertExactKeys(comparison, ['productId', 'bestFor', 'tradeoff'], path);
    assertNonEmptyString(comparison.productId, `${path}.productId`);
    assertNonEmptyString(comparison.bestFor, `${path}.bestFor`);
    assertNonEmptyString(comparison.tradeoff, `${path}.tradeoff`);
  }

  const comparisonIds = value.comparison.map(/* 비교 목록의 상품 ID만 뽑아 중복과 추천 목록 일치 여부를 검사한다. */ ({ productId }) => productId);
  if (new Set(comparisonIds).size !== comparisonIds.length) {
    throw new Error('agent.comparison contains duplicate product IDs');
  }

  if (value.type === 'recommendation') {
    if (value.recommendations.length === 0) {
      throw new Error('recommendation response requires at least one product');
    }
    if (value.suggestion !== null) {
      throw new Error('recommendation response suggestion must be null');
    }
    if (value.recommendations.length === 1 && value.comparison.length !== 0) {
      throw new Error('single recommendation response must have empty comparison');
    }
    if (
      value.recommendations.length > 1 &&
      (value.comparison.length !== value.recommendations.length ||
        comparisonIds.some(/* 비교 목록에 실제 추천하지 않은 상품 ID가 섞였는지 확인한다. */ (productId) => !recommendationIds.includes(productId)))
    ) {
      throw new Error('comparison must contain each recommended product exactly once');
    }
  } else {
    if (value.recommendations.length !== 0 || value.comparison.length !== 0) {
      throw new Error(`${value.type} response cannot contain products or comparison`);
    }
    if (value.type === 'clarification' && value.suggestion !== null) {
      throw new Error('clarification response suggestion must be null');
    }
    if (value.type === 'no_result' && value.suggestion === null) {
      throw new Error('no_result response requires a suggestion');
    }
  }

  return value;
}
