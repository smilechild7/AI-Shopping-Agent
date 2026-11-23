/**
 * 역할: 대화 메시지에서 이전 AI 응답과 직전 사용자 질문을 묶어 시간순 이력 항목으로 만든다.
 * 후속 검색 대기 중에는 최신 응답도 이전 대화 목록에 포함할 수 있다.
 */

export function previousAssistantResponses(messages, { includeLatest = false } = {}) {
  const assistantMessages = messages.filter((message) => message.role === 'assistant');
  const latestAssistantMessage = assistantMessages.at(-1);
  const entries = [];
  let latestUserMessage = null;

  messages.forEach((message, index) => {
    if (message.role === 'user') {
      latestUserMessage = message;
      return;
    }
    if (message.role !== 'assistant') return;
    if (!includeLatest && message === latestAssistantMessage) return;

    entries.push({
      key: message.data?.responseId ?? `assistant-${index}`,
      message,
      userMessage: latestUserMessage,
    });
  });

  return entries;
}
