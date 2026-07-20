import type { EntityDescriptor, EntityContext } from './types.ts';
import { encryptSecret, decryptSecret, isEncrypted } from '../crypto.ts';
import { credIndex, resolveCredLocalId } from '../engine/cred-map.ts';
import { dim } from '../style.ts';

// The credential `apply.ts` references its secret as `process.env.<VAR>`, which
// resolves to the real value when the module is read (buildDocs). So by the time
// n8c has the body the secret is already concrete — no marker step. `beforeSave`
// encrypts it at rest; `beforePush` decrypts it on the way to n8n.

// n8n validates a credential's `data` against the FULL schema for its type, even on
// a partial PATCH, and never lets us read the current secret back to complete it —
// so it answers with an unreadable allOf/subschema dump. Pull the field names it
// says are missing out of that message. Exported for testing.
export function missingFieldsFromError(raw: string): string[] {
  const missing: string[] = [];
  const marker = 'requires property ';
  let i = raw.indexOf(marker);
  while (i !== -1) {
    // the field name is the next quoted token; n8n escapes the quotes (\"), so drop
    // backslashes before reading between the first pair of quotes.
    const rest = raw.slice(i + marker.length).split('\\').join('');
    const q1 = rest.indexOf('"');
    const q2 = q1 === -1 ? -1 : rest.indexOf('"', q1 + 1);
    const field = q1 !== -1 && q2 !== -1 ? rest.slice(q1 + 1, q2) : '';
    if (field && !missing.includes(field)) missing.push(field);
    i = raw.indexOf(marker, i + marker.length);
  }
  return missing;
}

// Defaults for schema-required fields that carry no secret and have an obvious
// permissive value. Applied ONLY when n8n reports the field as missing, so a type
// without the field is never sent one. `allowedDomains: "*"` = any domain, i.e. the
// same as leaving it unrestricted — set it explicitly in the file to narrow it.
export const CREDENTIAL_FIELD_DEFAULTS: Record<string, string> = { allowedDomains: '*' };

// Ask n8n what the defaults are for a credential type's fields (same values its UI
// prefills). Cached PER CONTEXT — a global type→defaults cache would leak between
// environments (`-e staging` vs `-e prod` are different instances).
const defaultsCache = new WeakMap<object, Map<string, Record<string, unknown>>>();
export async function credentialFieldDefaults(ctx: EntityContext, type: string): Promise<Record<string, unknown>> {
  let perCtx = defaultsCache.get(ctx as object);
  if (!perCtx) { perCtx = new Map(); defaultsCache.set(ctx as object, perCtx); }
  const hit = perCtx.get(type);
  if (hit) return hit;
  let out: Record<string, unknown> = {};
  try {
    const { collectFieldDefaults } = await import('../engine/types-gen.ts');
    const schema = await (ctx.n8n as any)?.getCredentialSchema?.(type);
    if (schema) out = collectFieldDefaults(schema);
  } catch { /* schema not readable → no defaults */ }
  perCtx.set(type, out);
  return out;
}

// Complete a rejected `data` using n8n's own declared defaults, falling back to
// n8c's own for fields n8n gives no default for. Returns null when some required
// field has no default anywhere — those genuinely cannot be invented.
export async function fillMissingFields(
  ctx: EntityContext, type: string, data: Record<string, unknown>, missing: string[],
): Promise<Record<string, unknown> | null> {
  const schemaDefaults = await credentialFieldDefaults(ctx, type);
  const filled = { ...data };
  const used: string[] = [];
  for (const f of missing) {
    if (f in schemaDefaults) filled[f] = schemaDefaults[f];
    else if (f in CREDENTIAL_FIELD_DEFAULTS) filled[f] = CREDENTIAL_FIELD_DEFAULTS[f];
    else return null; // no default known — cannot complete honestly
    used.push(f);
  }
  return used.length ? filled : null;
}

// Send `data`, completing it from n8n's schema defaults for whatever it rejects —
// looping because n8n may report missing fields one response at a time. Resolves to
// the response plus the fields we filled, or null when a required field has no
// default (the caller then preserves the stored secret / reports it).
// Flat (not a discriminated union): the build runs with `strict: false`, where
// narrowing on a boolean literal doesn't apply — so every field is always present.
export interface SendResult<T> { ok: boolean; result?: T; filled: string[]; missing: string[]; }

export async function sendWithSchemaDefaults<T>(
  ctx: EntityContext, type: string, data: Record<string, unknown>,
  send: (data: Record<string, unknown>) => Promise<T>, maxTries = 6,
): Promise<SendResult<T>> {
  let current = data;
  const filled: string[] = [];
  let missing: string[] = [];
  for (let i = 0; i < maxTries; i++) {
    try { return { ok: true, result: await send(current), filled, missing: [] }; }
    catch (e: any) {
      missing = missingFieldsFromError(String(e?.message ?? e));
      if (!missing.length) throw e;          // not a schema problem — a real error
      const next = await fillMissingFields(ctx, type, current, missing);
      if (!next) return { ok: false, filled, missing }; // cannot complete honestly
      for (const f of missing) if (!filled.includes(f)) filled.push(f);
      current = next;
    }
  }
  return { ok: false, filled, missing };
}

export function explainCredentialError(name: string, type: string, sentData: boolean, raw: string): string {
  const missing = missingFieldsFromError(raw);
  if (!missing.length || !sentData) return `credential "${name}": ${raw}`;
  return `credential "${name}" (${type}): n8n rejected \`data\` — missing required field(s): ${missing.join(', ')}.`;
}

// Decrypt a credential body's `data` if it is stored encrypted.
export function decryptCredentialData(ctx: EntityContext, body: any): any {
  if (typeof body?.data === 'string' && isEncrypted(body.data)) {
    if (!ctx.encryptionKey) throw new Error('N8C_CREDENTIAL_ENCRYPTION_KEY required to decrypt credentials');
    return { ...body, data: JSON.parse(decryptSecret(body.data, ctx.encryptionKey)) };
  }
  return body;
}

export const credential: EntityDescriptor = {
  kind: 'credentials',
  hasServer: true,
  beforeSave(ctx: EntityContext, body: unknown): unknown {
    const b = body as any;
    if (!ctx.encrypted || b.data === undefined) return b;
    if (!ctx.encryptionKey) throw new Error('N8C_CREDENTIAL_ENCRYPTION_KEY required to encrypt credentials');
    return { ...b, data: encryptSecret(JSON.stringify(b.data), ctx.encryptionKey) };
  },
  beforePush(ctx: EntityContext, body: unknown): unknown {
    // decrypt the at-rest secret on the way to n8n (already the real value).
    return decryptCredentialData(ctx, body as any);
  },
  async pushToServer(ctx, docs, status): Promise<Record<string, unknown>> {
    // n8n Public API (1.1.x) supports PATCH, so update in place instead of always
    // creating a duplicate. `changed` + a live id → PATCH; otherwise create.
    // `data` only travels when the file carries an `env:` marker, and PATCH uses
    // isPartialData:true so omitting data PRESERVES the existing secret (no wipe).
    const existing = await ctx.getDefinitions('credentials');
    const mapping: Record<string, unknown> = {};
    for (const d of docs) {
      const prior = existing[d.localId] as { id: string; name: string; updatedAt?: string } | undefined;
      if (prior && status?.[d.localId] === 'identical') { mapping[d.localId] = prior; continue; }
      const plain = this.beforePush!(ctx, d.body, {}) as any;
      const isUpdate = !!prior?.id && status?.[d.localId] === 'changed';
      try {
        if (isUpdate) {
          const patch: any = { name: plain.name, type: plain.type, isPartialData: true };
          if (plain.data !== undefined) patch.data = plain.data;
          let upd: any;
          if (patch.data === undefined) {
            upd = await ctx.n8n!.updateCredential(prior.id, patch);
          } else {
            // Send `data`, completing whatever n8n rejects from its OWN declared
            // defaults for this type — only fields it actually asks for, so a type
            // without such a field is never sent one.
            const sent = await sendWithSchemaDefaults(ctx, plain.type, patch.data,
              (data) => ctx.n8n!.updateCredential(prior.id, { ...patch, data }));
            if (sent.ok) {
              upd = sent.result;
              if (sent.filled.length) console.error(dim(`  ↳ credential "${d.name}": filled ${sent.filled.join(', ')} from n8n's schema defaults`));
            } else {
              // Some required field has no default anywhere (e.g. mongoDb host).
              // Retry WITHOUT data: isPartialData keeps the stored secret, so the
              // rest of the credential still applies instead of failing the apply.
              delete patch.data;
              upd = await ctx.n8n!.updateCredential(prior.id, patch);
              console.error(`  ⚠ credential "${d.name}": secret NOT updated — n8n requires ${sent.missing.join(', ')} in \`data\` and gives no default. `
                + `Name/type applied; the stored secret is unchanged. Add the missing field(s) to set it.`);
            }
          }
          mapping[d.localId] = { id: prior.id, name: plain.name, updatedAt: upd?.updatedAt };
        } else {
          // CREATE. Unlike a PATCH there is no stored secret to merge with, so n8n
          // demands the type's COMPLETE `data` — dropping it isn't an option here.
          const sent = await sendWithSchemaDefaults(ctx, plain.type, plain.data ?? {},
            (data) => ctx.n8n!.createCredential({ name: plain.name, type: plain.type, data }));
          if (!sent.ok) {
            throw new Error(`credential "${d.name}" (${plain.type}) must be CREATED on n8n (its mapped id no longer exists), `
              + `and a create needs the type's complete \`data\` — n8n requires ${sent.missing.join(', ')} and gives no default.\n`
              + `  Add the field(s) to the file, or create the credential in the n8n UI and run \`n8c pull\` to map it.`);
          }
          if (sent.filled.length) console.error(dim(`  ↳ credential "${d.name}": filled ${sent.filled.join(', ')} from n8n's schema defaults`));
          const created = sent.result as any;
          mapping[d.localId] = { id: created.id, name: plain.name, updatedAt: created?.updatedAt };
        }
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        // already explained (create path) — don't prefix it twice
        if (msg.startsWith('credential "')) throw e;
        throw new Error(explainCredentialError(d.name, plain.type, plain.data !== undefined, msg));
      }
    }
    return mapping;
  },
  async pullFromServer(ctx) {
    const creds = await ctx.n8n!.listCredentials();
    // Single source of truth for localId: reuse the mapped one, else mint once.
    const mapping = { ...(await ctx.getDefinitions('credentials')) };
    const idx = credIndex(mapping);
    return creds.map((c: any) => {
      const localId = resolveCredLocalId(mapping, idx, String(c.id), c.name);
      // store updatedAt too → the plan uses it as a server-side change token.
      const defValue: any = { id: String(c.id), name: c.name };
      if (c.updatedAt !== undefined) defValue.updatedAt = c.updatedAt;
      return { localId, name: c.name, body: { name: c.name, type: c.type }, serverId: String(c.id), defValue };
    });
  },
};
