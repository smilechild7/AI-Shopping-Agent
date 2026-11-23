/**
 * 역할: 실시간 쇼핑 Agent와 오프라인 상품 가공에 사용하는 AI 모델·추론 수준·토큰·재시도·시간 제한을 정의한다.
 */

export const AI_CONFIG = Object.freeze({
  agent: Object.freeze({
    model: 'gpt-5.6-sol',
    reasoningEffort: 'low',
    maxToolRounds: 3,
    maxRecoveryAttempts: 1,
    maxModelCalls: 4,
    maxSearchCalls: 2,
    requestTimeoutMs: 90_000,
    maxOutputTokens: 4_000,
    maxRetries: 0,
    timeoutMs: 90_000,
  }),
  enrichment: Object.freeze({
    model: 'gpt-5.6-luna',
    reasoningEffort: 'none',
    maxOutputTokens: 1800,
    promptVersion: 'v2',
    maxRetries: 2,
    timeoutMs: 60_000,
  }),
});
