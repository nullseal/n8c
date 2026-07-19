import './sqlite-quiet.ts'; // must precede loading node:sqlite — silences its experimental warning
import { createRequire } from 'node:module';
import type { Store, Doc, ManifestEntry, Session, StoreCapabilities } from './store.ts';
import { mappingRows } from '../engine/cred-map.ts';

// Load node:sqlite at RUNTIME (require, not a static import) so the warning fires
// after sqlite-quiet has installed its filter — a static `import 'node:sqlite'`
// is linked before any user module evaluates, so the warning would slip through.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

// A single-file SQLite store. Same data model as the Mongo store (live docs,
// version snapshots, a version manifest, and per-env localId→n8nId definitions)
// mapped onto relational tables. Runtime prompt content is NOT supported here
// (capabilities.promptContents = false): that collection exists to be read by the
// n8n load_prompts node at execution time, which can only reach Mongo — so the
// engine skips the promptContents kind entirely when this store is active.
export class SqliteStore implements Store {
  readonly capabilities: StoreCapabilities = { promptContents: false, backup: false };
  private db: DatabaseSync;
  private txDepth = 0;

  constructor(file: string) { this.db = new DatabaseSync(file); this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;'); }

  async getLive(kind: string): Promise<Doc[]> {
    const rows = this.db.prepare('SELECT localId, name, body, checksum FROM live WHERE kind = ?').all(kind) as any[];
    return rows.map((r) => ({ localId: r.localId, name: r.name, body: JSON.parse(r.body), checksum: r.checksum }));
  }
  async putLive(kind: string, docs: Doc[], _s: Session): Promise<void> {
    this.db.prepare('DELETE FROM live WHERE kind = ?').run(kind);
    const ins = this.db.prepare('INSERT INTO live (kind, localId, name, body, checksum) VALUES (?, ?, ?, ?, ?)');
    for (const d of docs) ins.run(kind, d.localId, d.name, JSON.stringify(d.body), d.checksum);
  }
  async upsertLive(kind: string, docs: Doc[], _s: Session): Promise<void> {
    const up = this.db.prepare(
      'INSERT INTO live (kind, localId, name, body, checksum) VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT(kind, localId) DO UPDATE SET name = excluded.name, body = excluded.body, checksum = excluded.checksum');
    for (const d of docs) up.run(kind, d.localId, d.name, JSON.stringify(d.body), d.checksum);
  }

  async createSnapshot(kind: string, versionId: string, docs: Doc[], checksum: string, _s: Session, message?: string, draft?: boolean): Promise<void> {
    this.db.prepare('INSERT INTO manifests (kind, versionId, isActive, checksum, createdAt, message, draft) VALUES (?, ?, 0, ?, ?, ?, ?)')
      .run(kind, versionId, checksum, new Date().toISOString(), message ?? null, draft ? 1 : 0);
    const ins = this.db.prepare('INSERT INTO versions (kind, versionId, localId, name, body, checksum) VALUES (?, ?, ?, ?, ?, ?)');
    for (const d of docs) ins.run(kind, versionId, d.localId, d.name, JSON.stringify(d.body), d.checksum);
  }
  async listVersions(kind: string): Promise<ManifestEntry[]> {
    const rows = this.db.prepare('SELECT versionId, isActive, checksum, createdAt, message, draft FROM manifests WHERE kind = ? ORDER BY versionId ASC').all(kind) as any[];
    return rows.map((r) => ({ versionId: r.versionId, isActive: !!r.isActive, checksum: r.checksum, createdAt: r.createdAt, message: r.message ?? undefined, draft: !!r.draft }));
  }
  async getVersion(kind: string, versionId: string): Promise<Doc[]> {
    const rows = this.db.prepare('SELECT localId, name, body, checksum FROM versions WHERE kind = ? AND versionId = ?').all(kind, versionId) as any[];
    return rows.map((r) => ({ localId: r.localId, name: r.name, body: JSON.parse(r.body), checksum: r.checksum }));
  }
  async markActive(kind: string, versionId: string, _s: Session): Promise<void> {
    this.db.prepare('UPDATE manifests SET isActive = 0 WHERE kind = ?').run(kind);
    this.db.prepare('UPDATE manifests SET isActive = 1 WHERE kind = ? AND versionId = ?').run(kind, versionId);
  }
  async dropVersion(kind: string, versionId: string, _s: Session): Promise<void> {
    this.db.prepare('DELETE FROM manifests WHERE kind = ? AND versionId = ?').run(kind, versionId);
    this.db.prepare('DELETE FROM versions WHERE kind = ? AND versionId = ?').run(kind, versionId);
  }

  async putDefinitions(env: string, kind: string, mapping: Record<string, unknown>, _s: Session): Promise<void> {
    // Replace-semantics per {env,kind}; n8nId lifted out for the unique index.
    this.db.prepare('DELETE FROM definitions WHERE env = ? AND kind = ?').run(env, kind);
    const ins = this.db.prepare('INSERT INTO definitions (env, kind, localId, n8nId, value) VALUES (?, ?, ?, ?, ?)');
    for (const r of mappingRows(mapping)) ins.run(env, kind, r.localId, r.n8nId ?? null, JSON.stringify(r.value));
  }
  async getDefinitions(env: string, kind: string): Promise<Record<string, unknown>> {
    const rows = this.db.prepare('SELECT localId, value FROM definitions WHERE env = ? AND kind = ?').all(env, kind) as any[];
    const out: Record<string, unknown> = {};
    for (const r of rows) out[r.localId] = JSON.parse(r.value);
    return out;
  }

  async withTransaction<T>(fn: (session: Session) => Promise<T>): Promise<T> {
    // node:sqlite is synchronous and has no nested transactions — a depth guard
    // lets inner withTransaction calls join the outer one instead of erroring on
    // a second BEGIN.
    if (this.txDepth > 0) return fn({ id: 'sqlite' });
    this.db.exec('BEGIN');
    this.txDepth++;
    try { const r = await fn({ id: 'sqlite' }); this.db.exec('COMMIT'); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
    finally { this.txDepth--; }
  }

  async init(): Promise<{ replicaSet: boolean; indexes: string[] }> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS live (
        kind TEXT NOT NULL, localId TEXT NOT NULL, name TEXT, body TEXT NOT NULL, checksum TEXT,
        PRIMARY KEY (kind, localId));
      CREATE TABLE IF NOT EXISTS versions (
        kind TEXT NOT NULL, versionId TEXT NOT NULL, localId TEXT NOT NULL, name TEXT, body TEXT NOT NULL, checksum TEXT);
      CREATE INDEX IF NOT EXISTS versions_kv ON versions (kind, versionId);
      CREATE TABLE IF NOT EXISTS manifests (
        kind TEXT NOT NULL, versionId TEXT NOT NULL, isActive INTEGER, checksum TEXT, createdAt TEXT, message TEXT, draft INTEGER,
        PRIMARY KEY (kind, versionId));
      CREATE INDEX IF NOT EXISTS manifests_kc ON manifests (kind, checksum);
      CREATE TABLE IF NOT EXISTS definitions (
        env TEXT NOT NULL, kind TEXT NOT NULL, localId TEXT NOT NULL, n8nId TEXT, value TEXT NOT NULL,
        PRIMARY KEY (env, kind, localId));
      CREATE UNIQUE INDEX IF NOT EXISTS definitions_n8n ON definitions (env, kind, n8nId);
    `);
    // Single-writer file DB: transactions are always available (no replica set).
    return { replicaSet: true, indexes: ['live', 'versions{kind,versionId}', 'manifests{kind,versionId}', 'definitions{env,kind,localId}', 'definitions{env,kind,n8nId}'] };
  }

  backupDb(): never { throw new Error('backup is only supported for the mongodb store'); }
  async close(): Promise<void> { this.db.close(); }
}
