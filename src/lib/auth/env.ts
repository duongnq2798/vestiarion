/**
 * The two Supabase settings the browser-facing auth flow needs. Both are
 * public by design (the anon key only reaches what RLS and grants allow), and
 * both are platform settings, not a business's configuration — so they are
 * read here rather than through `VestiarionConfig`.
 */
export function supabaseAuthEnv(): { url: string; anonKey: string } {
  const env = supabaseAuthEnvOrNull();
  if (!env) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must both be set for sign-in");
  }
  return env;
}

/**
 * Same as `supabaseAuthEnv()`, but returns null instead of throwing when the
 * settings are missing. For the proxy, which must not fail a public page just
 * because sign-in is misconfigured.
 */
export function supabaseAuthEnvOrNull(): { url: string; anonKey: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return { url, anonKey };
}
