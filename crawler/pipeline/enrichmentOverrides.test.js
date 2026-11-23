/**
 * 역할: 등록된 상품의 사진·실물 신호만 보정되고 다른 후기 축이나 보정 대상이 아닌 상품은 유지되는지 검증한다.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ENRICHMENT_OVERRIDES,
  applyEnrichmentOverrides,
} from './enrichmentOverrides.js';

function fixtureEnrichment() {
  return {
    summary: '상품 요약',
    reviewSummary: {
      appearanceMatch: { signal: 'similar', summary: '모델 원본 요약' },
      sizeFit: { signal: 'unknown', summary: '근거 없음' },
    },
  };
}

test('applies audited appearance overrides without changing other review axes', () => {
  const original = fixtureEnrichment();
  const overridden = applyEnrichmentOverrides('graychic:12325', original);

  assert.equal(overridden.reviewSummary.appearanceMatch.signal, 'different');
  assert.equal(
    overridden.reviewSummary.appearanceMatch.summary,
    ENRICHMENT_OVERRIDES['graychic:12325'].appearanceMatch.summary,
  );
  assert.deepEqual(overridden.reviewSummary.sizeFit, original.reviewSummary.sizeFit);
  assert.equal(original.reviewSummary.appearanceMatch.signal, 'similar');
});

test('returns an untouched enrichment when no audited override exists', () => {
  const enrichment = fixtureEnrichment();
  assert.equal(applyEnrichmentOverrides('other:1', enrichment), enrichment);
});
