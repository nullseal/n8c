import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, setDebug, debugEnabled, debugRequest, debugResponse } from '../src/debug.ts';
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

function captureStderr(fn: () => void): string[] {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { lines.push(a.join(' ')); };
  setDebug(true);
  try { fn(); } finally { console.error = orig; setDebug(false); }
  return lines;
}

test('debugRequest truncates a body longer than MAX_BODY and reports the remainder', () => {
  const lines = captureStderr(() => debugRequest('POST', '/x', { blob: 'a'.repeat(3000) }));
  assert.match(lines[0], /POST \/x/);
  assert.match(lines[1], /… \(\d+ more chars\)$/);
});

test('debugRequest prints a short body in full', () => {
  const lines = captureStderr(() => debugRequest('POST', '/x', { a: 1 }));
  assert.match(lines[1], /"a": 1/);
  assert.doesNotMatch(lines[1], /more chars/);
});

test('debugRequest falls back to String(body) for an unserializable body', () => {
  const circ: any = {}; circ.self = circ;
  const lines = captureStderr(() => debugRequest('PUT', '/c', circ));
  assert.match(lines[1], /\[object Object\]/);
});

test('debugRequest prints an empty body line when the body serializes to undefined', () => {
  const lines = captureStderr(() => debugRequest('PUT', '/c', () => 1));
  assert.equal(lines.length, 2);
  assert.equal(lines[1], '');
});

test('debugResponse truncates long text with an ellipsis and prints status only when no text', () => {
  const long = captureStderr(() => debugResponse(500, 'x'.repeat(2500)));
  assert.match(long[0], /← 500 x+…$/);
  assert.equal(long[0].length, '← 500 '.length + 2000 + 1);
  assert.deepEqual(captureStderr(() => debugResponse(200)), ['← 200']);
});

test('debug output is silent while disabled', () => {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { lines.push(a.join(' ')); };
  try { debugRequest('GET', '/x', {}); debugResponse(200, 'ok'); } finally { console.error = orig; }
  assert.deepEqual(lines, []);
});

test('debugResponse prints short text verbatim, without truncation', () => {
  assert.deepEqual(captureStderr(() => debugResponse(404, 'not found')), ['← 404 not found']);
});
