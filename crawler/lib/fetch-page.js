/**
 * 역할: 크롤러의 HTTP 요청에 식별 헤더, 시간 초과와 재시도 간격을 적용해 응답 본문을 읽는다.
 * 상품·리뷰 수집 사이의 요청 간격에 사용하는 대기 함수도 제공한다.
 */

const DEFAULT_USER_AGENT =
  'LevitProblemSolverCrawler/0.1 (+https://levit-problem-solver.onrender.com; educational MVP)';

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function fetchPage(
  url,
  {
    timeoutMs = 15_000,
    retries = 2,
    retryDelayMs = 500,
    userAgent = DEFAULT_USER_AGENT,
    accept = 'text/html,application/xhtml+xml',
  } = {},
) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept,
          'user-agent': userAgent,
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }

      return await response.text();
    } catch (error) {
      lastError = error;

      if (attempt < retries) {
        await wait(retryDelayMs * (attempt + 1));
      }
    }
  }

  throw new Error(`Failed to fetch ${url}: ${lastError?.message ?? 'unknown error'}`);
}

export { wait };
