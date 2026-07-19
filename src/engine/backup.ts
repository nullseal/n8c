// Back up / restore the n8c-managed Mongo collections (all records + indexes).
// The orchestration is pure and works over a small BackupDb port, so it's
// testable without a live database; MongoStore supplies the real adapter.

export interface BackupIndex { name: string; key: Record<string, 1 | -1>; options?: Record<string, unknown>; }
export interface BackupCollection { docs: any[]; indexes: BackupIndex[]; }
export interface BackupFile { format: 'n8c-backup/1'; n8cVersion: string; createdAt: string; db?: string; collections: Record<string, BackupCollection>; }

export interface BackupDb {
  names(): string[];                                  // the n8c collections to back up
  find(name: string): Promise<any[]>;                 // all docs (with _id)
  listIndexes(name: string): Promise<BackupIndex[]>;  // non-default indexes
  recreate(name: string): Promise<void>;              // drop (if any) so import starts clean
  insert(name: string, docs: any[]): Promise<void>;
  createIndex(name: string, index: BackupIndex): Promise<void>;
}

// db-export: dump every n8c collection's docs + indexes into one file object.
export async function dumpBackup(db: BackupDb, n8cVersion: string, dbName?: string): Promise<BackupFile> {
  const collections: Record<string, BackupCollection> = {};
  for (const name of db.names()) {
    collections[name] = { docs: await db.find(name), indexes: await db.listIndexes(name) };
  }
  return { format: 'n8c-backup/1', n8cVersion, createdAt: new Date().toISOString(), db: dbName, collections };
}

// db-import: recreate each collection then re-insert records and re-create indexes.
export async function restoreBackup(db: BackupDb, file: BackupFile): Promise<{ collections: number; docs: number; indexes: number }> {
  if (file?.format !== 'n8c-backup/1') throw new Error(`not an n8c backup file (format=${(file as any)?.format})`);
  let docs = 0, indexes = 0;
  const names = Object.keys(file.collections);
  for (const name of names) {
    const c = file.collections[name];
    await db.recreate(name);
    if (c.docs?.length) { await db.insert(name, c.docs); docs += c.docs.length; }
    for (const idx of c.indexes ?? []) { await db.createIndex(name, idx); indexes++; }
  }
  return { collections: names.length, docs, indexes };
}
