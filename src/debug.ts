// `--debug`: show every n8n API call (method, path, request body, response status).
//
// Secrets are REDACTED, never printed. The values under a credential's `data` — and
// any obviously secret-looking key anywhere — are replaced with `***`, while the KEY
// NAMES are kept: when n8n rejects a credential for a missing field, the key names
// are exactly what you need to see, and the values are exactly what must not leak.
import { dim } from './style.ts';

let enabled = false;
export function setDebug(on: boolean): void { enabled = on; }
export function debugEnabled(): boolean { return enabled; }

// Keys whose value is a secret wherever they appear.
const SECRET_KEYS = new Set(['password', 'apikey', 'token', 'secret', 'accesstoken', 'privatekey', 'passphrase', 'sessiontoken', 'clientsecret']);
// Keys whose entire subtree is credential payload (n8n's write-only `data`).
const SECRET_SUBTREES = new Set(['data']);
const MAX_BODY = 2000;

export function redact(value: unknown, insideSecret = false): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, insideSecret));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const key = k.toLowerCase();
      out[k] = redact(v, insideSecret || SECRET_SUBTREES.has(key) || SECRET_KEYS.has(key));
    }
    return out;
  }
  // primitive: mask it when it sits inside a secret subtree / under a secret key
  return insideSecret ? '***' : value;
}

function pretty(body: unknown): string {
  let s: string;
  try { s = JSON.stringify(redact(body), null, 2); } catch { s = String(body); }
  if (s === undefined) return '';
  return s.length > MAX_BODY ? `${s.slice(0, MAX_BODY)}\n… (${s.length - MAX_BODY} more chars)` : s;
}

export function debugRequest(method: string, url: string, body?: unknown): void {
  if (!enabled) return;
  console.error(dim(`→ ${method} ${url}`));
  if (body !== undefined) console.error(dim(pretty(body)));
}

export function debugResponse(status: number, text?: string): void {
  if (!enabled) return;
  const tail = text ? ` ${text.length > MAX_BODY ? text.slice(0, MAX_BODY) + '…' : text}` : '';
  console.error(dim(`← ${status}${tail}`));
}
