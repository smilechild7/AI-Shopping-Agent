/**
 * 역할: Cafe24 상품 HTML의 메타 정보·JSON-LD·DOM에서 가격, 이미지, 판매 옵션 등 실제 상품 정보를 추출한다.
 * 쇼핑몰별 옵션 차이를 정리하고 검증된 실측표만 포함한 원본 상품 객체를 만든다.
 */

import * as cheerio from 'cheerio';

import { isValidSizeGuideText } from '../../shared/sizeGuide.js';
import { extractSourceProductId } from './product-url.js';

/**
 * HTML에서 읽은 문자열의 특수 공백과 연속 공백을 정리하고, 내용이 없으면 null을 반환한다.
 */
function cleanText(value) {
  const cleaned = value?.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || null;
}

/**
 * 가격 문구에서 처음 나타나는 숫자와 쉼표를 읽어 정수 원으로 바꾸며, 해석할 수 없으면 null을 반환한다.
 */
function parseMoney(value) {
  const firstNumber = value?.match(/[\d,]+/u)?.[0];
  if (!firstNumber) {
    return null;
  }

  const parsed = Number.parseInt(firstNumber.replaceAll(',', ''), 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * 상대 이미지 주소를 쇼핑몰 기준의 절대 URL로 바꾸고, 비어 있거나 잘못된 주소는 null로 처리한다.
 */
function normalizeAssetUrl(value, baseUrl) {
  if (!value) {
    return null;
  }

  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * 메타 태그·상품 이미지 DOM·JSON-LD의 순서로 이미지 후보를 확인한다.
 * 쇼핑몰 홈 주소처럼 상품 이미지로 쓰기 어려운 값을 건너뛰고 첫 유효 주소를 반환한다.
 */
function findProductImageUrl($, product, baseUrl) {
  const jsonLdImage = Array.isArray(product?.image)
    ? product.image[0]
    : product?.image;
  const candidates = [
    $('meta[property="og:image"]').attr('content'),
    $('.keyImg img').first().attr('src'),
    $('img.BigImage').first().attr('src'),
    jsonLdImage,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeAssetUrl(candidate, baseUrl);

    if (!normalized) {
      continue;
    }

    const url = new URL(normalized);
    if (url.pathname !== '/' || url.search.length > 0) {
      return normalized;
    }
  }

  return null;
}

/**
 * JSON-LD 스크립트와 @graph 내부에서 Product 유형의 객체를 찾아 반환하고, 없으면 null을 반환한다.
 */
function findJsonLdProduct($) {
  const candidates = [];

  $('script[type="application/ld+json"]').each(/* JSON-LD 스크립트 하나를 파싱해 후보에 추가하며, 깨진 외부 JSON은 무시하고 다음 후보를 확인한다. */ (_, element) => {
    try {
      const parsed = JSON.parse($(element).text());
      candidates.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      // Invalid third-party JSON-LD is ignored in favor of meta and DOM fallbacks.
    }
  });

  for (const candidate of candidates) {
    const nested = candidate?.['@graph'];
    const nodes = Array.isArray(nested) ? nested : [candidate];
    const product = nodes.find(/* JSON-LD 노드의 @type이 Product이거나 Product를 포함하는지 확인한다. */ (node) => {
      const type = node?.['@type'];
      return type === 'Product' || (Array.isArray(type) && type.includes('Product'));
    });

    if (product) {
      return product;
    }
  }

  return null;
}

/**
 * 상품의 offers가 단일 객체든 배열이든 첫 번째 값이 있는 판매 조건을 반환한다.
 */
function jsonLdOffer(product) {
  const offers = Array.isArray(product?.offers) ? product.offers : [product?.offers];
  return offers.find(Boolean) ?? null;
}

/**
 * 문자열 배열을 정리하고 빈 값과 중복을 제거한 목록을 반환한다.
 */
function unique(values) {
  return [...new Set(values.map(cleanText).filter(Boolean))];
}

/**
 * 실제 판매 옵션이 아닌 선택 안내·구분선·빈 값인지 판단한다.
 */
function isPlaceholderOption(value) {
  return (
    !value ||
    value === '*' ||
    value === '**' ||
    /^-+$/.test(value) ||
    /선택|필수|옵션/u.test(value)
  );
}

const SIZE_TITLE_PATTERN = /(size|사이즈)/i;
const COLOR_TITLE_PATTERN = /(color|colour|색상|컬러)/i;
const COMPOSITE_SIZE_PATTERN =
  /^(?:free|f|xs|s|m|l|xl|xxl|xxxl|[2-8]xl|[1-5]|\d{2,3})$/i;
const LENGTH_OPTION_PATTERN = /^(?:숏|롱|기본|short|long)$/i;

/**
 * select 옵션과 option_value 속성에서 화면에 표시되는 판매 값을 읽고 안내 문구·중복을 제거한다.
 */
function optionDisplayValues($, element) {
  const values = [];

  $(element)
    .find('option')
    .each(/* 일반 option의 표시 문구 또는 value를 읽어 유효한 판매 값만 모은다. */ (_, option) => {
      const value = cleanText($(option).text()) ?? $(option).attr('value');
      if (!isPlaceholderOption(value)) {
        values.push(value);
      }
    });

  $(element)
    .find('[option_value]')
    .each(/* 버튼형 옵션의 표시 문구·title·option_value를 순서대로 확인해 유효한 판매 값만 모은다. */ (_, option) => {
      const value =
        cleanText($(option).text()) ??
        $(option).attr('title') ??
        $(option).attr('option_value');
      if (!isPlaceholderOption(value)) {
        values.push(value);
      }
    });

  return unique(values);
}

/**
 * 옵션 제목에 색상과 사이즈가 함께 있거나 쇼핑몰의 복합 옵션 규칙에 맞는지 판단한다.
 */
function isCompositeOptionTitle(title, optionConfig) {
  if (SIZE_TITLE_PATTERN.test(title) && COLOR_TITLE_PATTERN.test(title)) {
    return true;
  }

  return (optionConfig?.compositeTitlePatterns ?? []).some(/* 쇼핑몰이 지정한 복합 옵션 제목 패턴과 현재 제목을 비교한다. */ (pattern) =>
    pattern.test(title),
  );
}

/**
 * 색상·사이즈·기장 등이 합쳐진 옵션을 구분자로 나누어 size와 color를 추출한다.
 * 사이즈 토큰을 찾지 못하면 두 값을 null로 반환하고, 색상에서 기장·영문 부가 표기를 제외한다.
 */
function compositeOptionParts(value) {
  const segments = value
    .replace(/\s*\([+-]?\s*[\d,]+원?\)\s*$/u, '')
    .split(/[\/_-]+/u)
    .map(/* 나눈 옵션 조각의 공백을 정리해 비교할 수 있는 문자열로 만든다. */ (segment) => cleanText(segment))
    .filter(Boolean);
  const sizeIndex = segments.findIndex(/* 옵션 조각 중 판매 사이즈로 인정하는 표기와 처음 일치하는 위치를 찾는다. */ (segment) =>
    COMPOSITE_SIZE_PATTERN.test(segment),
  );

  if (sizeIndex < 0) {
    return { size: null, color: null };
  }

  const color = [...segments.slice(0, sizeIndex)]
    .reverse()
    .find(/* 사이즈 앞의 옵션 조각 중 숏·롱 같은 기장 값을 제외해 색상 후보를 고른다. */ (segment) => !LENGTH_OPTION_PATTERN.test(segment));

  return {
    size: segments[sizeIndex],
    color: cleanText(color?.replace(/\([a-z\s]+\)/gi, '')),
  };
}

/**
 * 현재 상품의 옵션만 순회하며 요청한 종류인 색상 또는 사이즈를 추출하고 중복을 제거한다.
 */
function extractOptionValues($, kind, sourceProductId, optionConfig) {
  const matchesKind = kind === 'size' ? SIZE_TITLE_PATTERN : COLOR_TITLE_PATTERN;
  const values = [];

  $('[option_title]').each(/* 추가 상품·다른 상품의 옵션은 건너뛰고, 현재 옵션 제목과 복합 옵션 여부에 따라 값을 분류한다. */ (_, element) => {
    const title = $(element).attr('option_title') ?? '';
    const productType = $(element).attr('product_type');
    const optionProductId = $(element).attr('option_product_no');

    if (
      (productType && productType !== 'product_option') ||
      (sourceProductId && optionProductId && optionProductId !== sourceProductId)
    ) {
      return;
    }

    const displayValues = optionDisplayValues($, element);

    if (isCompositeOptionTitle(title, optionConfig)) {
      values.push(
        ...displayValues
          .map(/* 복합 옵션 한 개에서 호출자가 요청한 color 또는 size 값만 선택한다. */ (value) => compositeOptionParts(value)[kind])
          .filter(Boolean),
      );
      return;
    }

    if (matchesKind.test(title)) {
      values.push(...displayValues);
    }
  });

  return unique(values);
}

/**
 * 상품명 대괄호 안의 모든 항목이 사이즈 표기일 때만 판매 사이즈의 보조 정보로 사용한다.
 */
function extractSizesFromName(name) {
  const sizes = [];
  const sizeTokenPattern = /^(?:free|xs|s|m|l|xl|xxl|xxxl|프리)(?:\([^)]*\))?$/i;

  for (const match of name.matchAll(/\[([^\]]+)\]/g)) {
    const tokens = match[1].split(',').map(/* 상품명에서 쉼표로 나눈 사이즈 표기의 앞뒤 공백을 제거한다. */ (token) => token.trim());

    if (tokens.length > 0 && tokens.every(/* 대괄호의 각 항목이 허용된 사이즈 표기인지 확인해 홍보 문구의 오인식을 막는다. */ (token) => sizeTokenPattern.test(token))) {
      sizes.push(...tokens);
    }
  }

  return unique(sizes);
}

/**
 * 상품 기본 정보 표에서 주어진 항목명 패턴과 일치하는 첫 행의 값을 반환한다.
 */
function basicInfoValue($, labelPattern) {
  let result = null;

  $('tr').each(/* 표의 th를 항목명과 비교하고, 일치하면 td 값을 저장한 뒤 행 탐색을 끝낸다. */ (_, row) => {
    const label = cleanText($(row).find('th').first().text());
    if (!label || !labelPattern.test(label)) {
      return;
    }

    result = cleanText($(row).find('td').first().text());
    return false;
  });

  return result;
}

/**
 * 상세 영역의 표 후보에서 측정 항목과 숫자가 있는 짧은 원문을 찾는다.
 * 후기 표를 제외하고 공유 실측표 파서로 판매 사이즈와 대조해 검증한 텍스트만 반환한다.
 */
function extractSizeGuideText($, selectors = [], sizes = []) {
  const candidateSelectors = [
    ...selectors,
    '#prdDetail table',
    '.xans-product-additional table',
    '[id*="detail"] table',
  ];
  const dimensionPattern = /(허리|힙|엉덩이|허벅지|밑위|밑단|총장|가슴|어깨|소매)/gi;
  const reviewTableHeaderPattern = /(번호|제목|작성자|작성일|조회|평점)/;

  for (const selector of candidateSelectors) {
    const elements = $(selector).toArray();

    for (const element of elements) {
      const cells = $(element)
        .find('th,td')
        .toArray()
        .map(/* 표 셀의 텍스트를 정리해 실측표 원문을 구성할 재료로 사용한다. */ (cell) => cleanText($(cell).text()))
        .filter(Boolean);
      const text = cleanText(cells.length > 0 ? cells.join(' ') : $(element).text());
      const numberCount = text?.match(/\d+(?:\.\d+)?/g)?.length ?? 0;
      const dimensionCount = new Set(text?.match(dimensionPattern) ?? []).size;
      const firstRowText = cleanText($(element).find('tr').first().text()) ?? '';

      if (
        text &&
        text.length <= 2_000 &&
        !reviewTableHeaderPattern.test(firstRowText) &&
        numberCount >= 2 &&
        ((/cm/i.test(text) && dimensionCount >= 1) || dimensionCount >= 3)
      ) {
        if (isValidSizeGuideText(text, sizes)) {
          return text;
        }
      }
    }
  }

  return null;
}

/**
 * JSON-LD의 평점과 리뷰 수를 숫자로 변환하고, 유효한 값이 없으면 각 필드를 null로 둔다.
 */
function aggregateRating(product) {
  const rating = Number.parseFloat(product?.aggregateRating?.ratingValue);
  const reviewCount = Number.parseInt(product?.aggregateRating?.reviewCount, 10);

  return {
    rating: Number.isFinite(rating) ? rating : null,
    reviewCount: Number.isSafeInteger(reviewCount) ? reviewCount : null,
  };
}

/**
 * 상품 HTML과 쇼핑몰·카테고리 정보를 받아 수집 원본 형식의 상품 객체를 만든다.
 * 상품 ID·이름·가격·이미지가 없으면 오류를 던지고, 판매 옵션·실측표·소재·출처를 함께 반환한다.
 */
export function parseCafe24Product(
  html,
  { shopConfig, categoryConfig, productUrl, crawledAt = new Date().toISOString() },
) {
  const $ = cheerio.load(html);
  const product = findJsonLdProduct($);
  const offer = jsonLdOffer(product);
  const sourceProductId =
    extractSourceProductId(productUrl) ??
    $('[option_product_no]').first().attr('option_product_no') ??
    null;
  const ogTitle = cleanText($('meta[property="og:title"]').attr('content'));
  const name = cleanText(
    ogTitle && ogTitle !== cleanText(shopConfig.name) ? ogTitle : product?.name,
  );
  const basePrice =
    parseMoney($('#span_product_price_text').first().text()) ??
    parseMoney($('meta[property="product:price:amount"]').attr('content')) ??
    parseMoney(offer?.price?.toString());
  const salePrice = parseMoney($('#span_product_price_sale').first().text());
  const price = salePrice ?? basePrice;
  const imageUrl = findProductImageUrl($, product, shopConfig.baseUrl);
  const jsonLdRating = aggregateRating(product);
  const domReviewCount = Number.parseInt(
    $('.sp__product_data[scope="index"]').first().attr('data-review'),
    10,
  );

  if (!sourceProductId || !name || price === null || !imageUrl) {
    throw new Error(
      `Missing required product data: id=${sourceProductId ?? 'null'} name=${name ?? 'null'} price=${price ?? 'null'} image=${imageUrl ?? 'null'}`,
    );
  }

  const optionSizes = extractOptionValues(
    $,
    'size',
    sourceProductId,
    shopConfig.options,
  );
  const sizes = optionSizes.length > 0 ? optionSizes : extractSizesFromName(name);

  return {
    source: {
      shopId: shopConfig.id,
      shopName: shopConfig.name,
      sourceProductId,
      productUrl,
    },
    name,
    brand: cleanText(
      typeof product?.brand === 'string' ? product.brand : product?.brand?.name,
    ),
    category: categoryConfig.id,
    price,
    originalPrice: salePrice !== null && basePrice > salePrice ? basePrice : null,
    imageUrl,
    colors: extractOptionValues(
      $,
      'color',
      sourceProductId,
      shopConfig.options,
    ),
    sizes,
    sizeGuideText: extractSizeGuideText(
      $,
      shopConfig.selectors?.sizeGuideText ?? [],
      sizes,
    ),
    material: basicInfoValue($, /^(소재|material)$/i),
    description: cleanText(
      product?.description ??
        $('meta[property="og:description"]').attr('content') ??
        $('meta[name="description"]').attr('content'),
    ),
    rating: jsonLdRating.rating,
    reviewCount: Number.isSafeInteger(domReviewCount)
      ? domReviewCount
      : jsonLdRating.reviewCount,
    reviews: [],
    crawledAt,
  };
}
