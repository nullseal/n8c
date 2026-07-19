export interface Doc { localId: string; name: string; body: unknown; checksum: string; }
export interface ManifestEntry { versionId: string; isActive: boolean; checksum: string; createdAt: string; message?: string; draft?: boolean; }
export interface Session { readonly id: string; }
// What a store backend supports. `promptContents`: the runtime prompt collection
// the n8n load_prompts node reads — only Mongo can serve it, so other backends
// set it false and the engine skips that kind. `backup`: the db export/import port.
export interface StoreCapabilities { promptContents: boolean; backup: boolean; }
export interface Store {
  readonly capabilities: StoreCapabilities;
  getLive(kind: string): Promise<Doc[]>;
  putLive(kind: string, docs: Doc[], session: Session): Promise<void>;
  upsertLive(kind: string, docs: Doc[], session: Session): Promise<void>;
  createSnapshot(kind: string, versionId: string, docs: Doc[], checksum: string, session: Session, message?: string, draft?: boolean): Promise<void>;
  listVersions(kind: string): Promise<ManifestEntry[]>;
  getVersion(kind: string, versionId: string): Promise<Doc[]>;
  markActive(kind: string, versionId: string, session: Session): Promise<void>;
  // Delete a version from history: its manifest entry AND its version docs. Live
  // docs are untouched. Idempotent (dropping a missing version is a no-op).
  dropVersion(kind: string, versionId: string, session: Session): Promise<void>;
  putDefinitions(env: string, kind: string, mapping: Record<string, unknown>, session: Session): Promise<void>;
  getDefinitions(env: string, kind: string): Promise<Record<string, unknown>>;
  withTransaction<T>(fn: (session: Session) => Promise<T>): Promise<T>;
  // Reconcile indexes and report whether the deployment is a replica set
  // (transactions require one). Idempotent.
  init(): Promise<{ replicaSet: boolean; indexes: string[] }>;
  // Low-level port for `backup db-export|db-import` (mongodb only).
  backupDb(): import('../engine/backup.ts').BackupDb;
  close(): Promise<void>;
}
