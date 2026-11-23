/**
 * 역할: 잘못된 검색 인자·추천 결과를 수정하는 Agent 복구 흐름과 필수 조건 보존을 검증한다.
 * 재시도·시간·호출 예산, 취소, 늦은 응답 폐기와 동시 요청의 상태 격리를 확인한다.
 */

import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import OpenAI from 'openai';
import { createShoppingAgent } from './shoppingAgent.js';
import { createConstraintStore } from './constraintStore.js';
import { recoveryFinal as final, recoveryTool as tool, recoveryRequired as required, recoveryProduct as product } from '../../eval/recoveryScenarios.js';

function harness(turns, options = {}) {
  const requests = [], searches = [], events = [];
  const store = createConstraintStore();
  const agent = createShoppingAgent({
    config: options.config, now: options.now, constraintStore: store,
    client: options.client ?? { responses: { async create(input, transport) {
      requests.push({ input, transport });
      assert.ok(turns.length, 'unexpected extra model call');
      const turn = turns.shift();
      return typeof turn === 'function' ? turn(input, transport) : turn;
    } } },
    search(input) {
      searches.push(input);
      return options.search ? options.search(input) : { hardFilterMatchCount: 1, candidates: [structuredClone(product)] };
    },
    repository: { getProductsByIds: options.getProducts ?? (() => [structuredClone(product)]) },
    logger: { log(value) { events.push(JSON.parse(value)); } },
  });
  return { agent, store, requests, searches, events, terminal: () => events.at(-1) };
}
const message = '5만원 이하 바지';
const badId = () => final('resp_bad', { productId: 'fixture:invented' });

for (const [name, bad] of [
  ['product ID', badId()],
  ['evidence', final('resp_bad', { evidence: [{ type: 'style', value: 'feminine' }] })],
  ['invalid JSON', { ...final('resp_bad'), output_text: '{invalid' }],
  ['output schema', final('resp_bad', { evidence: [{ type: 'style', value: 'invented_enum' }] })],
]) {
  test('corrects ' + name + ' once, revalidates, and only commits the valid response', async () => {
    const h = harness([tool('resp_search'), bad, final('resp_fixed')]);
    const result = await h.agent.chat({ message });
    assert.equal(result.products[0].price, 40_000);
    assert.equal(h.requests.length, 3);
    assert.equal(h.searches.length, 1);
    assert.equal(h.requests[2].input.previous_response_id, 'resp_bad');
    assert.equal(h.requests[2].input.tool_choice, 'none');
    assert.deepEqual(h.requests.map((r) => r.transport.maxRetries), [0, 0, 0]);
    for (const request of h.requests) assert.ok(request.input.instructions.includes(JSON.stringify(required())));
    assert.throws(() => h.store.get('resp_bad'), { code: 'invalid_conversation_state' });
    assert.equal(h.store.get('resp_fixed').maxPrice, 50_000);
    const event = h.terminal();
    assert.equal(event.initialOutcome, 'validation_rejected');
    assert.equal(event.finalOutcome, 'validated');
    assert.equal(event.recovery.attempts, 1);
    assert.equal(event.recovery.outcome, 'succeeded');
    assert.equal(event.recovery.additionalModelCalls, 1);
    assert.equal(event.usageBeforeRecovery.totalTokens, 240);
    assert.equal(event.usageRecovery.totalTokens, 120);
    assert.equal(event.usage.totalTokens, 360);
    assert.equal(event.usageComplete, true);
  });
}

test('corrects a drifted re-search, keeping the snapshot and final call within four calls', async () => {
  const h = harness([tool('resp_a'), tool('resp_bad', required(100_000)), tool('resp_fixed'), final('resp_final')]);
  const result = await h.agent.chat({ message });
  assert.equal(result.criteria.required.maxPrice, 50_000);
  assert.deepEqual(h.searches.map((s) => s.required.maxPrice), [50_000, 50_000]);
  assert.equal(h.searches[0].required, h.searches[1].required);
  assert.ok(Object.isFrozen(h.searches[1].required));
  const correction = h.requests[2].input;
  assert.deepEqual(correction.tool_choice, { type: 'function', name: 'search_products' });
  assert.equal(correction.input[0].call_id, 'call_resp_bad');
  assert.deepEqual(JSON.parse(correction.input[0].output).required, required());
  assert.equal(h.requests[3].input.tool_choice, 'none');
  assert.equal(h.terminal().modelCalls, 4);
  assert.equal(h.terminal().recovery.additionalModelCalls, 2);
});

test('corrects first-search color/size omission without executing the rejected search', async () => {
  const strict = { ...required(), colors: ['black'], sizes: ['m'] };
  const h = harness([tool('resp_bad'), tool('resp_fixed', strict), final('resp_ok')]);
  await h.agent.chat({ message: '5만원 이하 검정만 M 사이즈만 바지' });
  assert.equal(h.searches.length, 1);
  assert.deepEqual(h.searches[0].required, strict);
});

test('corrects malformed tool arguments once and performs the same search validation', async () => {
  const malformed = tool('resp_bad');
  malformed.output[0].arguments = '{broken';
  const h = harness([malformed, tool('resp_fixed'), final('resp_ok')]);
  await h.agent.chat({ message });
  assert.equal(h.searches.length, 1);
  assert.equal(h.terminal().recovery.trigger, 'invalid_tool_arguments');
});

test('requires a current-request search even when correcting an answer that skipped it', async () => {
  const h = harness([final('resp_bad'), tool('resp_fixed'), final('resp_ok')]);
  await h.agent.chat({ message });
  assert.equal(h.searches.length, 1);
  assert.equal(h.terminal().recovery.trigger, 'search_required');
});

for (const [name, turns, errorCode, searchCount] of [
  ['repeated product hallucination', [tool('resp_a'), badId(), badId()], 'factual_validation_failed', 1],
  ['repeated constraint violation', [tool('resp_bad', required(100_000)), tool('resp_bad_again', required(100_000))], 'constraint_violation', 0],
  ['unexpected re-search during final correction', [tool('resp_a'), badId(), tool('resp_bad_again')], 'invalid_output', 1],
]) {
  test('safely terminates ' + name + ' without a second correction', async () => {
    const h = harness(turns);
    await assert.rejects(h.agent.chat({ message }), { code: errorCode });
    assert.equal(h.searches.length, searchCount);
    assert.equal(h.terminal().recovery.attempts, 1);
    assert.equal(h.terminal().recovery.outcome, 'failed');
    assert.equal(h.terminal().finalOutcome, 'failed');
    assert.throws(() => h.store.get('resp_bad'), { code: 'invalid_conversation_state' });
  });
}

for (const fields of [{ price: 90_000 }, { category: 'dress' }, { colors: [] }, { sizes: [] }]) {
  test('checks fresh DB fields again after regeneration: ' + JSON.stringify(fields), async () => {
    const strict = { ...required(), colors: ['black'], sizes: ['m'] };
    const h = harness([tool('resp_a', strict), badId(), final('resp_fixed')], {
      getProducts: () => [{ ...product, ...fields }],
    });
    await assert.rejects(h.agent.chat({ message: '5만원 이하 검정만 M 사이즈만 바지' }), { code: 'required_product_mismatch' });
    assert.equal(h.requests.length, 3);
    assert.throws(() => h.store.get('resp_fixed'), { code: 'invalid_conversation_state' });
  });
}

test('preserves follow-up edits and independent branches after a successful correction', async () => {
  const turns = [tool('resp_a'), badId(), final('resp_fixed')];
  const h = harness(turns);
  await h.agent.chat({ message });
  turns.push(tool('resp_b', required(100_000)), final('resp_branch'));
  const changed = await h.agent.chat({ message: '최대 가격을 10만원으로 변경', previousResponseId: 'resp_fixed' });
  assert.equal(changed.criteria.required.maxPrice, 100_000);
  turns.push(tool('resp_c'), final('resp_sibling'));
  const unchanged = await h.agent.chat({ message: '후기가 좋은 걸로', previousResponseId: 'resp_fixed' });
  assert.equal(unchanged.criteria.required.maxPrice, 50_000);
  assert.equal(h.store.get('resp_branch').maxPrice, 100_000);
  assert.equal(h.store.get('resp_fixed').maxPrice, 50_000);
});

test('a failed correction cannot commit an explicit follow-up edit', async () => {
  const h = harness([tool('resp_a', required(100_000)), badId(), badId()]);
  h.store.set('resp_parent', required());
  await assert.rejects(h.agent.chat({ message: '최대 가격을 10만원으로 변경', previousResponseId: 'resp_parent' }));
  assert.equal(h.store.get('resp_parent').maxPrice, 50_000);
  assert.throws(() => h.store.get('resp_bad'), { code: 'invalid_conversation_state' });
});

for (const failure of [
  Object.assign(new Error('authentication'), { status: 401 }),
  Object.assign(new Error('authorization'), { status: 403 }),
  Object.assign(new Error('limit'), { status: 429 }),
  Object.assign(new Error('server'), { status: 500 }),
  Object.assign(new Error('network'), { name: 'APIConnectionError' }),
  Object.assign(new Error('timeout'), { name: 'APIConnectionTimeoutError' }),
]) {
  test('does not regenerate infrastructure failure: ' + failure.message, async () => {
    const h = harness([() => { throw failure; }]);
    await assert.rejects(h.agent.chat({ message }), (error) => error === failure);
    assert.equal(h.requests.length, 1);
    assert.equal(h.terminal().recovery.attempts, 0);
    assert.equal(h.terminal().usageComplete, false);
  });
}

test('database exceptions are not reclassified as model validation failures', async () => {
  const failure = new Error('database is unavailable');
  const h = harness([tool('resp_a'), final('resp_ok')], { getProducts() { throw failure; } });
  await assert.rejects(h.agent.chat({ message }), (error) => error === failure);
  assert.equal(h.requests.length, 2);
  assert.equal(h.terminal().recovery.attempts, 0);
});

test('disables real SDK internal retries even if its client default enables them', async () => {
  let fetchCalls = 0;
  const client = new OpenAI({
    apiKey: 'local-test-placeholder', maxRetries: 2,
    fetch: async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ error: { message: 'local injected failure' } }), {
        status: 500, headers: { 'content-type': 'application/json' },
      });
    },
  });
  const h = harness([], { client });
  await assert.rejects(h.agent.chat({ message }), { status: 500 });
  assert.equal(fetchCalls, 1);
  assert.equal(h.terminal().modelCalls, 1);
});

test('uses one decreasing deadline across initial calls and regeneration', async () => {
  let clock = 0;
  const h = harness([
    () => { clock = 60; return tool('resp_a'); },
    () => { clock = 80; return badId(); },
    () => { clock = 101; return final('resp_late'); },
  ], { now: () => clock, config: { requestTimeoutMs: 100 } });
  await assert.rejects(h.agent.chat({ message }), { code: 'request_timeout' });
  assert.deepEqual(h.requests.map((r) => r.transport.timeout), [100, 40, 20]);
  assert.equal(h.terminal().recovery.outcome, 'failed');
  assert.throws(() => h.store.get('resp_late'), { code: 'invalid_conversation_state' });
});

test('rejects a result if synchronous DB validation finishes after the deadline', async () => {
  let clock = 0;
  const h = harness([tool('resp_a'), final('resp_late')], {
    now: () => clock, config: { requestTimeoutMs: 100 },
    getProducts() { clock = 101; return [product]; },
  });
  await assert.rejects(h.agent.chat({ message }), { code: 'request_timeout' });
  assert.throws(() => h.store.get('resp_late'), { code: 'invalid_conversation_state' });
});

test('times out a pending model call even when the adapter ignores cancellation', async () => {
  const pending = Promise.withResolvers();
  const h = harness([() => pending.promise], { config: { requestTimeoutMs: 15 } });
  await assert.rejects(h.agent.chat({ message }), { code: 'request_timeout' });
  assert.equal(h.requests[0].transport.signal.aborted, true);
  pending.resolve(final('resp_late'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(() => h.store.get('resp_late'), { code: 'invalid_conversation_state' });
  assert.equal(h.terminal().modelCalls, 1);
});

test('does not start a pre-cancelled request', async () => {
  const controller = new AbortController();
  controller.abort();
  const h = harness([]);
  await assert.rejects(h.agent.chat({ message, signal: controller.signal }), { code: 'request_cancelled' });
  assert.equal(h.requests.length, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('cancels regeneration, cleans listeners and discards a late valid response', async () => {
  const controller = new AbortController();
  const entered = Promise.withResolvers();
  const pending = Promise.withResolvers();
  const h = harness([tool('resp_a'), badId(), () => { entered.resolve(); return pending.promise; }]);
  const running = h.agent.chat({ message, signal: controller.signal });
  const rejected = assert.rejects(running, { code: 'request_cancelled' });
  await entered.promise;
  controller.abort();
  await rejected;
  assert.equal(h.requests[2].transport.signal.aborted, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  pending.resolve(final('resp_late'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(() => h.store.get('resp_late'), { code: 'invalid_conversation_state' });
  assert.equal(h.terminal().recovery.additionalModelCalls, 1);
});

for (const [config, turns, code] of [
  [{ maxModelCalls: 2 }, [tool('resp_a'), badId()], 'model_call_budget_exceeded'],
  [{ maxModelCalls: 3 }, [tool('resp_a'), tool('resp_bad', required(100_000))], 'model_call_budget_exceeded'],
  [{ maxSearchCalls: 1 }, [tool('resp_a'), tool('resp_bad', required(100_000))], 'search_call_budget_exceeded'],
]) {
  test('reserves sufficient recovery budget before dispatch: ' + JSON.stringify(config), async () => {
    const h = harness(turns, { config });
    await assert.rejects(h.agent.chat({ message }), { code });
    assert.equal(h.requests.length, 2);
    assert.equal(h.terminal().recovery.attempts, 0);
    assert.equal(h.terminal().recovery.outcome, 'budget_exhausted');
  });
}

test('separately records a validated no_result fallback instead of a recovered recommendation', async () => {
  const h = harness([tool('resp_a'), badId(), final('resp_safe', { type: 'no_result' })]);
  const result = await h.agent.chat({ message });
  assert.equal(result.type, 'no_result');
  assert.equal(result.products, undefined);
  assert.equal(h.terminal().type, 'no_result');
  assert.equal(h.store.get('resp_safe').maxPrice, 50_000);
});

for (const [name, response, code] of [
  ['refusal', { id: 'resp_refusal', output: [{ content: [{ type: 'refusal' }] }] }, 'refused_response'],
  ['incomplete', { ...tool('resp_incomplete'), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }, 'incomplete_response'],
]) {
  test('does not retry ' + name, async () => {
    const h = harness([response]);
    await assert.rejects(h.agent.chat({ message }), { code });
    assert.equal(h.requests.length, 1);
    assert.equal(h.searches.length, 0);
    assert.equal(h.terminal().recovery.attempts, 0);
  });
}

test('isolates budgets and snapshots between simultaneous requests', async () => {
  const events = [];
  let turn = 0;
  const agent = createShoppingAgent({
    config: { maxModelCalls: 2 },
    client: { responses: { async create(input) {
      turn += 1;
      return input.input[0].type === 'function_call_output' ? final('resp_final_' + turn) : tool('resp_search_' + turn);
    } } },
    repository: { getProductsByIds: () => [product] },
    search: () => ({ hardFilterMatchCount: 1, candidates: [product] }),
    logger: { log(value) { events.push(JSON.parse(value)); } },
  });
  const results = await Promise.all([agent.chat({ message }), agent.chat({ message })]);
  assert.equal(results.length, 2);
  assert.notEqual(results[0].responseId, results[1].responseId);
  assert.deepEqual(events.map((e) => e.modelCalls), [2, 2]);
  assert.notEqual(events[0].requestId, events[1].requestId);
});
