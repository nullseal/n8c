// Hand-rolled MCP (stdio) — deliberately zero-dep. The server exposes n8c's own
// CLI verbs as tools; every call SPAWNS the CLI, so plan/apply behaviour (drift
// gate, archived rules, output) is inherited, never reimplemented. `drop` and the
// gate-bypass flags (--force, --no-verify) are intentionally NOT exposed: an
// agent that hits the drift gate should re-plan, not override it.
export type ToolRunner = (argv: string[]) => Promise<{ text: string; ok: boolean }>;

const env = { env: { type: 'string', description: 'n8c environment name (maps to -e); omit for default' } };

export const MCP_TOOLS = [
  { name: 'n8c_pull', description: 'Import the live n8n instance into the DB and local files (overwrites local entity files).',
    inputSchema: { type: 'object', properties: { ...env }, additionalProperties: false } },
  { name: 'n8c_plan', description: 'Diff local entity files against live n8n and save the plan. Run after every edit.',
    inputSchema: { type: 'object', properties: { destroy: { type: 'boolean', description: 'include deletes for entities whose files were removed' }, ...env }, additionalProperties: false } },
  { name: 'n8c_apply', description: 'Execute the saved plan. Refuses if n8n drifted since plan — then re-run n8c_plan.',
    inputSchema: { type: 'object', properties: { message: { type: 'string', description: 'release note shown in n8c_list' }, ...env }, additionalProperties: false } },
  { name: 'n8c_list', description: 'List releases (generations), newest first.',
    inputSchema: { type: 'object', properties: { full: { type: 'boolean' }, ...env }, additionalProperties: false } },
  { name: 'n8c_restore', description: 'Roll every entity kind back to a generation (from n8c_list); src/ unit code is not rolled back. apply=true deploys it now.',
    inputSchema: { type: 'object', properties: { generation: { type: 'string' }, apply: { type: 'boolean' }, ...env }, required: ['generation'], additionalProperties: false } },
];

export function toolArgv(name: string, args: Record<string, unknown>): string[] {
  const e = args.env ? ['-e', String(args.env)] : [];
  const out: string[] = [];
  if (name === 'n8c_pull') out.push('pull', '-y', ...e);
  else if (name === 'n8c_plan') out.push('plan', ...(args.destroy ? ['--destroy'] : []), ...e);
  else if (name === 'n8c_apply') out.push('apply', ...(args.message ? ['-m', String(args.message)] : []), ...e);
  else if (name === 'n8c_list') out.push('list', ...(args.full ? ['--full'] : []), ...e);
  else if (name === 'n8c_restore') {
    if (!args.generation) throw new Error('n8c_restore requires a generation ref (see n8c_list)');
    // A generation ref that starts with "-" would be parsed by commander as a flag
    // (e.g. "--force") once splatted into argv, not as the positional ref — letting
    // a model-supplied string smuggle in a gate-bypass flag we deliberately don't
    // expose as a tool parameter. Reject it here, before it ever reaches argv.
    if (String(args.generation).startsWith('-')) throw new Error('n8c_restore: generation must not start with "-" (use a hash from n8c_list)');
    out.push('restore', String(args.generation), ...(args.apply ? ['--apply'] : []), ...e);
  } else throw new Error(`unknown tool: ${name}`);
  out.push('--pipe');
  return out;
}

const rpc = (id: unknown, body: object) => ({ jsonrpc: '2.0', id, ...body });

export async function handleMessage(msg: unknown, run: ToolRunner, version: string): Promise<object | undefined> {
  if (!msg || typeof msg !== 'object') return undefined;
  const { id, method, params } = msg as { id?: unknown; method?: unknown; params?: any };
  if (id === undefined) return undefined; // notification — never answered
  if (method === 'initialize') {
    return rpc(id, { result: {
      protocolVersion: params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'n8c', version },
    } });
  }
  if (method === 'ping') return rpc(id, { result: {} });
  if (method === 'tools/list') return rpc(id, { result: { tools: MCP_TOOLS } });
  if (method === 'tools/call') {
    // Tool failures are RESULTS (isError), not protocol errors — per the MCP spec,
    // so the model can read the CLI's message and react (e.g. re-plan on drift).
    try {
      const argv = toolArgv(String(params?.name), params?.arguments ?? {});
      const r = await run(argv);
      return rpc(id, { result: { content: [{ type: 'text', text: r.text }], ...(r.ok ? {} : { isError: true }) } });
    } catch (e: any) {
      return rpc(id, { result: { content: [{ type: 'text', text: String(e?.message ?? e) }], isError: true } });
    }
  }
  return rpc(id, { error: { code: -32601, message: `method not found: ${method}` } });
}
