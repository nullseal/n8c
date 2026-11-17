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

// --- fields outside `nodes` (rename & friends) -------------------------------
// `plan` used to decide changed-vs-identical from the nodes array and the active
// flag alone, so renaming a workflow — the one field n8n shows you — was a silent
// no-op: the plan printed the NEW name (read from the file) next to "identical".
const named = (name: string, extra: any = {}) => ({ name, nodes: [{ id: 'n1', name: 'A', parameters: { x: 1 } }], connections: {}, ...extra });

test('planDiff: renaming the workflow is a change (name is pushed, so it must be diffed)', () => {
  const r = planDiff(named('New Name'), named('Old Name'));
  assert.equal(r.status, 'changed');
  assert.deepEqual(r.fields, ['name']);
});

test('planDiff: rewiring connections is a change even when every node is identical', () => {
  const r = planDiff(named('W', { connections: { A: { main: [[{ node: 'B', type: 'main', index: 0 }]] } } }), named('W'));
  assert.equal(r.status, 'changed');
  assert.deepEqual(r.fields, ['connections']);
});

test('planDiff: changing a settings value the file sets is a change', () => {
  const r = planDiff(named('W', { settings: { executionOrder: 'v1' } }), named('W', { settings: { executionOrder: 'v0' } }));
  assert.equal(r.status, 'changed');
  assert.deepEqual(r.fields, ['settings.executionOrder']);
});

// Subset semantics: a push only sends what the file defines, so a setting n8n
// filled in on its own is not drift. Demanding equality here would make every
// n8c-created workflow read as changed forever, pushing `settings: {}` in a loop.
test('planDiff: a setting n8n defaulted but the file never set is NOT a change', () => {
  const r = planDiff(named('W', { settings: {} }), named('W', { settings: { executionOrder: 'v1', binaryMode: 'default' } }));
  assert.equal(r.status, 'identical');
});

test('planDiff: a settings key n8n\'s API does not accept is never diffed', () => {
  const r = planDiff(named('W', { settings: { binaryMode: 'filesystem' } }), named('W', { settings: { binaryMode: 'default' } }));
  assert.equal(r.status, 'identical', 'binaryMode is read-only — a diff on it could never be applied');
});

// The [n8c-managed] marker is appended by n8c itself (layout.ts), not written by
// the operator. Diffing it raw would flip EVERY workflow in a repo to "changed"
// the first time this comparison shipped, over text nobody edited.
test('planDiff: the [n8c-managed] description marker alone is not a change', () => {
  const r = planDiff(named('W', { description: '[n8c-managed]' }), named('W'));
  assert.equal(r.status, 'identical');
});

test('planDiff: a real description edit IS a change', () => {
  const r = planDiff(named('W', { description: 'Handles refunds\n[n8c-managed]' }), named('W', { description: '[n8c-managed]' }));
  assert.equal(r.status, 'changed');
  assert.deepEqual(r.fields, ['description']);
});

test('planDiff: meta is never diffed (n8n rejects it on push)', () => {
  const r = planDiff(named('W', { meta: { n8cLocalId: 'wf1' } }), named('W', { meta: { instanceId: 'abc' } }));
  assert.equal(r.status, 'identical');
});

// staticData is n8n's own runtime scratch space ($getWorkflowStaticData persists
// into it between executions), not authored config. Diffing it would report a
// change on every workflow that uses it, every time it ran.
test('planDiff: staticData drift on the server is not a change', () => {
  const r = planDiff(named('W', { staticData: { cursor: 1 } }), named('W', { staticData: { cursor: 99 } }));
  assert.equal(r.status, 'identical');
});

test('normalizeCredentials: tolerates a missing body and nodes without nodes/credentials', () => {
  assert.deepEqual(normalizeCredentials(undefined, {}), {});
  assert.deepEqual(normalizeCredentials({ name: 'W' }, {}), { name: 'W' });
});

test('normalizeCredentials: a credential ref without an id is dropped, and the credentials key goes with it', () => {
  const out = normalizeCredentials({ nodes: [
    { name: 'A', credentials: { openAiApi: { name: 'only a name' } } },
    { name: 'B', credentials: { openAiApi: null, slackApi: { id: 'L1', name: 'S' } } },
  ] }, { L1: 'N1' });
  assert.equal('credentials' in out.nodes[0], false, 'all refs idless → credentials removed');
  assert.deepEqual(out.nodes[1].credentials, { slackApi: { credentialId: 'N1' } }, 'idless ref skipped, mapped ref kept');
});

test('planDiff: a new workflow with id-less / name-less nodes names each node by whichever it has, and survives no nodes at all', () => {
  const r = planDiff({ nodes: [{ name: 'OnlyName' }, { id: 'only-id' }] }, undefined);
  assert.equal(r.status, 'new');
  assert.deepEqual(r.nodes.map((n: any) => [n.id, n.name]), [['OnlyName', 'OnlyName'], ['only-id', 'only-id']]);
  assert.deepEqual(planDiff({}, undefined).nodes, []);
});

test('planAgainstServer: refuses without an n8n connection', async () => {
  const { entityByKind } = await import('../src/entities/index.ts');
  const ctx = { env: 'default', encrypted: false, getDefinitions: async () => ({}) } as any;
  await assert.rejects(() => planAgainstServer(new MemoryStore(), entityByKind['workflows'], '/nonexistent', ctx), /--plan needs an n8n connection/);
});

test('planAgainstServer: refuses kinds with no server state to compare', async () => {
  const { entityByKind } = await import('../src/entities/index.ts');
  const ctx = { env: 'default', encrypted: false, n8n: {}, getDefinitions: async () => ({}) } as any;
  await assert.rejects(() => planAgainstServer(new MemoryStore(), entityByKind['prompts'], '/nonexistent', ctx), /--plan is not supported for prompts/);
});

test('planAgainstServer: a server-only row from a source that reports no serverId carries serverId undefined', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { entityByKind } = await import('../src/entities/index.ts');
  const root = mkdtempSync(join(tmpdir(), 'n8c-noid-'));
  try {
    // a descriptor whose server listing has no serverId (a defensive case: the workflow
    // descriptor always stringifies the id)
    const desc = { ...entityByKind['workflows'], pullFromServer: async () => [{ localId: 'ghost', name: 'Ghost', body: {} }] } as any;
    const ctx = { env: 'default', encrypted: false, n8n: {}, getDefinitions: async () => ({}) } as any;
    const rows = await planAgainstServer(new MemoryStore(), desc, root, ctx);
    assert.deepEqual(rows, [{ localId: 'ghost', name: 'Ghost', status: 'removed', checksum: '', archived: false, serverId: undefined }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
