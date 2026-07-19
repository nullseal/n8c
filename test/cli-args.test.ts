import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderVersion, resolveVersionRef, pickVersion, buildProgram, renderApplyTail } from '../src/cli.ts';
import { setStyle } from '../src/style.ts';

test('pickVersion: explicit ref, else active, else newest, else throws', () => {
  const vs = [
    { versionId: 'v1', checksum: 'aaaa', isActive: false },
    { versionId: 'v2', checksum: 'bbbb', isActive: true },
    { versionId: 'v3', checksum: 'cccc', isActive: false },
  ];
  assert.equal(pickVersion(vs, 'v1'), 'v1');           // explicit
  assert.equal(pickVersion(vs), 'v2');                  // active
  assert.equal(pickVersion(vs.map((v) => ({ ...v, isActive: false }))), 'v3'); // no active → newest
  assert.throws(() => pickVersion([]), /no versions available/);
});

test('resolveVersionRef matches exact id or unique hash prefix', () => {
  const vs = [
    { versionId: '2026-01-01T00:00:00Z', checksum: 'a1b2c3d4ffff' },
    { versionId: '2026-01-02T00:00:00Z', checksum: 'a1b2ffffffff' },
    { versionId: '2026-01-03T00:00:00Z', checksum: 'bbeef00000000' },
  ];
  assert.equal(resolveVersionRef(vs, '2026-01-02T00:00:00Z'), '2026-01-02T00:00:00Z');
  assert.equal(resolveVersionRef(vs, 'bb'), '2026-01-03T00:00:00Z');              // unique prefix
  assert.throws(() => resolveVersionRef(vs, 'a1b2'), /ambiguous/);                 // 2 matches
  assert.throws(() => resolveVersionRef(vs, 'nope'), /no version matching/);
});

test('renderVersion truncates the message but keeps it full with --full', () => {
  const long = 'x'.repeat(100);
  const v = { isActive: true, versionId: '2026-01-01T00:00:00Z', checksum: 'a'.repeat(64), message: long };
  const short = renderVersion(v, false);
  const full = renderVersion(v, true);
  assert.ok(short.includes('…'), 'truncated with ellipsis');
  assert.ok(short.includes('aaaaaaaa') && !short.includes('a'.repeat(64)), 'short hash');
  assert.ok(full.includes(long), 'full message kept');
  assert.ok(full.includes('a'.repeat(64)), 'full hash');
  assert.ok(short.startsWith('* '), 'active marker');
  assert.ok(short.indexOf('aaaaaaaa') < short.indexOf('2026-01-01'), 'hash is left of the versionId date');
});

test('renderVersion colors the hash when style is on, raw when off (--pipe)', () => {
  const v = { isActive: true, versionId: '2026-07-19T00:00:00Z', checksum: 'a1b2c3d4ef', message: 'hi' };
  try {
    setStyle(true);
    const colored = renderVersion(v, false);
    assert.ok(colored.includes('\x1b[36ma1b2c3d4\x1b[0m'), 'hash wrapped in cyan');
    setStyle(false);
    const raw = renderVersion(v, false);
    assert.ok(!raw.includes('\x1b['), 'no ANSI codes when style off');
  } finally { setStyle(false); }
});

test('renderApplyTail: identical → no changes; dry non-identical → (unknown); real → versionId', () => {
  assert.equal(renderApplyTail('identical', undefined), 'no changes');
  assert.equal(renderApplyTail('identical', '2026-07-19T00:00:00Z'), 'no changes');
  assert.equal(renderApplyTail('new', undefined), '(unknown)');      // --dry: version known after apply
  assert.equal(renderApplyTail('changed', undefined), '(unknown)');
  assert.equal(renderApplyTail('new', '2026-07-19T00:00:00Z'), '2026-07-19T00:00:00Z');
});

test('--pipe is a global option', () => {
  assert.ok(buildProgram().options.some((o) => o.long === '--pipe'));
});

test('unknown command is wired to show help (command:* handler present)', () => {
  assert.equal(buildProgram().listenerCount('command:*'), 1);
});

test('buildProgram wires the Terraform-style top-level commands', () => {
  const names = buildProgram().commands.map((c) => c.name());
  for (const n of ['init', 'plan', 'apply', 'restore', 'list', 'pull', 'db', 'create']) {
    assert.ok(names.includes(n), `missing command ${n}`);
  }
  // removed: entity groups, build, node, environment/definition, backup, export
  for (const gone of ['workflow', 'prompt', 'credential', 'build', 'node', 'environment', 'definition', 'backup', 'export']) {
    assert.ok(!names.includes(gone), `${gone} should be gone`);
  }
});

test('pull has --no-export; db has export/import subcommands', () => {
  const cmds = buildProgram().commands;
  const pull = cmds.find((c) => c.name() === 'pull')!;
  assert.ok(pull.options.some((o) => o.long === '--no-export'));
  const db = cmds.find((c) => c.name() === 'db')!;
  const dbVerbs = db.commands.map((c) => c.name());
  assert.ok(dbVerbs.includes('export') && dbVerbs.includes('import'));
});

test('apply has --force/--destroy for one-shot plan+apply', () => {
  const apply = buildProgram().commands.find((c) => c.name() === 'apply')!;
  const longs = apply.options.map((o) => o.long);
  assert.ok(longs.includes('--force') && longs.includes('--destroy'));
});

test('plan has --destroy and restore has --apply (no --kind — restore spans all kinds)', () => {
  const cmds = buildProgram().commands;
  const plan = cmds.find((c) => c.name() === 'plan')!;
  assert.ok(plan.options.some((o) => o.long === '--destroy'));
  const restore = cmds.find((c) => c.name() === 'restore')!;
  const longs = restore.options.map((o) => o.long);
  assert.ok(longs.includes('--apply'));
  assert.ok(!longs.includes('--kind'), 'restore no longer scopes to one kind');
});

test('drop command exists with variadic refs and no --force (active is never droppable)', () => {
  const drop = buildProgram().commands.find((c) => c.name() === 'drop')!;
  assert.ok(drop, 'drop command registered');
  assert.equal(drop.registeredArguments[0].variadic, true, 'takes multiple refs');
  assert.ok(!drop.options.some((o) => o.long === '--force'), 'no --force override');
});
