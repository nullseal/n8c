import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inlineUnit } from './build/inline.ts';

// True if the (type-stripped) source has real code beyond comments/whitespace.
function hasRealCode(src: string): boolean {
  return src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim().length > 0;
}

// Folder name for a kind (kind === folder, except the camelCase promptContents
// lives under the hyphenated `prompt-contents/`).
function kindDir(kind: string): string {
  return kind === 'promptContents' ? 'prompt-contents' : kind;
}

export function entityDir(root: string, kind: string, localId: string): string {
  return join(root, kindDir(kind), localId);
}

export function listEntityIds(root: string, kind: string): string[] {
  const dir = join(root, kindDir(kind));
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory());
}

async function runApply(file: string): Promise<unknown> {
  const mod = await import(pathToFileUrl(file));
  const def = mod.default;
  return typeof def === 'function' ? await def({}) : def;
}

// Import a companion file's default export, or undefined if the file is absent.
// Like apply.ts, the export may be a static value, a function, or an async
// function — a function is called with a context and awaited.
async function optionalImport(file: string): Promise<unknown> {
  if (!existsSync(file)) return undefined;
  const mod = await import(pathToFileUrl(file));
  const def = mod.default;
  return typeof def === 'function' ? await def({}) : def;
}

let importSeq = 0;
function pathToFileUrl(p: string): string {
  // pathToFileURL handles Windows drive letters / backslashes / encoding
  // (cross-platform). Cache-bust with a monotonic counter (not just Date.now())
  // so two reads within the same ms don't return the stale cached module.
  return `${pathToFileURL(p).href}?t=${Date.now()}-${++importSeq}`;
}

export interface EntityPrompt { localId: string; name: string; body: unknown; }
export interface ReadEntityResult { metadata: any; body: unknown; prompts: EntityPrompt[]; }

export async function readEntity(root: string, kind: string, localId: string, codeByNode: Record<string, string> = {}): Promise<ReadEntityResult> {
  const dir = entityDir(root, kind, localId);
  const metadata = JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf8'));
  const nodesDir = join(dir, 'nodes');
  if (kind === 'workflows' && existsSync(nodesDir)) {
    const nodeIds = readdirSync(nodesDir).filter((n) => statSync(join(nodesDir, n)).isDirectory());
    const idToName: Record<string, string> = {};
    const nodes: any[] = [];
    const prompts: EntityPrompt[] = [];
    const nodeConn: Record<string, unknown> = {}; // raw per-node connection.ts exports
    for (const nid of nodeIds) {
      const nmeta = JSON.parse(readFileSync(join(nodesDir, nid, 'metadata.json'), 'utf8'));
      const params = await runApply(join(nodesDir, nid, 'apply.ts'));
      idToName[nid] = nmeta.name;
      const parameters: any = (params && typeof params === 'object') ? params : {};
      // code.ts (reserved) → parameters.jsCode. Dual form:
      //  (a) module: `export default () => \`...\`` / async fn / string  → its value
      //  (b) raw body: real JS/TS with top-level `return` (may import helpers) → type-stripped
      const codeFile = join(nodesDir, nid, 'code.ts');
      if (existsSync(codeFile)) {
        const src = readFileSync(codeFile, 'utf8');
        if (/(^|\n)\s*export\b/.test(src)) {
          const val = await optionalImport(codeFile); // imports default, calls if fn
          if (typeof val === 'string' && hasRealCode(val)) parameters.jsCode = val;
        } else {
          const inlined = inlineUnit(join(nodesDir, nid));
          if (hasRealCode(inlined)) parameters.jsCode = inlined.replace(/\s+$/, '');
        }
      }
      if (codeByNode[nid] !== undefined) parameters.jsCode = codeByNode[nid];
      const node: any = { id: nid, name: nmeta.name, type: nmeta.type, typeVersion: nmeta.typeVersion, position: nmeta.position, parameters, notes: 'n8c@' + nid };
      const creds = await optionalImport(join(nodesDir, nid, 'credentials.ts'));
      if (creds) {
        node.credentials = {};
        for (const [t, cid] of Object.entries(creds as Record<string, string>)) node.credentials[t] = { id: cid };
      } else if (nmeta.credentials) {
        node.credentials = nmeta.credentials;
      }
      const pr: any = await optionalImport(join(nodesDir, nid, 'prompt.ts'));
      if (pr) prompts.push({ localId: pr.key, name: pr.key, body: pr });
      const conn = await optionalImport(join(nodesDir, nid, 'connection.ts'));
      if (conn !== undefined) nodeConn[nid] = conn;
      nodes.push(node);
    }
    // Resolve target nodeIds → node names in any connection subtree.
    const resolveConn = (conn: unknown) => JSON.parse(JSON.stringify(conn), (_k, v) =>
      (v && typeof v === 'object' && typeof v.node === 'string' && idToName[v.node]) ? { ...v, node: idToName[v.node] } : v);
    const connections: Record<string, any> = {};
    // (1) workflow metadata.json connections (keyed by nodeId).
    for (const [srcId, conn] of Object.entries(metadata.connections ?? {})) {
      connections[idToName[srcId] ?? srcId] = resolveConn(conn);
    }
    // (2) per-node connection.ts wins for its source node.
    for (const [nid, conn] of Object.entries(nodeConn)) {
      connections[idToName[nid] ?? nid] = resolveConn(conn);
    }
    const { connections: _c, ...rest } = metadata;
    const desc = (metadata.description ?? '').trim();
    const description = desc.includes('[n8c-managed]') ? desc : (desc ? desc + '\n[n8c-managed]' : '[n8c-managed]');
    return { metadata, body: { ...rest, nodes, connections, description }, prompts };
  }
  const body = await runApply(join(dir, 'apply.ts'));
  // Workflows with no nodes/ dir still get metadata.description passed through
  // to body.description (the n8n workflow field), matching the node branch.
  if (kind === 'workflows' && body && typeof body === 'object' && metadata.description !== undefined && (body as any).description === undefined) {
    (body as any).description = metadata.description;
  }
  return { metadata, body, prompts: [] };
}

export function writeEntity(root: string, kind: string, localId: string, metadata: any, body: unknown): void {
  const dir = entityDir(root, kind, localId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n');
  // Materialize as a plain function that returns the JSON (the reader awaits the
  // result, so it can be made `async` by hand later if real logic is added).
  const json = JSON.stringify(body, null, 2).replace(/\n/g, '\n  ');
  writeFileSync(join(dir, 'apply.ts'), `export default function () {\n  return ${json};\n}\n`);
}
