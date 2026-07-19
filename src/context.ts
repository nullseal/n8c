import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStore } from './store/factory.ts';
import { N8nClient } from './n8n.ts';
import { loadEnv } from './env.ts';
import { entityByKind } from './entities/index.ts';
import type { EntityContext } from './entities/types.ts';

// Active env = explicit --env flag > config.defaultEnv > "default".
export async function buildContext(cwd: string, kind: string, envFlag?: string) {
  let config: any = {};
  try { config = JSON.parse(readFileSync(join(cwd, 'n8c.config.json'), 'utf8')); } catch {}
  const env = envFlag ?? config.defaultEnv ?? 'default';
  const vars = { ...loadEnv(cwd, env), ...process.env };
  const root = join(cwd, config.root ?? 'n8c');
  const desc = entityByKind[kind];
  const store = await createStore(config.database ?? 'mongodb', vars, { collectionPrefix: config.collectionPrefix, collections: config.collections, sqlite: config.sqlite });
  const n8n = vars.N8N_BASE ? new N8nClient(vars.N8N_BASE, vars.N8N_API_KEY ?? '', undefined, config.n8nProjectId || undefined) : undefined;
  const ctx: EntityContext = {
    env,
    encrypted: config.credentials?.encrypted !== false,
    encryptionKey: vars.N8C_CREDENTIAL_ENCRYPTION_KEY,
    n8n,
    getDefinitions: (k: string) => store.getDefinitions(env, k),
    promptContentsEnabled: store.capabilities.promptContents,
  };
  return { ctx, store, desc, root, env };
}
