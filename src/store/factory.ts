import type { Store } from './store.ts';

// Pick the store adapter from the config `database` attribute.
//  - mongodb: full-featured (versioning + runtime prompt content + db backup).
//  - sqlite:  single-file store; the runtime prompt-content feature is disabled
//             (only Mongo can serve the n8n load_prompts node).
// Unknown values fail clearly.
export async function createStore(
  database: string,
  vars: { MONGO_URI?: string; MONGO_DB?: string; SQLITE_PATH?: string },
  cfg: { collectionPrefix?: string; collections?: Record<string, string>; sqlite?: { file?: string } } = {},
): Promise<Store> {
  if (database === 'mongodb') {
    if (!vars.MONGO_URI || !vars.MONGO_DB) throw new Error('database "mongodb" requires MONGO_URI and MONGO_DB');
    const { MongoStore } = await import('./mongo.ts');
    const { resolveCollections } = await import('./collections.ts');
    return new MongoStore(vars.MONGO_URI, vars.MONGO_DB, resolveCollections(cfg)).connect();
  }
  if (database === 'sqlite') {
    const file = vars.SQLITE_PATH || cfg.sqlite?.file || 'n8c.sqlite';
    const { SqliteStore } = await import('./sqlite.ts');
    return new SqliteStore(file);
  }
  throw new Error(`unsupported database "${database}" (supported: mongodb, sqlite)`);
}
