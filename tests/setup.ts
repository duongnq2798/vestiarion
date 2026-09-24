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
