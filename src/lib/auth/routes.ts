/**
 * Which paths need a session, and where a person may be sent after signing
 * in. Pure, so the proxy, the login action and the callback all agree.
 */

export const DEFAULT_AFTER_LOGIN = "/onboarding";

const BASE = "http://vestiarion.invalid";

export function requiresSession(pathname: string): boolean {
  return (
    pathname === "/onboarding" || pathname === "/o" || pathname.startsWith("/o/") || pathname.startsWith("/invite/")
  );
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
 *
 * The string guard only catches an input that already starts with "//" —
 * WHATWG URL normalization of dot segments (and percent-encoded dots) can
 * still produce a resolved pathname that starts with "//" from an input that
 * did not, e.g. "/.//evil.example" or "/o/../..//evil.example" both resolve
 * to a same-origin URL whose pathname is "//evil.example". A browser sent
 * `Location: //evil.example` treats it as protocol-relative and leaves the
 * site, so the check below applies to the *resolved* path, not just the raw
 * input.
 */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return DEFAULT_AFTER_LOGIN;
  if (/[\u0000-\u001f\u007f]/.test(next)) return DEFAULT_AFTER_LOGIN;
  try {
    const resolved = new URL(next, BASE);
    if (resolved.origin !== BASE) return DEFAULT_AFTER_LOGIN;
    if (resolved.pathname.startsWith("//") || resolved.pathname.startsWith("/\\")) return DEFAULT_AFTER_LOGIN;
    return resolved.pathname + resolved.search + resolved.hash;
  } catch {
    return DEFAULT_AFTER_LOGIN;
  }
}
