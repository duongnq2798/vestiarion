/**
 * The ledger's canonical JSON: keys sorted at every level, `undefined` left out, nothing else changed. An entry's
 * `bodyHash` is SHA-256 of this over `{ actor, domain, action, summary, detail }`. tests/sdk-webhooks.test.ts holds it
 * to the server's own (src/lib/canonical-json.ts).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
}
