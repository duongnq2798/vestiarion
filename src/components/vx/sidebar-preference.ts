/**
 * Whether the workspace sidebar is collapsed to its icon rail (workspace shell design S3), kept in a first-party
 * cookie so the server draws the right width on the first paint. A plain module: the workspace layout reads it on the
 * server, and the frame writes it in the browser when someone toggles.
 */

export const SIDEBAR_COOKIE = "vx_sidebar";

/** A year: a preference, not a session. */
export const SIDEBAR_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/** The cookie's value, read on the server: only the exact word "collapsed" collapses; anything else is expanded. */
export function sidebarCollapsedFrom(value: string | undefined | null): boolean {
  return value === "collapsed";
}

/** The same, from a whole `document.cookie` string. */
export function sidebarCollapsedInCookies(cookies: string): boolean {
  for (const part of cookies.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SIDEBAR_COOKIE) return sidebarCollapsedFrom(rest.join("="));
  }
  return false;
}

/** The whole `Set-Cookie`-style string the browser writes with `document.cookie`. */
export function sidebarCookie(collapsed: boolean, secure: boolean): string {
  return [`${SIDEBAR_COOKIE}=${collapsed ? "collapsed" : "expanded"}`, `Max-Age=${SIDEBAR_MAX_AGE_SECONDS}`, "Path=/", "SameSite=Lax", ...(secure ? ["Secure"] : [])].join("; ");
}

/**
 * Whether a key press should toggle the sidebar: a bare `[`, outside anything a person types into, and not already
 * taken by another control.
 */
export function isSidebarShortcut(event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; defaultPrevented: boolean; isComposing?: boolean }, target: { tagName?: string; isContentEditable?: boolean } | null): boolean {
  if (event.key !== "[" || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented || event.isComposing) return false;
  if (!target) return true;
  if (target.isContentEditable) return false;
  return !["INPUT", "TEXTAREA", "SELECT"].includes((target.tagName ?? "").toUpperCase());
}
