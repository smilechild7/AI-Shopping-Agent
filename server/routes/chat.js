/**
 * 역할: POST /api/chat에서 입력과 요청 한도를 확인한 뒤 주입받은 Agent 채팅 함수를 호출한다.
 * 검증·인증·시간 초과 등 실패를 공개 API의 HTTP 상태와 오류 코드로 변환한다.
 */

import { Router } from 'express';
import { AgentRuntimeError } from '../agent/shoppingAgent.js';
import { validateChatRequest } from '../agent/chatRequest.js';

/**
 * Agent 검증·인증·이전 대화 상태·시간 초과 오류를 외부 HTTP 상태 코드로 분류한다.
 */
function upstreamStatus(error, hasPreviousResponseId) {
  if (error instanceof AgentRuntimeError) {
    return 502;
  }
  if (error?.status === 401 || error?.status === 403) {
    return 503;
  }
  if (error?.status === 400 && hasPreviousResponseId) {
    return 400;
  }
  if (error?.name === 'APIConnectionTimeoutError') {
    return 504;
  }
  return 502;
}

/**
 * 내부 오류와 HTTP 상태를 클라이언트가 이해할 공개 오류 코드로 바꾼다.
 */
function publicError(error, status) {
  if (error instanceof AgentRuntimeError) return 'agent_response_invalid';
  if (status === 400) return 'invalid_conversation_state';
  if (status === 503) return 'agent_unavailable';
  if (status === 504) return 'agent_timeout';
  return 'agent_failed';
}

/**
 * 채팅 함수와 요청 제한기를 주입받아 입력 검증·성공 응답·오류 변환을 수행하는 Express 라우터를 만든다.
 */
export function createChatRouter({
  chat,
  rateLimiters = [],
  maxMessageLength,
  logger = console,
}) {
  const router = Router();

  router.post('/', ...rateLimiters, /* POST 요청을 검증한 뒤 Agent를 실행하며, 실패하면 원문 대신 오류 메타데이터를 기록하고 공개 오류를 응답한다. */ async (request, response) => {
    let input;
    try {
      input = validateChatRequest(request.body, { maxMessageLength });
    } catch (error) {
      response.status(400).json({
        error: 'invalid_request',
        message: error.message,
      });
      return;
    }

    if (typeof chat !== 'function') {
      response.status(503).json({ error: 'agent_unavailable' });
      return;
    }

    try {
      response.status(200).json(await chat(input));
    } catch (error) {
      const status = upstreamStatus(error, input.previousResponseId !== null);
      logger.error(
        JSON.stringify({
          event: 'agent.failed',
          code: error.code ?? error.name ?? 'unknown',
          upstreamStatus: error.status ?? null,
          httpStatus: status,
        }),
      );
      response.status(status).json({ error: publicError(error, status) });
    }
  });

  return router;
}
