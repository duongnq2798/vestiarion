/** One whole path segment that is a UUID, the id of a workspace's record. */
const UUID_SEGMENT = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi;

/**
 * The path Google Analytics may see: invite, payee-link, pay-link, receipt, shared-report, statement, supplier status, early-payment offer, customer discount, term request, address-change check, document request and accountant client link tokens
 * and organization slugs are replaced, and callers pass a pathname only, so no query string or hash.
 * Under a workspace, every path segment that is a UUID becomes `:id` (docs/superpowers/specs/2026-11-09-counterparty-page-design.md
 * CL17): a counterparty's page, a project, a deal and an evidence page then name no record. A segment that is not a
 * UUID, such as an evidence page's kind, is kept.
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
  if (/^\/documents\/[^/]+/.test(pathname)) return "/documents/:token";
  if (!/^\/o\/[^/]+/.test(pathname)) return pathname;
  return pathname.replace(/^\/o\/[^/]+/, "/o/:org").replace(UUID_SEGMENT, "/:id");
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
