/**
 * 역할: 상품 링크를 절대 URL로 바꾸고 불필요한 추적 파라미터와 해시를 제거한다.
 * Cafe24의 쿼리형·경로형 URL에서 원본 상품 ID를 추출한다.
 */

export function normalizeProductUrl(href, baseUrl) {
  const url = new URL(href, baseUrl);

  url.hash = '';
  url.searchParams.delete('display_group');
  url.searchParams.delete('icid');

  return url.toString();
}

export function extractSourceProductId(productUrl) {
  const url = new URL(productUrl);
  const queryProductId = url.searchParams.get('product_no');

  if (queryProductId && /^\d+$/.test(queryProductId)) {
    return queryProductId;
  }

  const prettyUrlMatch = url.pathname.match(/\/product\/[^/]+\/(\d+)(?:\/|$)/);
  return prettyUrlMatch?.[1] ?? null;
}
