/**
 * 역할: 복구 평가와 테스트에 사용할 가상 상품, 검색 도구 응답과 최종 모델 응답을 생성한다.
 * 정상 응답·잘못된 상품 ID·허위 근거·필수 조건 변경 등의 재현 가능한 시나리오를 제공한다.
 */

// Deterministic local fault injection only. No API client, secrets, or network.
export const recoveryRequired = (maxPrice = 50_000) => ({
  category: 'pants', minPrice: null, maxPrice, colors: [], sizes: [],
});
export const recoveryProduct = {
  id: 'fixture:40000', name: '검정 바지', category: 'pants', price: 40_000,
  colors: ['검정'], sizes: ['M'], styleTags: ['minimal'], occasionTags: [],
  fitTags: [], seasonTags: [], source: { shopName: 'fixture', productUrl: 'https://example.com/pants' },
  imageUrl: 'https://example.com/pants.jpg', reviewSummary: null,
};
const usage = { input_tokens: 100, output_tokens: 20, total_tokens: 120 };
export function recoveryTool(id, required = recoveryRequired()) {
  return {
    id, status: 'completed', usage: { ...usage }, output: [{
      type: 'function_call', name: 'search_products', call_id: 'call_' + id,
      arguments: JSON.stringify({ query: '5만원 이하 바지', required }),
    }],
  };
}
export function recoveryFinal(id, { productId = recoveryProduct.id, evidence = [{ type: 'category', value: 'pants' }], type = 'recommendation' } = {}) {
  return {
    id, status: 'completed', output: [], usage: { ...usage }, output_text: JSON.stringify({
      type, message: '검증된 후보를 확인했어요.', suggestion: type === 'no_result' ? '다른 조건을 지정해주세요.' : null,
      recommendations: type === 'recommendation' ? [{
        productId, reason: '카테고리와 가격이 맞습니다.', evidence,
        strengths: ['실제 상품'], concerns: ['실측 확인 필요'],
      }] : [], comparison: [],
    }),
  };
}
export function recoveryScenarios() {
  return [
    { id: 'normal', responses: [recoveryTool('resp_search'), recoveryFinal('resp_ok')] },
    { id: 'wrong-product-id', responses: [recoveryTool('resp_search'), recoveryFinal('resp_bad', { productId: 'fixture:invented' }), recoveryFinal('resp_fixed')] },
    { id: 'wrong-evidence', responses: [recoveryTool('resp_search'), recoveryFinal('resp_bad', { evidence: [{ type: 'style', value: 'feminine' }] }), recoveryFinal('resp_fixed')] },
    { id: 'tool-constraint-drift', responses: [recoveryTool('resp_search'), recoveryTool('resp_bad', recoveryRequired(100_000)), recoveryTool('resp_fixed'), recoveryFinal('resp_ok')] },
    { id: 'repeated-invalid-id', responses: [recoveryTool('resp_search'), recoveryFinal('resp_bad', { productId: 'fixture:invented' }), recoveryFinal('resp_bad_again', { productId: 'fixture:invented' })] },
    { id: 'repeated-constraint-drift', responses: [recoveryTool('resp_search'), recoveryTool('resp_bad', recoveryRequired(100_000)), recoveryTool('resp_bad_again', recoveryRequired(100_000))] },
  ].map((item) => ({ ...item, message: '5만원 이하 바지', expectedType: 'recommendation' }));
}
