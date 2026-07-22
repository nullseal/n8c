import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/store/memory.ts';
import { computePlan, desiredBundleChecksum, writeState, readState, statePath, type State } from '../src/engine/state.ts';
import { applyFromState } from '../src/engine/apply-state.ts';
import { verifyBeforeApply } from '../src/engine/verify.ts';
import { checksum } from '../src/checksum.ts';

function scaffold(): { root: string; nroot: string } {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  const nroot = join(root, 'n8c');
  mkdirSync(nroot, { recursive: true });
  return { root, nroot };
}
function writePrompt(nroot: string, id: string, key: string, content: string) {
  const dir = join(nroot, 'prompts', id); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'metadata.json'), JSON.stringify({ name: key }));
  writeFileSync(join(dir, 'apply.ts'), `export default ${JSON.stringify({ key, content })};\n`);
}
function writeWorkflow(nroot: string, id: string, name: string, nodes: any[]) {
  const dir = join(nroot, 'workflows', id); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'metadata.json'), JSON.stringify({ name }));
  writeFileSync(join(dir, 'apply.ts'), `export default ${JSON.stringify({ name, nodes, connections: {} })};\n`);
}
function writeCredential(nroot: string, id: string, name: string, type = 'httpHeaderAuth') {
  const dir = join(nroot, 'credentials', id); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'metadata.json'), JSON.stringify({ name }));
  writeFileSync(join(dir, 'apply.ts'), `export default ${JSON.stringify({ name, type })};\n`);
}
const ctxOf = (store: MemoryStore, n8n: any = { listWorkflows: async () => [] }) =>
  ({ env: 'default', encrypted: false, n8n, getDefinitions: (k: string) => store.getDefinitions('default', k) } as any);

test('computePlan marks a new prompt as create and writes a state file', async () => {
  const { root, nroot } = scaffold();
  try {
    writePrompt(nroot, 'p1', 'main', 'hello');
    const store = new MemoryStore();
    const state = await computePlan(store, nroot, ctxOf(store), { destroy: false, version: '0.0.0' });
    assert.equal(state.summary.create, 1);
    assert.equal(state.resources.find((r) => r.localId === 'p1')!.action, 'create');
    const file = writeState(root, 'default', state);
    assert.equal(file, statePath(root, 'default'));
    assert.deepEqual(readState(root, 'default').resources, state.resources);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('desiredBundleChecksum changes when a file changes (staleness guard input)', async () => {
  const { root, nroot } = scaffold();
  try {
    writePrompt(nroot, 'p1', 'main', 'v1');
    const store = new MemoryStore();
    const a = await desiredBundleChecksum(nroot, ctxOf(store));
    writePrompt(nroot, 'p1', 'main', 'v2');
    const b = await desiredBundleChecksum(nroot, ctxOf(store));
    assert.notEqual(a, b);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('readState errors when there is no plan', () => {
  const { root } = scaffold();
  try { assert.throws(() => readState(root, 'default'), /no plan/); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test('applyFromState commits a prompt (no push) and records it applied', async () => {
  const { root, nroot } = scaffold();
  try {
    writePrompt(nroot, 'p1', 'main', 'hello');
    const store = new MemoryStore();
    const state: State = { env: 'default', n8cVersion: '0', createdAt: '', desiredChecksum: '', summary: { create: 1, update: 0, noop: 0, delete: 0 },
      resources: [{ kind: 'prompts', localId: 'p1', name: 'main', action: 'create', fromChecksum: null, toChecksum: 'x' }], applied: null };
    const done = await applyFromState(store, nroot, ctxOf(store), state);
    assert.deepEqual(done.applied!.ok, ['p1']);
    const live = await store.getLive('prompts');
    assert.equal((live[0].body as any).key, 'main');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('applyFromState pushes a workflow THEN commits; server-drift deploys even if DB matches', async () => {
  const { root, nroot } = scaffold();
  try {
    writeWorkflow(nroot, 'w1', 'W', [{ id: 'n1', name: 'A', parameters: { x: 1 } }]);
    const store = new MemoryStore();
    // DB already has the same doc (would look "identical") — the plan said update from SERVER drift.
    await store.withTransaction((s) => store.putDefinitions('default', 'workflows', { w1: 'N1' }, s));
    const pushed: any[] = [];
    const n8n = { listWorkflows: async () => [], updateWorkflow: async (id: string, b: any) => { pushed.push({ id, b }); } };
    const state: State = { env: 'default', n8cVersion: '0', createdAt: '', desiredChecksum: '', summary: { create: 0, update: 1, noop: 0, delete: 0 },
      resources: [{ kind: 'workflows', localId: 'w1', name: 'W', action: 'update', fromChecksum: 'a', toChecksum: 'b' }], applied: null };
    const done = await applyFromState(store, nroot, ctxOf(store, n8n), state);
    assert.equal(pushed.length, 1, 'pushed to n8n');
    assert.equal(pushed[0].id, 'N1');
    assert.deepEqual(done.applied!.ok, ['w1']);
    assert.equal((await store.getLive('workflows')).length, 1, 'committed after push');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('computePlan: a credential already in the env mapping is never re-created (no duplicate on n8n)', async () => {
  const { root, nroot } = scaffold();
  try {
    writeCredential(nroot, 'c1', 'OpenAI');
    const store = new MemoryStore();
    // already bound to this env's n8n (via pull) — NOT via apply, so the credential
    // live docs are empty. It must never read as `create` (that would duplicate on
    // n8n); with no baseline for the file it reads as `update`, which PATCHes in place.
    await store.withTransaction((s) => store.putDefinitions('default', 'credentials', { c1: { id: 'N1', name: 'OpenAI' } }, s));
    const state = await computePlan(store, nroot, ctxOf(store), { destroy: false, version: '0' });
    assert.equal(state.resources.find((r) => r.localId === 'c1')!.action, 'update');
    assert.equal(state.summary.create, 0, 'never creates a duplicate');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('deleting a credential file is reported as an orphan, and planned as delete with --destroy', async () => {
  const { root, nroot } = scaffold();
  try {
    // c1 has a file; c2 was deleted (mapping + live doc remain)
    writeCredential(nroot, 'c1', 'Keep');
    const store = new MemoryStore();
    await store.withTransaction((s) => store.putDefinitions('default', 'credentials', {
      c1: { id: 'N1', name: 'Keep' }, c2: { id: 'N2', name: 'Gone' },
    }, s));
    await store.withTransaction((s) => store.putLive('credentials', [
      { localId: 'c2', name: 'Gone', body: { name: 'Gone', type: 'httpHeaderAuth' }, checksum: 'x' },
    ], s));

    // without --destroy: no delete planned, but reported as an orphan (not silent)
    const plain = await computePlan(store, nroot, ctxOf(store), { destroy: false, version: '0' });
    assert.equal(plain.resources.some((r) => r.action === 'delete'), false, 'never destroys implicitly');
    assert.deepEqual(plain.orphans?.map((o) => `${o.kind}:${o.name}`), ['credentials:Gone'], 'orphan surfaced');

    // with --destroy: planned as a delete
    const destroy = await computePlan(store, nroot, ctxOf(store), { destroy: true, version: '0' });
    const del = destroy.resources.find((r) => r.action === 'delete')!;
    assert.equal(del.kind, 'credentials');
    assert.equal(del.localId, 'c2');
    assert.equal(destroy.summary.delete, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('deleting a prompt-content file is reported/planned the same way', async () => {
  const { root, nroot } = scaffold();
  try {
    const store = new MemoryStore();
    await store.withTransaction((s) => store.putLive('promptContents', [
      { localId: 'pc1', name: 'main_triage', body: { key: 'main_triage' }, checksum: 'x' },
    ], s));
    const plain = await computePlan(store, nroot, ctxOf(store), { destroy: false, version: '0' });
    assert.deepEqual(plain.orphans?.map((o) => o.kind), ['promptContents']);
    const destroy = await computePlan(store, nroot, ctxOf(store), { destroy: true, version: '0' });
    assert.equal(destroy.resources.find((r) => r.kind === 'promptContents')!.action, 'delete');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('applyFromState deletes a credential via deleteCredential (not deleteWorkflow) and drops its mapping', async () => {
  const { root, nroot } = scaffold();
  try {
    const store = new MemoryStore();
    await store.withTransaction((s) => store.putDefinitions('default', 'credentials', { c2: { id: 'N2', name: 'Gone' } }, s));
    await store.withTransaction((s) => store.putLive('credentials', [
      { localId: 'c2', name: 'Gone', body: { name: 'Gone', type: 'httpHeaderAuth' }, checksum: 'x' },
    ], s));
    const deleted: string[] = [];
    const ctx = { ...ctxOf(store), n8n: { listWorkflows: async () => [], deleteCredential: async (id: string) => { deleted.push(id); } } } as any;
    const state: State = {
      env: 'default', n8cVersion: '0', createdAt: '', desiredChecksum: '',
      summary: { create: 0, update: 0, noop: 0, delete: 1 },
      resources: [{ kind: 'credentials', localId: 'c2', name: 'Gone', action: 'delete', fromChecksum: 'x', toChecksum: null }],
      applied: null,
    };
    await applyFromState(store, nroot, ctx, state);
    assert.deepEqual(deleted, ['N2'], 'deleted by the mapped n8n id, via deleteCredential');
    assert.deepEqual(await store.getLive('credentials'), [], 'live doc removed');
    assert.deepEqual(await store.getDefinitions('default', 'credentials'), {}, 'mapping removed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('computePlan: an unmapped credential is create', async () => {
  const { root, nroot } = scaffold();
  try {
    writeCredential(nroot, 'c1', 'OpenAI');
    const store = new MemoryStore();
    const state = await computePlan(store, nroot, ctxOf(store), { destroy: false, version: '0' });
    assert.equal(state.resources.find((r) => r.localId === 'c1')!.action, 'create');
    assert.equal(state.summary.create, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- credential server-diff (list + updatedAt), n8n API 1.1.x ---
const credCtx = (store: MemoryStore, serverCreds: any[]) =>
  ({ env: 'default', encrypted: false, n8n: { listWorkflows: async () => [], listCredentials: async () => serverCreds }, getDefinitions: (k: string) => store.getDefinitions('default', k) } as any);

// `seedLive: false` reproduces a credential that was pulled/mapped but never
// applied — i.e. no live doc, so there's no baseline for the file's content.
async function planCredAction(server: any[], mapping: any, opts: { seedLive?: boolean } = {}): Promise<string> {
  const { root, nroot } = scaffold();
  try {
    writeCredential(nroot, 'c1', 'OpenAI', 'openAiApi');
    const store = new MemoryStore();
    if (mapping) await store.withTransaction((s) => store.putDefinitions('default', 'credentials', { c1: mapping }, s));
    if (opts.seedLive !== false) {
      const body = { name: 'OpenAI', type: 'openAiApi' }; // matches writeCredential's file
      await store.withTransaction((s) => store.putLive('credentials', [{ localId: 'c1', name: 'OpenAI', body, checksum: checksum(body) }], s));
    }
    const state = await computePlan(store, nroot, credCtx(store, server), { destroy: false, version: '0' });
    return state.resources.find((r) => r.localId === 'c1')!.action;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('credential with NO live baseline → update (a file edit must never read as "no changes")', async () => {
  // regression: editing `data` on a pulled-but-never-applied credential showed noop,
  // because fileChanged required a live doc. A secret can't be read back from n8n,
  // so without a baseline we must assume the file differs.
  const action = await planCredAction(
    [{ id: 'N1', name: 'OpenAI', type: 'openAiApi', updatedAt: 'T1' }],
    { id: 'N1', name: 'OpenAI', updatedAt: 'T1' },
    { seedLive: false },
  );
  assert.equal(action, 'update');
});

test('credential server-diff: mapped + server matches (name/type/updatedAt) → noop', async () => {
  const action = await planCredAction([{ id: 'N1', name: 'OpenAI', type: 'openAiApi', updatedAt: 'T1' }], { id: 'N1', name: 'OpenAI', updatedAt: 'T1' });
  assert.equal(action, 'noop');
});
test('credential server-diff: updatedAt changed on n8n (external edit) → update', async () => {
  const action = await planCredAction([{ id: 'N1', name: 'OpenAI', type: 'openAiApi', updatedAt: 'T2' }], { id: 'N1', name: 'OpenAI', updatedAt: 'T1' });
  assert.equal(action, 'update');
});
test('credential server-diff: name/type drift → update', async () => {
  const action = await planCredAction([{ id: 'N1', name: 'Renamed', type: 'openAiApi', updatedAt: 'T1' }], { id: 'N1', name: 'OpenAI', updatedAt: 'T1' });
  assert.equal(action, 'update');
});
test('credential server-diff: mapped id gone on n8n → create (recreate)', async () => {
  const action = await planCredAction([], { id: 'N1', name: 'OpenAI', updatedAt: 'T1' });
  assert.equal(action, 'create');
});

function writePromptContent(nroot: string, id: string, key: string, content: string) {
  const dir = join(nroot, 'prompt-contents', id); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'metadata.json'), JSON.stringify({ name: key }));
  writeFileSync(join(dir, 'apply.ts'), `export default ${JSON.stringify({ key, content })};\n`);
}

test('computePlan: a new prompt-content is create (DB-only entity, no n8n)', async () => {
  const { root, nroot } = scaffold();
  try {
    writePromptContent(nroot, 'pc1', 'main_triage', 'Bạn là …');
    const store = new MemoryStore();
    const state = await computePlan(store, nroot, ctxOf(store), { destroy: false, version: '0' });
    const r = state.resources.find((x) => x.kind === 'promptContents')!;
    assert.equal(r.action, 'create');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('computePlan: prompt-content is skipped when the store disables it (e.g. sqlite)', async () => {
  const { root, nroot } = scaffold();
  try {
    writePromptContent(nroot, 'pc1', 'main_triage', 'Bạn là …');
    const store = new MemoryStore();
    const ctx = { ...ctxOf(store), promptContentsEnabled: false };
    const state = await computePlan(store, nroot, ctx, { destroy: false, version: '0' });
    assert.equal(state.resources.some((x) => x.kind === 'promptContents'), false, 'no promptContents resource planned');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('applyFromState: prompt-content writes DB live only, never touches n8n', async () => {
  const { root, nroot } = scaffold();
  try {
    writePromptContent(nroot, 'pc1', 'main_triage', 'Bạn là …');
    const store = new MemoryStore();
    const ctx = { env: 'default', encrypted: false, n8n: undefined, getDefinitions: (k: string) => store.getDefinitions('default', k) } as any;
    const state: State = { env: 'default', n8cVersion: '0', createdAt: '', desiredChecksum: '', summary: { create: 1, update: 0, noop: 0, delete: 0 },
      resources: [{ kind: 'promptContents', localId: 'pc1', name: 'main_triage', action: 'create', fromChecksum: null, toChecksum: 'x' }], applied: null };
    const done = await applyFromState(store, nroot, ctx, state);
    assert.deepEqual(done.applied!.ok, ['pc1']);
    const live = await store.getLive('promptContents');
    assert.equal((live[0].body as any).key, 'main_triage');
    assert.equal((live[0].body as any).content, 'Bạn là …');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('apply bumps ALL kinds to one shared generation versionId (coherent release)', async () => {
  const { root, nroot } = scaffold();
  try {
    writePrompt(nroot, 'p1', 'main', 'hi');
    writePromptContent(nroot, 'pc1', 'main_triage', 'runtime');
    const store = new MemoryStore();
    const ctx = ctxOf(store);
    await applyFromState(store, nroot, ctx, await computePlan(store, nroot, ctx, { destroy: false, version: '0' }));

    const vP = await store.listVersions('prompts');
    const vPC = await store.listVersions('promptContents');
    assert.equal(vP.length, 1); assert.equal(vPC.length, 1);
    assert.equal(vP[0].versionId, vPC[0].versionId, 'prompts and prompt-content share ONE generation id');
    assert.ok(vP[0].isActive && vPC[0].isActive, 'the generation is active for every kind');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('apply records the --message on the release (every kind of the generation)', async () => {
  const { root, nroot } = scaffold();
  try {
    writePrompt(nroot, 'p1', 'main', 'hi');
    writePromptContent(nroot, 'pc1', 'main_triage', 'runtime');
    const store = new MemoryStore();
    const ctx = ctxOf(store);
    await applyFromState(store, nroot, ctx, await computePlan(store, nroot, ctx, { destroy: false, version: '0' }), { message: 'ship triage v2' });
    for (const kind of ['prompts', 'promptContents']) {
      const active = (await store.listVersions(kind)).find((v) => v.isActive)!;
      assert.equal(active.message, 'ship triage v2', `message recorded on ${kind}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('apply bumps an UNCHANGED kind too (changing only prompts still versions prompt-content)', async () => {
  const { root, nroot } = scaffold();
  try {
    writePrompt(nroot, 'p1', 'main', 'v1');
    writePromptContent(nroot, 'pc1', 'main_triage', 'runtime');
    const store = new MemoryStore();
    const ctx = ctxOf(store);
    await applyFromState(store, nroot, ctx, await computePlan(store, nroot, ctx, { destroy: false, version: '0' }));
    const gen1 = (await store.listVersions('promptContents'))[0].versionId;

    // change ONLY the prompt, re-apply
    writePrompt(nroot, 'p1', 'main', 'v2');
    await applyFromState(store, nroot, ctx, await computePlan(store, nroot, ctx, { destroy: false, version: '0' }));

    const vPC = await store.listVersions('promptContents');
    const vP = await store.listVersions('prompts');
    assert.equal(vPC.length, 2, 'unchanged prompt-content still got a new version (bump-all)');
    const gen2 = vPC.find((v) => v.isActive)!.versionId;
    assert.notEqual(gen2, gen1, 'a new generation');
    assert.equal(vP.find((v) => v.isActive)!.versionId, gen2, 'both kinds share the new generation');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('apply that changes nothing creates no generation (no empty releases)', async () => {
  const { root, nroot } = scaffold();
  try {
    writePrompt(nroot, 'p1', 'main', 'hi');
    const store = new MemoryStore();
    const ctx = ctxOf(store);
    await applyFromState(store, nroot, ctx, await computePlan(store, nroot, ctx, { destroy: false, version: '0' }));
    const before = (await store.listVersions('prompts')).length;
    // re-apply the (now clean) plan — nothing changed
    await applyFromState(store, nroot, ctx, await computePlan(store, nroot, ctx, { destroy: false, version: '0' }));
    assert.equal((await store.listVersions('prompts')).length, before, 'no new version when nothing changed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('applyFromState: workflow setActive reconciles active state (activate/deactivate)', async () => {
  const { root, nroot } = scaffold();
  try {
    writeWorkflow(nroot, 'w1', 'W', [{ id: 'n1', name: 'A', parameters: {} }]);
    const store = new MemoryStore();
    await store.withTransaction((s) => store.putDefinitions('default', 'workflows', { w1: 'N1' }, s));
    const calls = { activate: 0, deactivate: 0 };
    const n8n = { listWorkflows: async () => [], updateWorkflow: async () => ({}),
      activateWorkflow: async () => { calls.activate++; }, deactivateWorkflow: async () => { calls.deactivate++; } };
    const ctx = { env: 'default', encrypted: false, n8n, getDefinitions: (k: string) => store.getDefinitions('default', k) } as any;
    const state: State = { env: 'default', n8cVersion: '0', createdAt: '', desiredChecksum: '', summary: { create: 0, update: 1, noop: 0, delete: 0 },
      resources: [{ kind: 'workflows', localId: 'w1', name: 'W', action: 'update', fromChecksum: 'a', toChecksum: 'b', setActive: true }], applied: null };
    await applyFromState(store, nroot, ctx, state);
    assert.equal(calls.activate, 1, 'activated');
    assert.equal(calls.deactivate, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('applyFromState: workflow delete ARCHIVES (soft), not hard-delete', async () => {
  const { root, nroot } = scaffold();
  try {
    const store = new MemoryStore();
    await store.withTransaction((s) => store.putDefinitions('default', 'workflows', { w1: 'N1' }, s));
    await store.withTransaction((s) => store.putLive('workflows', [{ localId: 'w1', name: 'W', body: {}, checksum: 'c' }], s));
    const calls = { archive: 0, del: 0 };
    const n8n = { listWorkflows: async () => [], archiveWorkflow: async () => { calls.archive++; }, deleteWorkflow: async () => { calls.del++; } };
    const ctx = { env: 'default', encrypted: false, n8n, getDefinitions: (k: string) => store.getDefinitions('default', k) } as any;
    const state: State = { env: 'default', n8cVersion: '0', createdAt: '', desiredChecksum: '', summary: { create: 0, update: 0, noop: 0, delete: 1 },
      resources: [{ kind: 'workflows', localId: 'w1', name: 'W', action: 'delete', fromChecksum: 'c', toChecksum: null }], applied: null };
    const done = await applyFromState(store, nroot, ctx, state);
    assert.equal(calls.archive, 1, 'archived');
    assert.equal(calls.del, 0, 'not hard-deleted');
    assert.deepEqual(done.applied!.ok, ['w1']);
    assert.equal((await store.getLive('workflows')).length, 0, 'removed from live');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('applyFromState: an archived workflow delete hard-deletes; a live one still archives', async () => {
  const { root, nroot } = scaffold();
  try {
    const store = new MemoryStore();
    await store.withTransaction((s) => store.putDefinitions('default', 'workflows', { wArch: 'N_ARCH', wLive: 'N_LIVE' }, s));
    await store.withTransaction((s) => store.putLive('workflows', [
      { localId: 'wArch', name: 'A', body: {}, checksum: 'x' },
      { localId: 'wLive', name: 'L', body: {}, checksum: 'y' },
    ], s));
    const calls: string[] = [];
    const n8n = {
      listWorkflows: async () => [],
      archiveWorkflow: async (id: string) => { calls.push(`archive:${id}`); },
      deleteWorkflow: async (id: string) => { calls.push(`delete:${id}`); },
    };
    const ctx = { env: 'default', encrypted: false, n8n, getDefinitions: (k: string) => store.getDefinitions('default', k) } as any;
    const state: State = {
      env: 'default', n8cVersion: '0', createdAt: '', desiredChecksum: '',
      summary: { create: 0, update: 0, noop: 0, delete: 2 },
      resources: [
        { kind: 'workflows', localId: 'wArch', name: 'A', action: 'delete', fromChecksum: 'x', toChecksum: null, archived: true },
        { kind: 'workflows', localId: 'wLive', name: 'L', action: 'delete', fromChecksum: 'y', toChecksum: null },
      ],
      applied: null,
    };
    await applyFromState(store, nroot, ctx, state);
    assert.ok(calls.includes('delete:N_ARCH'), 'archived → DELETE /workflows/{id}');
    assert.ok(calls.includes('archive:N_LIVE'), 'live → archive (soft)');
    assert.equal(calls.includes('archive:N_ARCH'), false, 'archived is never archived-again');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('applyFromState: credential update PATCHes in place (no duplicate)', async () => {
  const { root, nroot } = scaffold();
  try {
    writeCredential(nroot, 'c1', 'OpenAI', 'openAiApi');
    const store = new MemoryStore();
    await store.withTransaction((s) => store.putDefinitions('default', 'credentials', { c1: { id: 'N1', name: 'OpenAI', updatedAt: 'T1' } }, s));
    const calls = { create: 0, patch: 0 };
    const n8n = { listWorkflows: async () => [], listCredentials: async () => [],
      createCredential: async () => { calls.create++; return { id: 'NEW', updatedAt: 'T9' }; },
      updateCredential: async (id: string) => { calls.patch++; return { id, updatedAt: 'T2' }; } };
    const ctx = { env: 'default', encrypted: false, n8n, getDefinitions: (k: string) => store.getDefinitions('default', k) } as any;
    const state: State = { env: 'default', n8cVersion: '0', createdAt: '', desiredChecksum: '', summary: { create: 0, update: 1, noop: 0, delete: 0 },
      resources: [{ kind: 'credentials', localId: 'c1', name: 'OpenAI', action: 'update', fromChecksum: null, toChecksum: 'x' }], applied: null };
    const done = await applyFromState(store, nroot, ctx, state);
    assert.deepEqual(done.applied!.ok, ['c1']);
    assert.equal(calls.patch, 1, 'PATCH in place');
    assert.equal(calls.create, 0, 'no duplicate create');
    assert.equal((await store.getDefinitions('default', 'credentials') as any).c1.updatedAt, 'T2', 'new updatedAt stored');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- server baseline recording (Task 4) ---
// Wires MemoryStore + a temp root + the given n8n stub into computePlan, mirroring
// the setup the other computePlan tests in this file use (ctxOf/credCtx).
async function computePlanForTest(n8n: any): Promise<State> {
  const { root, nroot } = scaffold();
  try {
    const store = new MemoryStore();
    const ctx = { env: 'default', encrypted: false, n8n, getDefinitions: (k: string) => store.getDefinitions('default', k) } as any;
    return await computePlan(store, nroot, ctx, { destroy: false, version: '0.0.0' });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('computePlan records the server baseline so apply can detect drift', async () => {
  const state = await computePlanForTest({
    listWorkflows: async () => [{ id: 'W1', name: 'Main', nodes: [], connections: {}, updatedAt: 'T1' }],
    listCredentials: async () => [{ id: 'C1', name: 'Mongo', type: 'mongoDb', updatedAt: 'T1' }],
  });
  assert.equal(state.serverListed, true);
  assert.equal(state.serverFacts?.workflows.W1?.includes('T1'), true);
  assert.equal(state.serverFacts?.credentials.C1?.includes('Mongo'), true);
});

// Fix 1: the baseline must be captured BEFORE any other server read, so a UI edit
// landing mid-plan can never be baked into the "before" picture as if it were
// original. Also closes the double-listing: listCredentials must be called once,
// not once for the baseline and again for the credentials diff.
test('Fix 1: baseline capture happens before planAgainstServer\'s own server read, and listCredentials is called only once', async () => {
  const { root, nroot } = scaffold();
  try {
    const store = new MemoryStore();
    const calls: string[] = [];
    let workflowListCalls = 0;
    const n8n = {
      listWorkflows: async () => {
        calls.push('listWorkflows');
        workflowListCalls++;
        // The property the fix exists for, not just call order: the SECOND read
        // (planAgainstServer's own) reports a different updatedAt than the first
        // (the baseline capture). If the baseline were captured late — e.g. moved
        // back to the end of computePlan — it would silently pick up this later
        // value instead of the true "before" snapshot, and the assertion below
        // on state.serverFacts would catch it even though the call order looks fine.
        return [{ id: 'W1', name: 'Main', nodes: [], connections: {}, updatedAt: workflowListCalls === 1 ? 'T1-BASELINE' : 'T2-LATER' }];
      },
      listCredentials: async () => { calls.push('listCredentials'); return []; },
    };
    const ctx = { env: 'default', encrypted: false, n8n, getDefinitions: (k: string) => store.getDefinitions('default', k) } as any;
    const state = await computePlan(store, nroot, ctx, { destroy: false, version: '0.0.0' });
    // listCredentials: exactly once (baseline + credentials-diff reuse the same call).
    // listWorkflows: once for the baseline (facts), once for planAgainstServer's full
    // diff — and the baseline's call must come first.
    assert.deepEqual(calls, ['listCredentials', 'listWorkflows', 'listWorkflows']);
    assert.ok(state.serverFacts?.workflows.W1?.includes('T1-BASELINE'), 'the recorded baseline must be the FIRST read');
    assert.equal(state.serverFacts?.workflows.W1?.includes('T2-LATER'), false, 'not the later value planAgainstServer saw');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Fix 1, path 1: the credential listing can succeed while the baseline read
// itself throws (computePlan's own catch around readServerFacts). serverFacts
// ends up undefined but `listed` stays true — serverListed must still read
// false, or apply would treat this as "verified" and fail open.
test('Fix 1: baseline read throwing (credential listing still succeeds) yields serverListed=false, and verifyBeforeApply stops', async () => {
  const { root, nroot } = scaffold();
  try {
    const store = new MemoryStore();
    let workflowCalls = 0;
    const n8n = {
      // First call is the baseline capture inside computePlan — throws, so the
      // catch there leaves serverFacts undefined. Second call is
      // planAgainstServer's own read and must succeed, or computePlan crashes
      // instead of returning a degraded state to assert on.
      listWorkflows: async () => { workflowCalls++; if (workflowCalls === 1) throw new Error('transient 500'); return []; },
      listCredentials: async () => [{ id: 'C1', name: 'Mongo', type: 'mongoDb', updatedAt: 'T1' }],
    };
    const ctx = { env: 'default', encrypted: false, n8n, getDefinitions: (k: string) => store.getDefinitions('default', k) } as any;
    const state = await computePlan(store, nroot, ctx, { destroy: false, version: '0.0.0' });
    assert.equal(state.serverFacts, undefined, 'baseline read threw — no facts recorded');
    assert.equal(state.serverListed, false, 'listing succeeded but the baseline did not — the flag tracks the baseline, not just the listing call');

    const applyCtx = { ...ctx, n8n: { listWorkflows: async () => [], listCredentials: async () => [] } };
    const outcome = await verifyBeforeApply(applyCtx, state);
    assert.equal(outcome.decision, 'stop', 'a plan with no recorded baseline must never apply unverified');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a failed credential listing is recorded, not silently ignored', async () => {
  const state = await computePlanForTest({
    listWorkflows: async () => [],
    listCredentials: async () => { throw new Error('401 Unauthorized'); },
  });
  assert.equal(state.serverListed, false, 'plan degraded to file-vs-live and says so');
});

// The CLI's plan handler prints one of two different messages when
// `serverListed` is false, chosen by whether `onCredentialsListError` fired.
// `serverListed === false` is not one condition — it covers both a failed
// credential listing (diff IS degraded) and a failed baseline snapshot after
// a successful listing (diff is NOT degraded). Assert the callback itself
// distinguishes them, since that's what cli.ts branches on.
test('serverListed=false from a failed credential listing sets the transient listError signal', async () => {
  const { root, nroot } = scaffold();
  try {
    const store = new MemoryStore();
    const ctx = { env: 'default', encrypted: false, n8n: { listWorkflows: async () => [], listCredentials: async () => { throw new Error('401 Unauthorized'); } }, getDefinitions: (k: string) => store.getDefinitions('default', k) } as any;
    let listError: string | undefined;
    const state = await computePlan(store, nroot, ctx, { destroy: false, version: '0', onCredentialsListError: (message) => { listError = message; } });
    assert.equal(state.serverListed, false);
    assert.equal(listError, '401 Unauthorized', 'listing failure surfaces its own error');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('serverListed=false from a failed baseline snapshot (listing succeeded) leaves listError unset', async () => {
  const { root, nroot } = scaffold();
  try {
    const store = new MemoryStore();
    let workflowCalls = 0;
    const n8n = {
      // First call is the baseline capture — throws, so serverFacts ends up
      // undefined. Second call is planAgainstServer's own read and must
      // succeed, or computePlan crashes before returning a state to assert on.
      listWorkflows: async () => { workflowCalls++; if (workflowCalls === 1) throw new Error('transient 500'); return []; },
      listCredentials: async () => [{ id: 'C1', name: 'Mongo', type: 'mongoDb', updatedAt: 'T1' }],
    };
    const ctx = { env: 'default', encrypted: false, n8n, getDefinitions: (k: string) => store.getDefinitions('default', k) } as any;
    let listError: string | undefined;
    const state = await computePlan(store, nroot, ctx, { destroy: false, version: '0', onCredentialsListError: (message) => { listError = message; } });
    assert.equal(state.serverListed, false, 'same flag value as a failed listing');
    assert.equal(listError, undefined, 'but the listing itself never failed — the CLI must tell these two apart');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- Fix 2: a failed listing must yield an undefined baseline, not an empty one ---
// (listWorkflows is also used by the workflows-diff step earlier in computePlan,
// so only listCredentials can fail here without the plan aborting before it ever
// reaches readServerFacts — that earlier crash is pre-existing and out of scope.)
test('computePlan still returns a state, with serverFacts left undefined, when the n8n client throws', async () => {
  const state = await computePlanForTest({
    listWorkflows: async () => [],
    listCredentials: async () => { throw new Error('500 boom'); },
  });
  assert.ok(state, 'computePlan does not crash on a listing failure');
  assert.equal(state.serverFacts, undefined, 'no baseline recorded — NOT an empty one (that would read as "everything vanished")');
});

// --- Fix 1 regression guard: the raw n8n error body must never reach disk ---
test('serialized state never contains a serverListError key', async () => {
  const state = await computePlanForTest({
    listWorkflows: async () => [],
    listCredentials: async () => { throw new Error('401 Unauthorized: token=super-secret-value'); },
  });
  assert.equal((state as any).serverListError, undefined, 'not on the State object either');
  const serialized = JSON.stringify(state, null, 2) + '\n'; // mirrors writeState's own serialization
  assert.ok(!serialized.includes('serverListError'), 'not in the on-disk JSON');
});

// --- archived workflows (Task 2): n8n rejects updates to an archived workflow ---
async function computePlanForArchivedTest(opts: { server: any[]; file: { localId: string; name: string; node: any } | null; destroy: boolean }) {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { MemoryStore } = await import('../src/store/memory.ts');
  const { computePlan } = await import('../src/engine/state.ts');
  const root = mkdtempSync(join(tmpdir(), 'n8c-archp-'));
  try {
    if (opts.file) {
      const dir = join(root, 'workflows', opts.file.localId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'metadata.json'), JSON.stringify({ name: opts.file.name }) + '\n');
      const n = JSON.stringify(opts.file.node);
      writeFileSync(join(dir, 'apply.ts'),
        `export default () => ({ name: ${JSON.stringify(opts.file.name)}, nodes: [${n}], connections: {}, settings: {}, meta: { n8cLocalId: ${JSON.stringify(opts.file.localId)} } });\n`);
    }
    const ctx = {
      env: 'default', encrypted: false,
      n8n: { listWorkflows: async () => opts.server, listCredentials: async () => [] },
      getDefinitions: async () => ({}),
    } as any;
    return await computePlan(new MemoryStore(), root, ctx, { destroy: opts.destroy, version: '0' });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

// A workflow archived on n8n that still has a matching local file whose body differs
// must NOT be planned as an update (the API rejects it) — it is a noop, and is
// surfaced in `ignored` so the operator knows the change is waiting on an unarchive.
test('archived workflow with a differing file → noop + reported in ignored', async () => {
  const state = await computePlanForArchivedTest({
    server: [{ id: 'W1', name: 'Old', nodes: [{ name: 'a', type: 't', parameters: { v: 1 } }], connections: {}, settings: {}, isArchived: true, meta: { n8cLocalId: 'wf1' } }],
    file: { localId: 'wf1', name: 'Old', node: { name: 'a', type: 't', parameters: { v: 2 } } }, // v differs
    destroy: false,
  });
  const r = state.resources.find((x) => x.localId === 'wf1');
  assert.equal(r.action, 'noop', 'archived workflow is never updated');
  assert.ok((state.ignored ?? []).some((i) => i.localId === 'wf1'), 'reported as skipped');
});

// Archived, file gone, --destroy → a delete flagged archived (apply hard-deletes it).
test('archived workflow with no file + --destroy → delete flagged archived', async () => {
  const state = await computePlanForArchivedTest({
    server: [{ id: 'W1', name: 'Old', nodes: [], connections: {}, settings: {}, isArchived: true, meta: { n8cLocalId: 'wf1' } }],
    file: null, destroy: true,
  });
  const r = state.resources.find((x) => x.localId === 'wf1');
  assert.equal(r.action, 'delete');
  assert.equal(r.archived, true, 'delete carries the archived flag for a hard delete');
});

// Archived, file gone, no --destroy → orphan (unchanged safety gate).
test('archived workflow with no file, no --destroy → orphan', async () => {
  const state = await computePlanForArchivedTest({
    server: [{ id: 'W1', name: 'Old', nodes: [], connections: {}, settings: {}, isArchived: true, meta: { n8cLocalId: 'wf1' } }],
    file: null, destroy: false,
  });
  assert.ok((state.orphans ?? []).some((o) => o.localId === 'wf1'));
  assert.equal(state.resources.some((x) => x.localId === 'wf1'), false);
});

// Control: a LIVE workflow with a differing file is still an update (behaviour preserved).
test('non-archived workflow with a differing file → update (unchanged)', async () => {
  const state = await computePlanForArchivedTest({
    server: [{ id: 'W1', name: 'Live', nodes: [{ name: 'a', type: 't', parameters: { v: 1 } }], connections: {}, settings: {}, isArchived: false, meta: { n8cLocalId: 'wf1' } }],
    file: { localId: 'wf1', name: 'Live', node: { name: 'a', type: 't', parameters: { v: 2 } } },
    destroy: false,
  });
  assert.equal(state.resources.find((x) => x.localId === 'wf1').action, 'update');
  assert.equal((state.ignored ?? []).length, 0);
});

test('applyFromState does NOT commit the live doc when the n8n push throws', async () => {
  const { root, nroot } = scaffold();
  try {
    writeWorkflow(nroot, 'w1', 'W', [{ id: 'n1', name: 'A', parameters: {} }]);
    const store = new MemoryStore();
    await store.withTransaction((s) => store.putDefinitions('default', 'workflows', { w1: 'N1' }, s));
    const n8n = { listWorkflows: async () => [], updateWorkflow: async () => { throw new Error('400 read-only'); } };
    const state: State = { env: 'default', n8cVersion: '0', createdAt: '', desiredChecksum: '', summary: { create: 0, update: 1, noop: 0, delete: 0 },
      resources: [{ kind: 'workflows', localId: 'w1', name: 'W', action: 'update', fromChecksum: 'a', toChecksum: 'b' }], applied: null };
    const done = await applyFromState(store, nroot, ctxOf(store, n8n), state);
    assert.equal(done.applied!.ok.length, 0);
    assert.equal(done.applied!.failed.length, 1);
    assert.match(done.applied!.failed[0].error, /read-only/);
    assert.equal((await store.getLive('workflows')).length, 0, 'live NOT committed on push failure');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
