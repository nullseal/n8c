import { N8nClientV2 } from './v2.ts';
import { N8nClientV3 } from './v3.ts';

export type N8nVersion = '2' | '3';
export type N8nClient = N8nClientV2; // engine-facing type

// Config value -> supported version. Absent -> '3'. The number form (3) is accepted
// as well as the string ("3"), since both are natural to write in JSON.
export function resolveN8nVersion(v: unknown): N8nVersion {
  if (v === undefined || v === null) return '3';
  const s = String(v);
  if (s === '2' || s === '3') return s;
  throw new Error(`unsupported n8nVersion "${s}" — n8c supports n8n 2 and 3`);
}

export function createN8nClient(version: N8nVersion, baseUrl: string, apiKey: string, fetchImpl?: typeof fetch, projectId?: string): N8nClient {
  return version === '2' ? new N8nClientV2(baseUrl, apiKey, fetchImpl, projectId) : new N8nClientV3(baseUrl, apiKey, fetchImpl, projectId);
}
