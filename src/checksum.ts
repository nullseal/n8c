import { createHash } from 'node:crypto';

const DEFAULT_VOLATILE = ['updatedAt', 'createdAt', 'versionId', 'id'];

function strip(value: unknown, volatile: string[]): unknown {
  if (Array.isArray(value)) return value.map((v) => strip(v, volatile));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (!volatile.includes(k)) out[k] = strip(v, volatile);
    }
    return out;
  }
  return value;
}

export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return '{' + keys
      .map((k) => JSON.stringify(k) + ':' + canonicalize((value as Record<string, unknown>)[k]))
      .join(',') + '}';
  }
  return JSON.stringify(value ?? null);
}

export function checksum(value: unknown, volatileKeys: string[] = DEFAULT_VOLATILE): string {
  return createHash('sha256').update(canonicalize(strip(value, volatileKeys))).digest('hex');
}
