import { randomUUID } from 'node:crypto';
import type { EntityDescriptor, EntityContext } from './types.ts';
import type { Doc } from '../store/store.ts';
import { checksum } from '../checksum.ts';
import { readEntity, listEntityIds } from '../layout.ts';

// The n8c localId is carried inside the n8n workflow's `meta` on PULL so a pull
// can recover the SAME env-neutral id. It is NOT sent back on push — n8n's
// Public API marks `meta` (and id/active/tags/…) read-only. localId stability on
// push comes from the committed folder name + the per-env workflow mapping.
const META_KEY = 'n8cLocalId';
// The ONLY fields the n8n Public API accepts on workflow create/update. Anything
// else (id, meta, active, isArchived, tags, versionId, pinData, shared, …) is
// read-only and makes the request 400 — so we whitelist rather than blacklist.
// (per the `workflow` schema, additionalProperties:false; `pinData` is intentionally
// NOT pushed — pins would override production execution.)
const WRITABLE = ['name', 'description', 'nodes', 'connections', 'settings', 'staticData', 'nodeGroups'] as const;
// n8n's GET returns MORE settings keys than its PUT/POST schema accepts (UI/instance
// extras like binaryMode/timeSavedMode → 400 "settings must NOT have additional
// properties"). Whitelist exactly the Public-API (1.1.x) workflowSettings keys.
const WRITABLE_SETTINGS = ['saveExecutionProgress', 'saveManualExecutions', 'saveDataErrorExecution', 'saveDataSuccessExecution', 'executionTimeout', 'executionOrder', 'errorWorkflow', 'timezone', 'callerPolicy', 'callerIds', 'timeSavedPerExecution', 'redactionPolicy', 'availableInMCP', 'customTelemetryTags'] as const;
// The node schema is additionalProperties:false too — a node key n8n's GET returns
// but its PUT rejects (or the readOnly createdAt/updatedAt) would 400. Strip nodes
// to the API-accepted keys.
const WRITABLE_NODE = ['id', 'name', 'webhookId', 'disabled', 'notesInFlow', 'notes', 'type', 'typeVersion', 'executeOnce', 'alwaysOutputData', 'retryOnFail', 'maxTries', 'waitBetweenTries', 'continueOnFail', 'onError', 'position', 'parameters', 'credentials', 'customTelemetryTags'] as const;

export const workflow: EntityDescriptor = {
  kind: 'workflows',
  hasServer: true,
  async collectExtra(root: string, _ctx: EntityContext): Promise<{ kind: string; docs: Doc[] }[]> {
    const ids = listEntityIds(root, 'workflows');
    const docs: Doc[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      const { prompts } = await readEntity(root, 'workflows', id);
      for (const p of prompts) {
        if (seen.has(p.localId)) throw new Error(`duplicate prompt key ${p.localId}`);
        seen.add(p.localId);
        docs.push({ localId: p.localId, name: p.name, body: p.body, checksum: checksum(p.body) });
      }
    }
    return docs.length ? [{ kind: 'prompts', docs }] : [];
  },
  async beforePush(_ctx: EntityContext, body: unknown, defs: Record<string, unknown>): Promise<unknown> {
    const b = JSON.parse(JSON.stringify(body)) as any;
    for (const node of b.nodes ?? []) {
      if (!node.credentials) continue;
      for (const type of Object.keys(node.credentials)) {
        const ref = node.credentials[type];
        const localId = ref?.id;
        const mapped = defs[localId] as { id: string; name: string } | undefined;
        if (!mapped) throw new Error(`missing credential mapping for ${localId}`);
        node.credentials[type] = { id: mapped.id, name: mapped.name };
      }
    }
    // Send ONLY writable fields — n8n rejects read-only ones (meta/id/tags/…).
    const out: any = {};
    for (const k of WRITABLE) if (b[k] !== undefined) out[k] = b[k];
    // name/nodes/connections/settings are REQUIRED by the schema — default the
    // structural ones so a from-scratch workflow (no settings yet) doesn't 400.
    if (out.connections === undefined) out.connections = {};
    if (out.settings === undefined) out.settings = {};
    // strip each node to the API-accepted keys (drops readOnly createdAt/updatedAt
    // and any UI-only field n8n's GET returns but its schema rejects).
    if (Array.isArray(out.nodes)) {
      out.nodes = out.nodes.map((n: any) => {
        const o: any = {};
        for (const k of WRITABLE_NODE) if (n[k] !== undefined) o[k] = n[k];
        return o;
      });
    }
    // …and only the writable KEYS inside settings.
    if (out.settings && typeof out.settings === 'object') {
      const s: any = {};
      for (const k of WRITABLE_SETTINGS) if (out.settings[k] !== undefined) s[k] = out.settings[k];
      out.settings = s;
    }
    return out;
  },
  async pushToServer(ctx, docs, status): Promise<Record<string, unknown>> {
    const defs = await ctx.getDefinitions('credentials');
    const wfDefs = await ctx.getDefinitions('workflows');
    const mapping: Record<string, unknown> = {}; // FULL set for the applied docs (replace-safe)
    for (const d of docs) {
      const existingId = wfDefs[d.localId] as string | undefined;
      // unchanged & already deployed → keep the id, skip the re-PUT (which republishes).
      if (existingId && status?.[d.localId] === 'identical') { mapping[d.localId] = existingId; continue; }
      const remapped = await this.beforePush!(ctx, d.body, defs) as any;
      if (existingId) { await ctx.n8n!.updateWorkflow(existingId, remapped); mapping[d.localId] = existingId; }
      else { const created = await ctx.n8n!.createWorkflow(remapped); mapping[d.localId] = String(created.id); } // deploy from scratch
    }
    return mapping;
  },
  async pullFromServer(ctx) {
    const wfs = await ctx.n8n!.listWorkflows();
    const defs = await ctx.getDefinitions('workflows'); // localId -> n8nId
    const byN8nId = new Map(Object.entries(defs).map(([lid, nid]) => [String(nid), lid]));
    return wfs.map((w: any) => {
      // localId: meta marker > reverse-lookup this env's mapping > a fresh UUID.
      const localId = (w.meta && w.meta[META_KEY]) ?? byN8nId.get(String(w.id)) ?? randomUUID();
      const body: any = {
        name: w.name, active: !!w.active, nodes: w.nodes, connections: w.connections,
        settings: w.settings ?? {},
        meta: { ...(w.meta ?? {}), [META_KEY]: localId },
      };
      if (w.description !== undefined) body.description = w.description;
      if (w.nodeGroups) body.nodeGroups = w.nodeGroups;
      if (w.staticData) body.staticData = w.staticData;
      if (w.pinData) body.pinData = w.pinData;
      return { localId, name: w.name, body, serverId: String(w.id) };
    });
  },
};
