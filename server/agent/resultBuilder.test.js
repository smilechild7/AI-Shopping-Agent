/**
 * 역할: 추천 근거 검증과 DB 사실 필드 병합을 확인하고, 후보 밖 상품·허위 근거·unknown 후기 근거를 거부하는지 검증한다.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAgentResult } from './resultBuilder.js';

const candidate = {
  id: 'shop:1',
  name: '와이드 팬츠',
  brand: null,
  category: 'pants',
  price: 59000,
  colors: ['검정'],
  sizes: ['M(27~28)'],
  sizeGuideText: 'M 허리 70cm',
  material: '면',
  summary: '출근용 와이드 팬츠',
  styleTags: ['minimal'],
  occasionTags: ['office'],
  fitTags: ['wide'],
  seasonTags: ['fall'],
  extraTags: [],
  reviewSummary: {
    appearanceMatch: { signal: 'similar', summary: '비슷함' },
    sizeFit: { signal: 'true_to_size', summary: '정사이즈' },
    materialQuality: { signal: 'positive', summary: '소재 긍정' },
  },
};
const factualProduct = {
  id: 'shop:1',
  source: {
    shopName: '쇼핑몰',
    productUrl: 'https://shop.example/products/1',
  },
  name: '와이드 팬츠',
  brand: null,
  category: 'pants',
  price: 59000,
  imageUrl: 'https://shop.example/1.jpg',
  colors: ['검정'],
  sizes: ['M(27~28)'],
  sizeGuideText: 'M 허리 70cm',
  material: '면',
  rating: 4.8,
  reviewCount: 10,
};
const latestSearch = {
  input: {
    required: {
      category: 'pants',
      minPrice: null,
      maxPrice: 100000,
      colors: ['black'],
      sizes: ['28'],
    },
    preferred: {},
  },
  result: { candidates: [candidate] },
};
const repository = { /* DB 조회를 대신해 고정된 실제 상품 필드 표본을 반환하는 테스트용 저장소 함수다. */ getProductsByIds: () => [factualProduct] };

/**
 * 검사할 근거 배열을 넣어 한 상품을 추천하는 모의 모델 출력을 만든다.
 */
function output(evidence) {
  return {
    type: 'recommendation',
    message: '골랐어요.',
    recommendations: [
      {
        productId: 'shop:1',
        reason: '조건에 맞아요.',
        evidence,
        strengths: ['출근용'],
        concerns: ['실측 확인 필요'],
      },
    ],
    comparison: [],
  };
}

/**
 * 유효한 가격·옵션·후기 근거가 통과하고 가격·이미지·판매 URL은 DB 값으로 채워지는지 검증한다.
 */
test('validates evidence and merges only factual DB product fields', () => {
  const result = buildAgentResult({
    output: output([
      { type: 'price', value: 'within_required_range' },
      { type: 'color', value: 'black' },
      { type: 'size', value: '28' },
      { type: 'occasion', value: 'office' },
      { type: 'review_size_fit', value: 'true_to_size' },
    ]),
    responseId: 'resp_final',
    latestSearch,
    repository,
  });

  assert.equal(result.products[0].imageUrl, factualProduct.imageUrl);
  assert.equal(result.products[0].productUrl, factualProduct.source.productUrl);
  assert.equal(result.products[0].price, 59000);
  assert.equal(result.criteria.required.maxPrice, 100000);
});

/**
 * 후보에 없는 태그 근거와 최근 검색 후보 밖의 상품 ID가 각각 거부되는지 검증한다.
 */
test('rejects hallucinated evidence and products outside candidates', () => {
  assert.throws(
    /**
     * 후보에 없는 wedding 용도 근거로 결과 생성을 시도해 검증 오류 발생을 확인한다.
     */
    () =>
      buildAgentResult({
        output: output([{ type: 'occasion', value: 'wedding' }]),
        responseId: 'resp_final',
        latestSearch,
        repository,
      }),
    /evidence does not match/u,
  );

  const invalid = output([{ type: 'occasion', value: 'office' }]);
  invalid.recommendations[0].productId = 'shop:missing';
  assert.throws(
    /**
     * 존재하지 않는 후보 ID로 결과 생성을 시도해 검색 후보 범위 검사가 작동하는지 확인한다.
     */
    () =>
      buildAgentResult({
        output: invalid,
        responseId: 'resp_final',
        latestSearch,
        repository,
      }),
    /outside the latest candidate/u,
  );
});

/**
 * 후기 신호가 unknown인 후보라도 그 값을 추천 근거로 쓸 수 없다는 규칙을 검증한다.
 */
test('rejects unknown review signals as recommendation evidence', () => {
  const candidateWithUnknown = structuredClone(candidate);
  candidateWithUnknown.reviewSummary.appearanceMatch.signal = 'unknown';

  assert.throws(
    /**
     * unknown 후기 신호를 근거로 넣은 응답을 만들어 거부되는지 확인한다.
     */
    () =>
      buildAgentResult({
        output: output([
          { type: 'review_appearance_match', value: 'unknown' },
        ]),
        responseId: 'resp_final',
        latestSearch: {
          ...latestSearch,
          result: { candidates: [candidateWithUnknown] },
        },
        repository,
      }),
    /evidence does not match/u,
  );
});
