/**
 * 역할: 읽기 전용 SQLite DB, 상품 저장소, 검색 함수와 OpenAI 클라이언트를 조립해 Agent 실행 서비스를 만든다.
 * 채팅 함수와 DB 종료 함수를 제공하며 API 키가 없을 때는 채팅 서비스를 비활성화한다.
 */

import OpenAI from 'openai';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createShoppingAgent } from './agent/shoppingAgent.js';
import { AI_CONFIG } from './config/ai.js';
import { openDatabase } from './db/connection.js';
import { createProductRepository } from './products/productRepository.js';
import { searchProducts } from './products/searchProducts.js';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

/**
 * 읽기 전용 상품 DB와 저장소·검색 함수·OpenAI 클라이언트를 조립해 실행 서비스를 만든다.
 * chat과 close를 반환하며, API 키가 없으면 DB 종료 기능을 유지한 채 chat을 null로 둔다.
 */
export function createRuntimeServices({
  apiKey = process.env.OPENAI_API_KEY,
  databasePath = path.join(repositoryRoot, 'data/products.db'),
  logger = console,
} = {}) {
  const database = openDatabase(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  const repository = createProductRepository(database);

  if (!apiKey) {
    logger.warn(JSON.stringify({ event: 'agent.unavailable', reason: 'missing_api_key' }));
    return {
      chat: null,
      /**
       * API 키가 없어 Agent를 만들지 않은 경우에도 이미 열린 DB 연결을 닫는다.
       */
      close: () => database.close(),
    };
  }

  const client = new OpenAI({
    apiKey,
    maxRetries: AI_CONFIG.agent.maxRetries,
    timeout: AI_CONFIG.agent.timeoutMs,
  });
  const agent = createShoppingAgent({
    client,
    repository,
    /**
     * Agent가 요청한 검색 인자에 현재 상품 저장소와 로거를 연결해 실제 검색을 실행한다.
     */
    search: (input) => searchProducts(input, { repository, logger }),
    logger,
  });

  return {
    /**
     * HTTP 계층이 전달한 입력을 구성된 Agent의 chat 메서드로 넘긴다.
     */
    chat: (input) => agent.chat(input),
    /**
     * 정상 구성된 런타임을 종료할 때 상품 DB 연결을 닫는다.
     */
    close: () => database.close(),
  };
}
