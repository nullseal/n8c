import { MongoClient } from 'mongodb';
import type { Store, Doc, ManifestEntry, Session, StoreCapabilities } from './store.ts';
import { resolveCollections, collectionForKind, type Collections } from './collections.ts';
import { mappingRows } from '../engine/cred-map.ts';
import { liveStorageDoc } from './live-doc.ts';
import { toDoc, selectVersionDocs } from './version-docs.ts';
import { checksum } from '../checksum.ts';
import type { BackupDb } from '../engine/backup.ts';

export class MongoStore implements Store {
  readonly capabilities: StoreCapabilities = { promptContents: true, backup: true };
  private client: MongoClient;
  private dbName: string;
  private cols: Collections;
  constructor(uri: string, dbName: string, collections?: Collections) { this.client = new MongoClient(uri); this.dbName = dbName; this.cols = collections ?? resolveCollections(); }
  private db() { return this.client.db(this.dbName); }
  private col(kind: string) { return this.db().collection(collectionForKind(this.cols, kind)); }
  async connect() { await this.client.connect(); return this; }

  async getLive(kind: string): Promise<Doc[]> {
    const rows = await this.col(kind).find({ mode: 'live' }).toArray();
    if (kind === 'promptContents') {
      // Reconstruct from the flat runtime doc — robust to n8c-written docs (nested
      // body kept) AND externally-seeded ones ({key, content, mode:live} only).
      return rows.map((r: any) => {
        const body: any = r.body ?? {};
        if (body.key === undefined) { body.key = r.key; if (r.content !== undefined) body.content = r.content; if (r.blocks !== undefined) body.blocks = r.blocks; }
        return { localId: r.localId ?? String(r.key), name: r.name ?? String(r.key), body, checksum: r.checksum ?? checksum(body) };
      });
    }
    return rows.map((r: any) => ({ localId: r.localId, name: r.name, body: r.body, checksum: r.checksum }));
  }
  async putLive(kind: string, docs: Doc[], session: Session): Promise<void> {
    const s = (session as any).mongo;
    const col = this.col(kind);
    await col.deleteMany({ mode: 'live' }, { session: s });
    if (docs.length) await col.insertMany(docs.map((d) => liveStorageDoc(kind, d)), { session: s });
  }
  async upsertLive(kind: string, docs: Doc[], session: Session): Promise<void> {
    const s = (session as any).mongo;
    const col = this.col(kind);
    for (const d of docs) {
      await col.updateOne({ localId: d.localId, mode: 'live' }, { $set: liveStorageDoc(kind, d) }, { upsert: true, session: s });
    }
  }
  private manifests() { return this.db().collection(this.cols.manifests); }
  // n8c_manifests holds ONLY the version metadata (index of versions). The per-
  // version entity docs live in that kind's OWN collection, tagged by `versionId`
  // (live docs use `mode:"live"`; version docs carry a `versionId`, never mode).
  async createSnapshot(kind: string, versionId: string, docs: Doc[], checksum: string, session: Session, message?: string, draft?: boolean): Promise<void> {
    const s = (session as any).mongo;
    await this.manifests().insertOne({ kind, versionId, isActive: false, checksum, createdAt: new Date().toISOString(), message, draft }, { session: s });
    if (docs.length) {
      await this.col(kind).insertMany(docs.map((d) => ({ versionId, localId: d.localId, name: d.name, body: d.body, checksum: d.checksum })), { session: s });
    }
  }
  async listVersions(kind: string): Promise<ManifestEntry[]> {
    // Project out `docs`: legacy versions embedded their docs in the manifest doc,
    // which we never need for the metadata listing (and could be large).
    const rows = await this.manifests().find({ kind }, { projection: { docs: 0 } }).sort({ versionId: 1 }).toArray();
    return rows.map((r: any) => ({ versionId: r.versionId, isActive: r.isActive, checksum: r.checksum, createdAt: r.createdAt, message: r.message, draft: r.draft }));
  }
  async getVersion(kind: string, versionId: string): Promise<Doc[]> {
    const rows = await this.col(kind).find({ versionId }).toArray();
    if (rows.length) return rows.map(toDoc);
    // Backward compatibility: versions written before the per-kind split stored
    // their docs embedded in the manifest doc (`manifest.docs`). Fall back to them
    // so a storage-format change never makes an existing version unreadable
    // (see selectVersionDocs / regression: pull crashed on such a version).
    const man = await this.manifests().findOne({ kind, versionId }, { projection: { docs: 1 } });
    return selectVersionDocs(rows, man);
  }
  async markActive(kind: string, versionId: string, session: Session): Promise<void> {
    const s = (session as any).mongo;
    await this.manifests().updateMany({ kind }, { $set: { isActive: false } }, { session: s });
    await this.manifests().updateOne({ kind, versionId }, { $set: { isActive: true } }, { session: s });
  }
  async dropVersion(kind: string, versionId: string, session: Session): Promise<void> {
    const s = (session as any).mongo;
    await this.manifests().deleteOne({ kind, versionId }, { session: s });
    await this.col(kind).deleteMany({ versionId }, { session: s }); // per-kind version docs (legacy embedded docs go with the manifest)
  }
  async putDefinitions(env: string, kind: string, mapping: Record<string, unknown>, session: Session): Promise<void> {
    const s = (session as any).mongo;
    const col = this.db().collection(this.cols.definitions);
    // 1 doc per localId; n8nId lifted out for the unique index. Replace-semantics
    // (callers pass the full mapping) → wipe this {env,kind} then insert normalized.
    await col.deleteMany({ env, kind }, { session: s });
    const rows = mappingRows(mapping).map((r) => ({ env, kind, localId: r.localId, n8nId: r.n8nId, value: r.value }));
    if (rows.length) await col.insertMany(rows, { session: s });
  }
  async getDefinitions(env: string, kind: string): Promise<Record<string, unknown>> {
    const rows: any[] = await this.db().collection(this.cols.definitions).find({ env, kind }).toArray();
    const out: Record<string, unknown> = {};
    for (const r of rows) {
      if (r.localId !== undefined) out[r.localId] = r.value;           // per-doc format
      else if (r.mapping) Object.assign(out, r.mapping);              // legacy single-doc fallback
    }
    return out;
  }
  async withTransaction<T>(fn: (session: Session) => Promise<T>): Promise<T> {
    const mongoSession = this.client.startSession();
    try {
      let result: T;
      await mongoSession.withTransaction(async () => { result = await fn({ id: mongoSession.id?.toString() ?? 'm', mongo: mongoSession } as any); });
      return result!;
    } finally { await mongoSession.endSession(); }
  }
  async init(): Promise<{ replicaSet: boolean; indexes: string[] }> {
    let replicaSet = false;
    try { const hello: any = await this.db().admin().command({ hello: 1 }); replicaSet = !!hello.setName; } catch { replicaSet = false; }
    const indexes: string[] = [];
    // Per-entry mapping docs: 1 localId per {env,kind}, and 1 localId per n8n id.
    const envCol = this.db().collection(this.cols.definitions);
    await envCol.createIndex({ env: 1, kind: 1, localId: 1 }, { unique: true, partialFilterExpression: { localId: { $exists: true } } });
    await envCol.createIndex({ env: 1, kind: 1, n8nId: 1 }, { unique: true, partialFilterExpression: { n8nId: { $exists: true } } });
    indexes.push(`${this.cols.definitions}{env,kind,localId}`, `${this.cols.definitions}{env,kind,n8nId}`);
    // Per-kind collections hold live docs (1 per localId, mode:live) AND that
    // kind's version snapshot docs (tagged by versionId).
    for (const kind of ['workflows', 'prompts', 'credentials']) {
      const name = collectionForKind(this.cols, kind);
      const col = this.db().collection(name);
      await col.createIndex({ localId: 1 }, { partialFilterExpression: { mode: 'live' } });
      await col.createIndex({ versionId: 1 }, { partialFilterExpression: { versionId: { $exists: true } } });
      indexes.push(`${name}{live:localId}`, `${name}{versionId}`);
    }
    // Runtime prompt content: 1 live doc per key.
    await this.db().collection(this.cols.promptContents).createIndex({ key: 1 }, { partialFilterExpression: { mode: 'live' } });
    indexes.push(`${this.cols.promptContents}{live:key}`);
    // n8c_manifests: ONLY version metadata — 1 doc per {kind, versionId}.
    const man = this.manifests();
    await man.createIndex({ kind: 1, versionId: 1 }, { unique: true });
    await man.createIndex({ kind: 1, checksum: 1 });
    indexes.push(`${this.cols.manifests}{kind,versionId}`, `${this.cols.manifests}{kind,checksum}`);
    return { replicaSet, indexes };
  }
  // Adapter for backup/restore over the resolved n8c collections.
  backupDb(): BackupDb {
    const db = this.db();
    const names = Object.values(this.cols);
    const IDX_OPTS = ['unique', 'partialFilterExpression', 'sparse', 'expireAfterSeconds'];
    return {
      names: () => names,
      find: async (n) => db.collection(n).find({}).toArray(),
      listIndexes: async (n) => {
        try {
          const idx: any[] = await db.collection(n).indexes();
          return idx.filter((i) => i.name !== '_id_').map((i) => {
            const options: Record<string, unknown> = {};
            for (const k of IDX_OPTS) if (i[k] !== undefined) options[k] = i[k];
            return { name: i.name, key: i.key, options };
          });
        } catch { return []; } // collection may not exist yet
      },
      recreate: async (n) => { try { await db.collection(n).drop(); } catch { /* absent */ } },
      insert: async (n, docs) => { if (docs.length) await db.collection(n).insertMany(docs); },
      createIndex: async (n, idx) => { await db.collection(n).createIndex(idx.key as any, { name: idx.name, ...(idx.options ?? {}) } as any); },
    };
  }
  async close(): Promise<void> { await this.client.close(); }
}
