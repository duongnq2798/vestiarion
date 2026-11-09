/**
 * A Jira issue's link, read for its site and its key alone (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md
 * JR6, JR8, JR20). A pasted link is never opened: the key is taken from it, the host is compared with the connected
 * site's, and the issue is read through Atlassian's API with the workspace's own connection, by key once and by its
 * numeric id after that. Pure and browser-safe.
 *
 * The forms taken, https only, with no port and no credentials, of at most 1,000 characters:
 * - `https://<host>/browse/KEY-1`, with more path or a query after it, or none;
 * - any https Jira page whose query has `selectedIssue=KEY-1` (a board, a backlog, a filter);
 * - a path ending in `/issues/KEY-1` (a project's issue list);
 * - the key alone, `ENG-123`, in any case.
 */

export interface IssueRef {
  /** In capitals, as Jira writes it. */
  key: string;
  /** The link's host, in lower case; null for a key typed alone. */
  host: string | null;
}

const KEY = /^[A-Za-z][A-Za-z0-9_]{0,49}-[0-9]{1,18}$/;
const MAX_CHARS = 1000;

function httpsUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "" || url.hostname === "") return null;
    return url;
  } catch {
    return null;
  }
}

/** The key a path or a query names, in the order a person reads the page: the issue it opens, then the one it selects. */
function keyOf(url: URL): string | null {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length >= 2 && parts[0] === "browse" && KEY.test(parts[1])) return parts[1];
  const last = parts.at(-1);
  if (parts.length >= 2 && parts.at(-2) === "issues" && last !== undefined && KEY.test(last)) return last;
  const selected = url.searchParams.get("selectedIssue");
  return selected !== null && KEY.test(selected) ? selected : null;
}

export function issueRefOf(raw: string): IssueRef | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_CHARS) return null;
  if (KEY.test(value)) return { key: value.toUpperCase(), host: null };
  const url = httpsUrl(value);
  if (!url) return null;
  const key = keyOf(url);
  return key ? { key: key.toUpperCase(), host: url.hostname.toLowerCase() } : null;
}

/** A site's host, from its address as kept (`https://northstar.atlassian.net`); null when it is not one. */
export function siteHost(siteUrl: string): string | null {
  return httpsUrl(siteUrl)?.hostname.toLowerCase() ?? null;
}

/** Whether a link is to this issue itself, on the connected site, by its key: such a link is not a deliverable. */
export function linksToIssue(href: string, key: string, siteUrl: string): boolean {
  const ref = issueRefOf(href);
  return ref !== null && ref.host !== null && ref.host === siteHost(siteUrl) && ref.key === key.toUpperCase();
}
