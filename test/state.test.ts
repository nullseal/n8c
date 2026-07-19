import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/store/memory.ts';
import { computePlan, desiredBundleChecksum, writeState, readState, statePath, type State } from '../src/engine/state.ts';
import { applyFromState } from '../src/engine/apply-state.ts';

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

test('computePlan: a credential already in the env mapping is noop (no duplicate on n8n)', async () => {
  const { root, nroot } = scaffold();
  try {
    writeCredential(nroot, 'c1', 'OpenAI');
    const store = new MemoryStore();
    // already bound to this env's n8n (via pull / environment init) — NOT via apply,
    // so the credential live docs are empty. Must still read as noop, not create.
    await store.withTransaction((s) => store.putDefinitions('default', 'credentials', { c1: { id: 'N1', name: 'OpenAI' } }, s));
    const state = await computePlan(store, nroot, ctxOf(store), { destroy: false, version: '0' });
    assert.equal(state.resources.find((r) => r.localId === 'c1')!.action, 'noop');
    assert.equal(state.summary.create, 0);
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

async function planCredAction(server: any[], mapping: any): Promise<string> {
  const { root, nroot } = scaffold();
  try {
    writeCredential(nroot, 'c1', 'OpenAI', 'openAiApi');
    const store = new MemoryStore();
    if (mapping) await store.withTransaction((s) => store.putDefinitions('default', 'credentials', { c1: mapping }, s));
    const state = await computePlan(store, nroot, credCtx(store, server), { destroy: false, version: '0' });
    return state.resources.find((r) => r.localId === 'c1')!.action;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

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
