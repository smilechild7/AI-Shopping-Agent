/**
 * 역할: 상품 정보와 가공 태그·후기 신호를 선호 조건과 비교해 항목별 점수와 합계를 계산한다.
 * 선호 키워드에는 가점을, 회피 키워드에는 감점을 적용해 후보 정렬에 사용할 값을 만든다.
 */

import { RETRIEVAL_CONFIG } from '../config/retrieval.js';
import {
  colorsMatch,
  matchesAnyValue,
  normalizeText,
  sizesMatch,
} from './searchNormalization.js';

/**
 * 실제 값 목록에 요청한 값과 정규화 후 정확히 같은 항목이 있는지 확인한다.
 */
function normalizedIncludes(values, expected) {
  const normalizedExpected = normalizeText(expected);
  return values.some(/* 실제 문자열 하나를 공통 규칙으로 정리한 뒤 요청한 정규화 문자열과 비교한다. */ (value) => normalizeText(value) === normalizedExpected);
}

/**
 * 요청한 선호 값들 중 실제 태그 목록과 일치하는 항목 수를 계산한다.
 */
function countMatches(expectedValues, actualValues) {
  return expectedValues.reduce(
    /**
     * 현재 선호 값의 일치 여부를 0 또는 1로 바꾸어 누적 일치 개수에 더한다.
     */
    (count, expected) => count + Number(normalizedIncludes(actualValues, expected)),
    0,
  );
}

/**
 * 상품명·소재·설명과 가공 태그·요약을 합쳐 키워드 포함 여부를 검사할 검색 문자열을 만든다.
 */
function keywordHaystack(product, enrichment) {
  return normalizeText(
    [
      product.name,
      product.brand,
      product.category,
      product.material,
      product.description,
      ...(product.colors ?? []),
      ...(product.sizes ?? []),
      enrichment?.summary,
      ...(enrichment?.styleTags ?? []),
      ...(enrichment?.occasionTags ?? []),
      ...(enrichment?.fitTags ?? []),
      ...(enrichment?.seasonTags ?? []),
      ...(enrichment?.extraTags ?? []),
    ]
      .filter(Boolean)
      .join(' '),
  );
}

/**
 * 비어 있지 않은 요청 키워드 중 검색 문자열에 포함되는 키워드의 개수를 센다.
 */
function keywordMatchCount(keywords, haystack) {
  return keywords.reduce(/* 키워드를 정규화하고 실제로 포함된 경우에만 누적 일치 수를 늘린다. */ (count, keyword) => {
    const normalizedKeyword = normalizeText(keyword);
    return count + Number(normalizedKeyword !== '' && haystack.includes(normalizedKeyword));
  }, 0);
}

/**
 * 상품 정보와 가공 결과를 선호 조건에 대조해 설정된 가중치로 항목별 점수를 계산한다.
 * 회피 키워드는 감점하며 최종 합계와 점수 내역을 반환한다. 이 점수는 구매 적합 확률이 아니다.
 */
export function scoreSearchCandidate(
  candidate,
  preferred,
  config = RETRIEVAL_CONFIG,
) {
  const { product, enrichment } = candidate;
  const weights = config.weights;
  const haystack = keywordHaystack(product, enrichment);
  const reviewSummary = enrichment?.reviewSummary;

  const breakdown = {
    keyword:
      keywordMatchCount(preferred.keywords, haystack) * weights.keyword -
      keywordMatchCount(preferred.avoidKeywords, haystack) * weights.keyword,
    color: matchesAnyValue(product.colors ?? [], preferred.colors, colorsMatch)
      ? weights.color
      : 0,
    size: matchesAnyValue(product.sizes ?? [], preferred.sizes, sizesMatch)
      ? weights.size
      : 0,
    style:
      countMatches(preferred.styleTags, enrichment?.styleTags ?? []) * weights.style,
    occasion:
      countMatches(preferred.occasionTags, enrichment?.occasionTags ?? []) *
      weights.occasion,
    fit: countMatches(preferred.fitTags, enrichment?.fitTags ?? []) * weights.fit,
    season:
      countMatches(preferred.seasonTags, enrichment?.seasonTags ?? []) * weights.season,
    reviewSignal: 0,
  };

  for (const [field, expectedSignal] of Object.entries(preferred.reviewSignals)) {
    if (expectedSignal !== null && reviewSummary?.[field]?.signal === expectedSignal) {
      breakdown.reviewSignal += weights.reviewSignal;
    }
  }

  return {
    total: Object.values(breakdown).reduce(/* 키워드·옵션·태그·후기 신호 점수를 모두 더해 후보 정렬에 사용할 합계를 만든다. */ (total, value) => total + value, 0),
    breakdown,
  };
}
