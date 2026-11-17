import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderAgentSection, upsertAgentsMd, N8C_START, N8C_END } from '../src/engine/agent-context.ts';

test('renderAgentSection covers the loop, the layout, and the agent rules', () => {
  const s = renderAgentSection({ database: 'mongodb', promptContents: true });
  for (const must of [
    N8C_START, N8C_END,
    'n8c pull', 'n8c plan', 'n8c apply', 'n8c restore',   // the loop
    'n8c/',                                                // default root, top of the tree
    'workflows/', 'credentials/', 'prompts/',              // the layout
    'process.env',                                         // secrets rule
    'localId',                                             // id rule
    'n8c mcp',                                             // MCP hint
    'overwrites and prunes local entity files',            // pull's actual behaviour (prunes too)
    '`.states/`',                                          // .states/ called out, but outside the tree
    'nodes/*/code.ts',                                     // per-node Code-node bodies are editable too
  ]) assert.ok(s.includes(must), `section mentions ${must}`);
  assert.ok(!s.includes('undefined'), 'no leaked undefined interpolation');
  // .states/ must be documented, but NOT drawn as a child of the entity tree —
  // it lives at the project root, a sibling of the entities dir.
  assert.ok(!s.includes('└── .states/'), '.states/ is not a tree leaf');
  assert.ok(s.includes('at the project root'), '.states/ location is spelled out');
});

test('renderAgentSection omits prompt-contents when the backend disables them', () => {
  const s = renderAgentSection({ database: 'sqlite', promptContents: false });
  assert.ok(!s.includes('prompt-contents/'), 'sqlite backend → no prompt-contents dir mentioned');
});

test('renderAgentSection uses config.root as the tree top, default "n8c"', () => {
  const withRoot = renderAgentSection({ root: 'infra' });
  assert.ok(withRoot.includes('infra/'), 'custom root replaces the tree top line');
  assert.ok(!withRoot.includes('n8c/'), 'default root name is not left behind alongside the custom one');
  const withoutRoot = renderAgentSection({});
  assert.ok(withoutRoot.includes('n8c/'), 'omitting root falls back to n8c');
});

test('upsertAgentsMd: creates, appends, and replaces between markers without touching user content', () => {
  const section = renderAgentSection({});
  // create
  assert.equal(upsertAgentsMd(undefined, section), section + '\n');
  // append — user file without markers keeps its content, section lands at the end
  const appended = upsertAgentsMd('# My project\nRules here.\n', section);
  assert.ok(appended.startsWith('# My project\nRules here.\n'));
  assert.ok(appended.includes(N8C_START));
  // replace — a re-run swaps ONLY the marker block, user text on both sides survives
  const before = 'ABOVE\n' + section + '\nBELOW\n';
  const v2 = section.replace('n8c pull', 'n8c pull  ');
  const replaced = upsertAgentsMd(before, v2);
  assert.ok(replaced.startsWith('ABOVE\n') && replaced.endsWith('BELOW\n'));
  assert.equal(replaced.split(N8C_START).length, 2, 'exactly one start marker after re-run');
});

test('upsertAgentsMd: refuses START marker only (torn pair)', () => {
  const content = `# My doc\n${N8C_START}\nSome content\n`;
  assert.throws(
    () => upsertAgentsMd(content, 'new section'),
    /malformed/,
    'throws when only START marker present'
  );
});

test('upsertAgentsMd: refuses END marker only (torn pair)', () => {
  const content = `# My doc\nSome content\n${N8C_END}\n`;
  assert.throws(
    () => upsertAgentsMd(content, 'new section'),
    /malformed/,
    'throws when only END marker present'
  );
});

test('upsertAgentsMd: refuses END before START (inverted markers)', () => {
  const content = `# My doc\n${N8C_END}\nSome content\n${N8C_START}\n`;
  assert.throws(
    () => upsertAgentsMd(content, 'new section'),
    /malformed/,
    'throws when END comes before START'
  );
});

test('upsertAgentsMd: refuses multiple well-formed pairs', () => {
  const section = renderAgentSection({});
  const content = `# My doc\n${section}\nMiddle\n${section}\n`;
  assert.throws(
    () => upsertAgentsMd(content, 'new section'),
    /malformed/,
    'throws when more than one marker pair present'
  );
});

test('upsertAgentsMd: single well-formed pair replaces cleanly (control)', () => {
  const section = renderAgentSection({});
  const content = `BEFORE\n${section}\nAFTER\n`;
  const v2 = section.replace('n8c pull', 'n8c pull  ');
  const result = upsertAgentsMd(content, v2);
  assert.ok(result.includes('BEFORE') && result.includes('AFTER'), 'user content preserved');
  assert.equal(result.split(N8C_START).length, 2, 'exactly one marker pair');
  assert.ok(result.includes('n8c pull  '), 'updated section applied');
});

test('upsertAgentsMd: appending to a file without a trailing newline adds a blank-line separator', () => {
  const section = renderAgentSection({});
  assert.equal(upsertAgentsMd('# Title', section), '# Title\n\n' + section + '\n');
  assert.equal(upsertAgentsMd('# Title\n', section), '# Title\n\n' + section + '\n');
});
