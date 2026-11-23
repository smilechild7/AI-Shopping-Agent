/**
 * 역할: 조건 저장소의 만료·용량 제한, 대화 분기별 격리와 기존 스냅샷의 변경 방지를 검증한다.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createConstraintStore } from './constraintStore.js';

test('expires snapshots at TTL and does not resurrect them after a restart', () => {
  let time = 0;
  const store = createConstraintStore({ ttlMs: 100, now: () => time });
  store.set('resp_a', { maxPrice: 50_000 });
  time = 99;
  assert.equal(store.get('resp_a').maxPrice, 50_000);
  time = 100;
  assert.throws(() => store.get('resp_a'), { code: 'invalid_conversation_state' });
  assert.throws(() => createConstraintStore().get('resp_a'), { code: 'invalid_conversation_state' });
});

test('bounds storage, isolates branches and prevents mutation of ancestry', () => {
  const store = createConstraintStore({ maxEntries: 3 });
  const input = { maxPrice: 50_000, colors: ['black'] };
  store.set('resp_parent', input);
  input.colors.push('white');
  store.set('resp_left', { ...store.get('resp_parent'), maxPrice: 100_000 });
  store.set('resp_right', { ...store.get('resp_parent'), colors: [] });
  assert.equal(store.get('resp_parent').maxPrice, 50_000);
  assert.deepEqual(store.get('resp_parent').colors, ['black']);
  assert.equal(store.get('resp_left').maxPrice, 100_000);
  assert.equal(store.get('resp_right').maxPrice, 50_000);
  assert.throws(() => { store.get('resp_parent').colors.push('white'); }, TypeError);
  assert.throws(() => store.set('resp_parent', {}), /Duplicate/u);
  store.set('resp_last', {});
  assert.throws(() => store.get('resp_parent'), { code: 'invalid_conversation_state' });
  assert.equal(store.get('resp_left').maxPrice, 100_000);
});
