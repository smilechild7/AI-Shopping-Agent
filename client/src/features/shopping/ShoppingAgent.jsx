/**
 * 역할: 검색 제출부터 API 호출, 응답 분기, 오류 복구와 대화 초기화까지 쇼핑 화면의 전체 흐름을 연결한다.
 * 현재 세션의 대화 목록과 이전 응답 펼치기를 관리하고 후속 요청용 responseId를 보관한다.
 */

import { useEffect, useReducer, useRef, useState } from 'react';

import LoadingState from '../../components/LoadingState.jsx';
import {
  ChatApiError,
  chatErrorMessage,
  isRecoverableChatError,
  postChat,
} from './api.js';
import ClarificationMessage from './ClarificationMessage.jsx';
import { previousAssistantResponses } from './history.js';
import NoResultMessage from './NoResultMessage.jsx';
import { formatProductDisplayName } from './productName.js';
import RecommendationResult from './RecommendationResult.jsx';
import { recoveryQuestion } from './recovery.js';
import { createInitialShoppingState, shoppingReducer } from './reducer.js';
import SearchInput from './SearchInput.jsx';

const RESPONSE_STORAGE_KEY = 'shopping-agent-previous-response-id';

/**
 * sessionStorage에서 이전 응답 ID를 읽고, 저장소에 접근할 수 없으면 새 대화를 뜻하는 null을 반환한다.
 */
function storedResponseId() {
  try {
    return window.sessionStorage.getItem(RESPONSE_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * 후속 대화용 응답 ID를 저장하거나 지우며, 브라우저 저장소 오류가 화면 사용을 중단시키지 않도록 처리한다.
 */
function storeResponseId(responseId) {
  try {
    if (responseId) window.sessionStorage.setItem(RESPONSE_STORAGE_KEY, responseId);
    else window.sessionStorage.removeItem(RESPONSE_STORAGE_KEY);
  } catch {
    // The app still works when browser storage is unavailable.
  }
}

/**
 * 서버 응답 유형을 reducer 이벤트로 바꾸고 지원하지 않는 유형은 null로 반환한다.
 */
function responseAction(type) {
  if (type === 'clarification') return 'RECEIVE_CLARIFICATION';
  if (type === 'recommendation') return 'RECEIVE_RECOMMENDATION';
  if (type === 'no_result') return 'RECEIVE_NO_RESULT';
  return null;
}

/**
 * 메시지 종류에 따라 추천 결과·추가 질문·결과 없음 컴포넌트를 선택해 렌더링한다.
 */
function AssistantResult({ message }) {
  if (!message) return null;
  if (message.kind === 'recommendation') return <RecommendationResult result={message.data} />;
  if (message.kind === 'clarification') return <ClarificationMessage message={message.data.message} />;
  return <NoResultMessage message={message.data.message} suggestion={message.data.suggestion} />;
}

/**
 * 이전 대화 접기 버튼에 사용할 짧은 이름을 만들고, 추천이면 첫 상품명과 개수를 포함한다.
 */
function previousResponseLabel(message) {
  if (message.kind === 'recommendation') {
    const products = message.data.products ?? [];
    const firstName = formatProductDisplayName(products[0]?.name);
    return firstName
      ? `이전 추천 ${products.length}개 · ${firstName}${products.length > 1 ? ` 외 ${products.length - 1}개` : ''}`
      : '이전 추천 결과';
  }
  if (message.kind === 'clarification') return '이전 추가 질문';
  if (message.kind === 'no_result') return '이전 검색 결과 없음';
  return '이전 AI 답변';
}

/**
 * 사용자의 입력 문장이 있을 때 우측 대화 말풍선을 표시하고, 없으면 렌더링하지 않는다.
 */
function UserMessage({ content }) {
  if (!content) return null;

  return (
    <section className="mb-6 flex justify-end" aria-label="내 메시지">
      <div className="max-w-[88%] sm:max-w-2xl">
        <p className="mb-2 text-right text-xs font-semibold text-stone-500">나</p>
        <p className="rounded-2xl rounded-tr-sm border border-stone-200 bg-white px-4 py-3 text-sm font-medium leading-6 text-stone-900 shadow-sm sm:px-5">
          {content}
        </p>
      </div>
    </section>
  );
}

/**
 * 이전 사용자 질문과 AI 응답을 펼치거나 접는 영역을 만들며 접기 애니메이션과 접근성 연결 ID를 관리한다.
 */
function PreviousResponseSummary({
  animate = false,
  expanded,
  historyKey,
  message,
  onToggle,
  userMessage,
}) {
  const contentId = `previous-response-${historyKey}`;
  const folding = animate && !expanded;

  return (
    <section
      className={folding ? 'previous-response-collapsing' : ''}
      aria-label={expanded ? '펼친 이전 대화' : '접힌 이전 대화'}
    >
      {folding && (
        <div className="previous-response-content">
          <div>
            <AssistantResult message={message} />
          </div>
        </div>
      )}
      <button
        aria-controls={contentId}
        aria-expanded={expanded}
        className={`flex w-full items-center gap-3 rounded-2xl text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 focus-visible:ring-offset-2 ${folding ? 'previous-response-summary-enter' : ''}`}
        onClick={onToggle}
        type="button"
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-stone-300 text-[0.65rem] font-bold text-stone-700" aria-hidden="true">AI</span>
        <span className="flex min-w-0 max-w-2xl flex-1 items-center gap-3 rounded-2xl rounded-tl-sm border border-stone-200 bg-white/80 px-4 py-2.5 text-sm text-stone-500 shadow-sm transition hover:border-orange-300 hover:text-stone-700">
          <span className="block truncate">{previousResponseLabel(message)}</span>
          <span className="ml-auto shrink-0 text-xs" aria-hidden="true">{expanded ? '↑' : '↓'}</span>
        </span>
      </button>
      {expanded && (
        <div className="detail-reveal mt-4" id={contentId}>
          <UserMessage content={userMessage?.content} />
          <AssistantResult message={message} />
        </div>
      )}
    </section>
  );
}

/**
 * 쇼핑 대화의 상태·요청 취소·이전 응답 펼치기와 각 응답 화면을 관리하는 최상위 기능 컴포넌트다.
 * 검색창에서 받은 입력을 API에 보내고 후속 대화 ID를 이어 주며, 응답·복구·실패에 따라 reducer를 갱신한다.
 */
export default function ShoppingAgent() {
  const [state, dispatch] = useReducer(
    shoppingReducer,
    null,
    /**
     * 컴포넌트 초기화 시 저장된 응답 ID를 읽어 초기 대화 상태를 한 번 만든다.
     */
    () => createInitialShoppingState(storedResponseId()),
  );
  const [expandedPreviousKey, setExpandedPreviousKey] = useState(null);
  const activeRequest = useRef(null);
  const lastUserMessage = [...state.messages].reverse().find(/* 대화 목록을 뒤에서부터 확인해 가장 최근 사용자 메시지를 고른다. */ (message) => message.role === 'user');
  const assistantMessages = state.messages.filter(/* 전체 메시지에서 AI 응답만 남겨 최신 결과와 이전 이력을 계산한다. */ (message) => message.role === 'assistant');
  const lastAssistantMessage = assistantMessages.at(-1);
  const isRefinementLoading = state.status === 'loading' && Boolean(lastAssistantMessage);
  const isRefinementError = state.status === 'error' && Boolean(lastAssistantMessage);
  const previousAssistantEntries = previousAssistantResponses(state.messages, {
    includeLatest: isRefinementLoading,
  });
  const hasConversation = state.messages.length > 0;

  useEffect(/* 컴포넌트가 사라질 때 실행할 요청 취소 함수를 effect의 정리 함수로 등록한다. */ () => /* 화면을 벗어나면 아직 진행 중인 채팅 요청을 취소한다. */ () => activeRequest.current?.abort(), []);

  /**
   * 화면용 사용자 문장을 이력에 추가하고 서버용 문장과 이전 응답 ID를 API로 보낸다.
   * 성공 응답이나 복구용 재질문을 반영하면 true, 요청 실패면 false를 반환하고 현재 요청 참조를 정리한다.
   */
  async function submit({ requestMessage, displayMessage }) {
    const controller = new AbortController();
    activeRequest.current = controller;
    dispatch({ type: 'SEND_MESSAGE', payload: { displayMessage } });

    try {
      const result = await postChat({
        message: requestMessage,
        previousResponseId: state.previousResponseId,
        signal: controller.signal,
      });
      const action = responseAction(result.type);
      if (!action) {
        throw new ChatApiError('Unexpected Agent response', { code: 'invalid_response' });
      }
      storeResponseId(result.responseId);
      dispatch({ type: action, payload: result });
      return true;
    } catch (error) {
      if (isRecoverableChatError(error)) {
        dispatch({
          type: 'RECEIVE_RECOVERY_CLARIFICATION',
          payload: { message: recoveryQuestion(lastAssistantMessage) },
        });
        return true;
      }
      const message = chatErrorMessage(error);
      if (error?.code === 'invalid_conversation_state') storeResponseId(null);
      if (message) dispatch({ type: 'REQUEST_FAILED', payload: message });
      return false;
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
    }
  }

  /**
   * 진행 중 요청을 취소하고 펼친 이력·저장된 응답 ID·대화 상태를 초기화한 뒤 화면 상단으로 이동한다.
   */
  function reset() {
    activeRequest.current?.abort();
    activeRequest.current = null;
    setExpandedPreviousKey(null);
    storeResponseId(null);
    dispatch({ type: 'RESET_CONVERSATION' });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  return (
    <main className="flex min-h-screen flex-col overflow-hidden bg-stone-50 bg-[radial-gradient(circle_at_top_left,_rgba(251,146,60,0.16)_0,_transparent_38rem),radial-gradient(circle_at_top_right,_rgba(168,162,158,0.24)_0,_transparent_34rem)] text-stone-950">

      <header className="relative mx-auto flex w-full max-w-7xl items-center justify-between px-5 py-6 sm:px-8">
        <button className="flex items-center gap-3 rounded-xl text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 focus-visible:ring-offset-2" onClick={reset} type="button" aria-label="새 검색 시작">
          <span className="grid size-10 place-items-center rounded-full bg-orange-600 text-sm font-bold text-white">AI</span>
          <span className="font-semibold tracking-tight">Shopping Decision Agent</span>
        </button>
        {hasConversation && (
          <button
            className="rounded-full border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-stone-700 transition hover:border-orange-400 hover:text-orange-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 focus-visible:ring-offset-2"
            onClick={reset}
            type="button"
          >
            새로 찾기
          </button>
        )}
      </header>

      {!hasConversation ? (
        <section className="relative mx-auto w-full max-w-5xl px-5 pb-28 pt-16 text-center sm:px-8 lg:pt-28">
          <div className="mx-auto max-w-4xl">
            <p className="mb-5 text-sm font-semibold uppercase tracking-[0.22em] text-orange-700">Search less. Decide better.</p>
            <h1 className="text-4xl font-bold leading-[1.12] tracking-[-0.045em] sm:text-6xl">어떤 옷을 찾고 계세요?</h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-stone-600">찾고 싶은 옷을 문장으로 알려주세요. 입력을 시작하면 필요한 조건을 더 선택할 수 있어요.</p>
            {state.previousResponseId && (
              <div className="mt-5 inline-flex items-center gap-2 rounded-full bg-orange-100 px-3 py-1.5 text-xs font-semibold text-orange-900">
                <span className="size-2 rounded-full bg-orange-600" /> 이전 검색 맥락을 이어서 찾을 수 있어요
              </div>
            )}
            <SearchInput disabled={state.status === 'loading'} onSubmit={submit} />
          </div>
        </section>
      ) : (
        <div className="relative mx-auto w-full max-w-7xl px-5 pb-24 pt-8 sm:px-8">
          {previousAssistantEntries.length > 0 && (
            <div className="mb-6 space-y-3" aria-label="이전 대화 목록">
              {previousAssistantEntries.map(/* 이전 대화 항목마다 접기 애니메이션 여부와 펼침 상태를 계산해 요약 컴포넌트를 만든다. */ ({ key, message, userMessage }) => {
                const animate = isRefinementLoading && message === lastAssistantMessage;
                const expanded = expandedPreviousKey === key;

                return (
                  <PreviousResponseSummary
                    animate={animate}
                    expanded={expanded}
                    historyKey={key}
                    key={key}
                    message={message}
                    onToggle={/* 선택한 이전 대화의 펼침 상태를 전환하는 상태 갱신을 요청한다. */ () => setExpandedPreviousKey(/* 같은 항목을 다시 누르면 닫고, 다른 항목을 누르면 해당 항목만 펼친다. */ (current) => current === key ? null : key)}
                    userMessage={userMessage}
                  />
                );
              })}
            </div>
          )}
          {isRefinementError && (
            <div className="mb-6">
              <AssistantResult message={lastAssistantMessage} />
            </div>
          )}

          <UserMessage content={lastUserMessage?.content} />

          {state.status === 'loading' && <div className="mb-6"><LoadingState /></div>}
          {state.error && (
            <div className="mb-6 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800" role="alert">{state.error}</div>
          )}
          {state.status === 'ready' && <AssistantResult message={lastAssistantMessage} />}

          {state.status === 'ready' && (
            <section className="mx-auto mt-8 max-w-2xl text-center" aria-label="검색 조건 다듬기">
              <div className="mb-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">조건 다듬기</p>
                <h2 className="mt-1 font-bold text-stone-950">원하는 방향을 이어서 말씀해주세요</h2>
              </div>
              <SearchInput compact onSubmit={submit} />
            </section>
          )}
        </div>
      )}

      <footer className="mt-auto border-t border-stone-200 bg-white/70 px-5 py-6 text-center text-xs leading-5 text-stone-500">
        추천은 저장된 상품 정보와 일부 구매후기를 바탕으로 합니다. 구매 전 판매 페이지의 최신 가격·옵션을 확인해주세요.
      </footer>
    </main>
  );
}
