import type { Store, Doc, ManifestEntry, Session, StoreCapabilities } from './store.ts';
import { normalizeMapping } from '../engine/cred-map.ts';

export class MemoryStore implements Store {
  readonly capabilities: StoreCapabilities = { promptContents: true, backup: false };
  private live = new Map<string, Doc[]>();
  private snaps = new Map<string, Map<string, Doc[]>>();
  private manifest = new Map<string, ManifestEntry[]>();
  private defs = new Map<string, Record<string, unknown>>();

  async getLive(kind: string): Promise<Doc[]> { return this.live.get(kind) ?? []; }
  async putLive(kind: string, docs: Doc[], _s: Session): Promise<void> { this.live.set(kind, docs); }
  async upsertLive(kind: string, docs: Doc[], _s: Session): Promise<void> {
    const cur = this.live.get(kind) ?? [];
    const byId = new Map(cur.map((d) => [d.localId, d]));
    for (const d of docs) byId.set(d.localId, d);
    this.live.set(kind, [...byId.values()]);
  }

  async createSnapshot(kind: string, versionId: string, docs: Doc[], checksum: string, _s: Session, message?: string, draft?: boolean): Promise<void> {
    if (!this.snaps.has(kind)) this.snaps.set(kind, new Map());
    this.snaps.get(kind)!.set(versionId, docs);
    const list = this.manifest.get(kind) ?? [];
    list.push({ versionId, isActive: false, checksum, createdAt: new Date().toISOString(), message, draft });
    this.manifest.set(kind, list);
  }
  async listVersions(kind: string): Promise<ManifestEntry[]> { return this.manifest.get(kind) ?? []; }
  async getVersion(kind: string, versionId: string): Promise<Doc[]> { return this.snaps.get(kind)?.get(versionId) ?? []; }
  async markActive(kind: string, versionId: string, _s: Session): Promise<void> {
    for (const e of this.manifest.get(kind) ?? []) e.isActive = e.versionId === versionId;
  }
  async dropVersion(kind: string, versionId: string, _s: Session): Promise<void> {
    this.manifest.set(kind, (this.manifest.get(kind) ?? []).filter((e) => e.versionId !== versionId));
    this.snaps.get(kind)?.delete(versionId);
  }
  async putDefinitions(env: string, kind: string, mapping: Record<string, unknown>, _s: Session): Promise<void> {
    // normalize so every n8n id maps to exactly one localId (matches the Mongo
    // unique {env,kind,n8nId} index; legacy pollution self-heals on write).
    this.defs.set(env + ':' + kind, normalizeMapping(mapping));
  }
  async getDefinitions(env: string, kind: string): Promise<Record<string, unknown>> {
    return this.defs.get(env + ':' + kind) ?? {};
  }
  backupDb(): never { throw new Error('backup is only supported for the mongodb store'); }
  async withTransaction<T>(fn: (session: Session) => Promise<T>): Promise<T> { return fn({ id: 'mem' }); }
  async init(): Promise<{ replicaSet: boolean; indexes: string[] }> { return { replicaSet: true, indexes: [] }; }
  async close(): Promise<void> {}
}
