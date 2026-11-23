/**
 * 역할: 상품명에서 홍보 태그와 긴 검색 키워드 문구를 걷어내 화면용 이름을 만든다.
 * 긴 이름은 글자 수에 맞춰 줄이고 정리 결과가 비면 원래 이름을 사용한다.
 */

const SQUARE_TAG_PATTERN = /\[[^\]]*\]|【[^】]*】/gu;
const PARENTHETICAL_PATTERN = /\([^)]*\)|（[^）]*）/gu;
const TRAILING_SEPARATOR_PATTERN = /[\s,;/|·-]+$/u;

function removeLongSeoBlock(name) {
  for (const match of name.matchAll(PARENTHETICAL_PATTERN)) {
    const content = match[0].slice(1, -1);
    const hyphenCount = [...content].filter((character) => character === '-').length;
    if (content.length >= 40 || hyphenCount >= 2) {
      return name.slice(0, match.index);
    }
  }

  return name;
}

function removeSeoKeywordSuffix(name) {
  const firstComma = name.indexOf(',');
  if (firstComma === -1) return name;

  const remainingCommaCount = [...name.slice(firstComma + 1)]
    .filter((character) => character === ',')
    .length;

  return remainingCommaCount > 0 ? name.slice(0, firstComma) : name;
}

export function formatProductDisplayName(name, maxLength = 28) {
  const original = String(name ?? '').replace(/\s+/gu, ' ').trim();
  if (!original) return '';

  const withoutSeoBlock = removeLongSeoBlock(original);
  const withoutMarketingTags = withoutSeoBlock
    .replace(SQUARE_TAG_PATTERN, ' ')
    .replace(PARENTHETICAL_PATTERN, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const cleaned = removeSeoKeywordSuffix(withoutMarketingTags)
    .replace(TRAILING_SEPARATOR_PATTERN, '')
    .trim() || original;
  const characters = [...cleaned];

  if (characters.length <= maxLength) return cleaned;
  return `${characters.slice(0, maxLength).join('').trimEnd()}…`;
}
