/**
 * The path Google Analytics may see: invite, payee-link, pay-link, receipt, shared-report, statement, supplier status, early-payment offer, customer discount, term request, address-change check and accountant client link tokens
 * and organization slugs are replaced, and callers pass a pathname only, so no query string or hash.
 */
export function redactPath(pathname: string): string {
  if (/^\/invite\/[^/]+/.test(pathname)) return "/invite/:token";
  if (/^\/payee\/[^/]+/.test(pathname)) return "/payee/:token";
  if (/^\/receipt\/[^/]+/.test(pathname)) return "/receipt/:token";
  if (/^\/report\/[^/]+/.test(pathname)) return "/report/:token";
  if (/^\/pay\/[^/]+/.test(pathname)) return "/pay/:token";
  if (/^\/statement\/[^/]+/.test(pathname)) return "/statement/:token";
  if (/^\/supplier\/[^/]+/.test(pathname)) return "/supplier/:token";
  if (/^\/offer\/[^/]+/.test(pathname)) return "/offer/:token";
  if (/^\/discount\/[^/]+/.test(pathname)) return "/discount/:token";
  if (/^\/more-time\/[^/]+/.test(pathname)) return "/more-time/:token";
  if (/^\/address-change\/[^/]+/.test(pathname)) return "/address-change/:token";
  if (/^\/join\/[^/]+/.test(pathname)) return "/join/:token";
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
