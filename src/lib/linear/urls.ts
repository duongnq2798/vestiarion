/**
 * A Linear issue's link, read for its identifier alone (docs/superpowers/specs/2026-10-31-linear-acceptance-design.md
 * LN4, LN14). A pasted link is never opened: the issue's identifier is taken from it, and the issue is read through
 * Linear's API with the workspace's own connection. Only `https://linear.app` links read; any other address is not a
 * Linear issue. Pure and browser-safe.
 *
 * The forms taken:
 * - `https://linear.app/<workspace>/issue/<identifier>` with an optional title slug, or anything, after it;
 * - the identifier alone, `ENG-123`, in any case.
 */

export interface IssueRef {
  /** In capitals, as Linear writes it. */
  identifier: string;
  /** The Linear workspace's URL key in the link; null for an identifier typed alone. */
  workspaceKey: string | null;
}

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,9}-[0-9]{1,9}$/;
const WORKSPACE_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function linearUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "linear.app" || url.port !== "" || url.username !== "" || url.password !== "") return null;
    return url;
  } catch {
    return null;
  }
}

export function issueRefOf(raw: string): IssueRef | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > 1000) return null;
  if (IDENTIFIER.test(value)) return { identifier: value.toUpperCase(), workspaceKey: null };
  const url = linearUrl(value);
  if (!url) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length >= 3 && WORKSPACE_KEY.test(parts[0]) && parts[1] === "issue" && IDENTIFIER.test(parts[2])) {
    return { identifier: parts[2].toUpperCase(), workspaceKey: parts[0] };
  }
  return null;
}

/** Whether a link is to this issue itself, by its identifier: such a link is not a deliverable. */
export function linksToIssue(href: string, identifier: string): boolean {
  const ref = issueRefOf(href);
  return ref !== null && ref.workspaceKey !== null && ref.identifier === identifier.toUpperCase();
}
