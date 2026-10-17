/**
 * Placeholder database credentials for the whole test process.
 *
 * Every module now resolves its settings through `currentConfig()`, which
 * builds an environment-derived context on first use — and that build requires
 * a database, because Vestiarion is meaningless without one.
 *
 * No test here talks to a database. The suite covers pure policy: the hash
 * chain, risk tiering, treasury economics, duplicate detection, the follow-up
 * rules, provider selection. Anything that needs a real Supabase project is
 * exercised by `npm run cycle` against one, which is the honest place for it.
 * So the placeholder is not a mock standing in for behaviour; it is the one
 * required field of a config whose other fields are what a given test is
 * actually about.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://tests.supabase.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role";
// Entering an organization builds a tenant client (spec §5.6), which needs both
// of these to mint and present a request token — so they get placeholders too.
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
process.env.SUPABASE_JWT_SECRET ??= "test-request-token-secret-at-least-32-characters";

/**
 * No test reaches the network. A provider whose stub leaves a fee or a balance
 * unsaid reads it from the chain's RPC, and the test then waits on a real
 * request: seconds on a slow connection, enough to outlast vitest's timeout
 * while the whole suite runs. Refused here at once, the request fails as an
 * unreachable node's does. A test that serves its own answers on loopback, or
 * stubs `fetch`, is unaffected.
 */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const networkFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = URL.parse(input instanceof Request ? input.url : String(input));
  if (!url || LOOPBACK.has(url.hostname)) return networkFetch(input, init);
  throw new TypeError(`fetch failed: tests do not reach the network (${url.origin})`);
}) as typeof fetch;
