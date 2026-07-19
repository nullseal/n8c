import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planDiff } from '../src/engine/plan.ts';

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
  const a = wf([{ id: 'n1', name: 'A', parameters: { x: 1 }, credentials: { openAiApi: { id: 'LOCAL_UUID', name: 'K' } } }]);
  const b = wf([{ id: 'n1', name: 'A', parameters: { x: 1 }, credentials: { openAiApi: { id: 'N8N_ID', name: 'K' } } }]);
  assert.equal(planDiff(a, b).status, 'identical');
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
