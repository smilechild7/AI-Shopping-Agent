/**
 * 역할: 실제 SQLite 상품을 사용해 모델의 조건 변경 차단과 사용자의 명시적 가격 변경 허용을 검증한다.
 * 검색 후 상품 가격이 바뀐 경우 재검증과 유효한 대안 선택을 확인하는 통합 테스트다.
 */

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { openDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrationRunner.js';
import { createProductRepository } from '../products/productRepository.js';
import { searchProducts } from '../products/searchProducts.js';
import { createShoppingAgent } from './shoppingAgent.js';

const rawProduct = (price) => ({
  source: { shopId: 'fixture', shopName: 'Fixture', sourceProductId: String(price), productUrl: 'https://example.com/' + price },
  name: '검정 바지', brand: null, category: 'pants', price, originalPrice: null,
  imageUrl: 'https://example.com/image.jpg', colors: ['검정'], sizes: ['M'],
  sizeGuideText: null, material: null, description: null, rating: null,
  reviewCount: 0, crawledAt: '2026-11-11T00:00:00Z', reviews: [],
});
const conditions = (maxPrice) => ({
  category: 'pants', minPrice: null, maxPrice, colors: [], sizes: [],
});
const call = (id, maxPrice) => ({
  id, status: 'completed', output: [{
    type: 'function_call', name: 'search_products', call_id: 'call_' + id,
    arguments: JSON.stringify({ query: '바지', required: conditions(maxPrice) }),
  }],
});
const answer = (price, id) => ({
  id, status: 'completed', output: [], output_text: JSON.stringify({
    type: 'recommendation', message: '상품을 찾았어요.', suggestion: null,
    recommendations: [{
      productId: 'fixture:' + price, reason: '바지입니다.',
      evidence: [{ type: 'category', value: 'pants' }],
      strengths: ['실제 상품'], concerns: ['실측 확인 필요'],
    }], comparison: [],
  }),
});

test('real SQLite: blocks model drift but accepts the same 90k item after an explicit user edit', async () => {
  const database = openDatabase(':memory:');
  try {
    await runMigrations(database, fileURLToPath(new URL('../../db/migrations', import.meta.url)));
    const repository = createProductRepository(database);
    repository.saveProducts([rawProduct(40_000), rawProduct(90_000)]);
    const events = [];
    const logger = { log(value) { events.push(JSON.parse(value)); } };
    let responses = [call('resp_a', 50_000), call('resp_b', 100_000), answer(90_000, 'resp_bad')];
    let searchCount = 0;
    const agent = createShoppingAgent({
      config: { maxRecoveryAttempts: 0 },
      client: { responses: { async create() {
        assert.ok(responses.length);
        return responses.shift();
      } } },
      repository, logger,
      search(input) {
        searchCount += 1;
        return searchProducts(input, { repository, logger });
      },
    });
    await assert.rejects(agent.chat({ message: '5만원 이하 바지' }), { code: 'constraint_violation' });
    assert.equal(searchCount, 1);
    assert.equal(events.find((event) => event.event === 'search.complete').sqlMatches, 1);

    responses = [call('resp_c', 50_000), answer(40_000, 'resp_parent')];
    await agent.chat({ message: '5만원 이하 바지' });
    responses = [call('resp_d', 100_000), answer(90_000, 'resp_allowed')];
    const allowed = await agent.chat({
      message: '최대 가격을 10만원으로 올려줘', previousResponseId: 'resp_parent',
    });
    assert.equal(allowed.products[0].price, 90_000);
    assert.equal(allowed.criteria.required.maxPrice, 100_000);

    // A changed DB price is caught even if the search DTO and category evidence were valid.
    responses = [call('resp_e', 50_000), answer(40_000, 'resp_stale')];
    const staleAgent = createShoppingAgent({
      config: { maxRecoveryAttempts: 0 },
      client: { responses: { async create() { return responses.shift(); } } },
      repository, logger,
      search(input) {
        const result = searchProducts(input, { repository, logger });
        database.prepare('UPDATE products SET price = 90000 WHERE id = ?').run('fixture:40000');
        return result;
      },
    });
    await assert.rejects(staleAgent.chat({ message: '5만원 이하 바지' }), { code: 'required_product_mismatch' });
  } finally {
    database.close();
  }
});

test('real SQLite: regeneration selects a valid alternative after the first candidate price changed', async () => {
  const database = openDatabase(':memory:');
  try {
    await runMigrations(database, fileURLToPath(new URL('../../db/migrations', import.meta.url)));
    const repository = createProductRepository(database);
    repository.saveProducts([rawProduct(30_000), rawProduct(40_000)]);
    const events = [];
    let modelCalls = 0, searchCalls = 0;
    const agent = createShoppingAgent({
      client: { responses: { async create() {
        modelCalls += 1;
        if (modelCalls === 1) return call('resp_search', 50_000);
        if (modelCalls === 2) {
          database.prepare('UPDATE products SET price = 90000 WHERE id = ?').run('fixture:40000');
          return answer(40_000, 'resp_bad');
        }
        assert.equal(modelCalls, 3);
        return answer(30_000, 'resp_fixed');
      } } },
      repository, logger: { log(value) { events.push(JSON.parse(value)); } },
      search(input) { searchCalls += 1; return searchProducts(input, { repository, logger: { log() {} } }); },
    });
    const result = await agent.chat({ message: '5만원 이하 바지' });
    assert.equal(result.products[0].price, 30_000);
    assert.equal(result.criteria.required.maxPrice, 50_000);
    assert.equal(searchCalls, 1);
    assert.equal(events.at(-1).recovery.trigger, 'required_product_mismatch');
    assert.equal(events.at(-1).recovery.outcome, 'succeeded');
  } finally {
    database.close();
  }
});
