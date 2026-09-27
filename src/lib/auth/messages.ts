/**
 * Login error codes arrive in the URL, so they are looked up, never echoed.
 */
const MESSAGES: Record<string, string> = {
  link:
    "That sign-in link could not be used. It may have expired, or it was opened in a different browser " +
    "from the one that asked for it. Request a new link here and open it in the same browser.",
  google: "Google sign-in could not start. Use an email link instead, or try again in a minute.",
};

export function loginErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : null;
}
