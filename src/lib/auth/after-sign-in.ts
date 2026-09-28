import { safeNext } from "./routes";

/**
 * Remembers where a signed-out visit to a protected page was headed, across
 * an email sign-in: the Supabase templates (supabase/templates/*.html) link
 * to `{{ .SiteURL }}/auth/confirm?token_hash=…&type=email` with no `next`, so
 * without this the person lands on the default after every email sign-in
 * instead of back on the page — often an invitation — they started from.
 *
 * Single-use: the routes that read it (`/auth/confirm`, `/auth/callback`)
 * delete it from the response, on success and on failure, so a stale
 * destination never leaks into an unrelated later sign-in.
 */
export const AFTER_SIGN_IN_COOKIE = "vx_after_sign_in";

/**
 * An explicit `next` — the search param on `/auth/confirm` and
 * `/auth/callback`, or the form field the login actions received — always
 * wins over the cookie; the cookie is only a fallback for when the email
 * template dropped it. Both pass through `safeNext` here, exactly as they did
 * when the cookie was written, so a cookie value is never trusted further
 * than any other redirect target: an open redirect stays impossible whether
 * it slipped in through the query string or through the cookie.
 */
export function afterSignInTarget(
  explicitNext: string | null | undefined,
  cookieValue: string | null | undefined
): string {
  if (explicitNext) return safeNext(explicitNext);
  return safeNext(cookieValue ?? null);
}
