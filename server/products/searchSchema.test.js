/**
 * 역할: 검색 도구 스키마가 추가 필드를 제한하고 공통 카테고리·태그 어휘와 필수 필드 구조를 사용하는지 검증한다.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { SEARCH_PRODUCTS_INPUT_SCHEMA } from './searchSchema.js';

function assertStrictObjects(schema, path = 'root') {
  if (schema.type === 'object') {
    assert.equal(schema.additionalProperties, false, `${path} must be strict`);
    assert.deepEqual(
      [...schema.required].sort(),
      Object.keys(schema.properties).sort(),
      `${path} must require every field`,
    );
    for (const [field, value] of Object.entries(schema.properties)) {
      assertStrictObjects(value, `${path}.${field}`);
    }
  }
  if (schema.type === 'array') {
    assertStrictObjects(schema.items, `${path}[]`);
  }
}

test('defines a strict function-call schema with controlled tag vocabulary', () => {
  assertStrictObjects(SEARCH_PRODUCTS_INPUT_SCHEMA);
  assert.deepEqual(
    SEARCH_PRODUCTS_INPUT_SCHEMA.properties.required.properties.category.enum,
    ['pants', 'top', 'dress', 'skirt', 'outerwear', null],
  );
  assert.equal(
    SEARCH_PRODUCTS_INPUT_SCHEMA.properties.preferred.properties.fitTags.items.enum.includes(
      'relaxed',
    ),
    true,
  );
  assert.equal(
    SEARCH_PRODUCTS_INPUT_SCHEMA.properties.preferred.properties.reviewSignals.properties
      .sizeFit.enum.includes('true_to_size'),
    true,
  );
});
