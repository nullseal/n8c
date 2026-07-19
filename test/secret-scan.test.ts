import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanWorkflowSecrets } from '../src/engine/secret-scan.ts';

test('flags a known token prefix in node params', () => {
  const body = { nodes: [{ name: 'Sync', parameters: { jsCode: "const t = 'shpat_0123456789abcdef';" } }] };
  const f = scanWorkflowSecrets(body);
  assert.equal(f.length, 1);
  assert.match(f[0], /Sync: possible Shopify access token/);
});

test('flags a prefix-less long hex token (Storefront-style)', () => {
  const body = { nodes: [{ name: 'Indexer', parameters: { jsCode: "const t='492636" + 'a'.repeat(30) + "';" } }] };
  assert.ok(scanWorkflowSecrets(body).some((x) => /long hex/.test(x)));
});

test('a clean workflow produces no findings', () => {
  const body = { nodes: [{ name: 'Http', parameters: { url: 'https://example.com/api', method: 'GET' } }] };
  assert.deepEqual(scanWorkflowSecrets(body), []);
});

test('short hex / short ids are not flagged', () => {
  const body = { nodes: [{ name: 'X', parameters: { credId: 'gVghO1VDRwZwtbpa', hex: 'deadbeef' } }] };
  assert.deepEqual(scanWorkflowSecrets(body), []);
});
