import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptSecret, decryptSecret, isEncrypted } from '../src/crypto.ts';

test('round-trips a secret', () => {
  const plain = JSON.stringify({ token: 'shpat_123', n: 5 });
  const enc = encryptSecret(plain, 'my-key');
  assert.ok(isEncrypted(enc));
  assert.notEqual(enc, plain);
  assert.equal(decryptSecret(enc, 'my-key'), plain);
});

test('different calls produce different ciphertext (random salt+iv)', () => {
  const a = encryptSecret('x', 'k');
  const b = encryptSecret('x', 'k');
  assert.notEqual(a, b);
});

test('wrong key fails to decrypt', () => {
  const enc = encryptSecret('x', 'right');
  assert.throws(() => decryptSecret(enc, 'wrong'));
});

test('malformed payload throws', () => {
  assert.throws(() => decryptSecret('not-encrypted', 'k'), /bad encryption payload/);
});
