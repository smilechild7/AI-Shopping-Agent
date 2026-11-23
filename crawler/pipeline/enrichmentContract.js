/**
 * 역할: 상품 가공 결과와 모델의 리뷰 근거 집계에 사용할 스키마·검증 규칙을 정의한다.
 * 허용 태그·리뷰 수·체형 근거를 확인하고 근거 집계로 unknown·mixed 등을 포함한 최종 신호를 결정한다.
 */

import { CONTROLLED_VOCABULARY } from '../../server/config/vocabulary.js';

export { CONTROLLED_VOCABULARY };

export const REVIEW_SIGNALS = Object.freeze({
  appearanceMatch: Object.freeze(['similar', 'different', 'mixed', 'unknown']),
  sizeFit: Object.freeze([
    'runs_small',
    'true_to_size',
    'runs_large',
    'mixed',
    'unknown',
  ]),
  materialQuality: Object.freeze(['positive', 'negative', 'mixed', 'unknown']),
});

/**
 * 문자열 배열용 스키마를 만들고 허용 값 목록이 있으면 각 원소를 해당 enum으로 제한한다.
 */
const stringArraySchema = (values) => ({
  type: 'array',
  items: values ? { type: 'string', enum: values } : { type: 'string' },
});

/**
 * 후기 신호와 한국어 요약으로 구성되는 객체 스키마를 만들고 신호의 허용 값을 고정한다.
 */
const signalSchema = (values) => ({
  type: 'object',
  properties: {
    signal: { type: 'string', enum: values },
    summary: { type: 'string' },
  },
  required: ['signal', 'summary'],
  additionalProperties: false,
});

export const ENRICHMENT_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    summary: { type: 'string' },
    styleTags: stringArraySchema(CONTROLLED_VOCABULARY.styleTags),
    occasionTags: stringArraySchema(CONTROLLED_VOCABULARY.occasionTags),
    fitTags: stringArraySchema(CONTROLLED_VOCABULARY.fitTags),
    seasonTags: stringArraySchema(CONTROLLED_VOCABULARY.seasonTags),
    extraTags: stringArraySchema(),
    reviewSummary: {
      type: 'object',
      properties: {
        analyzedReviewCount: { type: 'integer', minimum: 0 },
        appearanceMatch: signalSchema(REVIEW_SIGNALS.appearanceMatch),
        sizeFit: signalSchema(REVIEW_SIGNALS.sizeFit),
        materialQuality: signalSchema(REVIEW_SIGNALS.materialQuality),
        positives: stringArraySchema(),
        concerns: stringArraySchema(),
        similarReviewerNotes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              profile: { type: 'string' },
              note: { type: 'string' },
            },
            required: ['profile', 'note'],
            additionalProperties: false,
          },
        },
      },
      required: [
        'analyzedReviewCount',
        'appearanceMatch',
        'sizeFit',
        'materialQuality',
        'positives',
        'concerns',
        'similarReviewerNotes',
      ],
      additionalProperties: false,
    },
  },
  required: [
    'summary',
    'styleTags',
    'occasionTags',
    'fitTags',
    'seasonTags',
    'extraTags',
    'reviewSummary',
  ],
  additionalProperties: false,
});

const evidenceCountSchema = {
  type: 'integer',
  minimum: 0,
};

export const MODEL_ENRICHMENT_OUTPUT_SCHEMA = Object.freeze({
  ...ENRICHMENT_OUTPUT_SCHEMA,
  properties: {
    ...ENRICHMENT_OUTPUT_SCHEMA.properties,
    evidenceTally: {
      type: 'object',
      properties: {
        appearanceMatch: {
          type: 'object',
          properties: {
            similar: evidenceCountSchema,
            different: evidenceCountSchema,
          },
          required: ['similar', 'different'],
          additionalProperties: false,
        },
        sizeFit: {
          type: 'object',
          properties: {
            runsSmall: evidenceCountSchema,
            trueToSize: evidenceCountSchema,
            runsLarge: evidenceCountSchema,
          },
          required: ['runsSmall', 'trueToSize', 'runsLarge'],
          additionalProperties: false,
        },
        materialQuality: {
          type: 'object',
          properties: {
            positive: evidenceCountSchema,
            negative: evidenceCountSchema,
          },
          required: ['positive', 'negative'],
          additionalProperties: false,
        },
      },
      required: ['appearanceMatch', 'sizeFit', 'materialQuality'],
      additionalProperties: false,
    },
  },
  required: [...ENRICHMENT_OUTPUT_SCHEMA.required, 'evidenceTally'],
});

/**
 * null·배열·기본형을 거부하고 객체가 아닌 값의 필드 경로를 오류에 포함한다.
 */
function assertPlainObject(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
}

/**
 * 객체의 키가 기대 목록과 정확히 일치하는지 확인해 누락되거나 추가된 필드를 거부한다.
 */
function assertExactKeys(value, expectedKeys, path) {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(sortedExpectedKeys)) {
    throw new Error(`${path} has unexpected or missing fields`);
  }
}

/**
 * 값이 문자열인지 확인하고 아니면 해당 필드 경로와 함께 오류를 던진다.
 */
function assertString(value, path) {
  if (typeof value !== 'string') {
    throw new Error(`${path} must be a string`);
  }
}

/**
 * 문자열 배열인지 검사하고, 허용 값 목록이 주어지면 목록 밖의 항목도 거부한다.
 */
function assertStringArray(value, path, allowedValues) {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`);
  }
  for (const [index, item] of value.entries()) {
    assertString(item, `${path}[${index}]`);
    if (allowedValues && !allowedValues.includes(item)) {
      throw new Error(`${path}[${index}] is outside the controlled vocabulary`);
    }
  }
}

/**
 * 리뷰 중 실제 값이 채워진 구조화 체형 프로필이 하나라도 있는지 확인한다.
 */
function hasStructuredReviewerProfile(product) {
  return (product.reviews ?? []).some(/* 리뷰의 체형 프로필이 객체이며 비어 있지 않은 속성을 포함하는지 검사한다. */ (review) => {
    const profile = review.reviewerProfile;
    return (
      profile &&
      typeof profile === 'object' &&
      Object.values(profile).some(/* 프로필 속성이 null이나 빈 문자열이 아닌지 확인한다. */ (value) => value !== null && value !== '')
    );
  });
}

/**
 * 저장할 가공 결과의 필드·태그·후기 신호와 분석 리뷰 수를 원본 상품에 대조한다.
 * 리뷰·체형 근거가 없는데 관련 설명을 생성한 경우 거부하고, 통과한 결과 객체를 반환한다.
 */
export function validateEnrichmentOutput(value, product) {
  assertPlainObject(value, 'enrichment');
  assertExactKeys(value, ENRICHMENT_OUTPUT_SCHEMA.required, 'enrichment');
  assertString(value.summary, 'enrichment.summary');

  for (const field of ['styleTags', 'occasionTags', 'fitTags', 'seasonTags']) {
    assertStringArray(value[field], `enrichment.${field}`, CONTROLLED_VOCABULARY[field]);
  }
  assertStringArray(value.extraTags, 'enrichment.extraTags');

  const reviewSummary = value.reviewSummary;
  assertPlainObject(reviewSummary, 'enrichment.reviewSummary');
  assertExactKeys(
    reviewSummary,
    ENRICHMENT_OUTPUT_SCHEMA.properties.reviewSummary.required,
    'enrichment.reviewSummary',
  );

  const expectedReviewCount = product.reviews?.length ?? 0;
  if (reviewSummary.analyzedReviewCount !== expectedReviewCount) {
    throw new Error(
      `analyzedReviewCount must equal supplied review count ${expectedReviewCount}`,
    );
  }

  for (const field of ['appearanceMatch', 'sizeFit', 'materialQuality']) {
    const signalValue = reviewSummary[field];
    assertPlainObject(signalValue, `enrichment.reviewSummary.${field}`);
    assertExactKeys(signalValue, ['signal', 'summary'], `enrichment.reviewSummary.${field}`);
    if (!REVIEW_SIGNALS[field].includes(signalValue.signal)) {
      throw new Error(`enrichment.reviewSummary.${field}.signal is invalid`);
    }
    assertString(signalValue.summary, `enrichment.reviewSummary.${field}.summary`);
  }

  assertStringArray(reviewSummary.positives, 'enrichment.reviewSummary.positives');
  assertStringArray(reviewSummary.concerns, 'enrichment.reviewSummary.concerns');
  if (!Array.isArray(reviewSummary.similarReviewerNotes)) {
    throw new Error('enrichment.reviewSummary.similarReviewerNotes must be an array');
  }
  for (const [index, note] of reviewSummary.similarReviewerNotes.entries()) {
    const path = `enrichment.reviewSummary.similarReviewerNotes[${index}]`;
    assertPlainObject(note, path);
    assertExactKeys(note, ['profile', 'note'], path);
    assertString(note.profile, `${path}.profile`);
    assertString(note.note, `${path}.note`);
  }

  if (!hasStructuredReviewerProfile(product) && reviewSummary.similarReviewerNotes.length > 0) {
    throw new Error('similarReviewerNotes require structured reviewer profile evidence');
  }

  if (expectedReviewCount === 0) {
    for (const field of ['appearanceMatch', 'sizeFit', 'materialQuality']) {
      if (reviewSummary[field].signal !== 'unknown') {
        throw new Error(`${field} must be unknown when no reviews were supplied`);
      }
    }
    if (
      reviewSummary.positives.length > 0 ||
      reviewSummary.concerns.length > 0 ||
      reviewSummary.similarReviewerNotes.length > 0
    ) {
      throw new Error('review evidence arrays must be empty when no reviews were supplied');
    }
  }

  return value;
}

/**
 * 리뷰 근거 집계의 필드가 정확하고 모든 개수가 0부터 실제 리뷰 수 사이의 정수인지 검사한다.
 */
function assertEvidenceTally(tally, fields, reviewCount, path) {
  assertPlainObject(tally, path);
  assertExactKeys(tally, fields, path);
  for (const field of fields) {
    const count = tally[field];
    if (!Number.isSafeInteger(count) || count < 0 || count > reviewCount) {
      throw new Error(`${path}.${field} must be an evidence count within review count`);
    }
  }
}

/**
 * 사진과 실물이 비슷하다는 근거와 다르다는 근거가 함께 있으면 mixed, 모두 없으면 unknown으로 결정한다.
 */
function appearanceSignal(tally) {
  if (tally.similar > 0 && tally.different > 0) return 'mixed';
  if (tally.similar > 0) return 'similar';
  if (tally.different > 0) return 'different';
  return 'unknown';
}

/**
 * 작음·정사이즈·큼의 근거 종류 수에 따라 하나의 사이즈 신호, mixed 또는 unknown을 결정한다.
 */
function sizeSignal(tally) {
  const presentSignals = [
    ['runsSmall', 'runs_small'],
    ['trueToSize', 'true_to_size'],
    ['runsLarge', 'runs_large'],
  ].filter(/* 실제로 한 번 이상 관측된 사이즈 의견의 종류만 남긴다. */ ([field]) => tally[field] > 0);
  if (presentSignals.length === 0) return 'unknown';
  if (presentSignals.length > 1) return 'mixed';
  return presentSignals[0][1];
}

/**
 * 소재 품질의 긍정·부정 근거 유무로 positive·negative·mixed·unknown 중 하나를 결정한다.
 */
function materialSignal(tally) {
  if (tally.positive > 0 && tally.negative > 0) return 'mixed';
  if (tally.positive > 0) return 'positive';
  if (tally.negative > 0) return 'negative';
  return 'unknown';
}

/**
 * 모델이 반환한 evidenceTally를 검증하고 근거 개수로 후기 신호를 다시 결정한다.
 * 모델의 신호 이름을 계산된 값으로 교체하고 저장용 계약을 재검증한 결과를 반환한다.
 */
export function validateModelEnrichmentOutput(value, product) {
  assertPlainObject(value, 'modelEnrichment');
  assertExactKeys(value, MODEL_ENRICHMENT_OUTPUT_SCHEMA.required, 'modelEnrichment');

  const { evidenceTally, ...enrichment } = value;
  assertPlainObject(evidenceTally, 'modelEnrichment.evidenceTally');
  assertExactKeys(
    evidenceTally,
    ['appearanceMatch', 'sizeFit', 'materialQuality'],
    'modelEnrichment.evidenceTally',
  );

  const reviewCount = product.reviews?.length ?? 0;
  assertEvidenceTally(
    evidenceTally.appearanceMatch,
    ['similar', 'different'],
    reviewCount,
    'modelEnrichment.evidenceTally.appearanceMatch',
  );
  assertEvidenceTally(
    evidenceTally.sizeFit,
    ['runsSmall', 'trueToSize', 'runsLarge'],
    reviewCount,
    'modelEnrichment.evidenceTally.sizeFit',
  );
  assertEvidenceTally(
    evidenceTally.materialQuality,
    ['positive', 'negative'],
    reviewCount,
    'modelEnrichment.evidenceTally.materialQuality',
  );

  const expectedSignals = {
    appearanceMatch: appearanceSignal(evidenceTally.appearanceMatch),
    sizeFit: sizeSignal(evidenceTally.sizeFit),
    materialQuality: materialSignal(evidenceTally.materialQuality),
  };
  const normalizedEnrichment = {
    ...enrichment,
    reviewSummary: {
      ...enrichment.reviewSummary,
      appearanceMatch: {
        ...enrichment.reviewSummary.appearanceMatch,
        signal: expectedSignals.appearanceMatch,
      },
      sizeFit: {
        ...enrichment.reviewSummary.sizeFit,
        signal: expectedSignals.sizeFit,
      },
      materialQuality: {
        ...enrichment.reviewSummary.materialQuality,
        signal: expectedSignals.materialQuality,
      },
    },
  };

  return validateEnrichmentOutput(normalizedEnrichment, product);
}
