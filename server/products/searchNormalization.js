/**
 * 역할: 문자열·색상 별칭·사이즈 표기를 정리하고 상품 값과 요청 조건의 일치 여부를 판단한다.
 * 필수 색상·사이즈 필터에서 값이 없는 상품을 유지하는 공통 규칙도 제공한다.
 */

const COLOR_GROUPS = Object.freeze({
  black: ['black', '검정', '블랙', '흑청', '블랙청'],
  gray: ['gray', 'grey', '그레이', '회색', '회색톤', '그레이청', '연그레이'],
  charcoal: ['charcoal', '차콜', '먹색'],
  navy: ['navy', '네이비'],
  blue: ['blue', '파랑', '블루', '연청', '중청', '진청'],
  beige: ['beige', '베이지', '베이지톤', '연베이지', '진베이지', '회베이지'],
  brown: ['brown', '브라운', '밤색', '진밤색', '다크브라운'],
  khaki: ['khaki', '카키', '카키톤'],
  cream: ['cream', '크림', '크림톤', 'ivory', '아이보리', '오트밀'],
  white: ['white', '화이트', '흰색'],
});

const COLOR_ALIASES = new Map(
  Object.entries(COLOR_GROUPS).flatMap(([canonical, aliases]) =>
    aliases.map((alias) => [normalizeText(alias), canonical]),
  ),
);

const SIZE_LABEL_ALIASES = Object.freeze({
  small: 's',
  스몰: 's',
  medium: 'm',
  미디움: 'm',
  large: 'l',
  라지: 'l',
  extra_large: 'xl',
  extralarge: 'xl',
  엑스라지: 'xl',
  free: 'free',
  프리: 'free',
});

export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('ko-KR')
    .replace(/[\s_./-]+/gu, '')
    .replace(/[^\p{L}\p{N}~]/gu, '');
}

/** 조건 자체의 동일성을 비교하므로 부분 문자열이나 상품 옵션의 범위 겹침을 사용하지 않는다. */
export function canonicalColor(value) {
  const normalized = normalizeText(value);
  return COLOR_ALIASES.get(normalized) ?? normalized;
}

export function canonicalSize(value) {
  const text = String(value ?? '').normalize('NFKC').trim();
  const range = text.match(/^(\d+)\s*[~〜-]\s*(\d+)$/u);
  if (range) {
    return [Number(range[1]), Number(range[2])].sort((a, b) => a - b).join('~');
  }
  const normalized = normalizeText(text);
  return SIZE_LABEL_ALIASES[normalized] ?? normalized;
}

function colorTokens(value) {
  const normalized = normalizeText(value);
  const tokens = new Set([normalized]);
  const exactCanonical = COLOR_ALIASES.get(normalized);
  if (exactCanonical) {
    tokens.add(exactCanonical);
  }

  for (const [alias, canonical] of COLOR_ALIASES) {
    if (alias.length >= 2 && normalized.includes(alias)) {
      tokens.add(canonical);
    }
  }

  return tokens;
}

export function colorsMatch(left, right) {
  const leftTokens = colorTokens(left);
  const rightTokens = colorTokens(right);
  return [...leftTokens].some((token) => rightTokens.has(token));
}

function sizeLabel(value) {
  const normalized = normalizeText(value);
  const label = normalized.match(/^(free|xl|l|m|s)/u)?.[1] ?? normalized;
  return SIZE_LABEL_ALIASES[label] ?? label;
}

function sizeNumbers(value) {
  return [...String(value ?? '').normalize('NFKC').matchAll(/\d+/gu)].map(
    ([number]) => Number(number),
  );
}

function numberRange(value) {
  const numbers = sizeNumbers(value);
  if (numbers.length === 0) {
    return null;
  }
  if (numbers.length === 1) {
    return { min: numbers[0], max: numbers[0] };
  }
  return {
    min: Math.min(numbers[0], numbers[1]),
    max: Math.max(numbers[0], numbers[1]),
  };
}

export function sizesMatch(left, right) {
  const leftRange = numberRange(left);
  const rightRange = numberRange(right);
  if (leftRange && rightRange) {
    return leftRange.min <= rightRange.max && rightRange.min <= leftRange.max;
  }

  return sizeLabel(left) === sizeLabel(right);
}

export function matchesAnyValue(productValues, requestedValues, matcher) {
  return requestedValues.some((requestedValue) =>
    productValues.some((productValue) => matcher(productValue, requestedValue)),
  );
}

export function passesConditionalRequired(productValues, requestedValues, matcher) {
  if (requestedValues.length === 0 || productValues.length === 0) {
    return true;
  }
  return matchesAnyValue(productValues, requestedValues, matcher);
}
