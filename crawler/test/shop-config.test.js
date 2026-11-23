/**
 * 역할: 수집 설정에 필요한 쇼핑몰과 다섯 카테고리가 정의되고 URL·리뷰 수집 방식이 유효한지 검증한다.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { SHOPS } from '../config/shops.js';

const CATEGORY_IDS = ['pants', 'top', 'dress', 'skirt', 'outerwear'];

test('defines ten Cafe24 shops with the five canonical categories', () => {
  assert.equal(Object.keys(SHOPS).length, 10);

  for (const [shopId, shop] of Object.entries(SHOPS)) {
    assert.equal(shop.id, shopId);
    assert.match(shop.baseUrl, /^https:\/\//u);
    assert.deepEqual(
      shop.categories.map((category) => category.id),
      CATEGORY_IDS,
    );

    for (const category of shop.categories) {
      assert.match(category.url, /^https:\/\/[^/]+\/product\/list\.html\?cate_no=\d+$/u);
    }

    assert.ok(['cafe24-html', 'crema-api'].includes(shop.reviews.type));
    if (shop.reviews.type === 'crema-api') {
      assert.match(shop.reviews.apiBaseUrl, /^https:\/\//u);
      assert.ok(shop.reviews.brandCode);
      assert.ok(Number.isSafeInteger(shop.reviews.widgetId));
    }
  }
});
