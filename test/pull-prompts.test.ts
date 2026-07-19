import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/store/memory.ts';
import { pullPromptsFromNodes } from '../src/engine/pull-prompts.ts';
import { exportDocs } from '../src/engine/transfer.ts';
import { computePlan } from '../src/engine/state.ts';

const workflows = [{
  id: 'wf1', name: 'Main', meta: { n8cLocalId: 'wf-uuid' },
  nodes: [
    { name: 'Triage', type: 'x.agent', parameters: { text: '=user', options: { systemMessage: 'you are triage' } } },
  ],
}];

function ctx(store: MemoryStore, wfs = workflows) {
  return { env: 'staging', encrypted: false, n8n: { listWorkflows: async () => wfs }, getDefinitions: async () => ({}) } as any;
}

test('pull --from-nodes extracts prompts with type + provenance and snapshots', async () => {
  const store = new MemoryStore();
  const r = await pullPromptsFromNodes(store, ctx(store));
  assert.equal(r.count, 2); // system + user
  const docs = await store.getVersion('prompts', r.versionId!);
  const sys = docs.find((d) => (d.body as any).type === 'system')!;
  assert.equal((sys.body as any).content, 'you are triage');
  assert.equal((sys.body as any).source.workflow, 'wf-uuid');
  assert.match(sys.localId, /[0-9a-f-]{36}/, 'localId is a UUID');
});

test('pull adopts extracted prompts as live so a following plan is clean (no phantom creates)', async () => {
  const store = new MemoryStore();
  const c = ctx(store);
  const r = await pullPromptsFromNodes(store, c);
  // pull populated live docs (not just a version) — this is what plan diffs against
  const live = await store.getLive('prompts');
  assert.equal(live.length, r.count, 'live docs match the pulled set');
  assert.deepEqual(live.map((d) => d.checksum).sort(), r.docs.map((d) => d.checksum).sort());

  // reproduce the user's flow: export the pulled docs to files, then plan
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  const nroot = join(root, 'n8c'); mkdirSync(nroot, { recursive: true });
  try {
    await exportDocs({ kind: 'prompts', hasServer: false } as any, nroot, r.docs);
    const state = await computePlan(store, nroot, c, { destroy: false, version: '0' });
    const promptRes = state.resources.filter((x) => x.kind === 'prompts');
    assert.equal(promptRes.length, r.count, 'all extracted prompts are present in the plan');
    assert.equal(promptRes.every((x) => x.action === 'noop'), true, 'plan shows them as noop, not create');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pull prunes orphan prompt dirs from earlier pulls (no phantom "create")', async () => {
  const store = new MemoryStore();
  const c = ctx(store);
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  const nroot = join(root, 'n8c'); mkdirSync(nroot, { recursive: true });
  try {
    const r1 = await pullPromptsFromNodes(store, c);
    await exportDocs({ kind: 'prompts', hasServer: false } as any, nroot, r1.docs);

    // simulate an orphan dir left by an earlier (buggy) pull that used a different localId
    const ghost = join(nroot, 'prompts', '00000000-0000-4000-8000-000000000000');
    mkdirSync(ghost, { recursive: true });
    writeFileSync(join(ghost, 'metadata.json'), '{"name":"ghost"}');
    writeFileSync(join(ghost, 'apply.ts'), 'export default { key: "ghost", content: "x" };\n');

    // re-pull → export must remove the orphan so files mirror the pulled set
    const r2 = await pullPromptsFromNodes(store, c);
    await exportDocs({ kind: 'prompts', hasServer: false } as any, nroot, r2.docs);
    const dirs = readdirSync(join(nroot, 'prompts')).sort();
    assert.equal(dirs.includes('00000000-0000-4000-8000-000000000000'), false, 'orphan dir pruned');

    const state = await computePlan(store, nroot, c, { destroy: false, version: '0' });
    assert.equal(state.resources.filter((x) => x.kind === 'prompts').every((x) => x.action === 'noop'), true,
      'plan clean — no phantom create from the orphan');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('skips archived workflows', async () => {
  const store = new MemoryStore();
  const wfs = [
    { id: 'a', name: 'A', nodes: [{ name: 'n', type: 'x.agent', parameters: { options: { systemMessage: 'keep' } } }] },
    { id: 'b', name: 'B', isArchived: true, nodes: [{ name: 'n', type: 'x.agent', parameters: { options: { systemMessage: 'drop' } } }] },
  ];
  const r = await pullPromptsFromNodes(store, ctx(store, wfs));
  const contents = (await store.getVersion('prompts', r.versionId!)).map((d) => (d.body as any).content);
  assert.deepEqual(contents, ['keep']);
});

test('re-pull reuses localIds by provenance and dedups', async () => {
  const store = new MemoryStore();
  const r1 = await pullPromptsFromNodes(store, ctx(store));
  const firstSysId = (await store.getVersion('prompts', r1.versionId!)).find((d) => (d.body as any).type === 'system')!.localId;

  const r2 = await pullPromptsFromNodes(store, ctx(store));
  assert.equal(r2.deduped, true, 'unchanged re-pull dedups');
  assert.equal((await store.listVersions('prompts')).length, 1);

  // change the prompt -> new version, but SAME localId (provenance matched)
  const changed = [{ ...workflows[0], nodes: [{ name: 'Triage', type: 'x.agent', parameters: { text: '=user', options: { systemMessage: 'you are triage v2' } } }] }];
  const r3 = await pullPromptsFromNodes(store, ctx(store, changed));
  assert.equal(r3.deduped, false);
  const sysId = (await store.getVersion('prompts', r3.versionId!)).find((d) => (d.body as any).type === 'system')!.localId;
  assert.equal(sysId, firstSysId, 'same provenance keeps the same localId across edits');
});
