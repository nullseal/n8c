import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const APPLY_TEMPLATE = `export default {\n  // TODO: return the entity JSON\n};\n`;

// Reserved node companion stubs — commented so they're inert until filled in
// (an absent default export → the builder skips that companion).
const NODE_CODE_STUB = [
  '// Code-node body → parameters.jsCode. Two forms (uncomment one):',
  '//',
  '// (a) module — a jsCode string:',
  '// export default `return items.map(i => i.json);`;',
  '//',
  '// (b) raw body — real JS/TS, top-level `return` is fine, may `import` helpers:',
  '// return items.map(i => ({ json: { ...i.json } }));',
  '',
].join('\n');
const NODE_CONNECTION_STUB = `// Outgoing connections of this node (node = TARGET nodeId). Or use \`n8c node set-connection\`.\n// export default { main: [[{ node: '<targetNodeId>', type: 'main', index: 0 }]] };\n`;
const NODE_OTHER_HINT = `\n// Other reserved companions (add a file when needed):\n//   prompt.ts       → export default { key: 'my_prompt', content: '...' }  (extracted to n8c_prompts)\n//   credentials.ts  → export default { httpHeaderAuth: '<credentialLocalId>' }  (remapped at push)\n`;

// Env var name derived from a credential name: uppercase, non-alnum -> _.
function envVarName(name: string): string {
  return (name || 'credential').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') + '_TOKEN';
}

// Credential apply.ts reads its secret from the environment (.env.<env>) via
// `process.env.<VAR>` so no secret is ever hard-coded in a source file.
function credentialTemplate(name: string, type: string): string {
  const envName = envVarName(name);
  return `export default {\n` +
    `  name: ${JSON.stringify(name)},\n` +
    `  type: ${JSON.stringify(type || 'httpHeaderAuth')},\n` +
    `  // Secret comes from .env — the source file holds only the reference, never the secret:\n` +
    `  data: { token: process.env.${envName} },\n` +
    `};\n`;
}
const TYPE_TO_KIND: Record<string, string> = { workflow: 'workflows', prompt: 'prompts', credential: 'credentials' };

export interface CreateOpts {
  name?: string;
  description?: string;
  nodeType?: string;
  key?: string;
  workflowId?: string;
}

// createEntity is a pure, flag-driven scaffolder (no prompts). The interactive
// readline path lives in the CLI and only fills missing fields on a TTY.
export function createEntity(root: string, type: 'workflow' | 'prompt' | 'credential' | 'node', opts: CreateOpts): { localId: string; dir: string } {
  const localId = randomUUID();
  let dir: string;
  const metadata: Record<string, unknown> = { name: opts.name ?? `new-${type}` };
  if (opts.description !== undefined) metadata.description = opts.description;

  if (type === 'node') {
    if (!opts.workflowId) throw new Error('create node requires --workflow=<workflowId>');
    dir = join(root, 'workflows', opts.workflowId, 'nodes', localId);
    metadata.type = opts.nodeType ?? '';
    metadata.typeVersion = 1;
    metadata.position = [0, 0];
  } else {
    const kind = TYPE_TO_KIND[type];
    if (!kind) throw new Error(`unknown entity type ${type}`);
    dir = join(root, kind, localId);
    if (type === 'prompt' && opts.key !== undefined) metadata.key = opts.key;
    if (type === 'credential' && opts.nodeType !== undefined) metadata.type = opts.nodeType;
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n');
  const applyBody = type === 'credential'
    ? credentialTemplate(opts.name ?? 'credential', opts.nodeType ?? 'httpHeaderAuth')
    : APPLY_TEMPLATE;
  writeFileSync(join(dir, 'apply.ts'), applyBody);
  if (type === 'node') {
    // Reserved companion stubs (commented out → no-op until you fill them in).
    // prompt.ts / credentials.ts are also reserved but node-type-specific — add
    // them by hand when needed (see the comments below for their shape).
    writeFileSync(join(dir, 'code.ts'), NODE_CODE_STUB);
    writeFileSync(join(dir, 'connection.ts'), NODE_CONNECTION_STUB + NODE_OTHER_HINT);
  }
  return { localId, dir };
}

// Backwards-compatible alias for the pre-Phase-2 `generate` verb (still used by
// engine-verbs.test.ts). Maps a plural `kind` to a create type.
export function generateEntity(root: string, kind: string, _opts: Record<string, unknown>): { localId: string; dir: string } {
  const type = kind.slice(0, -1) as 'workflow' | 'prompt' | 'credential';
  return createEntity(root, type, {});
}
