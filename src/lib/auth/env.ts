/**
 * The public origin sign-in links are built from. Never taken from request
 * headers (Origin/Host are client-supplied and a forged Host on a POST with
 * no Origin can steer a magic link at an attacker's domain if the Supabase
 * redirect allow-list is broad) — so this is the one source of truth, and it
 * fails loudly in production rather than silently trusting the request.
 *
 * Pure and exported (no `server-only` in this file) so it stays testable
 * without a request context.
 */
export function resolveSiteOrigin(raw: string | undefined, nodeEnv: string | undefined): string {
  const trimmed = raw?.trim();
  if (trimmed) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new Error("SITE_URL must be a valid absolute URL, e.g. https://vestiarion.vercel.app");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("SITE_URL must use http or https");
    }
    return url.origin;
  }
  if (nodeEnv === "production") {
    throw new Error("SITE_URL must be set in production — sign-in links are never built from request headers");
  }
  return "http://localhost:3000";
}

/** Reads `SITE_URL`/`NODE_ENV` and resolves them with `resolveSiteOrigin`. */
export function siteOrigin(): string {
  return resolveSiteOrigin(process.env.SITE_URL, process.env.NODE_ENV);
}

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
