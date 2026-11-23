/**
 * 역할: Express 앱에 JSON 본문 파싱, 상태 확인·채팅 API, 요청 제한과 입력 오류 처리를 등록한다.
 * 프런트엔드 빌드가 있으면 정적 파일과 React 진입 HTML도 제공한다.
 */

import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAT_CONFIG } from './config/chat.js';
import { createChatRateLimiters } from './middleware/chatRateLimit.js';
import { createChatRouter } from './routes/chat.js';
import healthRouter from './routes/health.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const clientBuildDirectory = path.resolve(currentDirectory, '../dist/client');
const clientEntry = path.join(clientBuildDirectory, 'index.html');

export function createApp({ chat = null, logger = console, rateLimitConfig } = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: CHAT_CONFIG.jsonBodyLimit }));
  app.use('/api/health', healthRouter);
  app.use(
    '/api/chat',
    createChatRouter({
      chat,
      logger,
      maxMessageLength: CHAT_CONFIG.maxMessageLength,
      rateLimiters: createChatRateLimiters(
        rateLimitConfig ?? {
          client: CHAT_CONFIG.clientRateLimit,
          service: CHAT_CONFIG.serviceRateLimit,
        },
      ),
    }),
  );

  app.use('/api', (_request, response) => {
    response.status(404).json({
      error: 'not_found'
    });
  });

  app.use((error, _request, response, next) => {
    if (error?.type === 'entity.too.large') {
      response.status(413).json({ error: 'request_too_large' });
      return;
    }
    if (error instanceof SyntaxError && error?.type === 'entity.parse.failed') {
      response.status(400).json({ error: 'invalid_json' });
      return;
    }
    next(error);
  });

  if (existsSync(clientEntry)) {
    app.use(express.static(clientBuildDirectory));
    app.get(/.*/, (_request, response) => {
      response.sendFile(clientEntry);
    });
  }

  return app;
}
