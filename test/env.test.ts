import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDotenv, resolveEnvName, listEnvs } from '../src/env.ts';

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
