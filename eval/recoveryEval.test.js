/**
 * 역할: 같은 여섯 오류 주입 시나리오에서 자동 복구 활성화 전후의 완료율·안전성·추가 호출 집계를 검증한다.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { runRecoveryEval } from './recoveryEval.js';

test('compares the same six injected scenarios with correction disabled and enabled', async () => {
  const report = await runRecoveryEval();
  assert.equal(report.externalApiCalls, 0);
  assert.deepEqual(report.summary, [
    { recoveryEnabled: false, cases: 6, completed: 1, unsafeResults: 0, recoveryAttempts: 0, recovered: 0, modelCalls: 12, additionalModelCalls: 0 },
    { recoveryEnabled: true, cases: 6, completed: 4, unsafeResults: 0, recoveryAttempts: 5, recovered: 3, modelCalls: 18, additionalModelCalls: 6 },
  ]);
  assert.equal(report.rows.filter((r) => r.recoveryEnabled && r.recovery.outcome === 'failed').length, 2);
  assert.ok(report.rows.every((r) => r.modelCalls <= 4 && r.searchCalls <= 2));
});
