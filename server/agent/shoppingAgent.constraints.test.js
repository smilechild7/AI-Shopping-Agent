/**
 * 역할: Agent가 필수 조건을 임의로 완화하지 않고 명시적인 후속 변경과 대화 분기를 보존하는지 검증한다.
 * 만료된 상태, 실패 후 스냅샷 보존과 DB의 최신 상품 조건 재검증도 확인한다.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createShoppingAgent } from './shoppingAgent.js';
import { createConstraintStore } from './constraintStore.js';

/**
 * 가격 상한만 바꿔 쓸 수 있는 바지 검색의 기본 필수 조건 표본을 만든다.
 */
const required = (maxPrice = 50_000) => ({
  category: 'pants', minPrice: null, maxPrice, colors: [], sizes: [],
});
/**
 * 주어진 가격으로 상품 ID와 사실 필드를 구성해 모델·검색·DB에 쓸 가상 상품을 만든다.
 */
const product = (price) => ({
  id: `fixture:${price}`, name: '테스트 바지', category: 'pants', price,
  colors: ['검정'], sizes: ['M'], styleTags: [], occasionTags: [], fitTags: [],
  seasonTags: [], source: { shopName: 'fixture', productUrl: 'https://example.com/pants' },
  imageUrl: 'https://example.com/pants.jpg', reviewSummary: null,
});
/**
 * 지정한 조건을 search_products 인자로 요청하는 모의 모델 응답을 만든다.
 */
const tool = (id, conditions) => ({
  id, status: 'completed', output: [{
    type: 'function_call', name: 'search_products', call_id: `call_${id}`,
    arguments: JSON.stringify({ query: '5만원 이하 바지', required: conditions }),
  }],
});
/**
 * 지정한 가격의 상품을 가격 근거와 함께 추천하는 모의 최종 응답을 만든다.
 */
const final = (price, id = 'resp_final') => ({
  id, status: 'completed', output: [], output_text: JSON.stringify({
    type: 'recommendation', message: '추천합니다.', suggestion: null,
    recommendations: [{
      productId: `fixture:${price}`, reason: '가격 조건에 맞습니다.',
      evidence: [{ type: 'price', value: 'within_required_range' }],
      strengths: ['가격 조건 충족'], concerns: ['실측 확인 필요'],
    }], comparison: [],
  }),
});

/**
 * 모델이 5만원 상한을 10만원으로 바꾸면 두 번째 검색 전에 차단되고 9만원 추천까지 진행하지 않는지 검증한다.
 */
test('blocks a 50k → 100k tool drift before a 90k recommendation can escape', async () => {
  const responses = [
    tool('resp_first', required()),
    tool('resp_changed', required(100_000)),
    final(90_000),
  ];
  const searchPrices = [];
  const agent = createShoppingAgent({
    config: { maxRecoveryAttempts: 0 }, // Preserve the Phase 1 fail-fast baseline.
    client: { responses: { /* 준비한 모델 응답을 앞에서 하나씩 반환해 검색·재검색·추천 순서를 재현한다. */ async create() { return responses.shift(); } } },
    /**
     * 실행된 검색 상한을 기록하고 5만원 검색에는 4만원, 완화된 검색에는 9만원 후보를 돌려준다.
     */
    search(input) {
      searchPrices.push(input.required.maxPrice);
      return {
        hardFilterMatchCount: 1,
        candidates: [product(input.required.maxPrice === 50_000 ? 40_000 : 90_000)],
      };
    },
    repository: { /* 최종 DB 조회에서 9만원 상품을 반환하도록 설정해 잘못된 추천 유출 여부를 드러낸다. */ getProductsByIds: () => [product(90_000)] },
    logger: { /* 이 테스트에서 일반 Agent 로그가 출력되지 않도록 무시한다. */ log() {} },
  });

  await assert.rejects(/* Agent가 조건 위반으로 실패하는지 확인하고, 추천이 반환되면 잘못된 가격을 담아 테스트를 실패시킨다. */ async () => {
    const result = await agent.chat({ message: '5만원 이하 바지 찾아줘' });
    throw new Error(`Unsafe recommendation escaped: ${result.products[0].price} won`);
  }, { code: 'constraint_violation' });
  assert.deepEqual(searchPrices, [50_000]);
  assert.equal(responses.length, 1, 'no automatic regeneration in Phase 1');
});

/**
 * 모의 모델·검색·DB·로그·조건 저장소를 묶어 테스트용 Agent와 관찰 기록을 만든다.
 * 각 사례는 같은 실행 틀에서 입력 조건이나 반환 상품만 바꾸어 보호 규칙을 검증한다.
 */
function harness(responses, { store = createConstraintStore(), products, search } = {}) {
  const requests = [];
  const searchCalls = [];
  const events = [];
  const agent = createShoppingAgent({
    config: { maxRecoveryAttempts: 0 }, // Recovery-on invariants are covered separately.
    client: { responses: { /* 모델 요청을 기록하고 준비된 응답을 하나 소비하며 예상보다 많은 호출은 테스트 실패로 처리한다. */ async create(input) {
      requests.push(input);
      assert.ok(responses.length, 'unexpected extra LLM call');
      return responses.shift();
    } } },
    /**
     * 검색 입력을 기록하고 주입한 검색 결과 또는 기본 4만원 후보를 반환한다.
     */
    search(input) {
      searchCalls.push(input);
      return search ? search(input) : { hardFilterMatchCount: 1, candidates: [product(40_000)] };
    },
    repository: { /* 별도 지정한 DB 상품 목록이 있으면 사용하고 없으면 기본 4만원 상품을 반환한다. */ getProductsByIds: () => products ?? [product(40_000)] },
    logger: { /* 구조화 로그 문자열을 객체로 복원해 검증할 이벤트 목록에 저장한다. */ log(value) { events.push(JSON.parse(value)); } },
    constraintStore: store,
  });
  return { agent, store, requests, searchCalls, events };
}

for (const [name, changed] of [
  ['initial budget inflation', required(100_000)],
  ['budget omission', required(null)],
  ['invented hard color', { ...required(), colors: ['black'] }],
  ['invented hard size', { ...required(), sizes: ['M'] }],
  ['changed category', { ...required(), category: 'dress' }],
]) {
  /**
   * 최초 검색에서 가격 상승·삭제나 사용자에게 없는 필수 조건 추가가 검색 실행 전에 거부되는지 검증한다.
   */
  test('rejects ' + name + ' before executing any search', async () => {
    const h = harness([tool('resp_bad', changed)]);
    await assert.rejects(h.agent.chat({ message: '5만원 이하 바지' }), { code: 'constraint_violation' });
    assert.equal(h.searchCalls.length, 0);
    assert.equal(h.requests.length, 1);
    assert.equal(h.events.find(/* 수집한 로그 중 조건 검증 거부 이벤트를 찾아 오류 코드를 확인한다. */ (e) => e.event === 'agent.validation_rejected').code, 'constraint_violation');
    assert.throws(/* 거부된 응답 ID가 조건 저장소에 저장되지 않았는지 조회 오류로 확인한다. */ () => h.store.get('resp_bad'), { code: 'invalid_conversation_state' });
  });
}

/**
 * 재검색에서 엄격한 색상 조건을 삭제하거나 선호로 낮추는 변경이 차단되는지 검증한다.
 */
test('rejects dropping or demoting a strict color on a revised search', async () => {
  const strict = { ...required(), colors: ['black'] };
  const h = harness([tool('resp_first', strict), tool('resp_dropped', required())]);
  await assert.rejects(h.agent.chat({ message: '5만원 이하 검정만 바지' }), { code: 'constraint_violation' });
  assert.equal(h.searchCalls.length, 1);
  assert.deepEqual(h.searchCalls[0].required.colors, ['black']);
});

/**
 * 사용자의 명시적 가격 변경·색상 해제는 허용하되 부모 대화와 다른 분기의 조건은 유지되는지 검증한다.
 */
test('allows explicit follow-up edits and independent branches, retaining unmentioned fields', async () => {
  const black = { ...required(), colors: ['black'] };
  const higher = { ...black, maxPrice: 100_000 };
  const h = harness([
    tool('resp_tool_a', black), final(40_000, 'resp_parent'),
    tool('resp_tool_b', higher), final(40_000, 'resp_changed'),
    tool('resp_tool_c', black), final(40_000, 'resp_branch'),
    tool('resp_tool_d', required()), final(40_000, 'resp_color_cleared'),
  ]);
  await h.agent.chat({ message: '5만원 이하 검정만 바지' });
  const changed = await h.agent.chat({ message: '최대 가격을 10만원으로 올려줘', previousResponseId: 'resp_parent' });
  assert.equal(changed.criteria.required.maxPrice, 100_000);
  assert.deepEqual(changed.criteria.required.colors, ['black']);
  const branch = await h.agent.chat({ message: '후기가 더 좋은 걸로', previousResponseId: 'resp_parent' });
  assert.equal(branch.criteria.required.maxPrice, 50_000);
  const cleared = await h.agent.chat({ message: '색상은 상관없어', previousResponseId: 'resp_parent' });
  assert.deepEqual(cleared.criteria.required.colors, []);
  assert.equal(cleared.criteria.required.maxPrice, 50_000);
  assert.equal(h.store.get('resp_parent').maxPrice, 50_000);
  assert.equal(h.requests[2].previous_response_id, 'resp_parent');
});

/**
 * 모호한 변경에 서버가 재질문하고 모델 호출·조건 일부 저장 없이 기존 응답 ID를 유지하는지 검증한다.
 */
test('clarifies ambiguity without LLM calls, losing ancestry, or committing partial edits', async () => {
  const store = createConstraintStore();
  store.set('resp_parent', required());
  const h = harness([], { store });
  const result = await h.agent.chat({ message: '예산을 조금 늘리고 원피스로 바꿔줘', previousResponseId: 'resp_parent' });
  assert.equal(result.type, 'clarification');
  assert.equal(result.source, 'server');
  assert.equal(result.responseId, 'resp_parent');
  assert.equal(h.store.get('resp_parent').category, 'pants');
  const first = await h.agent.chat({ message: '5만원 이하 또는 10만원 이하 바지' });
  assert.equal(first.responseId, null);
  assert.equal(h.requests.length, 0);
});

/**
 * 만료되거나 없는 대화 상태는 모델 호출 전에 거부되고, 이전 ID 없는 새 요청은 가능한지 검증한다.
 */
test('rejects missing/expired state before any external call and permits a fresh reset', async () => {
  let now = 0;
  const store = createConstraintStore({ ttlMs: 100, /* 테스트가 조절하는 현재 시각을 저장소에 제공해 만료 경계를 재현한다. */ now: () => now });
  store.set('resp_old', required());
  const h = harness([tool('resp_new_tool', required()), final(40_000)], { store });
  now = 100;
  for (const id of ['resp_old', 'resp_missing']) {
    await assert.rejects(h.agent.chat({ message: '후기가 더 좋은 걸로', previousResponseId: id }), { code: 'invalid_conversation_state' });
  }
  assert.equal(h.requests.length, 0);
  assert.equal((await h.agent.chat({ message: '5만원 이하 바지' })).type, 'recommendation');
});

/**
 * 실패한 후속 요청이 이전 유효 스냅샷을 덮어쓰거나 새 응답 상태를 남기지 않는지 검증한다.
 */
test('a rejected follow-up cannot overwrite the last valid constraint state', async () => {
  const store = createConstraintStore();
  store.set('resp_parent', required());
  const h = harness([tool('resp_bad', required(200_000))], { store });
  await assert.rejects(h.agent.chat({ message: '최대 가격을 10만원으로 변경', previousResponseId: 'resp_parent' }), { code: 'constraint_violation' });
  assert.equal(store.get('resp_parent').maxPrice, 50_000);
  assert.throws(/* 거부된 후속 응답의 ID가 저장되지 않았는지 확인한다. */ () => store.get('resp_bad'), { code: 'invalid_conversation_state' });
});

/**
 * 모델이 가격 근거를 생략해도 최신 DB 가격이 사용자 상한을 넘으면 추천을 거부해야 한다는 계약을 검증한다.
 */
test('validates fresh DB price even when the model omits price evidence', async () => {
  const answer = final(40_000);
  const output = JSON.parse(answer.output_text);
  output.recommendations[0].evidence = [{ type: 'category', value: 'pants' }];
  answer.output_text = JSON.stringify(output);
  const h = harness([tool('resp_tool', required()), answer], {
    products: [{ ...product(40_000), price: 90_000 }],
  });
  await assert.rejects(h.agent.chat({ message: '5만원 이하 바지' }), { code: 'required_product_mismatch' });
  assert.equal(h.requests.length, 2);
  assert.throws(/* 최종 상품 검증에 실패한 응답의 조건 상태가 저장되지 않았는지 확인한다. */ () => h.store.get('resp_final'), { code: 'invalid_conversation_state' });
});

for (const [name, fields, request, conditions] of [
  ['unknown color', { colors: [] }, '5만원 이하 검정만 바지', { ...required(), colors: ['black'] }],
  ['mismatched color', { colors: ['white'] }, '5만원 이하 검정만 바지', { ...required(), colors: ['black'] }],
  ['unknown size', { sizes: [] }, '5만원 이하 M 사이즈만 바지', { ...required(), sizes: ['M'] }],
  ['mismatched category', { category: 'dress' }, '5만원 이하 바지', required()],
]) {
  /**
   * 검색 후보와 별개로 DB의 누락된 색상·사이즈나 불일치 카테고리를 최종 검증에서 거부하는지 확인한다.
   */
  test('rejects final DB ' + name + ' independently of candidate data', async () => {
    const h = harness([tool('resp_tool', conditions), final(40_000)], {
      products: [{ ...product(40_000), ...fields }],
    });
    await assert.rejects(h.agent.chat({ message: request }), { code: 'required_product_mismatch' });
  });
}

/**
 * 결과 없음·모델 추가 질문 뒤의 후속 대화도 기존 가격 조건을 이어받아 검색하는지 검증한다.
 */
test('no-result and model clarification retain constraints for subsequent user turns', async () => {
  /**
   * 상품 추천이 없는 no_result 또는 clarification 형태의 모의 최종 응답을 만든다.
   */
  const empty = (type, id) => ({
    id, status: 'completed', output: [], output_text: JSON.stringify({
      type, message: '조건을 확인해주세요.', suggestion: type === 'no_result' ? '조건을 확인해주세요.' : null,
      recommendations: [], comparison: [],
    }),
  });
  const h = harness([
    tool('resp_tool_a', required()), empty('no_result', 'resp_none'),
    tool('resp_tool_b', required()), final(40_000, 'resp_later'),
    empty('clarification', 'resp_question'),
    tool('resp_tool_c', required()), final(40_000, 'resp_answered'),
  ]);
  await h.agent.chat({ message: '5만원 이하 바지' });
  const later = await h.agent.chat({ message: '다시 찾아줘', previousResponseId: 'resp_none' });
  assert.equal(later.criteria.required.maxPrice, 50_000);
  await h.agent.chat({ message: '5만원 이하 예쁜 옷' });
  const answered = await h.agent.chat({ message: '바지', previousResponseId: 'resp_question' });
  assert.equal(answered.criteria.required.maxPrice, 50_000);
  assert.equal(answered.criteria.required.category, 'pants');
});
