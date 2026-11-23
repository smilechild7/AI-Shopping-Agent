/**
 * 역할: 필수 카테고리·가격을 SQL로 거른 뒤 확인 가능한 색상·사이즈 조건을 검사한다.
 * 후보가 한도를 넘으면 선호 점수로 정렬하고 Agent용 상품 요약과 일치 개수를 반환한다.
 */

import { RETRIEVAL_CONFIG } from '../config/retrieval.js';
import { toCompactProductDto } from './productDto.js';
import { scoreSearchCandidate } from './retrievalScore.js';
import { normalizeSearchInput } from './searchInput.js';
import {
  colorsMatch,
  passesConditionalRequired,
  sizesMatch,
} from './searchNormalization.js';

/**
 * 상품의 색상·사이즈를 필수 조건과 비교하되, 해당 상품 정보가 없으면 검색 후보로 유지한다.
 */
function passesRequiredProductValues(candidate, required) {
  return (
    passesConditionalRequired(
      candidate.product.colors ?? [],
      required.colors,
      colorsMatch,
    ) &&
    passesConditionalRequired(
      candidate.product.sizes ?? [],
      required.sizes,
      sizesMatch,
    )
  );
}

/**
 * 선호 점수 내림차순으로 정렬하고 동점이면 가격 오름차순, 상품 ID 순으로 순서를 고정한다.
 */
function retrievalOrder(left, right) {
  return (
    right.score.total - left.score.total ||
    left.candidate.product.price - right.candidate.product.price ||
    left.candidate.product.id.localeCompare(right.candidate.product.id)
  );
}

/**
 * 필수 카테고리·가격을 SQL로 거르고 색상·사이즈를 추가 확인해 후보를 구성한다.
 * 후보가 한도를 넘을 때만 선호 점수로 줄이며, 전체 필터 일치 수와 Agent용 상품 요약 목록을 반환한다.
 */
export function searchProducts(
  input,
  {
    repository,
    config = RETRIEVAL_CONFIG,
    logger = console,
  },
) {
  const normalizedInput = normalizeSearchInput(input);
  const sqlCandidates = repository.findSearchCandidates({
    category: normalizedInput.required.category,
    minPrice: normalizedInput.required.minPrice,
    maxPrice: normalizedInput.required.maxPrice,
  });
  const hardFilterCandidates = sqlCandidates.filter(/* SQL을 통과한 상품 중 확인 가능한 필수 색상·사이즈와 불일치하는 후보를 제외한다. */ (candidate) =>
    passesRequiredProductValues(candidate, normalizedInput.required),
  );

  let selectedCandidates = hardFilterCandidates;
  if (hardFilterCandidates.length > config.candidateLimit) {
    selectedCandidates = hardFilterCandidates
      .map(/* 후보에 선호 점수와 항목별 점수 내역을 붙여 정렬할 수 있게 한다. */ (candidate) => ({
        candidate,
        score: scoreSearchCandidate(candidate, normalizedInput.preferred, config),
      }))
      .sort(retrievalOrder)
      .slice(0, config.candidateLimit)
      .map(/* 정렬과 개수 제한을 마친 뒤 임시 점수 객체를 벗기고 상품 후보만 남긴다. */ ({ candidate }) => candidate);
  }

  logger.log(
    JSON.stringify({
      event: 'search.complete',
      sqlMatches: sqlCandidates.length,
      hardFilterMatches: hardFilterCandidates.length,
      candidates: selectedCandidates.length,
      retrievalApplied: hardFilterCandidates.length > config.candidateLimit,
    }),
  );

  return {
    hardFilterMatchCount: hardFilterCandidates.length,
    candidates: selectedCandidates.map(toCompactProductDto),
  };
}
