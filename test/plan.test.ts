import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planDiff, normalizeCredentials, planAgainstServer } from '../src/engine/plan.ts';
import { MemoryStore } from '../src/store/memory.ts';

const wf = (nodes: any[]) => ({ name: 'W', nodes, connections: {} });

test('planDiff: identical logic → in sync', () => {
  const a = wf([{ id: 'n1', name: 'A', parameters: { x: 1 } }]);
  const b = wf([{ id: 'n1', name: 'A', parameters: { x: 1 } }]);
  const r = planDiff(a, b);
  assert.equal(r.status, 'identical');
});

test('planDiff: a changed param → drift on that node', () => {
  const a = wf([{ id: 'n1', name: 'A', parameters: { x: 2 } }]);
  const b = wf([{ id: 'n1', name: 'A', parameters: { x: 1 } }]);
  const r = planDiff(a, b);
  assert.equal(r.status, 'changed');
  assert.equal(r.nodes.find((n: any) => n.id === 'n1').status, 'changed');
});

test('planDiff: credential-only difference is ignored (env-specific)', () => {
  // The file's localId ('LOCAL_UUID') resolves through this env's mapping to the
  // server's n8n id ('N8N_ID') — that's what makes this a non-change, not the old
  // blanket `delete n.credentials`. Without the mapping this IS a real rebind
  // (see the "an UNMAPPED localId reads as changed" case below).
  const a = wf([{ id: 'n1', name: 'A', parameters: { x: 1 }, credentials: { openAiApi: { id: 'LOCAL_UUID', name: 'K' } } }]);
  const b = wf([{ id: 'n1', name: 'A', parameters: { x: 1 }, credentials: { openAiApi: { id: 'N8N_ID', name: 'K' } } }]);
  assert.equal(planDiff(a, b, { LOCAL_UUID: 'N8N_ID' }).status, 'identical');
});

test('planDiff: not on server → new', () => {
  const a = wf([{ id: 'n1', name: 'A', parameters: {} }]);
  const r = planDiff(a, undefined);
  assert.equal(r.status, 'new');
  assert.equal(r.nodes[0].status, 'new');
});

test('planDiff: node removed on the code side shows as removed', () => {
  const a = wf([{ id: 'n1', name: 'A', parameters: {} }]);
  const b = wf([{ id: 'n1', name: 'A', parameters: {} }, { id: 'n2', name: 'B', parameters: {} }]);
  const r = planDiff(a, b);
  assert.equal(r.status, 'changed');
  assert.ok(r.nodes.some((n: any) => n.id === 'n2' && n.status === 'removed'));
});

test('planDiff: active flag drift → changed + setActive (even if nodes identical)', () => {
  const nodes = [{ id: 'n1', name: 'A', parameters: {} }];
  const r = planDiff({ ...wf(nodes), active: true }, { ...wf(nodes), active: false });
  assert.equal(r.status, 'changed');
  assert.equal(r.setActive, true);
});

test('planDiff: same content + same active → identical, no setActive', () => {
  const nodes = [{ id: 'n1', name: 'A', parameters: {} }];
  const r = planDiff({ ...wf(nodes), active: false }, { ...wf(nodes), active: false });
  assert.equal(r.status, 'identical');
  assert.equal(r.setActive, undefined);
});

// localId used in the FILE, and the n8n ids it maps to in two different envs.
const LOCAL_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const LOCAL_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const STAGING = { [LOCAL_A]: 'n8nCredA', [LOCAL_B]: 'n8nCredB' };

function node(creds?: Record<string, { id: string; name?: string }>) {
  const n: any = { id: 'n1', name: 'qdrant_search', type: 'n8n-nodes-base.httpRequest',
    typeVersion: 1, position: [0, 0], parameters: { url: 'https://q' } };
  if (creds) n.credentials = creds;
  return n;
}
const wf2 = (n: any) => ({ name: 'W', active: false, nodes: [n], connections: {} });

// The server always speaks n8n ids; the file always speaks localIds.
const serverBoundToA = wf2(node({ httpHeaderAuth: { id: 'n8nCredA', name: 'Qdrant Api-key' } }));

test('rebinding a node to a DIFFERENT credential is a change', () => {
  const desired = wf2(node({ httpHeaderAuth: { id: LOCAL_B, name: 'Other key' } }));
  assert.equal(planDiff(desired, serverBoundToA, STAGING).status, 'changed');
});

test('REMOVING a credential from a node is a change', () => {
  assert.equal(planDiff(wf2(node()), serverBoundToA, STAGING).status, 'changed');
});

test('ADDING a credential to a bare node is a change', () => {
  const serverBare = wf2(node());
  const desired = wf2(node({ httpHeaderAuth: { id: LOCAL_A } }));
  assert.equal(planDiff(desired, serverBare, STAGING).status, 'changed');
});

test('changing the credential TYPE key is a change', () => {
  const desired = wf2(node({ httpBasicAuth: { id: LOCAL_A } }));
  assert.equal(planDiff(desired, serverBoundToA, STAGING).status, 'changed');
});

test('an unchanged binding is identical — across envs, where the same localId maps to a DIFFERENT n8n id', () => {
  // This is the false positive the old `delete n.credentials` existed to avoid.
  // Normalization must keep it away: same file, two envs, no phantom change.
  const desired = wf2(node({ httpHeaderAuth: { id: LOCAL_A, name: 'Qdrant Api-key' } }));
  assert.equal(planDiff(desired, serverBoundToA, STAGING).status, 'identical', 'staging');

  const prodServer = wf2(node({ httpHeaderAuth: { id: 'prodCredA', name: 'Qdrant Api-key' } }));
  assert.equal(planDiff(desired, prodServer, { [LOCAL_A]: 'prodCredA' }).status, 'identical', 'prod');
});

test('renaming a credential alone is NOT a workflow change (the binding id is what matters)', () => {
  // The credentials kind plans the rename itself; diffing `name` here would
  // re-introduce false positives on every rename.
  const desired = wf2(node({ httpHeaderAuth: { id: LOCAL_A, name: 'Renamed key' } }));
  assert.equal(planDiff(desired, serverBoundToA, STAGING).status, 'identical');
});

test('an UNMAPPED localId reads as changed — the binding cannot be satisfied yet', () => {
  const desired = wf2(node({ httpHeaderAuth: { id: 'ffffffff-9999-4999-8999-ffffffffffff' } }));
  assert.equal(planDiff(desired, serverBoundToA, STAGING).status, 'changed');
});

test('normalizeCredentials drops the display name and resolves ids', () => {
  const out = normalizeCredentials(wf2(node({ httpHeaderAuth: { id: LOCAL_A, name: 'x' } })), STAGING);
  assert.deepEqual(out.nodes[0].credentials, { httpHeaderAuth: { credentialId: 'n8nCredA' } });
  const bare = normalizeCredentials(wf2(node()), STAGING);
  assert.equal('credentials' in bare.nodes[0], false, 'no credentials key when the node has none');
});

// Minimal ctx whose n8n returns two workflows, one archived. buildDocs reads the
// files under root; point root at a temp dir with one matching workflow file so the
// desired side lines up with the live 'keep' workflow by its meta marker localId.
test('planAgainstServer marks rows whose server workflow is archived', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'n8c-arch-'));
  try {
    const dir = join(root, 'workflows', 'liveLocal');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'metadata.json'), JSON.stringify({ name: 'Keep' }) + '\n');
    writeFileSync(join(dir, 'apply.ts'),
      'export default () => ({ name: "Keep", nodes: [], connections: {}, settings: {}, meta: { n8cLocalId: "liveLocal" } });\n');

    const server = [
      { id: 'W_KEEP', name: 'Keep', nodes: [], connections: {}, settings: {}, isArchived: false, meta: { n8cLocalId: 'liveLocal' } },
      { id: 'W_ARCH', name: 'Old', nodes: [], connections: {}, settings: {}, isArchived: true, meta: { n8cLocalId: 'archLocal' } },
    ];
    const ctx = {
      env: 'default', encrypted: false,
      n8n: { listWorkflows: async () => server },
      getDefinitions: async () => ({}),
    } as any;

    const rows = await planAgainstServer(new MemoryStore(), (await import('../src/entities/index.ts')).entityByKind['workflows'], root, ctx);
    const keep = rows.find((r) => r.localId === 'liveLocal')!;
    const arch = rows.find((r) => r.localId === 'archLocal')!;
    assert.equal(keep.archived, false, 'live workflow not archived');
    assert.equal(arch.archived, true, 'server-only archived workflow flagged');
    assert.equal(arch.status, 'removed', 'no local file → removed (deletable)');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
