import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, setDebug, debugEnabled } from '../src/debug.ts';
import { buildProgram } from '../src/cli.ts';

test('redact masks every value under `data` but KEEPS the key names', () => {
  // The key names are the whole point: they're what you need when n8n rejects a
  // credential for a missing field. The values are secrets that must never print.
  const out: any = redact({
    name: 'Qdrant Api-key',
    type: 'httpHeaderAuth',
    isPartialData: true,
    data: { name: 'Authorization', value: 'sk-live-REAL', allowedDomains: '' },
  });
  assert.equal(out.name, 'Qdrant Api-key', 'non-secret fields stay readable');
  assert.equal(out.isPartialData, true);
  assert.deepEqual(Object.keys(out.data), ['name', 'value', 'allowedDomains'], 'key names preserved');
  assert.deepEqual(Object.values(out.data), ['***', '***', '***'], 'values masked');
});

test('redact masks secret-looking keys anywhere, not just under data', () => {
  const out: any = redact({ apiKey: 'sk-live', password: 'hunter2', nested: { token: 'abc', keep: 'visible' } });
  assert.equal(out.apiKey, '***');
  assert.equal(out.password, '***');
  assert.equal(out.nested.token, '***');
  assert.equal(out.nested.keep, 'visible', 'unrelated values are untouched');
});

test('redact walks arrays and tolerates null/undefined', () => {
  const out: any = redact({ items: [{ data: { k: 'secret' } }, { name: 'ok' }], nothing: null });
  assert.equal(out.items[0].data.k, '***');
  assert.equal(out.items[1].name, 'ok');
  assert.equal(out.nothing, null);
});

test('setDebug toggles the flag', () => {
  try {
    assert.equal(debugEnabled(), false, 'off by default');
    setDebug(true);
    assert.equal(debugEnabled(), true);
  } finally { setDebug(false); }
});

test('--debug is a global flag', () => {
  assert.ok(buildProgram().options.some((o) => o.long === '--debug'));
});
