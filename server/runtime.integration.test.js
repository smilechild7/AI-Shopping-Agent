/**
 * 역할: 화면의 선택 필터 → HTTP → 실제 런타임 → SQLite 검색 → 복구·후속 조건 보존을 검증한다.
 * OpenAI 클라이언트만 모의 객체로 주입하며 외부 API를 호출하지 않는다.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { postChat } from '../client/src/features/shopping/api.js';
import { buildChatMessage, buildSelectedFilters } from '../client/src/features/shopping/query.js';
import { recoveryFinal, recoveryTool } from '../eval/recoveryScenarios.js';
import { createApp } from './app.js';
import { openDatabase } from './db/connection.js';
import { runMigrations } from './db/migrationRunner.js';
import { createProductRepository } from './products/productRepository.js';
import { createRuntimeServices } from './runtime.js';

test('connects UI filters, HTTP, runtime, SQLite, recovery and a later explicit edit', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'levit-runtime-'));
  const databasePath = path.join(directory, 'products.db');
  let services;
  let server;
  try {
    const database = openDatabase(databasePath);
    try {
      await runMigrations(database, fileURLToPath(new URL('../db/migrations', import.meta.url)));
      createProductRepository(database).saveProducts([{
        source: { shopId: 'fixture', shopName: 'Fixture', sourceProductId: '40000', productUrl: 'https://example.com/pants' },
        name: '검정 바지', brand: null, category: 'pants', price: 40_000, originalPrice: null,
        imageUrl: 'https://example.com/pants.jpg', colors: ['검정'], sizes: ['M'],
        sizeGuideText: null, material: null, description: null, rating: null,
        reviewCount: 0, crawledAt: '2026-11-23T00:00:00Z', reviews: [],
      }]);
    } finally { database.close(); }

    const required = { category: 'pants', minPrice: null, maxPrice: 50_000, colors: [], sizes: ['m'] };
    const events = [];
    let calls = 0;
    services = createRuntimeServices({
      databasePath,
      logger: { log(value) { events.push(JSON.parse(value)); } },
      client: { responses: { async create(request, transport) {
        calls += 1;
        assert.equal(transport.maxRetries, 0);
        if (calls === 1) {
          assert.ok(request.instructions.includes(JSON.stringify(required)));
          return recoveryTool('resp_drift', { ...required, maxPrice: 100_000 });
        }
        if (calls === 2) {
          assert.deepEqual(JSON.parse(request.input[0].output).required, required);
          return recoveryTool('resp_search', required);
        }
        if (calls === 4) {
          assert.equal(request.previous_response_id, 'resp_valid');
          return recoveryTool('resp_followup_search', { ...required, maxPrice: 100_000 });
        }
        assert.ok(calls === 3 || calls === 5);
        const result = JSON.parse(request.input[0].output);
        assert.equal(result.candidates[0].price, 40_000);
        return recoveryFinal(calls === 3 ? 'resp_valid' : 'resp_followup', { productId: result.candidates[0].id });
      } } },
    });
    server = createApp({ chat: services.chat, logger: { error() {} } }).listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const baseUrl = 'http://127.0.0.1:' + server.address().port;
    const fetchImpl = (url, options) => fetch(baseUrl + url, options);
    const form = { query: '10만원 이하 원피스', category: 'pants', maxPrice: 50_000, size: ' M ' };
    const first = await postChat({
      message: buildChatMessage(form), selectedFilters: buildSelectedFilters(form), fetchImpl,
    });
    assert.deepEqual(first.criteria.required, required);
    assert.equal(first.products[0].price, 40_000);
    assert.equal(events.filter((event) => event.event === 'search.complete').length, 1);
    assert.equal(events.at(-1).recovery.outcome, 'succeeded');

    const next = await postChat({
      message: '최대 가격을 10만원으로 변경', previousResponseId: first.responseId, fetchImpl,
    });
    assert.deepEqual(next.criteria.required, { ...required, maxPrice: 100_000 });
    await assert.rejects(postChat({
      message: '다시 찾아줘', previousResponseId: 'resp_unknown', fetchImpl,
    }), { code: 'invalid_conversation_state', status: 400 });
    assert.equal(calls, 5);
    assert.equal(events.some((event) => JSON.stringify(event).includes(form.query)), false);
  } finally {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    services?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
