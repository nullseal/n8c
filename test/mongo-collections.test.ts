import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCollections, collectionForKind, COLLECTION_KEYS } from '../src/store/collections.ts';

test('resolveCollections: defaults use the n8c_ prefix for every collection', () => {
  const c = resolveCollections();
  assert.deepEqual(c, {
    workflows: 'n8c_workflows', prompts: 'n8c_prompts', credentials: 'n8c_credentials',
    definitions: 'n8c_definitions', manifests: 'n8c_manifests', promptContents: 'n8c_prompt_contents',
  });
  assert.equal(COLLECTION_KEYS.length, 6);
});

test('resolveCollections: a custom prefix renames ALL collections', () => {
  const c = resolveCollections({ collectionPrefix: 'myapp_' });
  for (const k of COLLECTION_KEYS) assert.ok(c[k].startsWith('myapp_'), `${k} should use custom prefix`);
  assert.equal(c.promptContents, 'myapp_prompt_contents');
});

test('resolveCollections: per-name overrides win over the prefix', () => {
  const c = resolveCollections({ collectionPrefix: 'x_', collections: { promptContents: 'runtime_prompts', definitions: 'def_map' } });
  assert.equal(c.promptContents, 'runtime_prompts');
  assert.equal(c.definitions, 'def_map');
  assert.equal(c.workflows, 'x_workflows'); // others still follow the prefix
});

test('collectionForKind maps a kind to its physical name; rejects unknown', () => {
  const c = resolveCollections();
  assert.equal(collectionForKind(c, 'prompts'), 'n8c_prompts');
  assert.throws(() => collectionForKind(c, 'bogus'), /unknown kind/);
});
