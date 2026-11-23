/**
 * 역할: 정상 채팅 입력의 정규화와 잘못된 메시지·응답 ID·추가 필드의 거부를 검증한다.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { validateChatRequest } from './chatRequest.js';

const options = { maxMessageLength: 10 };

test('normalizes a valid chat request without persisting extra state', () => {
  assert.deepEqual(
    validateChatRequest(
      { message: '  검정 바지  ', previousResponseId: 'resp_abc-123' },
      options,
    ),
    { message: '검정 바지', previousResponseId: 'resp_abc-123' },
  );
});

test('rejects invalid message, response ID, and unknown fields', () => {
  assert.throws(() => validateChatRequest({ message: ' ' }, options), /1-10/u);
  assert.throws(
    () => validateChatRequest({ message: '검정 바지', previousResponseId: 'bad' }, options),
    /previousResponseId/u,
  );
  assert.throws(
    () => validateChatRequest({ message: '검정 바지', userId: '1' }, options),
    /unsupported/u,
  );
});

test('validates selected filters without accepting model-authored constraints', () => {
  assert.deepEqual(validateChatRequest({
    message: '편한 옷', selectedFilters: { category: 'pants', maxPrice: 50_000, size: ' M ' },
  }, options), {
    message: '편한 옷', previousResponseId: null,
    selectedFilters: { category: 'pants', maxPrice: 50_000, size: 'M' },
  });
  for (const selectedFilters of [null, [], { maxPrice: '50000' }, { maxPrice: -1 },
    { category: 'unknown' }, { size: 'anything' }, { required: {} }, { colors: ['black'] }]) {
    assert.throws(() => validateChatRequest({ message: '바지', selectedFilters }, options), /selectedFilters/u);
  }
});
