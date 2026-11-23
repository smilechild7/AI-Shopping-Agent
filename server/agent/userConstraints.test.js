/**
 * 역할: 자연어와 UI 필터의 우선순위, 후속 조건 변경·해제와 모호한 문장의 확인 질문 처리를 검증한다.
 * 조건의 정규화된 동일성과 기존 자연어 평가 사례의 해석도 확인한다.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { resolveUserConstraints } from './userConstraints.js';
import { requiredSnapshot, assertRequiredUnchanged } from './requiredConstraints.js';

const original = requiredSnapshot({
  category: 'pants', minPrice: null, maxPrice: 50_000, colors: ['black'], sizes: ['M'],
});

for (const [message, expected] of [
  ['5만원 이하 바지', { category: 'pants', maxPrice: 50_000 }],
  ['5만원 미만 바지', { category: 'pants', maxPrice: 49_999 }],
  ['3만원 초과 바지', { category: 'pants', minPrice: 30_001 }],
  ['최대 가격을 10만원으로 올려줘', { maxPrice: 100_000 }],
  ['최소 가격은 30,000원', { minPrice: 30_000 }],
  ['3만원 이상 5만원 이하 바지', { category: 'pants', minPrice: 30_000, maxPrice: 50_000 }],
  ['5~7만원 바지', { category: 'pants', minPrice: 50_000, maxPrice: 70_000 }],
  ['50,000원~70,000원 바지', { category: 'pants', minPrice: 50_000, maxPrice: 70_000 }],
  ['천원 이하 바지', { category: 'pants', maxPrice: 1_000 }],
  ['1천원 이하 원피스', { category: 'dress', maxPrice: 1_000 }],
  ['8만원 바지', { category: 'pants', minPrice: 70_000, maxPrice: 90_000 }],
  ['8만원대 바지', { category: 'pants', minPrice: 80_000, maxPrice: 89_999 }],
  ['딱 5만원 바지', { category: 'pants', minPrice: 50_000, maxPrice: 50_000 }],
  ['흰색 원피스', { category: 'dress', colors: [] }],
  ['검정 바지인데 너무 짧은 건 싫어', { category: 'pants', colors: [] }],
  ['화이트 아우터. 정확한 화이트가 있으면 먼저 보여줘', { category: 'outerwear', colors: [] }],
  ['꼭 정확한 화이트 원피스만. 아이보리나 크림은 싫어.', { category: 'dress', colors: ['white'] }],
  ['검정 바지만', { category: 'pants', colors: ['black'] }],
  ['검정 또는 네이비만', { colors: ['black', 'navy'] }],
  ['정확히 5만원 검정 바지', { category: 'pants', minPrice: 50_000, maxPrice: 50_000, colors: [] }],
  ['평소 66인데 편한 바지', { category: 'pants', sizes: [] }],
  ['5만원 이하 여름 바지 중 28 사이즈가 있고 너무 짧지 않은 것', { category: 'pants', maxPrice: 50_000, sizes: ['28'] }],
  ['M 사이즈만 있는 상의', { category: 'top', sizes: ['m'] }],
  ['청바지랑 편하게 입을 니트 상의', { category: 'top' }],
  ['꾸안꾸 윗도리', { category: 'top' }],
]) {
  test('resolves supported user conditions: ' + message, () => {
    const result = resolveUserConstraints({ message });
    assert.equal(result.clarification, null);
    assert.deepEqual(result.required, requiredSnapshot(expected));
  });
}

for (const [message, patch] of [
  ['후기가 더 좋은 걸로', {}],
  ['최대 가격을 10만원으로 올려줘', { maxPrice: 100_000 }],
  ['이번에는 네이비만 찾아줘', { colors: ['navy'] }],
  ['네이비로 바꿔줘', { colors: ['navy'] }],
  ['아이보리도 괜찮아', { colors: ['black', 'cream'] }],
  ['색상은 상관없어', { colors: [] }],
  ['가격 제한을 없애줘', { minPrice: null, maxPrice: null }],
  ['사이즈는 상관없어', { sizes: [] }],
  ['이번엔 원피스를 찾아줘', { category: 'dress' }],
]) {
  test('applies only explicit user edits: ' + message, () => {
    const result = resolveUserConstraints({ message, previousRequired: original });
    assert.equal(result.clarification, null);
    assert.deepEqual(result.required, requiredSnapshot({ ...original, ...patch }));
    assert.equal(original.maxPrice, 50_000);
  });
}

for (const message of [
  '예산을 조금 늘려줘', '10만원으로 올리지는 마', '최대 10만원은 아니야',
  '5만원 이하 또는 10만원 이하', '10만원 이하라면 사겠어',
  '"10만원 이하"라는 말은 예시야', '3만원 미만 5만원 이상',
  '바지랑 원피스 찾아줘', '검정은 싫어', '보라색만 찾아줘',
  '사이즈를 조금 더 큰 걸로 변경', '네이비도 보여줘',
  '검정만 원하고 네이비는 선호해',
  '5만원에서 10만원으로 올려줘', '-5만원 이하 바지', '10만원은 안돼',
  '1억원 이하 바지',
  '5만 5천원 이하 바지', '십만원 이하 바지',
  '아까 추천한 9만원 상품의 후기는?', '9만원 상품의 후기는?',
  '10만원보다 비싸면 안돼', '9만원짜리 상품이 좋아 보여',
  '지난번 추천한 원피스는 예쁘네',
]) {
  test('clarifies ambiguous edits without mutating state: ' + message, () => {
    const result = resolveUserConstraints({ message, previousRequired: original });
    assert.ok(result.clarification);
    assert.deepEqual(result.required, original);
  });
}

test('current UI selection overrides text, but a later explicit edit overrides old UI state', () => {
  const first = resolveUserConstraints({
    message: '10만원 이하 원피스',
    selectedFilters: { category: 'pants', maxPrice: 50_000, size: 'M' },
  });
  assert.equal(first.clarification, null);
  assert.deepEqual(first.required, requiredSnapshot({ category: 'pants', maxPrice: 50_000, sizes: ['M'] }));
  const next = resolveUserConstraints({ message: '최대 가격을 10만원으로 변경', previousRequired: first.required });
  assert.equal(next.required.maxPrice, 100_000);
  assert.equal(next.required.category, 'pants');
});

test('compares canonical condition identity, never overlapping product-size ranges', () => {
  const expected = requiredSnapshot({ colors: ['black', 'white'], sizes: ['M', '27~28'] });
  assert.doesNotThrow(() => assertRequiredUnchanged({ colors: ['흰색', '검정', 'black'], sizes: ['27-28', '미디움'] }, expected));
  assert.throws(() => assertRequiredUnchanged({ colors: ['black', 'white'], sizes: ['M', '28~29'] }, expected), { code: 'constraint_violation' });
});

test('existing twenty naturalness inputs retain expected hard category/price and remain searchable', async () => {
  const cases = JSON.parse(await readFile(new URL('../../eval/naturalnessCases.json', import.meta.url), 'utf8'));
  for (const c of cases) {
    const result = resolveUserConstraints({ message: c.query });
    assert.equal(result.clarification, null, c.id);
    if (c.must?.category) assert.equal(result.required.category, c.must.category, c.id);
    if (c.must?.maxPrice !== undefined) assert.equal(result.required.maxPrice, c.must.maxPrice, c.id);
  }
});
