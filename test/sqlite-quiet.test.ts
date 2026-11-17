import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/store/sqlite-quiet.ts';

async function warningsFor(msg: any): Promise<string[]> {
  const seen: string[] = [];
  const listener = (w: Error) => { seen.push(w.message); };
  process.on('warning', listener);
  try {
    process.emitWarning(msg);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  } finally { process.off('warning', listener); }
  return seen;
}

test('sqlite-quiet swallows only the SQLite experimental warning', async () => {
  assert.deepEqual(await warningsFor('SQLite is an experimental feature and might change at any time'), []);
  assert.deepEqual(await warningsFor('something else entirely'), ['something else entirely']);
  assert.deepEqual(await warningsFor(new Error('an Error-object warning')), ['an Error-object warning']);
});
