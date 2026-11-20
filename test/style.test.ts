import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setStyle, status } from '../src/style.ts';

test('status colours a failed apply row red', () => {
  setStyle(true);
  try {
    assert.equal(status('failed'), '\x1b[31mfailed\x1b[0m');
  } finally { setStyle(false); }
});

test('status colours known words and passes unknown words through uncoloured', () => {
  setStyle(true);
  try {
    assert.equal(status('new'), '\x1b[32mnew\x1b[0m');
    // unknown word: empty colour code, still wrapped with the reset
    assert.equal(status('mystery'), 'mystery\x1b[0m');
  } finally { setStyle(false); }
  assert.equal(status('mystery'), 'mystery');
});
