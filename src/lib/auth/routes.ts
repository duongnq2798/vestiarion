/**
 * Which paths need a session, and where a person may be sent after signing
 * in. Pure, so the proxy, the login action and the callback all agree.
 */

export const DEFAULT_AFTER_LOGIN = "/onboarding";

const BASE = "http://vestiarion.invalid";

export function requiresSession(pathname: string): boolean {
  return pathname === "/onboarding" || pathname === "/o" || pathname.startsWith("/o/");
}

/** The login URL for a signed-out request to a protected page, or null to let it through. */
export function loginRedirectFor(pathname: string, search: string, signedIn: boolean): string | null {
  if (signedIn || !requiresSession(pathname)) return null;
  return `/login?next=${encodeURIComponent(pathname + search)}`;
}

/**
 * An open redirect turns a trusted sign-in link into a phishing link, so only
 * a same-origin absolute path survives. Resolving against a fixed base catches
 * what string checks miss: browsers read `/\evil` as `//evil`.
 */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return DEFAULT_AFTER_LOGIN;
  if (/[\u0000-\u001f\u007f]/.test(next)) return DEFAULT_AFTER_LOGIN;
  try {
    const resolved = new URL(next, BASE);
    if (resolved.origin !== BASE) return DEFAULT_AFTER_LOGIN;
    return resolved.pathname + resolved.search + resolved.hash;
  } catch {
    return DEFAULT_AFTER_LOGIN;
  }
}
