import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveStorageDoc } from '../src/store/live-doc.ts';

// promptContents live docs are flattened so the n8n load_prompts node reads
// x.json.key / x.json.content, while the nested body is kept for n8c's diff.
test('promptContents live doc exposes {key, content} at top level AND keeps nested body', () => {
  const d = { localId: 'main_triage', name: 'main_triage', body: { key: 'main_triage', content: 'Bạn là bộ …' }, checksum: 'abc' };
  const doc = liveStorageDoc('promptContents', d) as any;
  assert.equal(doc.key, 'main_triage');        // runtime reads this
  assert.equal(doc.content, 'Bạn là bộ …');
  assert.equal(doc.mode, 'live');
  assert.deepEqual(doc.body, d.body);          // n8c getLive/diff still works
  assert.equal(doc.checksum, 'abc');
});

test('blocks-style prompt content spreads blocks to top level', () => {
  const d = { localId: 'product_build_prompt', name: 'product_build_prompt', body: { key: 'product_build_prompt', blocks: [{ name: 'B_HEADER', content: 'h' }] }, checksum: 'z' };
  const doc = liveStorageDoc('promptContents', d) as any;
  assert.ok(Array.isArray(doc.blocks));
});

test('other kinds are NOT flattened (nested body only)', () => {
  const d = { localId: 'w1', name: 'wf', body: { key: 'should-not-leak' }, checksum: 'c' };
  const doc = liveStorageDoc('workflows', d) as any;
  assert.equal(doc.key, undefined);
  assert.deepEqual(doc.body, d.body);
});

test('n8c fields win over a colliding body field', () => {
  const d = { localId: 'p3', name: 'n', body: { key: 'k', checksum: 'HACK', localId: 'HACK' }, checksum: 'real' };
  const doc = liveStorageDoc('promptContents', d) as any;
  assert.equal(doc.checksum, 'real');
  assert.equal(doc.localId, 'p3');
});
