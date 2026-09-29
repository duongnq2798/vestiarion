/**
 * The path Google Analytics may see: invite tokens and organization slugs are
 * replaced, and callers pass a pathname only, so no query string or hash.
 */
export function redactPath(pathname: string): string {
  if (/^\/invite\/[^/]+/.test(pathname)) return "/invite/:token";
  return pathname.replace(/^\/o\/[^/]+/, "/o/:org");
}

/**
 * The referrer Google Analytics may see. A same-origin referrer is a full URL
 * of this app, so it gets the same redaction as the page; any other referrer
 * is cut to its origin.
 */
export function redactReferrer(referrer: string, origin: string): string {
  if (!referrer) return "";
  let url: URL;
  try {
    url = new URL(referrer);
  } catch {
    return "";
  }
  if (url.origin === origin) return `${origin}${redactPath(url.pathname)}`;
  return `${url.origin}/`;
}

/**
 * The title Google Analytics may see. Workspace titles name the organization
 * ("Audit log · Acme · Vestiarion"), so a page whose path was redacted is
 * titled by its redacted path instead.
 */
export function redactTitle(pathname: string, title: string): string {
  const redacted = redactPath(pathname);
  return redacted === pathname ? title : redacted;
}
