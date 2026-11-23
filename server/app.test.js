/**
 * 역할: 로컬 HTTP 요청으로 채팅 입력 검증, Agent 오류 변환, IP별·서비스 전체 요청 제한과 본문 크기 제한을 검증한다.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { getEventListeners } from 'node:events';

import { AgentRuntimeError, createShoppingAgent } from './agent/shoppingAgent.js';
import { ExecutionBudgetError } from './agent/errors.js';
import { ConstraintError } from './agent/requiredConstraints.js';
import { createConstraintStore } from './agent/constraintStore.js';
import { createApp } from './app.js';

async function withServer(app, callback) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address();
  try {
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function chatResult(message) {
  return {
    type: 'clarification',
    responseId: 'resp_test',
    message,
  };
}

for (const [error, status, code] of [
  [new ConstraintError('invalid_conversation_state'), 400, 'invalid_conversation_state'],
  [new ConstraintError('constraint_violation', ['maxPrice']), 502, 'agent_response_invalid'],
  [new ConstraintError('required_product_mismatch', ['price']), 502, 'agent_response_invalid'],
  [new ExecutionBudgetError('request_timeout'), 504, 'agent_timeout'],
  [new ExecutionBudgetError('model_call_budget_exceeded'), 502, 'agent_response_invalid'],
  [new Error('database failure'), 502, 'agent_failed'],
]) {
  test('maps ' + (error.code ?? error.message) + ' to the public HTTP contract', async () => {
    const app = createApp({ chat: async () => { throw error; }, logger: { error() {} } });
    await withServer(app, async (baseUrl) => {
      const response = await fetch(baseUrl + '/api/chat', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: '5만원 이하 바지' }),
      });
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { error: code });
    });
  });
}

test('HTTP disconnect cancels the Agent and discards a late model response', { timeout: 5_000 }, async () => {
  const started = Promise.withResolvers();
  const pending = Promise.withResolvers();
  const finished = Promise.withResolvers();
  const events = [];
  const store = createConstraintStore();
  let transportSignal;
  let routeSignal;
  const agent = createShoppingAgent({
    client: { responses: { async create(_request, transport) {
      transportSignal = transport.signal;
      started.resolve();
      return pending.promise;
    } } },
    search: () => assert.fail('cancelled request must not search'),
    repository: { getProductsByIds: () => [] },
    constraintStore: store,
    logger: { log(value) { events.push(JSON.parse(value)); } },
  });
  const app = createApp({
    async chat(input) {
      routeSignal = input.signal;
      try { return await agent.chat(input); }
      finally { finished.resolve(); }
    },
    logger: { error() {} },
  });
  await withServer(app, async (baseUrl) => {
    const controller = new AbortController();
    const request = fetch(baseUrl + '/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '5만원 이하 바지' }), signal: controller.signal,
    });
    const rejected = assert.rejects(request, { name: 'AbortError' });
    await started.promise;
    controller.abort();
    await rejected;
    await finished.promise;
    assert.equal(transportSignal.aborted, true);
    assert.equal(getEventListeners(routeSignal, 'abort').length, 0);
    assert.equal(events.at(-1).code, 'request_cancelled');
    pending.resolve({ id: 'resp_late', status: 'completed', output: [], output_text: JSON.stringify({
      type: 'clarification', message: '조건 확인', suggestion: null, recommendations: [], comparison: [],
    }) });
    await new Promise((resolve) => setImmediate(resolve));
    assert.throws(() => store.get('resp_late'), { code: 'invalid_conversation_state' });
    assert.equal(events.length, 1);
  });
});

test('validates chat input and does not send invalid requests to the Agent', async () => {
  let calls = 0;
  const app = createApp({
    chat: async ({ message }) => {
      calls += 1;
      return chatResult(message);
    },
  });

  await withServer(app, async (baseUrl) => {
    const invalid = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '' }),
    });
    assert.equal(invalid.status, 400);

    const valid = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '검정 바지' }),
    });
    assert.equal(valid.status, 200);
    assert.equal((await valid.json()).message, '검정 바지');
    assert.equal(calls, 1);
  });
});

test('distinguishes invalid Agent responses from infrastructure failures', async () => {
  const app = createApp({
    chat: async () => {
      throw new AgentRuntimeError('invalid_output', 'invalid Agent response');
    },
    logger: { error() {} },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '아우터랑 바지' }),
    });

    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'agent_response_invalid' });
  });
});

test('limits one client independently from the service-wide budget', async () => {
  const app = createApp({
    chat: async () => chatResult('ok'),
    rateLimitConfig: {
      client: { windowMs: 60_000, limit: 2 },
      service: { windowMs: 60_000, limit: 100 },
    },
  });

  await withServer(app, async (baseUrl) => {
    for (let index = 0; index < 2; index += 1) {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '203.0.113.10',
        },
        body: JSON.stringify({ message: '검정 바지' }),
      });
      assert.equal(response.status, 200);
    }

    const limited = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.10',
      },
      body: JSON.stringify({ message: '검정 바지' }),
    });
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).scope, 'client');
  });
});

test('limits distributed client IPs with the service-wide budget', async () => {
  const app = createApp({
    chat: async () => chatResult('ok'),
    rateLimitConfig: {
      client: { windowMs: 60_000, limit: 100 },
      service: { windowMs: 60_000, limit: 2 },
    },
  });

  await withServer(app, async (baseUrl) => {
    for (let index = 1; index <= 3; index += 1) {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': `203.0.113.${index}`,
        },
        body: JSON.stringify({ message: '검정 바지' }),
      });
      assert.equal(response.status, index < 3 ? 200 : 429);
      if (index === 3) {
        assert.equal((await response.json()).scope, 'service');
      }
    }
  });
});

test('rejects oversized JSON before calling the Agent', async () => {
  let calls = 0;
  const app = createApp({
    chat: async () => {
      calls += 1;
      return chatResult('ok');
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '가'.repeat(20_000) }),
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error, 'request_too_large');
    assert.equal(calls, 0);
  });
});
