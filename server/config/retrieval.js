/**
 * 역할: Agent에 전달할 검색 후보 수의 상한과 색상·사이즈·태그·키워드·후기 신호별 검색 점수 가중치를 정의한다.
 */

export const RETRIEVAL_CONFIG = Object.freeze({
  candidateLimit: 15,
  weights: Object.freeze({
    keyword: 1,
    color: 2,
    size: 2,
    style: 2,
    occasion: 2,
    fit: 3,
    season: 1,
    reviewSignal: 2,
  }),
});
