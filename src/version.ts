// Monotonic version id generator. versionId is an ISO-8601 timestamp string
// (spec); to keep ids unique and strictly ordered even when two versions are
// minted within the same millisecond, we never return a timestamp <= the last
// one handed out in this process — we bump by 1ms instead.
let lastMs = 0;

export function nextVersionId(): string {
  let ms = Date.now();
  if (ms <= lastMs) ms = lastMs + 1;
  lastMs = ms;
  return new Date(ms).toISOString();
}
