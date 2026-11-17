import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/store/memory.ts';
import { computePlan } from '../src/engine/state.ts';
import { applyFromState } from '../src/engine/apply-state.ts';

// A project code unit (`src/<unit>/`, metadata.target = nodeId) is inlined into its
// Code node when apply builds the workflow. `plan` must diff that SAME body against
// n8n — otherwise a change that lives only in the unit is invisible (plan says noop,
// apply skips the row, the code never deploys), and a deployed unit never plans as
// in sync (the unit's code on n8n always differs from the unit-less body).

// Stateful stand-in for n8n: keeps what was pushed and lists it back.
function fakeN8n() {
  const workflows = new Map<string, any>();
  const copy = (v: any) => JSON.parse(JSON.stringify(v));
  return {
    workflows,
    listWorkflows: async () => [...workflows.values()].map(copy),
    listCredentials: async () => [],
    createWorkflow: async (body: any) => {
      const id = 'WF' + (workflows.size + 1);
      workflows.set(id, { ...copy(body), id, active: false, isArchived: false });
      return { id };
    },
    updateWorkflow: async (id: string, body: any) => {
      workflows.set(id, { ...workflows.get(id), ...copy(body), id });
      return {};
    },
  };
}

// <root>/n8c/workflows/w1 in the nodes/ layout, with one Code node `code1`.
// `ownCode` is the node's own code.ts, if it has one.
function project(ownCode?: string): { root: string; nroot: string } {
  const root = mkdtempSync(join(tmpdir(), 'n8c-unit-plan-'));
  const nroot = join(root, 'n8c');
  const wf = join(nroot, 'workflows', 'w1');
  const node = join(wf, 'nodes', 'code1');
  mkdirSync(node, { recursive: true });
  writeFileSync(join(wf, 'metadata.json'), JSON.stringify({ name: 'W' }));
  writeFileSync(join(node, 'metadata.json'), JSON.stringify({ name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, position: [0, 0] }));
  writeFileSync(join(node, 'apply.ts'), 'export default { mode: "runOnceForAllItems" };\n');
  if (ownCode !== undefined) writeFileSync(join(node, 'code.ts'), ownCode);
  return { root, nroot };
}

// <root>/src/greet — a unit whose built code feeds node code1.
function writeUnit(root: string, code: string): void {
  const unit = join(root, 'src', 'greet');
  mkdirSync(unit, { recursive: true });
  writeFileSync(join(unit, 'metadata.json'), JSON.stringify({ target: 'code1' }));
  writeFileSync(join(unit, 'code.ts'), code);
}

const ctxOf = (store: MemoryStore, n8n: any) =>
  ({ env: 'default', encrypted: false, n8n, getDefinitions: (k: string) => store.getDefinitions('default', k) } as any);
const plan = (store: MemoryStore, nroot: string, n8n: any) =>
  computePlan(store, nroot, ctxOf(store, n8n), { destroy: false, version: '0' });
const w1 = (state: any) => state.resources.find((r: any) => r.kind === 'workflows' && r.localId === 'w1');
const serverCode = (n8n: ReturnType<typeof fakeN8n>): string =>
  [...n8n.workflows.values()][0].nodes.find((n: any) => n.id === 'code1').parameters.jsCode;

test('plan sees a code change that lives only in src/<unit>, and apply deploys it', async () => {
  const { root, nroot } = project("return [{ json: { greeting: 'hello' } }];\n");
  try {
    const store = new MemoryStore(); const n8n = fakeN8n();
    await applyFromState(store, nroot, ctxOf(store, n8n), await plan(store, nroot, n8n));
    assert.match(serverCode(n8n), /hello/, "n8n runs the node's own code");
    assert.equal(w1(await plan(store, nroot, n8n)).action, 'noop', 'files and n8n start in sync');

    // The ONLY change: a unit now feeds the Code node. No workflow file is touched.
    writeUnit(root, "return [{ json: { greeting: 'xin chao' } }];\n");
    const state = await plan(store, nroot, n8n);
    assert.equal(w1(state).action, 'update', 'the unit change is visible to plan');
    assert.deepEqual(w1(state).nodes, [{ name: 'Code', status: 'changed' }]);

    await applyFromState(store, nroot, ctxOf(store, n8n), state);
    assert.match(serverCode(n8n), /xin chao/, 'the unit code reached n8n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a deployed src/<unit> plans as noop until its source changes', async () => {
  const { root, nroot } = project();
  try {
    writeUnit(root, 'return [{ json: { v: 1 } }];\n');
    const store = new MemoryStore(); const n8n = fakeN8n();
    await applyFromState(store, nroot, ctxOf(store, n8n), await plan(store, nroot, n8n));
    assert.match(serverCode(n8n), /v: 1/, 'apply inlined the unit');

    assert.equal(w1(await plan(store, nroot, n8n)).action, 'noop', 'nothing changed → no phantom update');

    writeUnit(root, 'return [{ json: { v: 2 } }];\n');
    const state = await plan(store, nroot, n8n);
    assert.equal(w1(state).action, 'update');
    assert.deepEqual(w1(state).nodes, [{ name: 'Code', status: 'changed' }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
