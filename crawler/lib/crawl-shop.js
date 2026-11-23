/**
 * 역할: 한 쇼핑몰의 카테고리 페이지에서 상품 URL을 찾고 상세 페이지를 순차 수집한다.
 * 제외할 상품과 요청 간격을 반영해 Cafe24 파서로 정리한 원본 상품 목록을 반환한다.
 */

import { discoverProductUrls } from './discover-product-urls.js';
import { fetchPage, wait } from './fetch-page.js';
import { parseCafe24Product } from './parse-cafe24-product.js';

/**
 * 쇼핑몰·카테고리 설정을 받아 목록 페이지에서 찾은 상품을 차례로 수집한다.
 * 제외 ID와 요청 간격을 반영한 원본 상품 배열을 반환하며, 목표 개수만큼 URL을 찾지 못하면 중단한다.
 */
export async function crawlShop({
  shopConfig,
  categoryConfig,
  limit = 10,
  requestDelayMs = 1_000,
  excludedProductIds = new Set(),
  fetcher = fetchPage,
}) {
  const categoryHtml = await fetcher(categoryConfig.url);
  const productUrls = discoverProductUrls(
    categoryHtml,
    shopConfig,
    limit,
    categoryConfig,
    excludedProductIds,
  );

  if (productUrls.length < limit) {
    throw new Error(
      `Only discovered ${productUrls.length}/${limit} products for ${shopConfig.id}:${categoryConfig.id}`,
    );
  }

  const products = [];

  for (const [index, productUrl] of productUrls.entries()) {
    await wait(requestDelayMs);
    const html = await fetcher(productUrl);
    const product = parseCafe24Product(html, {
      shopConfig,
      categoryConfig,
      productUrl,
    });
    products.push(product);

    console.log(
      JSON.stringify({
        event: 'crawler.product.complete',
        shopId: shopConfig.id,
        category: categoryConfig.id,
        productId: product.source.sourceProductId,
        progress: `${index + 1}/${productUrls.length}`,
      }),
    );
  }

  return products;
}
