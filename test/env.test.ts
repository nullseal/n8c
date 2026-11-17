import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDotenv, resolveEnvName, listEnvs, loadEnv } from '../src/env.ts';

test('parseDotenv skips lines without "=" and strips single quotes only when matched', () => {
  const out = parseDotenv("JUSTAKEY\nS='single quoted'\nD=\"open only\nM='mismatched\"\n");
  assert.deepEqual(out, { S: 'single quoted', D: '"open only', M: '\'mismatched"' });
});

test('loadEnv reads the default file, a named env file, and returns {} for a missing one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'n8c-loadenv-'));
  try {
    writeFileSync(join(dir, '.env'), 'A=default\n');
    writeFileSync(join(dir, '.env.staging'), 'A=staging\n');
    assert.deepEqual(loadEnv(dir, 'default'), { A: 'default' });
    assert.deepEqual(loadEnv(dir, 'staging'), { A: 'staging' });
    assert.deepEqual(loadEnv(dir, 'nope'), {});
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('parseDotenv handles comments, blanks and quotes', () => {
  const out = parseDotenv('# c\n\nA=1\nB="two words"\nC=three\n');
  assert.deepEqual(out, { A: '1', B: 'two words', C: 'three' });
});

test('resolveEnvName precedence', () => {
  assert.equal(resolveEnvName(['--env=prod'], { defaultEnv: 'staging' }), 'prod');
  assert.equal(resolveEnvName([], { defaultEnv: 'staging' }), 'staging');
  assert.equal(resolveEnvName([], {}), 'default');
});

test('listEnvs maps filenames to env names', () => {
  assert.deepEqual(listEnvs(['.env', '.env.staging', '.env.production', 'other.txt']).sort(),
    ['default', 'production', 'staging']);
});
