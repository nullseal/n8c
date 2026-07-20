import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonSchemaToTs, renderTypesFile, fetchCredentialTypes, renderTsconfig } from '../src/engine/types-gen.ts';

test('renderTypesFile: ambient process shim only when asked (it clashes with @types/node)', () => {
  // With @types/node present, `declare global { var process }` fails with TS2403
  // ("Subsequent variable declarations must have the same type"), so the shim is
  // emitted only when the project has no Node types.
  const withShim = renderTypesFile([], { declareProcess: true });
  assert.match(withShim, /declare global/);
  assert.match(withShim, /var process: \{ env: Record<string, string> \};/, 'values are string, not string | undefined');

  const withoutShim = renderTypesFile([], { declareProcess: false });
  assert.ok(!withoutShim.includes('declare global'), 'no shim when @types/node is available');
  assert.ok(!renderTypesFile([]).includes('declare global'), 'off by default');
});

test('renderTsconfig: allows .ts import specifiers and points at the n8c root', () => {
  const cfg = JSON.parse(renderTsconfig('n8c'));
  assert.equal(cfg.compilerOptions.allowImportingTsExtensions, true);
  assert.equal(cfg.compilerOptions.noEmit, true, 'required by allowImportingTsExtensions');
  assert.deepEqual(cfg.include, ['n8c/**/*.ts']);
});

test('jsonSchemaToTs: flat object with required/optional fields', () => {
  const ts = jsonSchemaToTs({
    type: 'object',
    properties: { name: { type: 'string' }, value: { type: 'string' }, url: { type: 'string' } },
    required: ['name', 'value'],
  });
  assert.match(ts, /name: string;/);
  assert.match(ts, /value: string;/);
  assert.match(ts, /url\?: string;/, 'non-required field is optional');
});

test('jsonSchemaToTs: oneOf becomes a union (e.g. mongoDb connectionString | host+port)', () => {
  const ts = jsonSchemaToTs({
    oneOf: [
      { type: 'object', properties: { connectionString: { type: 'string' } }, required: ['connectionString'] },
      { type: 'object', properties: { host: { type: 'string' }, port: { type: 'number' } }, required: ['host', 'port'] },
    ],
  });
  assert.ok(ts.includes('|'), 'union');
  assert.match(ts, /connectionString: string;/);
  assert.match(ts, /port: number;/);
});

test('jsonSchemaToTs: primitives, enums, arrays, and unknown shapes degrade safely', () => {
  assert.equal(jsonSchemaToTs({ type: 'string' }), 'string');
  assert.equal(jsonSchemaToTs({ type: 'integer' }), 'number');
  assert.equal(jsonSchemaToTs({ type: 'boolean' }), 'boolean');
  assert.equal(jsonSchemaToTs({ enum: ['a', 'b'] }), '"a" | "b"');
  assert.equal(jsonSchemaToTs({ type: 'array', items: { type: 'string' } }), 'string[]');
  assert.equal(jsonSchemaToTs({ type: 'object' }), 'Record<string, unknown>', 'no properties → open record');
  assert.equal(jsonSchemaToTs(null), 'unknown');
});

test('jsonSchemaToTs: quotes keys that are not bare identifiers', () => {
  const ts = jsonSchemaToTs({ type: 'object', properties: { 'api-key': { type: 'string' } }, required: ['api-key'] });
  assert.match(ts, /"api-key": string;/);
});

test('fetchCredentialTypes: an unreadable schema degrades to an open record (never throws)', async () => {
  const ctx = { n8n: { getCredentialSchema: async (t: string) => { if (t === 'bad') throw new Error('404'); return { type: 'object', properties: { apiKey: { type: 'string' } }, required: ['apiKey'] }; } } } as any;
  const out = await fetchCredentialTypes(ctx, ['openAiApi', 'bad']);
  assert.deepEqual(out.map((o) => o.type), ['bad', 'openAiApi'], 'sorted, deduped');
  assert.equal(out.find((o) => o.type === 'bad')!.ts, 'Record<string, unknown>');
  assert.match(out.find((o) => o.type === 'openAiApi')!.ts, /apiKey: string;/);
});

test('renderTypesFile: emits CredentialData + entity shapes, and only erasable syntax', () => {
  const file = renderTypesFile([{ type: 'httpHeaderAuth', ts: '{\n    name: string;\n  }' }]);
  assert.match(file, /export interface CredentialData/);
  assert.match(file, /httpHeaderAuth:/);
  assert.match(file, /export type CredentialType = keyof CredentialData;/);
  assert.match(file, /export interface Credential<T extends CredentialType/);
  for (const t of ['Prompt', 'PromptContent', 'Workflow', 'WorkflowNode']) {
    assert.ok(file.includes(`export interface ${t}`), `${t} shape emitted`);
  }
  // types-only: no runtime declarations that would survive type stripping
  assert.ok(!file.includes('export const'), 'no runtime values');
  assert.ok(!file.includes('export function'), 'no runtime functions');
});

test('renderTypesFile: no credential types → open index signature (still compiles)', () => {
  const file = renderTypesFile([]);
  assert.match(file, /\[type: string\]: Record<string, unknown>;/);
});
