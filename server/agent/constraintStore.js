/**
 * 역할: responseId별 필수 검색 조건의 불변 스냅샷을 메모리에 저장하는 저장소를 제공한다.
 * 유효기간과 저장 개수 한도를 적용하고 기존 응답의 조건을 덮어쓰지 못하게 한다.
 */

import { ConstraintError, requiredSnapshot } from './requiredConstraints.js';

/**
 * 응답 ID별 조건 스냅샷을 보관하는 메모리 저장소를 만들고 만료 시간·개수 제한을 적용한다.
 * 읽기·저장 시 만료 항목을 정리하며 대화 원문은 저장하지 않는다.
 */
export function createConstraintStore({
  ttlMs = 30 * 60 * 1_000,
  maxEntries = 1_000,
  now = Date.now,
} = {}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 ||
      !Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new Error('Constraint store limits must be positive integers');
  }
  const entries = new Map();
  /**
   * 현재 시각에 만료되었거나 이미 만료된 항목을 저장소에서 제거한다.
   */
  function prune() {
    const time = now();
    for (const [id, entry] of entries) {
      if (entry.expiresAt <= time) entries.delete(id);
    }
  }
  return {
    /**
     * 만료 항목을 정리한 뒤 응답 ID의 스냅샷을 반환하고, 없으면 대화 상태 오류를 던진다.
     */
    get(responseId) {
      prune();
      const entry = entries.get(responseId);
      if (!entry) throw new ConstraintError('invalid_conversation_state');
      return entry.snapshot;
    },
    /**
     * 유효한 새 응답 ID에 조건을 정규화·동결해 저장하고, 중복 ID 덮어쓰기를 거부하며 용량 초과 시 오래된 항목을 제거한다.
     */
    set(responseId, required) {
      if (typeof responseId !== 'string' || !/^resp_[A-Za-z0-9_-]{1,200}$/u.test(responseId)) {
        throw new Error('Cannot store constraints without a valid response ID');
      }
      prune();
      const snapshot = requiredSnapshot(required);
      // Immutable ancestry: retries/branches cannot overwrite an earlier response.
      if (entries.has(responseId)) throw new Error('Duplicate response ID');
      while (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
      entries.set(responseId, { snapshot, expiresAt: now() + ttlMs });
    },
  };
}
