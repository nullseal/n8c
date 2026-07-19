import type { EntityDescriptor, EntityContext } from './types.ts';
import { encryptSecret, decryptSecret, isEncrypted } from '../crypto.ts';
import { credIndex, resolveCredLocalId } from '../engine/cred-map.ts';

// The credential `apply.ts` references its secret as `process.env.<VAR>`, which
// resolves to the real value when the module is read (buildDocs). So by the time
// n8c has the body the secret is already concrete — no marker step. `beforeSave`
// encrypts it at rest; `beforePush` decrypts it on the way to n8n.

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
      if (prior?.id && status?.[d.localId] === 'changed') {
        const patch: any = { name: plain.name, type: plain.type, isPartialData: true };
        if (plain.data !== undefined) patch.data = plain.data;
        const upd = await ctx.n8n!.updateCredential(prior.id, patch);
        mapping[d.localId] = { id: prior.id, name: plain.name, updatedAt: upd?.updatedAt };
      } else {
        const created = await ctx.n8n!.createCredential({ name: plain.name, type: plain.type, data: plain.data });
        mapping[d.localId] = { id: created.id, name: plain.name, updatedAt: created?.updatedAt };
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
