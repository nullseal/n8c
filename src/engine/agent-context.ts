export const N8C_START = '<!-- n8c:start -->';
export const N8C_END = '<!-- n8c:end -->';

// The repo's standing instructions for AI agents. Static on purpose: the less it
// derives from live state, the less it drifts. Regenerate with `n8c agent`.
export function renderAgentSection(info: { database?: string; promptContents?: boolean; root?: string }): string {
  const pc = info.promptContents !== false;
  const root = info.root ?? 'n8c';
  // `.states/` is deliberately NOT in this tree — it lives at the project root,
  // a sibling of `root`, not inside it (see the note printed after the block).
  const items = [
    'workflows/<localId>/apply.ts       # one workflow per folder, body as code',
    'credentials/<localId>/apply.ts     # data comes from process.env — never a literal',
    'prompts/<localId>/apply.ts         # build-time prompts wired into nodes',
    ...(pc ? ['prompt-contents/<localId>/apply.ts # runtime prompts read by n8n at execution'] : []),
  ];
  const layout = [root + '/', ...items.map((line, i) => (i === items.length - 1 ? '└── ' : '├── ') + line)].join('\n');
  return `${N8C_START}
## n8n workflows in this repo (managed by n8c)

This repo versions n8n workflows, prompts and credentials as code and deploys
them with a Terraform-style loop${info.database ? ` (history in ${info.database})` : ''}:

\`\`\`
n8c pull       # import the live n8n instance into files (overwrites and prunes local entity files)
n8c plan       # diff files vs live n8n — run after EVERY edit, review before apply
n8c apply      # deploy; refuses if n8n drifted since plan (then: re-run n8c plan)
n8c list       # releases, newest first — every apply is a restorable generation
n8c restore <generation>   # roll everything back to a known-good release
\`\`\`

Layout:

\`\`\`
${layout}
\`\`\`

\`.states/\` (at the project root) holds plan output — machine-managed, do not edit.

Rules for agents working here:

- Edit \`apply.ts\` files — and, for a workflow using the per-node layout
  (\`nodes/<id>/apply.ts\` + \`code.ts\`), its \`nodes/*/code.ts\` files too. Never
  rename \`localId\` folder names — they ARE the env-neutral identity of every
  entity. Never edit \`.states/\`. In \`metadata.json\`, change only \`name\`/\`description\`.
- Secrets: a credential's \`data\` reads \`process.env.MY_TOKEN\`. Never write a
  literal secret into any file — this directory is committed.
- After editing, run \`n8c plan\` and read the diff before \`n8c apply\`. If apply
  reports drift, someone changed n8n meanwhile: re-run \`n8c plan\`, do not force.
- Archived workflows are skipped for update by design; unarchive in n8n first.
- Never bump version fields or delete history (\`n8c drop\`) on your own.

Agent-native access: \`n8c mcp\` starts an MCP (stdio) server exposing
pull / plan / apply / list / restore as tools.
${N8C_END}`;
}

// Create, append, or replace-in-place — user content outside the markers is never touched.
export function upsertAgentsMd(existing: string | undefined, section: string): string {
  if (existing === undefined || existing.trim() === '') return section + '\n';
  const start = existing.indexOf(N8C_START);
  const end = existing.indexOf(N8C_END);

  // Count total occurrences to detect torn or multiple marker pairs.
  // A torn pair (one marker present), mismatched counts, or markers out of order must
  // never be "repaired" by appending: that leaves a stale orphaned marker that a later
  // run will mispair with the new block's markers, leading to silent content loss when
  // the guard passes and replace executes between the old and new markers.
  const startCount = existing.split(N8C_START).length - 1;
  const endCount = existing.split(N8C_END).length - 1;

  if (startCount !== endCount || startCount > 1 || (start !== -1 && end !== -1 && end < start)) {
    throw new Error(`AGENTS.md has a malformed n8c marker pair (${N8C_START} / ${N8C_END}) — fix or remove the markers, then re-run \`n8c agent\``);
  }

  if (start !== -1 && end !== -1) {
    return existing.slice(0, start) + section + existing.slice(end + N8C_END.length);
  }
  return existing.endsWith('\n') ? existing + '\n' + section + '\n' : existing + '\n\n' + section + '\n';
}
