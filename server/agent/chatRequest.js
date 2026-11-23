/**
 * 역할: 채팅 API 본문의 허용 필드, 메시지 길이와 previousResponseId 형식을 검증한다.
 * 검증을 통과한 메시지의 양끝 공백을 제거하고 대화 ID의 기본값을 정리한다.
 */

import { validateSelectedFilters } from './userConstraints.js';

export const RESPONSE_ID_PATTERN = /^resp_[A-Za-z0-9_-]{1,200}$/u;

export function validateChatRequest(value, { maxMessageLength }) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('request body must be an object');
  }

  const keys = Object.keys(value).sort();
  const allowedKeys = ['message', 'previousResponseId', 'selectedFilters'];
  if (keys.some((key) => !allowedKeys.includes(key))) {
    throw new Error('request body contains unsupported fields');
  }

  if (typeof value.message !== 'string') {
    throw new Error('message must be a string');
  }
  const message = value.message.trim();
  if (message.length === 0 || message.length > maxMessageLength) {
    throw new Error(`message must contain 1-${maxMessageLength} characters`);
  }

  const previousResponseId = value.previousResponseId ?? null;
  if (
    previousResponseId !== null &&
    (typeof previousResponseId !== 'string' ||
      !RESPONSE_ID_PATTERN.test(previousResponseId))
  ) {
    throw new Error('previousResponseId is invalid');
  }

  return {
    message,
    previousResponseId,
    ...('selectedFilters' in value
      ? { selectedFilters: validateSelectedFilters(value.selectedFilters) }
      : {}),
  };
}
