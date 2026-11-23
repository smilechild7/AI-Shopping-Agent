/**
 * 역할: 최종 추천의 상품 ID와 근거를 최근 검색 후보에 대조하고 실제 상품 정보를 DB에서 다시 조회한다.
 * 검증된 모델 설명과 DB 사실 필드를 합쳐 프런트엔드에 전달할 응답을 만든다.
 */

import { colorsMatch, sizesMatch } from '../products/searchNormalization.js';

/**
 * 근거 유형에 따라 최근 검색 후보의 실제 옵션·태그·후기 신호와 근거 값을 대조한다.
 * 가격 근거는 최근 검색의 가격 범위를 기준으로 검사하고, unknown 후기 신호는 근거로 허용하지 않는다.
 */
function evidenceMatches(candidate, evidence, criteria) {
  switch (evidence.type) {
    case 'category':
      return candidate.category === evidence.value;
    case 'price': {
      const { minPrice, maxPrice } = criteria.required;
      return (
        evidence.value === 'within_required_range' &&
        (minPrice !== null || maxPrice !== null) &&
        (minPrice === null || candidate.price >= minPrice) &&
        (maxPrice === null || candidate.price <= maxPrice)
      );
    }
    case 'color':
      return candidate.colors.some(/* 상품 색상 중 근거에 제시된 색상과 공통 별칭 규칙으로 일치하는 값이 있는지 확인한다. */ (color) => colorsMatch(color, evidence.value));
    case 'size':
      return candidate.sizes.some(/* 상품 판매 사이즈 중 근거에 제시된 사이즈와 일치하는 값이 있는지 확인한다. */ (size) => sizesMatch(size, evidence.value));
    case 'style':
      return candidate.styleTags.includes(evidence.value);
    case 'occasion':
      return candidate.occasionTags.includes(evidence.value);
    case 'fit':
      return candidate.fitTags.includes(evidence.value);
    case 'season':
      return candidate.seasonTags.includes(evidence.value);
    case 'review_appearance_match':
      return (
        evidence.value !== 'unknown' &&
        candidate.reviewSummary?.appearanceMatch?.signal === evidence.value
      );
    case 'review_size_fit':
      return (
        evidence.value !== 'unknown' &&
        candidate.reviewSummary?.sizeFit?.signal === evidence.value
      );
    case 'review_material_quality':
      return (
        evidence.value !== 'unknown' &&
        candidate.reviewSummary?.materialQuality?.signal === evidence.value
      );
    default:
      return false;
  }
}

/**
 * DB의 이름·가격·URL·판매 옵션에 후보의 가공 요약과 모델의 설명·장점·확인사항을 합친다.
 */
function mergeProduct(candidate, factualProduct, recommendation) {
  return {
    id: factualProduct.id,
    name: factualProduct.name,
    brand: factualProduct.brand,
    shopName: factualProduct.source.shopName,
    category: factualProduct.category,
    price: factualProduct.price,
    imageUrl: factualProduct.imageUrl,
    productUrl: factualProduct.source.productUrl,
    colors: factualProduct.colors,
    sizes: factualProduct.sizes,
    sizeGuideText: factualProduct.sizeGuideText,
    material: factualProduct.material,
    rating: factualProduct.rating,
    reviewCount: factualProduct.reviewCount,
    summary: candidate.summary,
    reviewSummary: candidate.reviewSummary,
    reason: recommendation.reason,
    evidence: recommendation.evidence,
    strengths: recommendation.strengths,
    concerns: recommendation.concerns,
  };
}

/**
 * 응답 분기에 맞는 공개 결과를 만들고 추천 ID·근거·비교 항목을 최근 검색에 대조한다.
 * 추천 상품을 DB에서 다시 읽어 사실 필드를 병합한다. 자유 서술 전체나 사용자 조건 스냅샷을 검사하는 함수는 아니다.
 */
export function buildAgentResult({
  output,
  responseId,
  latestSearch,
  repository,
}) {
  if (output.type === 'clarification') {
    return {
      type: 'clarification',
      responseId,
      message: output.message,
    };
  }

  if (!latestSearch) {
    throw new Error(`${output.type} response requires a completed search`);
  }

  if (output.type === 'no_result') {
    return {
      type: 'no_result',
      responseId,
      message: output.message,
      suggestion: output.suggestion,
    };
  }

  const candidatesById = new Map(
    latestSearch.result.candidates.map(/* 최근 검색 후보를 상품 ID로 바로 찾을 수 있도록 Map에 넣을 쌍을 만든다. */ (candidate) => [candidate.id, candidate]),
  );
  for (const recommendation of output.recommendations) {
    const candidate = candidatesById.get(recommendation.productId);
    if (!candidate) {
      throw new Error(
        `recommended product is outside the latest candidate set: ${recommendation.productId}`,
      );
    }
    for (const evidence of recommendation.evidence) {
      if (!evidenceMatches(candidate, evidence, latestSearch.input)) {
        throw new Error(
          `recommendation evidence does not match candidate: ${recommendation.productId} ${evidence.type}=${evidence.value}`,
        );
      }
    }
  }

  const recommendationIds = output.recommendations.map(/* 최종 추천의 상품 ID를 뽑아 비교 항목 확인과 DB 일괄 조회에 사용한다. */ ({ productId }) => productId);
  for (const comparison of output.comparison) {
    if (!recommendationIds.includes(comparison.productId)) {
      throw new Error(
        `comparison product is outside recommendations: ${comparison.productId}`,
      );
    }
  }

  const factualProducts = repository.getProductsByIds(recommendationIds);
  const factualById = new Map(factualProducts.map(/* DB에서 다시 조회한 실제 상품을 ID와 객체의 쌍으로 바꿔 병합 준비를 한다. */ (product) => [product.id, product]));
  if (factualById.size !== recommendationIds.length) {
    throw new Error('one or more recommended products are missing from the database');
  }

  return {
    type: 'recommendation',
    responseId,
    message: output.message,
    criteria: {
      required: latestSearch.input.required,
      preferred: latestSearch.input.preferred,
    },
    products: output.recommendations.map(/* 모델이 선택한 추천 순서대로 후보·DB 상품·추천 설명을 하나의 화면용 상품 객체로 합친다. */ (recommendation) =>
      mergeProduct(
        candidatesById.get(recommendation.productId),
        factualById.get(recommendation.productId),
        recommendation,
      ),
    ),
    comparison: output.comparison,
  };
}
