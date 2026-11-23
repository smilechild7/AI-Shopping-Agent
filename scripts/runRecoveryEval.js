/**
 * 역할: 외부 API 없이 모의 시나리오로 복구 평가를 실행하고 JSON 보고서를 출력하는 CLI다.
 * 평가에서 필수 조건을 위반한 결과가 발견되면 실패 종료 코드를 설정한다.
 */

import { runRecoveryEval } from '../eval/recoveryEval.js';

const report = await runRecoveryEval();
console.log(JSON.stringify(report, null, 2));
if (report.rows.some((row) => row.unsafeResult)) process.exitCode = 1;
