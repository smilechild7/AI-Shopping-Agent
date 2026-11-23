/**
 * 역할: 상품 카테고리와 스타일·용도·핏·계절 태그의 허용 값을 한곳에서 정의한다.
 * 상품 가공, 검색 입력과 Agent 응답이 같은 분류 어휘를 사용하도록 공유한다.
 */

export const CONTROLLED_VOCABULARY = Object.freeze({
  productCategories: Object.freeze([
    'pants',
    'top',
    'dress',
    'skirt',
    'outerwear',
  ]),
  styleTags: Object.freeze([
    'minimal',
    'classic',
    'casual',
    'feminine',
    'modern',
    'sporty',
  ]),
  occasionTags: Object.freeze([
    'daily',
    'office',
    'formal',
    'event',
    'travel',
    'exercise',
  ]),
  fitTags: Object.freeze([
    'slim',
    'regular',
    'relaxed',
    'oversized',
    'wide',
  ]),
  seasonTags: Object.freeze([
    'spring',
    'summer',
    'fall',
    'winter',
    'all_season',
  ]),
});
