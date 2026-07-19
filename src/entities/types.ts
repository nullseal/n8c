export interface EntityContext {
  env: string;
  encryptionKey?: string;
  encrypted: boolean;
  n8n?: import('../n8n.ts').N8nClient;
  getDefinitions(kind: string): Promise<Record<string, unknown>>;
  // Whether the active store serves the runtime prompt-content collection
  // (Mongo only). Undefined is treated as enabled for backward compatibility.
  promptContentsEnabled?: boolean;
}
export interface EntityDescriptor {
  kind: string;                 // 'workflows' | 'prompts' | 'credentials' (== dir + collection base)
  hasServer: boolean;           // false for prompts (no push/pull to n8n)
  // After a pull the engine records `definition[localId] = defValue ?? serverId`.
  // `serverId` is the entity's real id in the current env's n8n; `defValue`
  // overrides what's stored (credentials store `{id,name}` for remapping).
  pullFromServer?(ctx: EntityContext): Promise<{ localId: string; name: string; body: unknown; serverId?: string; defValue?: unknown }[]>;
  // Push the applied docs to n8n and return the FULL localId→value mapping for
  // the kind (replace-safe). `status` (localId → 'identical'|'changed'|'new')
  // lets the impl skip redundant server writes (e.g. not re-creating an
  // unchanged credential — n8n has no credential update).
  pushToServer?(ctx: EntityContext, docs: { localId: string; name: string; body: any; deployedId?: string }[], status?: Record<string, string>): Promise<Record<string, unknown>>; // returns definition mapping updates
  beforeSave?(ctx: EntityContext, body: unknown): unknown;  // credential: encrypt
  beforePush?(ctx: EntityContext, body: unknown, defs: Record<string, unknown>): Promise<unknown> | unknown; // workflow: remap credential refs; credential: decrypt
  collectExtra?(root: string, ctx: EntityContext): Promise<{ kind: string; docs: import('../store/store.ts').Doc[] }[]>; // workflow: extract node prompts into other collections
}
