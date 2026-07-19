// Shape a doc for the LIVE collection. Most kinds store `{ ...doc, mode:'live' }`
// (body stays nested). But some kinds have their live docs read DIRECTLY by an
// n8n node at runtime (not pushed to n8n) — that node reads fields as
// `x.json.<field>` at the TOP level. For those we spread the body up to the top
// level so the node can read them, while keeping the nested `body` so n8c's own
// getLive / diff / dedup (which read `r.body` and `r.checksum`) are unaffected.
//
// Today only `promptContents` qualifies: the MyKingdom `load_prompts` node reads
// n8c_prompt_contents and accesses `x.json.key` / `x.json.content` / `x.json.blocks`.
// (`prompts` = build-time prompts wired into nodes; `promptContents` = runtime.)
const FLATTEN_KINDS = new Set(['promptContents']);

export function liveStorageDoc(
  kind: string,
  d: { localId: string; name: string; body: unknown; checksum: string },
): Record<string, unknown> {
  const base = { ...d, mode: 'live' as const };
  if (!FLATTEN_KINDS.has(kind) || !d.body || typeof d.body !== 'object') return base;
  // body first (top-level key/content/blocks), base second so n8c's own
  // localId/name/body/checksum/mode always win over a same-named body field.
  return { ...(d.body as Record<string, unknown>), ...base };
}
