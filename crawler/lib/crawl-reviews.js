/**
 * 역할: 쇼핑몰 설정에 따라 Cafe24 HTML 또는 Crema 공개 API에서 상품별 리뷰를 수집한다.
 * 요청 간격·리뷰 개수 제한을 적용하고 갱신된 상품과 수집 실패 목록을 반환한다.
 */

import { fetchPage, wait } from './fetch-page.js';
import { parseCafe24Reviews, parseCremaReviews } from './parse-reviews.js';

/**
 * Crema 쇼핑몰 설정과 상품 ID로 최근 리뷰 조회 URL을 만들고 필요한 필드와 개수 제한을 지정한다.
 */
function cremaReviewsUrl(reviewConfig, productId, limit) {
  const url = new URL(
    `/api/${reviewConfig.brandCode}/reviews`,
    reviewConfig.apiBaseUrl,
  );

  url.searchParams.set('product_code', productId);
  url.searchParams.set('widget_id', reviewConfig.widgetId.toString());
  url.searchParams.set(
    'fields',
    'total_reviews_count,reviews.customer_properties,reviews.evaluation_properties',
  );
  url.searchParams.set('per', limit.toString());
  url.searchParams.set('page', '1');
  url.searchParams.set('sort', '20');
  url.searchParams.set('app', '0');

  return url.toString();
}

/**
 * 설정된 리뷰 출처에 따라 Cafe24 HTML 또는 Crema JSON을 읽어 공통 리뷰 형식으로 변환한다.
 * 실제 수집 리뷰 수보다 작지 않은 전체 리뷰 수를 함께 반환하며, 미지원 출처·잘못된 JSON은 거부한다.
 */
async function fetchProductReviews({ product, shopConfig, limit, fetcher }) {
  const reviewConfig = shopConfig.reviews;

  if (reviewConfig?.type === 'cafe24-html') {
    const html = await fetcher(product.source.productUrl);
    const reviews = parseCafe24Reviews(html, {
      limit,
      ...reviewConfig.parser,
    });
    return {
      reviews,
      reviewCount: Math.max(product.reviewCount ?? 0, reviews.length),
    };
  }

  if (reviewConfig?.type === 'crema-api') {
    const url = cremaReviewsUrl(
      reviewConfig,
      product.source.sourceProductId,
      limit,
    );
    const responseText = await fetcher(url, { accept: 'application/json' });
    let payload;

    try {
      payload = JSON.parse(responseText);
    } catch {
      throw new Error(
        `Invalid Crema JSON for product ${product.source.sourceProductId}`,
      );
    }

    const reviews = parseCremaReviews(payload, { limit });

    return {
      reviews,
      reviewCount: Number.isSafeInteger(payload?.total_reviews_count)
        ? Math.max(payload.total_reviews_count, reviews.length)
        : Math.max(product.reviewCount ?? 0, reviews.length),
    };
  }

  throw new Error(`Unsupported review source for shop ${shopConfig.id}`);
}

/**
 * 상품 목록에서 지정된 개수만큼 리뷰를 수집해 상품 복사본의 reviews와 reviewCount를 갱신한다.
 * 상품별 실패를 기록하면서 다음 상품으로 진행하고, 갱신된 목록과 실패 목록을 함께 반환한다.
 */
export async function crawlReviews({
  products,
  shopConfig,
  productLimit = products.length,
  reviewLimit = 20,
  requestDelayMs = 1_000,
  fetcher = fetchPage,
}) {
  const updatedProducts = products.map(/* 입력 상품 객체를 얕게 복사해 수집 결과를 원래 객체에 직접 대입하지 않도록 한다. */ (product) => ({ ...product }));
  const targetCount = Math.min(productLimit, updatedProducts.length);
  const failures = [];

  for (let index = 0; index < targetCount; index += 1) {
    const product = updatedProducts[index];

    await wait(requestDelayMs);

    try {
      const evidence = await fetchProductReviews({
        product,
        shopConfig,
        limit: reviewLimit,
        fetcher,
      });
      product.reviews = evidence.reviews;
      product.reviewCount = evidence.reviewCount;

      console.log(
        JSON.stringify({
          event: 'crawler.reviews.product.complete',
          shopId: shopConfig.id,
          productId: product.source.sourceProductId,
          reviewCount: product.reviews.length,
          progress: `${index + 1}/${targetCount}`,
        }),
      );
    } catch (error) {
      failures.push({
        productId: product.source.sourceProductId,
        message: error.message,
      });

      console.error(
        JSON.stringify({
          event: 'crawler.reviews.product.failed',
          shopId: shopConfig.id,
          productId: product.source.sourceProductId,
          message: error.message,
          progress: `${index + 1}/${targetCount}`,
        }),
      );
    }
  }

  return { products: updatedProducts, failures };
}
