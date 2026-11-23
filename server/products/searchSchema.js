/**
 * 역할: OpenAI search_products 도구의 입력 JSON Schema를 정의한다.
 * 필수 검색 조건과 선호 조건의 구조, 카테고리·태그·후기 신호의 허용 값을 명시한다.
 */

import { CONTROLLED_VOCABULARY } from '../config/vocabulary.js';

/**
 * 검색 도구의 문자열 배열 스키마를 만들고, 허용 목록이 있으면 배열 원소의 값을 제한한다.
 */
const stringArray = (values) => ({
  type: 'array',
  items: values ? { type: 'string', enum: values } : { type: 'string' },
});

/**
 * 후기 신호를 허용된 문자열 또는 조건 미지정을 뜻하는 null로 제한하는 스키마를 만든다.
 */
const nullableSignal = (values) => ({
  type: ['string', 'null'],
  enum: [...values, null],
});

export const SEARCH_PRODUCTS_INPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    query: { type: 'string' },
    required: {
      type: 'object',
      properties: {
        category: {
          type: ['string', 'null'],
          enum: [...CONTROLLED_VOCABULARY.productCategories, null],
        },
        minPrice: { type: ['integer', 'null'], minimum: 0 },
        maxPrice: { type: ['integer', 'null'], minimum: 0 },
        colors: stringArray(),
        sizes: stringArray(),
      },
      required: ['category', 'minPrice', 'maxPrice', 'colors', 'sizes'],
      additionalProperties: false,
    },
    preferred: {
      type: 'object',
      properties: {
        colors: stringArray(),
        sizes: stringArray(),
        styleTags: stringArray(CONTROLLED_VOCABULARY.styleTags),
        occasionTags: stringArray(CONTROLLED_VOCABULARY.occasionTags),
        fitTags: stringArray(CONTROLLED_VOCABULARY.fitTags),
        seasonTags: stringArray(CONTROLLED_VOCABULARY.seasonTags),
        keywords: stringArray(),
        avoidKeywords: stringArray(),
        reviewSignals: {
          type: 'object',
          properties: {
            appearanceMatch: nullableSignal([
              'similar',
              'different',
              'mixed',
              'unknown',
            ]),
            sizeFit: nullableSignal([
              'runs_small',
              'true_to_size',
              'runs_large',
              'mixed',
              'unknown',
            ]),
            materialQuality: nullableSignal([
              'positive',
              'negative',
              'mixed',
              'unknown',
            ]),
          },
          required: ['appearanceMatch', 'sizeFit', 'materialQuality'],
          additionalProperties: false,
        },
      },
      required: [
        'colors',
        'sizes',
        'styleTags',
        'occasionTags',
        'fitTags',
        'seasonTags',
        'keywords',
        'avoidKeywords',
        'reviewSignals',
      ],
      additionalProperties: false,
    },
  },
  required: ['query', 'required', 'preferred'],
  additionalProperties: false,
});
