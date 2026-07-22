import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readServerFacts, refreshedServerFacts, driftFor, touchedFromState, verifyBeforeApply } from '../src/engine/verify.ts';

const ctx = (workflows: any[], credentials: any[]) => ({
  n8n: { listWorkflows: async () => workflows, listCredentials: async () => credentials },
}) as any;

test('readServerFacts keys every entity by id with a change marker', async () => {
  const f = await readServerFacts(ctx(
    [{ id: 'W1', updatedAt: 'T1', active: true }],
    [{ id: 'C1', updatedAt: 'T1', name: 'Mongo', type: 'mongoDb' }],
  ));
  assert.equal(Object.keys(f.workflows).length, 1);
  assert.ok(f.workflows.W1.includes('T1'));
  assert.ok(f.credentials.C1.includes('Mongo'));
});

test('readServerFacts without an n8n connection is empty, not a throw', async () => {
  assert.deepEqual(await readServerFacts({} as any), { workflows: {}, credentials: {} });
});

test('readServerFacts propagates a listWorkflows failure (no silent empty facts)', async () => {
  const throwing = { n8n: { listWorkflows: async () => { throw new Error('401 Unauthorized'); }, listCredentials: async () => [] } } as any;
  await assert.rejects(() => readServerFacts(throwing), /401 Unauthorized/);
});

test('readServerFacts propagates a listCredentials failure (no silent empty facts)', async () => {
  const throwing = { n8n: { listWorkflows: async () => [], listCredentials: async () => { throw new Error('500 boom'); } } } as any;
  await assert.rejects(() => readServerFacts(throwing), /500 boom/);
});

test('driftFor reports ONLY entities this apply will write', () => {
  const before = { workflows: { W1: 'T1', W2: 'T1' }, credentials: {} };
  const after = { workflows: { W1: 'T2', W2: 'T2' }, credentials: {} };
  const drift = driftFor(before, after, [{ kind: 'workflows', id: 'W1', name: 'Main' }]);
  assert.equal(drift.length, 1, 'W2 changed too but is not in the plan — ignored');
  assert.deepEqual(drift[0], { kind: 'workflows', id: 'W1', name: 'Main', change: 'changed' });
});

test('driftFor flags an entity that vanished from the server', () => {
  const drift = driftFor({ workflows: {}, credentials: { C1: 'T1' } }, { workflows: {}, credentials: {} },
    [{ kind: 'credentials', id: 'C1', name: 'Mongo' }]);
  assert.equal(drift[0].change, 'disappeared');
});

test('driftFor is silent for an entity that did not exist at plan time (a create)', () => {
  const drift = driftFor({ workflows: {}, credentials: {} }, { workflows: { W9: 'T1' }, credentials: {} },
    [{ kind: 'workflows', id: 'W9', name: 'New' }]);
  assert.deepEqual(drift, [], 'we never knew it — creating it is the plan');
});

test('driftFor with no recorded baseline reports nothing (old state files stay usable)', () => {
  assert.deepEqual(driftFor(undefined, { workflows: { W1: 'T2' }, credentials: {} },
    [{ kind: 'workflows', id: 'W1', name: 'Main' }]), []);
});

test('touchedFromState maps the plan\'s non-noop resources to their n8n ids', () => {
  const state: any = { resources: [
    { kind: 'workflows', localId: 'wLocal', name: 'Main', action: 'update' },
    { kind: 'credentials', localId: 'cLocal', name: 'Mongo', action: 'update' },
    { kind: 'workflows', localId: 'skip', name: 'Untouched', action: 'noop' },
    { kind: 'prompts', localId: 'p1', name: 'greeting', action: 'update' },
  ] };
  const defs = { workflows: { wLocal: 'W1' }, credentials: { cLocal: { id: 'C1', name: 'Mongo' } } };
  assert.deepEqual(touchedFromState(state, defs), [
    { kind: 'workflows', id: 'W1', name: 'Main' },
    { kind: 'credentials', id: 'C1', name: 'Mongo' },
  ], 'noop rows and server-less kinds are excluded');
});

test('touchedFromState skips a resource with no mapping yet (a create)', () => {
  const state: any = { resources: [{ kind: 'workflows', localId: 'brandNew', name: 'New', action: 'create' }] };
  assert.deepEqual(touchedFromState(state, { workflows: {}, credentials: {} }), []);
});

// --- verifyBeforeApply: the apply-time gate itself, not just its primitives ---

test('verifyBeforeApply: drift on a touched workflow blocks, naming the workflow', async () => {
  const ctx = {
    n8n: { listWorkflows: async () => [{ id: 'W1', updatedAt: 'T2', active: true }], listCredentials: async () => [] },
    getDefinitions: async (kind: string) => (kind === 'workflows' ? { wLocal: 'W1' } : {}),
  } as any;
  const state = {
    serverFacts: { workflows: { W1: 'T1|true' }, credentials: {} },
    resources: [{ kind: 'workflows', localId: 'wLocal', name: 'Main Chatbot', action: 'update' }],
  };
  const outcome = await verifyBeforeApply(ctx, state);
  assert.equal(outcome.decision, 'block');
  assert.equal(outcome.drift.length, 1);
  assert.equal(outcome.drift[0].name, 'Main Chatbot', 'the report names the drifted workflow');
  assert.equal(outcome.drift[0].change, 'changed');
});

test('verifyBeforeApply: fail-safe on a facts-read error stops, and apply is never reached', async () => {
  const ctx = {
    n8n: { listWorkflows: async () => { throw new Error('401 Unauthorized'); }, listCredentials: async () => [] },
    getDefinitions: async () => ({}),
  } as any;
  const state = { serverFacts: { workflows: {}, credentials: {} }, resources: [] };
  const outcome = await verifyBeforeApply(ctx, state);
  assert.equal(outcome.decision, 'stop', 'must stop, not merely catch an error');
  assert.match(outcome.error!, /401 Unauthorized/);

  // Mirror the cli.ts gate: applyFromState only ever runs on 'proceed'.
  let applyReached = false;
  const applyFromState = async () => { applyReached = true; };
  if (outcome.decision === 'proceed') await applyFromState();
  assert.equal(applyReached, false, 'applyFromState must never run when verification failed');
});

test('verifyBeforeApply: a definitions-store failure is guarded the same as a facts-read failure', async () => {
  // Fix 2 — the getDefinitions calls used to sit outside the try/catch in cli.ts;
  // verifyBeforeApply now wraps both reads, so this fails safe too.
  const ctx = {
    n8n: { listWorkflows: async () => [], listCredentials: async () => [] },
    getDefinitions: async () => { throw new Error('mongo down'); },
  } as any;
  const state = { serverFacts: { workflows: {}, credentials: {} }, resources: [] };
  const outcome = await verifyBeforeApply(ctx, state);
  assert.equal(outcome.decision, 'stop');
  assert.match(outcome.error!, /mongo down/);
});

test('verifyBeforeApply: unrelated churn on an untouched workflow does not block', async () => {
  const ctx = {
    n8n: {
      listWorkflows: async () => [
        { id: 'W1', updatedAt: 'T1', active: true },        // touched by the plan, unchanged
        { id: 'W2', updatedAt: 'T2-CHANGED', active: true }, // NOT in the plan, changed
      ],
      listCredentials: async () => [],
    },
    getDefinitions: async (kind: string) => (kind === 'workflows' ? { wLocal: 'W1' } : {}),
  } as any;
  const state = {
    serverFacts: { workflows: { W1: 'T1|true', W2: 'T1|true' }, credentials: {} },
    resources: [{ kind: 'workflows', localId: 'wLocal', name: 'Main', action: 'update' }],
  };
  const outcome = await verifyBeforeApply(ctx, state);
  assert.equal(outcome.decision, 'proceed');
  assert.deepEqual(outcome.drift, []);
});

test('verifyBeforeApply: a legacy state file (no serverListed key at all) proceeds WITH a notice', async () => {
  const ctx = {
    n8n: { listWorkflows: async () => [{ id: 'W1', updatedAt: 'T1', active: true }], listCredentials: async () => [] },
    getDefinitions: async () => ({ wLocal: 'W1' }),
  } as any;
  // No `serverListed` key at all — mirrors a state file written before this feature.
  const state = { serverFacts: undefined, resources: [{ kind: 'workflows', localId: 'wLocal', name: 'Main', action: 'update' }] };
  const outcome = await verifyBeforeApply(ctx, state);
  assert.equal(outcome.decision, 'proceed', 'never blocks on an unrecorded baseline');
  assert.equal(outcome.notice, true, 'must say it skipped the drift check, not silently pretend it verified');
});

// Fix 2 — the two reasons a baseline can be missing are NOT the same and must not
// share an outcome: `serverListed === false` means THIS plan tried to verify and
// the credential listing failed, so proceeding would apply unverified (fail open).
// That must STOP, not slip through as the legacy "predates verification" notice.
test('verifyBeforeApply: serverListed === false with no facts STOPS (fail-safe, never fail-open)', async () => {
  const ctx = {
    n8n: { listWorkflows: async () => [{ id: 'W1', updatedAt: 'T1', active: true }], listCredentials: async () => [] },
    getDefinitions: async () => ({ wLocal: 'W1' }),
  } as any;
  const state = {
    serverFacts: undefined,
    serverListed: false, // recorded at plan time: the credential listing failed
    resources: [{ kind: 'workflows', localId: 'wLocal', name: 'Main', action: 'update' }],
  };
  const outcome = await verifyBeforeApply(ctx, state);
  assert.equal(outcome.decision, 'stop', 'a degraded plan must never apply unverified');
  assert.ok(outcome.error, 'must explain why, and to re-run `n8c plan`');
});

// --- Fix 3: the persisted post-apply baseline must reflect the apply's own writes ---
test('refreshedServerFacts + a re-check: an immediate retry does not see the apply\'s own writes as drift', async () => {
  // Simulates: plan captured T1, apply pushed and n8n now reports T2 (the write
  // apply itself just made). cli.ts refreshes the baseline to T2 before persisting;
  // a retry must then compare against T2, not the stale T1 plan-time baseline.
  const ctx = {
    n8n: { listWorkflows: async () => [{ id: 'W1', updatedAt: 'T2-POST-APPLY', active: true }], listCredentials: async () => [] },
    getDefinitions: async (kind: string) => (kind === 'workflows' ? { wLocal: 'W1' } : {}),
  } as any;
  const state: any = {
    serverFacts: { workflows: { W1: 'T1-PRE-APPLY|true' }, credentials: {} },
    resources: [{ kind: 'workflows', localId: 'wLocal', name: 'Main', action: 'update' }],
  };

  // What cli.ts does right before persisting the applied state.
  state.serverFacts = await refreshedServerFacts(ctx);
  assert.ok(state.serverFacts?.workflows.W1.includes('T2-POST-APPLY'), 'baseline refreshed to the post-apply reality');

  // The retry's own verify pass must not report drift caused by the apply's own writes.
  const outcome = await verifyBeforeApply(ctx, state);
  assert.equal(outcome.decision, 'proceed');
  assert.deepEqual(outcome.drift, []);
});

// Fix 1, path 2: the post-apply refresh (cli.ts, apply + restore --apply) can itself
// fail and return undefined. cli.ts must then degrade serverListed alongside
// serverFacts — persisting facts=undefined with listed=true left over from plan
// time would make the NEXT apply misread this as a legacy pre-verification file
// and proceed unverified instead of stopping.
test('Fix 1: a failed post-apply refresh degrades serverListed, so the next apply stops', async () => {
  const state: any = {
    serverFacts: { workflows: { W1: 'T1|true' }, credentials: {} },
    serverListed: true,
    resources: [{ kind: 'workflows', localId: 'wLocal', name: 'Main', action: 'update' }],
  };
  const failingRefreshCtx = { n8n: { listWorkflows: async () => { throw new Error('network blip'); }, listCredentials: async () => [] } } as any;

  // Mirrors cli.ts's apply/restore handlers.
  const facts = await refreshedServerFacts(failingRefreshCtx);
  state.serverFacts = facts;
  state.serverListed = facts !== undefined && state.serverListed;
  assert.equal(state.serverListed, false, 'the flag must fall with the facts, not stay stuck at true');

  const ctx = {
    n8n: { listWorkflows: async () => [{ id: 'W1', updatedAt: 'T2', active: true }], listCredentials: async () => [] },
    getDefinitions: async (kind: string) => (kind === 'workflows' ? { wLocal: 'W1' } : {}),
  } as any;
  const outcome = await verifyBeforeApply(ctx, state);
  assert.equal(outcome.decision, 'stop', 'a degraded post-apply baseline must force a re-plan, never a silent overwrite');
});
