import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, checksum } from '../src/checksum.ts';

test('canonicalize sorts object keys but keeps array order', () => {
  assert.equal(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalize([3, 1, 2]), '[3,1,2]');
  assert.equal(canonicalize({ z: { y: 1, x: 2 } }), '{"z":{"x":2,"y":1}}');
});

test('checksum is stable regardless of key order', () => {
  assert.equal(checksum({ a: 1, b: 2 }), checksum({ b: 2, a: 1 }));
});

test('checksum ignores volatile keys deeply', () => {
  const a = { name: 'x', updatedAt: '2026-01-01', meta: { id: '1', v: 9 } };
  const b = { name: 'x', updatedAt: '2099-12-31', meta: { id: '2', v: 9 } };
  assert.equal(checksum(a), checksum(b));
});

test('checksum differs when meaningful content differs', () => {
  assert.notEqual(checksum({ name: 'x' }), checksum({ name: 'y' }));
});
