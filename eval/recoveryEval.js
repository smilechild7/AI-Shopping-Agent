/**
 * 역할: 동일한 모의 오류 시나리오를 Agent 자동 복구를 끈 경우와 켠 경우에 각각 재생한다.
 * 완료 여부, 조건 위반, 복구 결과와 모델·검색 호출 수를 외부 API 호출 없이 비교한다.
 */

import { createShoppingAgent } from '../server/agent/shoppingAgent.js';
import { recoveryProduct, recoveryScenarios } from './recoveryScenarios.js';

export async function runRecoveryEval() {
  const rows = [];
  for (const maxRecoveryAttempts of [0, 1]) {
    for (const scenario of recoveryScenarios()) {
      const events = [];
      const responses = [...scenario.responses];
      const searched = [];
      const agent = createShoppingAgent({
        config: { maxRecoveryAttempts },
        client: { responses: { async create() {
          if (!responses.length) throw new Error('Unexpected model call in local replay');
          return responses.shift();
        } } },
        search(input) {
          searched.push(input.required.maxPrice);
          return { hardFilterMatchCount: 1, candidates: [structuredClone(recoveryProduct)] };
        },
        repository: { getProductsByIds: () => [structuredClone(recoveryProduct)] },
        logger: { log(value) { events.push(JSON.parse(value)); } },
      });
      let result;
      let error;
      try { result = await agent.chat({ message: scenario.message }); }
      catch (caught) { error = caught; }
      const terminal = events.at(-1);
      const unsafeResult = searched.some((price) => price !== 50_000) ||
        Boolean(result?.products?.some((p) => p.id !== recoveryProduct.id || p.price > 50_000));
      rows.push({
        id: scenario.id, recoveryEnabled: Boolean(maxRecoveryAttempts),
        completed: result?.type === scenario.expectedType,
        unsafeResult, failureCode: error?.code ?? null,
        initialOutcome: terminal.initialOutcome, recovery: terminal.recovery,
        modelCalls: terminal.modelCalls, searchCalls: terminal.searchCalls,
      });
    }
  }
  const summary = [false, true].map((enabled) => {
    const selected = rows.filter((r) => r.recoveryEnabled === enabled);
    return {
      recoveryEnabled: enabled, cases: selected.length,
      completed: selected.filter((r) => r.completed).length,
      unsafeResults: selected.filter((r) => r.unsafeResult).length,
      recoveryAttempts: selected.reduce((sum, r) => sum + r.recovery.attempts, 0),
      recovered: selected.filter((r) => r.recovery.outcome === 'succeeded' && r.completed).length,
      modelCalls: selected.reduce((sum, r) => sum + r.modelCalls, 0),
      additionalModelCalls: selected.reduce((sum, r) => sum + r.recovery.additionalModelCalls, 0),
    };
  });
  return { kind: 'deterministic-mock-replay', externalApiCalls: 0, summary, rows };
}
