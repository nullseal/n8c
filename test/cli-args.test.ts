import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveGenerationRef, buildProgram, renderApplyTail, dirHasEntities, groupByGeneration, renderGeneration } from '../src/cli.ts';
import { setStyle } from '../src/style.ts';

const perKind = () => [
  { kind: 'workflow', versions: [{ versionId: 'V1', isActive: false, checksum: 'aaa' }, { versionId: 'V2', isActive: true, message: 'rel2', checksum: 'bbb' }] },
  { kind: 'prompt', versions: [{ versionId: 'V2', isActive: true, checksum: 'ccc' }, { versionId: 'Vp', isActive: false, message: 'pull', checksum: 'ddd' }] },
];

test('two generations with IDENTICAL content still get distinct hashes (references stay unambiguous)', () => {
  // Regression: the hash used to be purely content-addressed, so a pull followed by
  // an apply that changed nothing produced two rows with the SAME hash — and
  // `n8c drop <hash>` failed with "ambiguous generation hash (2 matches)".
  const same = [{ versionId: 'V1', isActive: false, checksum: 'aaa' }, { versionId: 'V2', isActive: true, checksum: 'aaa' }];
  const gens = groupByGeneration([{ kind: 'workflows', versions: same }]);
  assert.equal(gens.length, 2);
  assert.notEqual(gens[0].hash, gens[1].hash, 'same content, different generation → different hash');
  // …and each still resolves on its own
  assert.equal(resolveGenerationRef(gens, gens[0].hash.slice(0, 8)), gens[0].versionId);
  assert.equal(resolveGenerationRef(gens, gens[1].hash.slice(0, 8)), gens[1].versionId);
});

test('the hash still changes when content changes', () => {
  const a = groupByGeneration([{ kind: 'workflows', versions: [{ versionId: 'V1', isActive: false, checksum: 'aaa' }] }])[0];
  const b = groupByGeneration([{ kind: 'workflows', versions: [{ versionId: 'V1', isActive: false, checksum: 'bbb' }] }])[0];
  assert.notEqual(a.hash, b.hash);
});

test('groupByGeneration folds a shared versionId across kinds (newest-first) and hashes it', () => {
  const gens = groupByGeneration(perKind());
  assert.deepEqual(gens.map((g) => g.versionId), ['Vp', 'V2', 'V1'], 'newest (lexically) first');
  const v2 = gens.find((g) => g.versionId === 'V2')!;
  assert.deepEqual(v2.kinds, ['workflow', 'prompt'], 'both kinds folded into one release');
  assert.equal(v2.active, true);
  assert.equal(v2.message, 'rel2');
  assert.match(v2.hash, /^[0-9a-f]{8,}$/, 'generation has a content hash');
  // hash is content-addressed: same members → same hash, changed member → different
  assert.equal(groupByGeneration(perKind()).find((g) => g.versionId === 'V2')!.hash, v2.hash, 'stable');
  const changed = perKind(); changed[0].versions[1].checksum = 'zzz';
  assert.notEqual(groupByGeneration(changed).find((g) => g.versionId === 'V2')!.hash, v2.hash, 'changes with content');
});

test('resolveGenerationRef: exact versionId, unique hash prefix, else throws', () => {
  const gens = groupByGeneration(perKind());
  const v2 = gens.find((g) => g.versionId === 'V2')!;
  assert.equal(resolveGenerationRef(gens, 'V2'), 'V2', 'exact versionId');
  assert.equal(resolveGenerationRef(gens, v2.hash.slice(0, 8)), 'V2', 'short hash prefix resolves');
  assert.throws(() => resolveGenerationRef(gens, 'nope'), /no generation matching/);
});

test('renderGeneration: `* <hash>: <msg>` then an indented per-entity row', () => {
  setStyle(false);
  const g = {
    versionId: 'V1', hash: 'abcdef1234567890', kinds: ['workflows', 'prompts'], active: true, message: 'update abc',
    members: [{ kind: 'workflows', checksum: '17257ffaaaaa' }, { kind: 'prompts', checksum: '0fde0b6abbbb' }],
  };
  const [head, row] = renderGeneration(g, false).split('\n');
  assert.equal(head, '* abcdef12: update abc', 'generation hash leads, then the message');
  assert.equal(row, '    prompt 0fde0b6a · workflow 17257ffa', 'each entity with its own short hash, kind-sorted');

  const full = renderGeneration(g, true);
  assert.ok(full.includes('abcdef1234567890'), 'full generation hash with --full');
  assert.ok(full.includes('17257ffaaaaa'), 'full entity hash with --full');
  assert.ok(full.includes('V1'), 'versionId shown with --full');
});

test('renderGeneration truncates a long message unless --full', () => {
  setStyle(false);
  const g = { versionId: 'V1', hash: 'abcdef12', kinds: ['workflows'], active: false, message: 'x'.repeat(80), members: [{ kind: 'workflows', checksum: 'aaaa1111' }] };
  assert.ok(renderGeneration(g, false).includes('…'), 'truncated');
  assert.ok(!renderGeneration(g, true).includes('…'), 'full = untruncated');
});

test('list groups by generation by default (no -g flag, no per-kind view)', () => {
  const list = buildProgram().commands.find((c) => c.name() === 'list')!;
  assert.ok(!list.options.some((o) => o.long === '--generations'), 'no -g flag — grouping is the default');
  assert.ok(list.options.some((o) => o.long === '--full'), '--full still available');
});

test('pull has a -y/--yes bypass for the overwrite confirmation', () => {
  const pull = buildProgram().commands.find((c) => c.name() === 'pull')!;
  const yes = pull.options.find((o) => o.long === '--yes');
  assert.ok(yes, 'pull has --yes');
  assert.equal(yes!.short, '-y');
});

test('dirHasEntities: false when empty, true once an entity file exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    assert.equal(dirHasEntities(root), false, 'empty root → pull would not overwrite anything');
    const d = join(root, 'prompts', 'p1'); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'apply.ts'), 'export default {};\n');
    assert.equal(dirHasEntities(root), true, 'has a prompt entity → pull would overwrite it');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveGenerationRef tolerates a trailing colon / whitespace from copy-pasting `list` output', () => {
  // `n8c list` prints `<hash>: <message>` — double-clicking the token grabs the colon.
  const gens = groupByGeneration([{ kind: 'workflows', versions: [{ versionId: 'V1', isActive: true, checksum: 'aaa' }] }]);
  const h = gens[0].hash.slice(0, 8);
  assert.equal(resolveGenerationRef(gens, `${h}:`), 'V1', 'trailing colon accepted');
  assert.equal(resolveGenerationRef(gens, `  ${h}  `), 'V1', 'surrounding whitespace accepted');
});

test('resolveGenerationRef rejects an ambiguous hash prefix', () => {
  const gens = [
    { versionId: 'V1', hash: 'a1b2c3d4ffff', kinds: ['workflow'], active: false },
    { versionId: 'V2', hash: 'a1b2ffffffff', kinds: ['workflow'], active: false },
  ];
  assert.equal(resolveGenerationRef(gens, 'a1b2c'), 'V1', 'unique prefix resolves');
  assert.throws(() => resolveGenerationRef(gens, 'a1b2'), /ambiguous/, '2 matches → ambiguous');
});

test('renderGeneration is raw when style is off (--pipe), styled when on', () => {
  const g = { versionId: '2026-07-19T00:00:00Z', hash: 'abcdef12', kinds: ['workflows'], active: true, message: 'hi', members: [{ kind: 'workflows', checksum: 'aaaa1111' }] };
  try {
    setStyle(false);
    assert.ok(!renderGeneration(g, false).includes('\x1b['), 'no ANSI codes when style off');
    setStyle(true);
    assert.ok(renderGeneration(g, false).includes('\x1b['), 'styled when on');
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
