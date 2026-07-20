import type { EntityContext } from '../entities/types.ts';

// Generate `n8c/n8c.types.ts` — editor-only types for the entity `apply.ts` files.
// The credential field names come from n8n itself (GET /credentials/schema/{type}),
// which is the only way to learn them: n8n never returns credential data, so a
// wrong key is otherwise only discovered as a 400 at apply time.
//
// Everything emitted here is ERASABLE TypeScript (`import type`, `satisfies`,
// return-type annotations), so Node's type stripping still runs the files
// unchanged — the types exist purely for your editor.

const INDENT = '  ';

function quoteKey(k: string): string {
  // bare identifier when safe, else a quoted key (no regex — repo preference)
  const ok = k.length > 0
    && !(k[0] >= '0' && k[0] <= '9')
    && [...k].every((c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_' || c === '$');
  return ok ? k : JSON.stringify(k);
}

// Convert a (subset of) JSON Schema to a TypeScript type literal. n8n credential
// schemas are usually a flat object of string fields, but some use oneOf/allOf
// alternatives (e.g. mongoDb: connectionString OR host+user+password+port).
// Anything we can't model faithfully degrades to `Record<string, unknown>`.
export function jsonSchemaToTs(schema: any, depth = 0): string {
  if (!schema || typeof schema !== 'object') return 'unknown';
  if (depth > 4) return 'Record<string, unknown>';

  if (Array.isArray(schema.enum) && schema.enum.length) {
    return schema.enum.map((v: unknown) => JSON.stringify(v)).join(' | ');
  }
  for (const key of ['oneOf', 'anyOf'] as const) {
    if (Array.isArray(schema[key]) && schema[key].length) {
      return schema[key].map((s: any) => jsonSchemaToTs(s, depth + 1)).join(' | ');
    }
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length) {
    return schema.allOf.map((s: any) => jsonSchemaToTs(s, depth + 1)).join(' & ');
  }

  const t = schema.type;
  if (t === 'string') return 'string';
  if (t === 'number' || t === 'integer') return 'number';
  if (t === 'boolean') return 'boolean';
  if (t === 'array') return `${jsonSchemaToTs(schema.items, depth + 1)}[]`;

  if (t === 'object' || schema.properties) {
    const props = schema.properties ?? {};
    const names = Object.keys(props);
    if (!names.length) return 'Record<string, unknown>';
    const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
    const pad = INDENT.repeat(depth + 2);
    const lines = names.map((n) => `${pad}${quoteKey(n)}${required.has(n) ? '' : '?'}: ${jsonSchemaToTs(props[n], depth + 1)};`);
    return `{\n${lines.join('\n')}\n${INDENT.repeat(depth + 1)}}`;
  }
  return 'Record<string, unknown>';
}

// Field names a credential type's `data` MUST carry. n8n validates the full schema
// even on a partial PATCH, so a data object missing any of these is rejected.
// `oneOf`/`anyOf` are alternatives, not requirements, so they're skipped.
export function collectRequiredFields(schema: any, depth = 0): string[] {
  if (!schema || typeof schema !== 'object' || depth > 4) return [];
  const out: string[] = [];
  if (Array.isArray(schema.required)) for (const r of schema.required) if (typeof r === 'string') out.push(r);
  if (Array.isArray(schema.allOf)) for (const s of schema.allOf) out.push(...collectRequiredFields(s, depth + 1));
  return [...new Set(out)];
}

// Default values n8n declares for a credential type's fields — the same ones its UI
// uses to prefill the form. n8n validates the WHOLE schema on every write and never
// returns credential data, so these defaults are the only way to complete a partial
// `data` object. Walks allOf/oneOf/anyOf so inherited fields are included.
export function collectFieldDefaults(schema: any, depth = 0): Record<string, unknown> {
  if (!schema || typeof schema !== 'object' || depth > 5) return {};
  const out: Record<string, unknown> = {};
  for (const branch of ['allOf', 'oneOf', 'anyOf'] as const) {
    if (Array.isArray(schema[branch])) {
      for (const s of schema[branch]) Object.assign(out, collectFieldDefaults(s, depth + 1));
    }
  }
  const props = schema.properties;
  if (props && typeof props === 'object') {
    for (const [k, v] of Object.entries<any>(props)) {
      if (v && typeof v === 'object' && 'default' in v) out[k] = v.default;
    }
  }
  return out;
}

export interface CredentialTypeSchema { type: string; ts: string; }

// Fetch the data schema for each credential type. A type whose schema can't be
// read (404 / no permission) degrades to an open record rather than failing.
export async function fetchCredentialTypes(ctx: EntityContext, types: string[]): Promise<CredentialTypeSchema[]> {
  const out: CredentialTypeSchema[] = [];
  for (const type of [...new Set(types)].sort()) {
    let ts = 'Record<string, unknown>';
    try {
      const schema = await (ctx.n8n as any)?.getCredentialSchema?.(type);
      if (schema) ts = jsonSchemaToTs(schema);
    } catch { /* unreadable schema → open record */ }
    out.push({ type, ts });
  }
  return out;
}

// Ambient `process.env` so entity files type-check without @types/node.
//
// Emitted ONLY when @types/node isn't available: declaring it alongside Node's own
// types fails with TS2403 ("Subsequent variable declarations must have the same
// type"). Values are `string` rather than `string | undefined` on purpose — n8c
// resolves these at deploy time and `plan` already fails loudly when a referenced
// variable is unset, so the extra `| undefined` would only force noise like `!`
// or `?? ''` in every credential file.
const PROCESS_DECL = `
declare global {
  /** Minimal \`process.env\` for entity files (no @types/node needed). */
  var process: { env: Record<string, string> };
}
`;

// Render the whole n8c.types.ts file.
export function renderTypesFile(creds: CredentialTypeSchema[], opts: { declareProcess?: boolean } = {}): string {
  const credEntries = creds.length
    ? creds.map((c) => `${INDENT}${quoteKey(c.type)}: ${c.ts};`).join('\n')
    : `${INDENT}[type: string]: Record<string, unknown>;`;
  return `// GENERATED by \`n8c types\` — do not edit.
// Editor-only types for the entity apply.ts files. Every construct here is
// erasable TypeScript, so Node still runs the files unchanged at deploy time.
//
// Credential field names come from your n8n instance
// (GET /credentials/schema/{type}); re-run \`n8c types\` after adding a
// credential of a new type.

/** \`data\` field shapes per n8n credential type. */
export interface CredentialData {
${credEntries}
}

export type CredentialType = keyof CredentialData;

/** A credential entity. \`data\` is typed by the credential's \`type\`. */
export interface Credential<T extends CredentialType = CredentialType> {
  name: string;
  type: T;
  data?: CredentialData[T];
}

/** A build-time prompt (wired into an agent/LLM node at deploy). */
export interface Prompt {
  key?: string;
  content?: string;
  blocks?: unknown;
  type?: string;
  source?: { workflow: string; nodeName: string; nodeType: string; index: number };
  [k: string]: unknown;
}

/** A runtime prompt-content doc (read from the DB while a workflow runs). */
export interface PromptContent {
  key: string;
  content?: string;
  blocks?: unknown;
  [k: string]: unknown;
}

/** An n8n workflow body (only the fields n8c writes). */
export interface WorkflowNode {
  id?: string;
  name: string;
  type: string;
  typeVersion?: number;
  position?: [number, number];
  parameters?: Record<string, unknown>;
  credentials?: Record<string, { id: string; name?: string }>;
  notes?: string;
  [k: string]: unknown;
}

export interface Workflow {
  name: string;
  nodes: WorkflowNode[];
  connections: Record<string, unknown>;
  settings?: Record<string, unknown>;
  description?: string;
  active?: boolean;
  [k: string]: unknown;
}
${opts.declareProcess ? PROCESS_DECL : ''}`;
}

// The tsconfig the entity files need: `.ts` import specifiers (allowImportingTsExtensions,
// which requires noEmit) and the n8c root on the include path. Never overwrites an
// existing tsconfig.
export function renderTsconfig(rootDirName: string): string {
  return JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      allowImportingTsExtensions: true,
      noEmit: true,
      strict: true,
      skipLibCheck: true,
    },
    include: [`${rootDirName}/**/*.ts`],
  }, null, 2) + '\n';
}
