/**
 * 역할: DB 상품과 AI 가공 결과에서 후보 비교에 필요한 필드만 골라 Agent에 전달할 간결한 객체로 변환한다.
 */

export function toCompactProductDto({ product, enrichment }) {
  return {
    id: product.id,
    name: product.name,
    brand: product.brand,
    category: product.category,
    price: product.price,
    colors: product.colors,
    sizes: product.sizes,
    sizeGuideText: product.sizeGuideText,
    material: product.material,
    summary: enrichment?.summary ?? null,
    styleTags: enrichment?.styleTags ?? [],
    occasionTags: enrichment?.occasionTags ?? [],
    fitTags: enrichment?.fitTags ?? [],
    seasonTags: enrichment?.seasonTags ?? [],
    extraTags: enrichment?.extraTags ?? [],
    reviewSummary: enrichment?.reviewSummary ?? null,
  };
}
