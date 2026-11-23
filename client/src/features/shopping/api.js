/**
 * 역할: 메시지와 이전 responseId를 /api/chat에 전송하고 요청 취소·시간 초과·HTTP 오류를 처리한다.
 * 오류를 화면용 한국어 안내로 바꾸고 대화형 재질문으로 복구할 수 있는지 구분한다.
 */

const DEFAULT_TIMEOUT_MS = 110_000;

export class ChatApiError extends Error {
  /**
   * 사용자 안내에 필요한 오류 코드·HTTP 상태·재시도 대기 시간을 가진 채팅 API 오류를 생성한다.
   */
  constructor(message, { code = 'agent_failed', status = 0, retryAfterSeconds = null } = {}) {
    super(message);
    this.name = 'ChatApiError';
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * 응답 본문을 JSON으로 읽고, JSON이 아니면 빈 객체를 반환해 오류 처리 경로를 유지한다.
 */
async function responseBody(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

/**
 * 메시지와 이전 응답 ID를 /api/chat에 전송하고 성공한 JSON 응답을 반환한다.
 * HTTP 오류·네트워크 단절·취소·시간 초과를 ChatApiError로 구분하며 타이머와 이벤트 리스너를 정리한다.
 */
export async function postChat({
  message,
  previousResponseId = null,
  fetchImpl = fetch,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(/* 제한 시간이 지나면 현재 HTTP 요청을 시간 초과 사유로 취소한다. */ () => timeoutController.abort('timeout'), timeoutMs);
  /**
   * 화면 등 상위 호출자의 취소 신호를 내부 HTTP 요청으로 전달한다.
   */
  const abortFromParent = () => timeoutController.abort(signal.reason);
  signal?.addEventListener('abort', abortFromParent, { once: true });

  try {
    const response = await fetchImpl('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, previousResponseId }),
      signal: timeoutController.signal,
    });
    const body = await responseBody(response);
    if (!response.ok) {
      const retryAfterHeader = Number(response.headers?.get?.('Retry-After'));
      throw new ChatApiError(body.message || body.error || 'Agent request failed', {
        code: body.error,
        status: response.status,
        retryAfterSeconds:
          body.retryAfterSeconds ??
          (Number.isFinite(retryAfterHeader) ? retryAfterHeader : null),
      });
    }
    return body;
  } catch (error) {
    if (error instanceof ChatApiError) throw error;
    if (timeoutController.signal.aborted) {
      throw new ChatApiError('Agent request was aborted', {
        code: signal?.aborted ? 'request_cancelled' : 'agent_timeout',
      });
    }
    throw new ChatApiError('Agent request could not be completed', {
      code: 'network_error',
    });
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abortFromParent);
  }
}

/**
 * API 오류 코드와 재시도 대기 시간을 한국어 안내 문장으로 바꾸며, 사용자의 취소는 표시하지 않는다.
 */
export function chatErrorMessage(error) {
  if (error?.code === 'rate_limit_exceeded') {
    const wait = error.retryAfterSeconds;
    return wait
      ? `요청이 많아요. 약 ${wait}초 후 다시 시도해주세요.`
      : '요청이 많아요. 잠시 후 다시 시도해주세요.';
  }
  if (error?.code === 'invalid_conversation_state') {
    return '이전 검색이 만료됐어요. 새로 찾기를 눌러 다시 시작해주세요.';
  }
  if (error?.code === 'agent_timeout') {
    return '상품을 확인하는 데 예상보다 오래 걸렸어요. 잠시 후 다시 시도해주세요.';
  }
  if (error?.code === 'agent_unavailable') {
    return '현재 AI 검색을 사용할 수 없어요. 잠시 후 다시 시도해주세요.';
  }
  if (error?.code === 'request_cancelled') return null;
  return '검색 중 문제가 생겼어요. 잠시 후 다시 시도해주세요.';
}

/**
 * 응답 형식·Agent 검증 실패처럼 화면에서 재질문으로 이어 갈 오류인지 판별한다.
 */
export function isRecoverableChatError(error) {
  return ['agent_response_invalid', 'invalid_response'].includes(error?.code);
}
