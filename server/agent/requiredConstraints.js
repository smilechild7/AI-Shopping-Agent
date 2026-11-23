/**
 * 역할: 필수 검색 조건을 비교 가능한 불변 스냅샷으로 만들고 모델이 조건을 바꾸었는지 검사한다.
 * DB에서 조회한 상품이 필수 카테고리·가격·색상·사이즈를 만족하는지 검증하는 함수를 제공한다.
 */

import { normalizeSearchInput } from '../products/searchInput.js';
import {
  canonicalColor, canonicalSize, colorsMatch, sizesMatch,
} from '../products/searchNormalization.js';

export class ConstraintError extends Error {
  /**
   * 조건 위반의 오류 코드와 문제 필드 목록을 보관해 호출자가 실패 원인을 구분할 수 있게 한다.
   */
  constructor(code, fields = []) {
    super(code + (fields.length ? ': ' + fields.join(', ') : ''));
    this.name = 'ConstraintError';
    this.code = code;
    this.fields = fields;
  }
}

/**
 * 필수 조건의 기본값·색상·사이즈를 정규화하고 중복 제거·정렬 후 객체와 배열을 동결한다.
 * 상품 옵션의 범위 겹침과 구별되는 조건 자체의 동일성을 비교할 기준값을 만든다.
 */
export function requiredSnapshot(required = {}) {
  const value = normalizeSearchInput({ query: 'constraints', required }).required;
  value.colors = Object.freeze([...new Set(value.colors.map(canonicalColor))].sort());
  value.sizes = Object.freeze([...new Set(value.sizes.map(canonicalSize))].sort());
  return Object.freeze(value);
}

/**
 * 모델이 제안한 필수 조건을 정규화해 서버 기준값과 비교하고, 다른 필드가 있으면 constraint_violation을 던진다.
 */
export function assertRequiredUnchanged(proposed, expected) {
  const canonical = requiredSnapshot(proposed);
  const fields = Object.keys(expected).filter(
    /**
     * 두 스냅샷의 동일한 필드를 직렬화해 값·배열 순서가 다른 필드만 찾는다.
     */
    (field) => JSON.stringify(canonical[field]) !== JSON.stringify(expected[field]),
  );
  if (fields.length) throw new ConstraintError('constraint_violation', fields);
}

// These checks use freshly hydrated DB fields, independently of LLM evidence.
/**
 * DB에서 다시 읽은 상품이 확정된 카테고리·가격·색상·사이즈를 충족하는지 검사한다.
 * 필수 색상·사이즈가 있는데 상품 값이 없거나 불일치하면 해당 필드를 모아 오류를 던진다.
 */
export function assertProductMeetsRequired(product, required) {
  const fields = [];
  if (required.category && product.category !== required.category) fields.push('category');
  if (
    (required.minPrice !== null || required.maxPrice !== null) &&
    (!Number.isSafeInteger(product.price) ||
      (required.minPrice !== null && product.price < required.minPrice) ||
      (required.maxPrice !== null && product.price > required.maxPrice))
  ) fields.push('price');
  for (const [field, matcher] of [['colors', colorsMatch], ['sizes', sizesMatch]]) {
    if (
      required[field].length &&
      !required[field].some(/* 허용된 필수 값 중 상품의 판매 옵션과 맞는 값이 하나라도 있는지 확인한다. */ (wanted) => (product[field] ?? []).some(/* 상품 옵션 한 개를 요청한 필수 값과 색상 또는 사이즈 매칭 함수로 비교한다. */ (value) => matcher(value, wanted)))
    ) fields.push(field);
  }
  if (fields.length) {
    const error = new ConstraintError('required_product_mismatch', fields);
    error.productId = product.id;
    throw error;
  }
}
