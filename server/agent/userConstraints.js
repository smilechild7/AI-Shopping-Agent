/**
 * 역할: 사용자 문장과 이번 요청의 선택 필터를 해석해 이전 대화의 필수 조건에 명시적인 변경을 반영한다.
 * 해석이 모호하거나 조건이 충돌하면 기존 조건을 유지하고 확인 질문을 반환한다.
 */

import { CONTROLLED_VOCABULARY } from '../config/vocabulary.js';
import { interpretedPriceRange } from '../products/priceIntent.js';
import { canonicalColor } from '../products/searchNormalization.js';
import { requiredSnapshot } from './requiredConstraints.js';

const CATEGORIES = {
  바지: 'pants', 팬츠: 'pants', 슬랙스: 'pants', 청바지: 'pants',
  상의: 'top', 윗도리: 'top', 블라우스: 'top', 셔츠: 'top', 티셔츠: 'top', 니트: 'top',
  원피스: 'dress', 드레스: 'dress', 스커트: 'skirt', 치마: 'skirt',
  아우터: 'outerwear', 재킷: 'outerwear', 자켓: 'outerwear', 코트: 'outerwear', 가디건: 'outerwear',
};
const CATEGORY_PATTERN = new RegExp(Object.keys(CATEGORIES).sort(/* 티셔츠처럼 긴 카테고리 표현을 먼저 매칭하도록 단어 길이 내림차순으로 정렬한다. */ (a, b) => b.length - a.length).join('|'), 'gu');
const COLOR_PATTERN = /화이트|흰색|검정색?|검은색|블랙|네이비|파랑|블루|그레이|회색|차콜|먹색|베이지|브라운|밤색|카키|아이보리|크림|오트밀|\b(?:white|black|navy|blue|gray|grey|charcoal|beige|brown|khaki|ivory|cream)\b/giu;
const NUMBER = '(?:\\d{1,3}(?:,\\d{3})+|\\d+(?:\\.\\d+)?)';
const AMOUNT_PATTERN = new RegExp('(?:' + NUMBER + '\\s*(?:만|천)?\\s*원|천\\s*원)', 'gu');
const STRICT_PREFIX = /(?:꼭|무조건|반드시|정확(?:한|히)|필수)(?:\s*정확(?:한|히))?\s*$/u;
const UNCERTAIN = /가능하면|있으면|우선|먼저|선호/u;
const CLARIFICATION = '필수 조건을 명확히 알려주세요. 예: “최대 가격을 10만원으로 변경”, “검정만”, “색상은 상관없어”.';

class AmbiguousConstraintError extends Error {}

/**
 * UI 선택 객체의 허용 필드와 카테고리·정수 가격·판매 사이즈 형식을 검증하고 정리한 값을 반환한다.
 */
export function validateSelectedFilters(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('selectedFilters must be an object');
  }
  if (Object.keys(value).some(/* 선택 필터에 category·maxPrice·size 이외의 필드가 들어왔는지 검사한다. */ (key) => !['category', 'maxPrice', 'size'].includes(key))) {
    throw new Error('selectedFilters contains unsupported fields');
  }
  const result = {};
  if ('category' in value) {
    if (!CONTROLLED_VOCABULARY.productCategories.includes(value.category)) {
      throw new Error('selectedFilters.category is invalid');
    }
    result.category = value.category;
  }
  if ('maxPrice' in value) {
    if (!Number.isSafeInteger(value.maxPrice) || value.maxPrice < 0) {
      throw new Error('selectedFilters.maxPrice is invalid');
    }
    result.maxPrice = value.maxPrice;
  }
  if ('size' in value) {
    if (typeof value.size !== 'string' || !/^(?:XS|S|M|L|XL|XXL|FREE|\d{2,3}(?:\s*[~-]\s*\d{2,3})?)$/iu.test(value.size.trim())) {
      throw new Error('selectedFilters.size must be a sale size such as M or 28');
    }
    result.size = value.size.trim();
  }
  return result;
}

/**
 * 쉼표·공백·원 표기를 제거하고 만·천 단위를 곱해 정수 금액을 만들며 잘못된 값은 모호한 가격으로 거부한다.
 */
function amount(text) {
  const cleaned = text.replace(/[,\s원]/gu, '');
  const unit = cleaned.endsWith('만') ? 10_000 : cleaned.endsWith('천') ? 1_000 : 1;
  const number = cleaned.replace(/[만천]/gu, '');
  const value = Number(number || '1') * unit;
  if (!Number.isSafeInteger(value) || value < 0) throw new AmbiguousConstraintError('ambiguous_price');
  return value;
}

/**
 * 문장에 명시된 가격 상한·하한·범위·목표 가격·조건 해제를 부분 변경 객체로 해석한다.
 * 충돌하는 금액, 간접 언급이나 지원하지 않는 표현은 임의 결정하지 않고 모호함 오류를 던진다.
 */
function pricePatch(text) {
  const clear = /(?:가격|예산)(?:\s*(?:조건|제한))?(?:은|는|을|이|가)?\s*(?:상관\s*없|무관|없애|해제|제한\s*없)/u.test(text);
  const matches = [...text.matchAll(AMOUNT_PATTERN)];
  if (clear) {
    if (matches.length) throw new AmbiguousConstraintError('ambiguous_price');
    return { minPrice: null, maxPrice: null };
  }
  // Explicit ranges, including a shared unit: 5~7만원 / 50,000원~70,000원.
  const rangePattern = new RegExp('(' + NUMBER + ')\\s*(만|천)?\\s*원?\\s*(?:~|〜|에서)\\s*(' + NUMBER + ')\\s*(만|천)?\\s*원', 'gu');
  const ranges = [...text.matchAll(rangePattern)];
  if (ranges.length) {
    if (/(?:올려|늘려|변경|바꿔|내려|낮춰)/u.test(text)) throw new AmbiguousConstraintError('ambiguous_price');
    if (ranges.length !== 1 || [...text.replace(ranges[0][0], '').matchAll(AMOUNT_PATTERN)].length) {
      throw new AmbiguousConstraintError('ambiguous_price');
    }
    const [, low, lowUnit, high, highUnit] = ranges[0];
    return {
      minPrice: amount(low + (lowUnit ?? highUnit ?? '') + '원'),
      maxPrice: amount(high + (highUnit ?? '') + '원'),
    };
  }
  const remainder = text.replace(AMOUNT_PATTERN, '');
  if (/\d+\s*(?:만|천|억|백|십)/u.test(remainder) ||
      (!matches.length && /원/u.test(text) && /이하|이상|미만|초과|최대|최소/u.test(text))) {
    throw new AmbiguousConstraintError('ambiguous_price');
  }
  const patch = {};
  /**
   * 같은 가격 경계가 한 문장에 중복 지정되면 모호함으로 처리하고, 아니면 변경값을 기록한다.
   */
  function assign(field, value) {
    if (field in patch) throw new AmbiguousConstraintError('ambiguous_price');
    patch[field] = value;
  }
  for (const match of matches) {
    const value = amount(match[0]);
    const before = text.slice(Math.max(0, match.index - 20), match.index);
    const after = text.slice(match.index + match[0].length);
    if (/^\s*(?:보다|넘|짜리|이던|이었던|인\s*(?:상품|제품))/u.test(after)) {
      throw new AmbiguousConstraintError('ambiguous_price');
    }
    if (/^\s*대\s*(?:이하|이상|미만|초과)/u.test(after)) throw new AmbiguousConstraintError('ambiguous_price');
    if (/^\s*(?:이하|이내|까지|아래)/u.test(after)) assign('maxPrice', value);
    else if (/^\s*미만/u.test(after)) assign('maxPrice', value - 1);
    else if (/^\s*(?:이상|부터)/u.test(after)) assign('minPrice', value);
    else if (/^\s*초과/u.test(after)) assign('minPrice', value + 1);
    else if (/(?:최대(?:\s*가격)?|상한|예산)(?:은|는|을|이|가)?\s*[=:]?\s*$/u.test(before)) assign('maxPrice', value);
    else if (/(?:최소(?:\s*가격)?|하한)(?:은|는|을|이|가)?\s*[=:]?\s*$/u.test(before)) assign('minPrice', value);
    else if (/(?:정확히|딱)\s*$/u.test(before)) {
      assign('minPrice', value); assign('maxPrice', value);
    } else {
      if (matches.length !== 1) throw new AmbiguousConstraintError('ambiguous_price');
      if (/(?:후기|리뷰|비싸|비싼|구매했|샀|결제했)/u.test(text)) {
        throw new AmbiguousConstraintError('ambiguous_price');
      }
      const range = interpretedPriceRange(String(value) + '원' + (/^\s*대/u.test(after) ? '대' : ''));
      if (!range) throw new AmbiguousConstraintError('ambiguous_price');
      Object.assign(patch, range);
    }
  }
  if (!matches.length && (
    /(?:가격|예산|금액).*(?:늘|올|낮|줄|변경|바꿔|바꾸)/u.test(text) ||
    /\d+\s*(?:만|억|백|십)\s*(?:원)?\s*(?:이하|이상|미만|초과)/u.test(text)
  )) throw new AmbiguousConstraintError('ambiguous_price');
  return patch;
}

/**
 * 동반 의류 표현을 제외하고 검색 대상 카테고리를 추출하며 여러 종류가 남으면 확인이 필요한 오류를 던진다.
 */
function categoryPatch(text) {
  const categories = [...text.matchAll(CATEGORY_PATTERN)]
    // A companion garment ("청바지랑 입을 니트") is not the search category.
    .filter(/* 청바지와 입을 니트처럼 함께 입는 옷을 검색 대상 카테고리로 잘못 해석하지 않도록 제외한다. */ (match) => !/^(?:랑|와|과|하고|위에|에)[^.!?]{0,20}(?:입을|입기|어울릴)/u.test(text.slice(match.index + match[0].length)))
    .map(/* 찾은 한국어 의류 표현을 시스템이 사용하는 카테고리 값으로 바꾼다. */ ([word]) => CATEGORIES[word]);
  const unique = [...new Set(categories)];
  if (unique.length > 1) throw new AmbiguousConstraintError('ambiguous_category');
  return unique.length ? { category: unique[0] } : {};
}

/**
 * 엄격한 색상 지정·기존 색상 변경·대안 허용·색상 조건 해제를 문장과 이전 조건에서 해석한다.
 * 제외 색상과 필수 색상이 충돌하거나 변경 의도가 모호하면 오류를 던지고 기존 상태 보존을 유도한다.
 */
function colorPatch(text, previous) {
  const clear = /색(?:상)?(?:\s*(?:조건|제한))?(?:은|는|을|이|가)?\s*(?:상관\s*없|무관|없애|해제)/u.test(text);
  const clauses = text.split(/[.!?;\n]/u);
  const explicit = [];
  const excluded = [];
  const mentioned = [];
  for (const clause of clauses) {
    const matches = [...clause.matchAll(COLOR_PATTERN)];
    const colors = matches.map(/* 검정색 등 표기 차이를 정리한 뒤 조건 비교에 사용할 대표 색상 값으로 변환한다. */ ([word]) => canonicalColor(word.replace(/검은색|검정색/gu, '검정')));
    mentioned.push(...colors);
    const negated = matches.some(/* 색상 뒤에 싫음·제외·아님 표현이 붙어 해당 색상을 거부하는 문장인지 확인한다. */ (m) =>
      /^\s*(?:(?:색상|색|은|는|이|가|을|를|으로|만)\s*)*(?:싫|제외|빼|아닌|말고)/u.test(clause.slice(m.index + m[0].length)));
    if (negated) {
      excluded.push(...colors);
      continue;
    }
    const strict = !UNCERTAIN.test(clause) && matches.some(/* 색상 앞뒤의 꼭·필수·만 같은 표현으로 엄격한 색상 조건인지 판단한다. */ (m) =>
      STRICT_PREFIX.test(clause.slice(0, m.index)) ||
      /^\s*(?:색(?:상)?\s*)?(?:(?:바지|원피스|상의|치마|스커트|아우터)\s*)?(?:으로)?만/u.test(clause.slice(m.index + m[0].length)));
    const replacing = previous.colors.length && /(?:색상|색|로)\s*(?:바꿔|변경)/u.test(clause);
    const adding = previous.colors.length && /도\s*(?:괜찮|가능|허용)/u.test(clause);
    if (strict && matches.length > 1 && !adding) {
      const alternatives = matches.slice(1).every(/* 여러 필수 색상 사이에 또는·혹은 같은 대안 연결 표현이 있는지 검사한다. */ (m, index) =>
        /^\s*(?:또는|혹은|이나|나|와|과|,|\/)\s*$/u.test(
          clause.slice(matches[index].index + matches[index][0].length, m.index),
        ));
      if (!alternatives) throw new AmbiguousConstraintError('ambiguous_color');
    }
    if (strict || replacing) explicit.push(...colors);
    if (adding) explicit.push(...previous.colors, ...colors);
  }
  if (clear) {
    if (explicit.length) throw new AmbiguousConstraintError('ambiguous_color');
    return { colors: [] };
  }
  const effective = explicit.length ? explicit : previous.colors;
  if (excluded.some(/* 사용자가 제외한 색상이 현재 유효한 필수 색상에도 포함되어 충돌하는지 확인한다. */ (c) => effective.includes(c)) || (excluded.length && !effective.length)) {
    throw new AmbiguousConstraintError('ambiguous_color');
  }
  if (!mentioned.length && /(?:색상|색).*(?:만|필수|바꿔|변경)/u.test(text)) throw new AmbiguousConstraintError('ambiguous_color');
  if (previous.colors.length && !explicit.length &&
      mentioned.some(/* 기존 필수 색상 밖의 색상을 명확한 교체·추가 없이 언급했는지 확인한다. */ (c) => !previous.colors.includes(c) && !excluded.includes(c))) {
    throw new AmbiguousConstraintError('ambiguous_color');
  }
  return explicit.length ? { colors: explicit } : {};
}

/**
 * 판매 사이즈의 명시적 요구·변경·해제만 추출하고 평소 체형 표기는 제외하며 모호한 변경은 거부한다.
 */
function sizePatch(text) {
  const clear = /사이즈(?:\s*(?:조건|제한))?(?:은|는|를|가)?\s*(?:상관\s*없|무관|없애|해제)/u.test(text);
  const token = '(?:XXL|XL|XS|S|M|L|FREE|\\d{2,3}(?:\\s*[~-]\\s*\\d{2,3})?)';
  const patterns = [
    new RegExp('(?:판매\\s*)?사이즈\\s*(?:[=:]|는|를|을)?\\s*(' + token + ')', 'giu'),
    new RegExp('(' + token + ')\\s*사이즈', 'giu'),
  ];
  const sizes = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const before = text.slice(Math.max(0, match.index - 12), match.index);
      const after = text.slice(match.index + match[0].length, match.index + match[0].length + 15);
      if (/평소|보통/u.test(before)) continue;
      if (/판매|[=:]/u.test(match[0]) || STRICT_PREFIX.test(before) ||
          /^\s*(?:만|가?\s*있|로\s*(?:바꿔|변경))/u.test(after)) sizes.push(match[1]);
    }
  }
  if (clear && sizes.length) throw new AmbiguousConstraintError('ambiguous_size');
  if (clear) return { sizes: [] };
  if (/사이즈.*(?:바꿔|변경|만|필수)/u.test(text) && !sizes.length) throw new AmbiguousConstraintError('ambiguous_size');
  return sizes.length ? { sizes } : {};
}

// This deliberately bounded grammar never treats model tool arguments as user intent.
/**
 * 현재 사용자 문장·UI 필터와 이전 스냅샷을 받아 명시된 필수 조건 변경만 합친다.
 * 같은 필드는 이번 UI 선택을 우선하고, 문장이 모호하면 기존 조건과 확인 질문을 반환해 부분 반영을 막는다.
 */
export function resolveUserConstraints({ message, previousRequired = {}, selectedFilters = {} }) {
  const previous = requiredSnapshot(previousRequired);
  const filters = validateSelectedFilters(selectedFilters);
  const text = message.normalize('NFKC');
  try {
    if (/["“”'‘’\x60]|(?:라면|다면|경우|아니라|아니야|아니에요|아니면|말고)|(?:올리|늘리|바꾸|변경하|없애|해제하|낮추)지(?:는|도)?\s*(?:마|말|않)|안\s*(?:올리|늘리|바꾸|변경)/u.test(text)) {
      throw new AmbiguousConstraintError('ambiguous_expression');
    }
    if (/-\s*\d+\s*(?:만|천)?\s*원|원\s*(?:이하|이상|미만|초과)?(?:은|는|이|가)?\s*(?:싫|아니|안\s*(?:돼|되))/u.test(text)) {
      throw new AmbiguousConstraintError('ambiguous_price');
    }
    const patch = {
      ...(!('category' in filters) ? categoryPatch(text) : {}),
      ...(!('maxPrice' in filters) ? pricePatch(text) : {}),
      ...colorPatch(text, previous),
      ...(!('size' in filters) ? sizePatch(text) : {}),
    };
    if ('category' in filters) patch.category = filters.category;
    if ('maxPrice' in filters) {
      // UI price selection describes an upper budget, superseding this turn's text price.
      patch.minPrice = null; patch.maxPrice = filters.maxPrice;
    }
    if ('size' in filters) patch.sizes = [filters.size];
    const next = { ...previous, ...patch };
    // Referencing an earlier product/price is not an explicit condition change.
    if (/아까|지난번|추천한|추천했던|전에\s*(?:본|봤|산|샀)/u.test(text) &&
        Object.keys(patch).some(/* 과거 상품을 가리키는 문장에서 이전 조건과 달라질 필드가 있는지 검사한다. */ (field) => JSON.stringify(next[field]) !== JSON.stringify(previous[field]))) {
      throw new AmbiguousConstraintError('ambiguous_reference');
    }
    if ([next.minPrice, next.maxPrice].some(/* 해석한 가격 경계가 null이 아닌 경우 음수이거나 안전한 정수가 아닌지 검사한다. */ (price) =>
      price !== null && (!Number.isSafeInteger(price) || price < 0)) ||
      (next.minPrice !== null && next.maxPrice !== null && next.minPrice > next.maxPrice)) {
      throw new AmbiguousConstraintError('ambiguous_price');
    }
    return { required: requiredSnapshot(next), clarification: null };
  } catch (error) {
    if (!(error instanceof AmbiguousConstraintError)) throw error;
    return { required: previous, clarification: CLARIFICATION };
  }
}
