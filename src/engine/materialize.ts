// Generate a readable single-file `apply.ts` for a workflow: each node is a
// named `const`, Code-node `jsCode` becomes a template-literal const, and the
// default export returns the workflow referencing those node vars. n8n keys
// connections by node NAME, so they render as-is.

// JS reserved words that can't be used as a bare `const` identifier.
const RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in',
  'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof',
  'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'await', 'async', 'implements', 'interface',
  'package', 'private', 'protected', 'public', 'arguments', 'eval',
]);

function slugify(name: string, used: Set<string>): string {
  let s = (name || 'node').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'node';
  if (/^[0-9]/.test(s)) s = 'n_' + s;
  s = s[0].toLowerCase() + s.slice(1);
  if (RESERVED.has(s)) s = s + '_'; // e.g. `if` → `if_`, `switch` → `switch_`
  let out = s;
  let i = 2;
  while (used.has(out)) out = s + '_' + i++;
  used.add(out);
  return out;
}

// A JS template literal for arbitrary code (escapes backslash, backtick, ${).
function tmpl(code: string): string {
  return '`' + code.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`';
}

// Rewrite node credential ids n8n-id → credential localId (env-neutral) using a
// reverse mapping { n8nId: localId }. Unknown ids are left as-is.
function relinkCredentials(nodes: any[], n8nIdToLocal: Record<string, string>): any[] {
  return nodes.map((node) => {
    if (!node?.credentials) return node;
    const creds: any = {};
    for (const [type, ref] of Object.entries<any>(node.credentials)) {
      const localId = ref?.id && n8nIdToLocal[String(ref.id)];
      creds[type] = localId ? { ...ref, id: localId } : ref;
    }
    return { ...node, credentials: creds };
  });
}

export function materializeWorkflowSource(body: any, n8nIdToLocal: Record<string, string> = {}): string {
  const b = body ?? {};
  const nodes: any[] = relinkCredentials(b.nodes ?? [], n8nIdToLocal);
  const { nodes: _n, connections, ...rest } = b;

  const used = new Set<string>();
  const codeConsts: string[] = [];
  const nodeConsts: string[] = [];
  const slugs: string[] = [];

  for (const node of nodes) {
    const slug = slugify(node?.name ?? 'node', used);
    slugs.push(slug);
    const n2 = JSON.parse(JSON.stringify(node));
    let codeVar: string | null = null;
    if (n2.parameters && typeof n2.parameters.jsCode === 'string') {
      codeVar = slug + 'Code';
      codeConsts.push(`const ${codeVar} = ${tmpl(n2.parameters.jsCode)};`);
      n2.parameters.jsCode = '__JSCODE__';
    }
    let s = JSON.stringify(n2, null, 2);
    if (codeVar) s = s.replace('"__JSCODE__"', codeVar);
    nodeConsts.push(`const ${slug} = ${s};`);
  }

  const wf = { ...rest, nodes: '__NODES__', connections: connections ?? {} };
  const wfStr = JSON.stringify(wf, null, 2).replace('"__NODES__"', `[${slugs.join(', ')}]`);

  const parts: string[] = [];
  // Editor-only type (erasable — Node still runs this file unchanged).
  parts.push("import type { Workflow } from '../../n8c.types.ts';");
  parts.push('');
  if (codeConsts.length) { parts.push(codeConsts.join('\n\n')); parts.push(''); }
  if (nodeConsts.length) { parts.push(nodeConsts.join('\n\n')); parts.push(''); }
  parts.push(`export default (): Workflow => (${wfStr});`);
  parts.push('');
  return parts.join('\n');
}
