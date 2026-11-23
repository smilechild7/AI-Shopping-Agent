/**
 * 역할: Agent 실행 오류, 모델 출력 검증 오류와 실행 예산 초과를 구분하는 오류 클래스를 정의한다.
 * 모델의 수정 대상인 오류와 DB·프로그램 오류를 구별할 수 있도록 오류 코드와 원인을 담는다.
 */

export class AgentRuntimeError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'AgentRuntimeError';
    this.code = code;
  }
}

// Only explicit validation failures may be shown to the model for correction.
// Database exceptions and programming errors must retain their original type.
export class ModelValidationError extends AgentRuntimeError {
  constructor(reason, message) {
    super('factual_validation_failed', message);
    this.name = 'ModelValidationError';
    this.reason = reason;
  }
}

export class ExecutionBudgetError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ExecutionBudgetError';
    this.code = code;
  }
}
