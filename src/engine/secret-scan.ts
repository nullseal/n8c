// Scan a workflow body for hardcoded secrets before it gets written to files
// under n8c/ (which is COMMITTED). Credentials use `env:` markers; workflow
// node jsCode/params have no such protection, so a token pasted into code would
// land in git. This is a best-effort warning scanner — never a guarantee.

// Known token shapes, matched as plain substrings (no regex) — cheap and precise.
const TOKEN_PREFIXES: { label: string; needle: string }[] = [
  { label: 'Shopify access token', needle: 'shpat_' },
  { label: 'Shopify shared secret', needle: 'shpss_' },
  { label: 'Shopify private-app password', needle: 'shppa_' },
  { label: 'Shopify custom-app token', needle: 'shpca_' },
  { label: 'OpenAI API key', needle: 'sk-' },
  { label: 'Slack bot token', needle: 'xoxb-' },
  { label: 'GitHub token', needle: 'ghp_' },
  { label: 'AWS access key id', needle: 'AKIA' },
  { label: 'Mongo connection string with password', needle: 'mongodb+srv://' },
];

// A long lowercase-hex run (≥32) — catches prefix-less tokens (e.g. Shopify
// Storefront tokens). Kept narrow (hex only) to limit false positives.
function hasLongHex(s: string): boolean {
  let run = 0;
  for (const ch of s) {
    const hex = (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f');
    if (hex) { if (++run >= 32) return true; } else run = 0;
  }
  return false;
}

// Returns a de-duplicated list of human-readable findings for one workflow body.
export function scanWorkflowSecrets(body: any): string[] {
  const findings = new Set<string>();
  for (const node of body?.nodes ?? []) {
    const text = JSON.stringify(node?.parameters ?? {});
    for (const { label, needle } of TOKEN_PREFIXES) {
      if (text.includes(needle)) findings.add(`${node?.name ?? node?.id ?? '?'}: possible ${label}`);
    }
    if (hasLongHex(text.toLowerCase())) findings.add(`${node?.name ?? node?.id ?? '?'}: possible secret (long hex string)`);
  }
  return [...findings];
}
