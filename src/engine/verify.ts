import type { EntityContext } from '../entities/types.ts';

// A cheap snapshot of the instance: every workflow/credential the API returns,
// keyed id → change marker. n8n stamps `updatedAt` on both list endpoints, so an
// edit made in the UI is detectable without fetching a single full body.
export interface ServerFacts { workflows: Record<string, string>; credentials: Record<string, string>; }
export type TouchedKind = 'workflows' | 'credentials';
export interface Touched { kind: TouchedKind; id: string; name: string; }
export interface Drift { kind: string; id: string; name: string; change: 'changed' | 'disappeared'; }

// `pre.credentials`, when given, is a listCredentials() result the caller already
// fetched — reused here instead of listing a second time (computePlan needs the
// raw list itself for its credential-diff logic, and used to fetch it twice).
export async function readServerFacts(ctx: EntityContext, pre?: { credentials?: any[] }): Promise<ServerFacts> {
  const facts: ServerFacts = { workflows: {}, credentials: {} };
  const n8n: any = ctx?.n8n;
  if (!n8n) return facts;
  // A list failure propagates (no swallow here): partial facts (e.g. workflows
  // populated, credentials empty because the call died) are indistinguishable from
  // "the instance genuinely has none", which a later drift check would misread as
  // every entity having disappeared. The caller (computePlan) decides what an
  // unusable baseline means — it leaves serverFacts undefined instead.
  if (n8n.listWorkflows) {
    for (const w of await n8n.listWorkflows()) facts.workflows[String(w.id)] = `${w.updatedAt ?? ''}|${!!w.active}`;
  }
  const credentials = pre?.credentials ?? (n8n.listCredentials ? await n8n.listCredentials() : []);
  for (const c of credentials) facts.credentials[String(c.id)] = `${c.updatedAt ?? ''}|${c.name ?? ''}|${c.type ?? ''}`;
  return facts;
}

// Call right before persisting an applied state (Fix 3): re-reads the instance so
// the saved baseline reflects THIS apply's own writes, not the pre-apply facts.
// Without this, a retry after a partial failure would see its own successful
// writes as "changed since plan" and block, naming workflows n8c itself wrote.
export async function refreshedServerFacts(ctx: EntityContext): Promise<ServerFacts | undefined> {
  try { return await readServerFacts(ctx); } catch { return undefined; }
}

// Drift that MATTERS: an entity this apply is about to write which changed or
// vanished since plan. Unrelated churn on a shared instance is ignored on
// purpose — blocking on it would make apply unusable. An entity absent from the
// baseline is a create, not drift.
export function driftFor(before: ServerFacts | undefined, after: ServerFacts, touched: Touched[]): Drift[] {
  if (!before) return []; // state file predates fact recording — nothing to compare
  const out: Drift[] = [];
  for (const t of touched) {
    const was = before[t.kind]?.[t.id];
    if (was === undefined) continue;
    const now = after[t.kind]?.[t.id];
    if (now === undefined) out.push({ kind: t.kind, id: t.id, name: t.name, change: 'disappeared' });
    else if (now !== was) out.push({ kind: t.kind, id: t.id, name: t.name, change: 'changed' });
  }
  return out;
}

// The server entities this plan will actually write, as n8n ids. Only
// server-backed kinds qualify; prompts live in the DB and cannot drift on n8n.
// A resource with no mapping is a create — there is nothing yet to drift.
export function touchedFromState(
  state: { resources: { kind: string; localId: string; name: string; action: string }[] },
  defsByKind: Record<string, Record<string, any>>,
): Touched[] {
  const out: Touched[] = [];
  for (const r of state.resources ?? []) {
    if (r.action === 'noop') continue;
    if (r.kind !== 'workflows' && r.kind !== 'credentials') continue;
    const mapped = defsByKind[r.kind]?.[r.localId];
    const id = mapped?.id ?? mapped;
    if (id === undefined || id === null) continue;
    out.push({ kind: r.kind, id: String(id), name: r.name });
  }
  return out;
}

export interface VerifyOutcome {
  decision: 'proceed' | 'block' | 'stop';
  drift: Drift[];
  error?: string;   // set when decision === 'stop'
  notice?: boolean; // set when decision === 'proceed' but the baseline predates fact recording
}

// The whole apply-time gate, extracted so it is unit-testable without spawning
// the CLI: re-read the instance, work out what THIS apply will write, and decide
// whether it is safe to proceed. Both reads (facts + definitions) sit inside the
// same try — either one failing must stop, never silently proceed.
export async function verifyBeforeApply(
  ctx: EntityContext,
  state: { serverFacts?: ServerFacts; serverListed?: boolean; resources: { kind: string; localId: string; name: string; action: string }[] },
): Promise<VerifyOutcome> {
  let fresh: ServerFacts;
  let defsByKind: Record<string, Record<string, any>>;
  try {
    fresh = await readServerFacts(ctx);
    defsByKind = {
      workflows: await ctx.getDefinitions('workflows'),
      credentials: await ctx.getDefinitions('credentials'),
    };
  } catch (e: any) {
    return { decision: 'stop', drift: [], error: String(e?.message ?? e) };
  }
  if (!state.serverFacts) {
    // Two different reasons a baseline is missing, and only one is safe to proceed on:
    // `serverListed === false` means THIS plan tried to verify and could not —
    // proceeding would fail open, so stop. A legacy state file written before this
    // feature has no `serverListed` key at all — that one predates verification and
    // is fine to proceed on, with a notice. The cause (a failed credential listing,
    // or a failed baseline read) was already reported by `plan`; don't guess at it here.
    if (state.serverListed === false) {
      return { decision: 'stop', drift: [], error: 'this plan recorded no server baseline, so drift cannot be verified. Re-run `n8c plan`.' };
    }
    return { decision: 'proceed', drift: [], notice: true };
  }
  const drift = driftFor(state.serverFacts, fresh, touchedFromState(state, defsByKind));
  return drift.length ? { decision: 'block', drift } : { decision: 'proceed', drift: [] };
}
