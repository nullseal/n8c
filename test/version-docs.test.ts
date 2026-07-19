import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectVersionDocs, toDoc } from '../src/store/version-docs.ts';

const row = (id: string) => ({ localId: id, name: id.toUpperCase(), body: { v: id }, checksum: 'c-' + id });

test('toDoc maps a raw row to a Doc (drops extra fields like versionId/_id)', () => {
  assert.deepEqual(toDoc({ ...row('a'), versionId: 'V1', _id: 'x', mode: 'live' }),
    { localId: 'a', name: 'A', body: { v: 'a' }, checksum: 'c-a' });
});

test('current layout: per-kind rows are used, manifest.docs ignored', () => {
  const docs = selectVersionDocs([row('a'), row('b')], { docs: [row('legacy')] });
  assert.deepEqual(docs.map((d) => d.localId), ['a', 'b']);
});

test('legacy layout: falls back to manifest.docs when the per-kind collection is empty', () => {
  // This is the regression guard: a version written before the per-kind split
  // (docs embedded in the manifest) must still be readable → no "version not found".
  const docs = selectVersionDocs([], { versionId: 'V1', docs: [row('legacy1'), row('legacy2')] });
  assert.deepEqual(docs.map((d) => d.localId), ['legacy1', 'legacy2']);
  assert.deepEqual(docs[0], { localId: 'legacy1', name: 'LEGACY1', body: { v: 'legacy1' }, checksum: 'c-legacy1' });
});

test('genuinely empty version → [] (no rows, no embedded docs, or missing manifest)', () => {
  assert.deepEqual(selectVersionDocs([], { docs: [] }), []);
  assert.deepEqual(selectVersionDocs([], {}), []);
  assert.deepEqual(selectVersionDocs([], null), []);
});
