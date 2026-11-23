/**
 * 역할: 실행에 필요한 서비스와 Express 앱을 연결하고 지정한 포트에서 HTTP 서버를 시작한다.
 * 서버 오류를 기록하고 종료 신호를 받으면 연결과 DB를 정리한다.
 */

import { createApp } from './app.js';
import { createRuntimeServices } from './runtime.js';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const runtime = createRuntimeServices();
const app = createApp({ chat: runtime.chat });

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`[server] listening port=${port}`);
});

server.on('error', (error) => {
  console.error(`[server] failed code=${error.code ?? 'unknown'}`);
  process.exitCode = 1;
});

function shutdown() {
  server.close(() => {
    runtime.close();
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
