/**
 * 역할: 채팅 요청 본문과 메시지의 크기 제한, IP별·서비스 전체 요청 횟수와 집계 시간을 정의한다.
 */

export const CHAT_CONFIG = Object.freeze({
  jsonBodyLimit: '16kb',
  maxMessageLength: 1_000,
  clientRateLimit: Object.freeze({
    windowMs: 10 * 60 * 1_000,
    limit: 10,
  }),
  serviceRateLimit: Object.freeze({
    windowMs: 60 * 60 * 1_000,
    limit: 30,
  }),
});
