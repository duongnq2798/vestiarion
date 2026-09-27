/**
 * Login error codes arrive in the URL, so they are looked up, never echoed.
 */
const MESSAGES: Record<string, string> = {
  link:
    "That sign-in link could not be used. It may have expired, or it was opened in a different browser " +
    "from the one that asked for it. Request a new link here and open it in the same browser.",
  google: "Google sign-in could not start. Use an email link instead, or try again in a minute.",
  expired: "That sign-in link has expired or was already used. Request a new one below.",
};

export function loginErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : null;
}

/**
 * Why a sign-in link was not sent, in words that are true.
 *
 * Supabase's email limits are hourly and project-wide, so a page that says
 * "try again in a minute" sends a person into a loop that fails for up to an
 * hour — which is what happened on production. Neither message names a wait
 * this code cannot know, and the provider's own message is never shown: it
 * can describe infrastructure, and it is logged server-side instead.
 */
export const SIGN_IN_RATE_LIMITED =
  "Too many sign-in emails have been requested recently. Wait before asking for another — " +
  "a link already in your inbox still works until it expires.";
export const SIGN_IN_FAILED = "We could not send a sign-in link. Please try again.";

const RATE_LIMIT_CODES = new Set(["over_email_send_rate_limit", "over_request_rate_limit"]);

export function signInFailureMessage(error: { status?: number; code?: string } | null | undefined): string {
  if (!error) return SIGN_IN_FAILED;
  if (error.status === 429 || (error.code !== undefined && RATE_LIMIT_CODES.has(error.code))) {
    return SIGN_IN_RATE_LIMITED;
  }
  return SIGN_IN_FAILED;
}
