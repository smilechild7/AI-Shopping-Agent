/**
 * 역할: 카테고리 HTML의 링크·이미지 설명·상품 카드 문구에서 조건에 맞는 상품 URL을 찾는다.
 * 쇼핑몰별 탐색 규칙과 제외 ID를 반영하고 중복 상품을 제거해 지정한 개수까지 반환한다.
 */

import * as cheerio from 'cheerio';

import { extractSourceProductId, normalizeProductUrl } from './product-url.js';

function productLabel($, element, href) {
  const text = $(element).text();
  const imageAlt = $(element).find('img[alt]').first().attr('alt') ?? '';
  const cardText = $(element).closest('.box, li').first().text();
  return `${text} ${imageAlt} ${cardText} ${href}`;
}

export function discoverProductUrls(
  html,
  shopConfig,
  limit = 10,
  categoryConfig = null,
  excludedProductIds = new Set(),
) {
  const $ = cheerio.load(html);
  const discovery = {
    ...shopConfig.discovery,
    ...categoryConfig?.discovery,
  };
  const selectors = discovery.productLinkSelectors ?? [
    'a[id^="anchorBoxName_"]',
    'a[name^="anchorBoxName_"]',
  ];
  const includePattern = discovery.includeProductPattern;
  const discovered = [];
  const seenProductIds = new Set();

  $(selectors.join(',')).each((_, element) => {
    if (discovered.length >= limit) {
      return false;
    }

    const href = $(element).attr('href');
    if (
      !href ||
      (includePattern && !includePattern.test(productLabel($, element, href)))
    ) {
      return;
    }

    const productUrl = normalizeProductUrl(href, shopConfig.baseUrl);
    const productId = extractSourceProductId(productUrl);

    if (
      !productId ||
      seenProductIds.has(productId) ||
      excludedProductIds.has(productId)
    ) {
      return;
    }

    seenProductIds.add(productId);
    discovered.push(productUrl);
  });

  return discovered;
}
