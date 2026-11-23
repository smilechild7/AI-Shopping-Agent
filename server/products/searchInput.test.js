/**
 * 역할: 검색 입력의 기본값과 중복 제거, 잘못된 가격·배열·후기 신호 및 허용되지 않은 카테고리 거부를 검증한다.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeSearchInput } from './searchInput.js';

test('fills optional search fields and removes duplicate string values', () => {
  assert.deepEqual(
    normalizeSearchInput({
      query: '  검정 바지  ',
      required: { category: 'pants', maxPrice: 100000, colors: ['black', 'black'] },
      preferred: { fitTags: ['relaxed'] },
    }),
    {
      query: '검정 바지',
      required: {
        category: 'pants',
        minPrice: null,
        maxPrice: 100000,
        colors: ['black'],
        sizes: [],
      },
      preferred: {
        colors: [],
        sizes: [],
        styleTags: [],
        occasionTags: [],
        fitTags: ['relaxed'],
        seasonTags: [],
        keywords: [],
        avoidKeywords: [],
        reviewSignals: {
          appearanceMatch: null,
          sizeFit: null,
          materialQuality: null,
        },
      },
    },
  );
});

test('rejects invalid prices, arrays, and review signals', () => {
  assert.throws(
    () =>
      normalizeSearchInput({
        query: '바지',
        required: { minPrice: 100000, maxPrice: 50000 },
      }),
    /must not exceed/u,
  );
  assert.throws(
    () => normalizeSearchInput({ query: '바지', preferred: { colors: 'black' } }),
    /array of strings/u,
  );
  assert.throws(
    () =>
      normalizeSearchInput({
        query: '바지',
        preferred: { reviewSignals: { sizeFit: 'perfect' } },
      }),
    /is invalid/u,
  );
  assert.throws(
    () =>
      normalizeSearchInput({
        query: '바지',
        preferred: { fitTags: ['comfortable'] },
      }),
    /controlled vocabulary/u,
  );
});

test('accepts only canonical product categories', () => {
  assert.equal(
    normalizeSearchInput({ query: '상의', required: { category: 'top' } }).required
      .category,
    'top',
  );
  assert.throws(
    () => normalizeSearchInput({ query: '바지', required: { category: '바지' } }),
    /category is outside/u,
  );
});
