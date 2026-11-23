/**
 * 역할: 한 요청의 공통 마감 시각과 모델·검색 호출 횟수를 관리하는 실행 예산을 제공한다.
 * 취소·시간 초과를 전파하고, 취소를 무시한 작업이 늦게 반환해도 결과를 거부한다.
 */

import { ExecutionBudgetError } from './errors.js';

export function createExecutionBudget({
  signal, timeoutMs, maxModelCalls, maxSearchCalls, now = () => performance.now(),
}) {
  for (const value of [timeoutMs, maxModelCalls, maxSearchCalls]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid execution budget');
  }
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  const controller = new AbortController();
  const abort = (code) => controller.abort(new ExecutionBudgetError(code));
  const cancel = () => abort('request_cancelled');
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => abort('request_timeout'), timeoutMs);
  let modelCalls = 0;
  let searchCalls = 0;

  function assertActive() {
    if (!controller.signal.aborted && now() >= deadline) abort('request_timeout');
    if (controller.signal.aborted) throw controller.signal.reason;
  }
  function reserveModelCalls(count = 1) {
    assertActive();
    if (modelCalls + count > maxModelCalls) throw new ExecutionBudgetError('model_call_budget_exceeded');
  }
  function reserveSearchCall() {
    assertActive();
    if (searchCalls >= maxSearchCalls) throw new ExecutionBudgetError('search_call_budget_exceeded');
  }
  // The race also handles adapters that ignore AbortSignal. Late results never commit.
  async function run(operation) {
    assertActive();
    let onAbort;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => { assertActive(); return operation(); }),
        new Promise((_, reject) => {
          onAbort = () => reject(controller.signal.reason);
          controller.signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
      assertActive();
      return result;
    } finally {
      controller.signal.removeEventListener('abort', onAbort);
    }
  }

  return {
    assertActive,
    reserveModelCalls,
    reserveSearchCall,
    get modelCalls() { return modelCalls; },
    get searchCalls() { return searchCalls; },
    get durationMs() { return Math.max(0, now() - startedAt); },
    async model(operation) {
      reserveModelCalls();
      modelCalls += 1;
      return run(() => operation({
        signal: controller.signal,
        timeout: Math.max(1, Math.ceil(deadline - now())),
        maxRetries: 0,
      }));
    },
    async search(operation) {
      reserveSearchCall();
      searchCalls += 1;
      return run(operation);
    },
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    },
  };
}
