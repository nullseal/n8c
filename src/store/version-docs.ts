import type { Doc } from './store.ts';

// Map a raw stored version-doc row to a Doc. The field names are identical in
// both storage layouts (per-kind collection rows AND legacy manifest-embedded
// docs), so one mapper serves both.
export function toDoc(r: any): Doc {
  return { localId: r.localId, name: r.name, body: r.body, checksum: r.checksum };
}

// Choose a version's docs while tolerating BOTH storage layouts:
//   - current: docs live in the per-kind collection tagged by versionId (perKindRows)
//   - legacy:  docs were embedded in the manifest doc under `docs`
// Per-kind rows win; the legacy embedded array is the fallback. This is the guard
// against a whole class of regression: a change to how versions are stored must
// never make an already-written version unreadable (getVersion returning [] made
// `restore`/`export`/`pull` throw "version not found"). Any future layout change
// should extend this fallback rather than silently orphan old data.
export function selectVersionDocs(perKindRows: any[], manifestDoc: any): Doc[] {
  const rows = perKindRows.length
    ? perKindRows
    : (Array.isArray(manifestDoc?.docs) ? manifestDoc.docs : []);
  return rows.map(toDoc);
}
