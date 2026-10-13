import net from "node:net";

/**
 * Which evidence links Vestiarion may check, and how (docs/superpowers/specs/2026-10-13-role-onboarding-evidence-access-
 * design.md E2): only links to services it already works with, and never by opening the link a person typed. A pull
 * request or a comment on github.com is asked about through GitHub's API, at an address built here from the parts of the
 * link that were checked; a signed link to the workspace's own Supabase storage is read at that same storage. Anything
 * else is shown "Not checked", and no request is ever made for it: a server that fetched whatever address a member or a
 * payee typed could be pointed at its own network (SSRF).
 *
 * Pure: no DNS, no request. `./check` resolves the host and refuses any address that is not public before it asks.
 */

export const GITHUB_WEB_HOST = "github.com";
export const GITHUB_API_HOST = "api.github.com";
const GITHUB_API = `https://${GITHUB_API_HOST}`;

/** A signed storage link carries a long token; nothing longer is read. */
const URL_MAX = 4000;

/** Why a link is not checked: it is never requested, whatever it is. */
export type NotCheckedReason = "invalid" | "scheme" | "credentials" | "port" | "address" | "host" | "path";

export const NOT_CHECKED_WORDS: Readonly<Record<NotCheckedReason, string>> = {
  invalid: "It is not a web address Vestiarion can read.",
  scheme: "Vestiarion checks https links only.",
  credentials: "A link that carries a user name or a password is never opened.",
  port: "A link to a port other than the web's own is never opened.",
  address: "A link to a private, local or numeric address is never opened.",
  host: "Vestiarion checks links on GitHub and on its own file storage only, and never opens other sites.",
  path: "On GitHub, Vestiarion checks pull requests and their comments; on its own storage, signed links.",
};

export type CheckTarget =
  | { kind: "github_pull"; href: string; owner: string; repo: string; number: number; request: string }
  | { kind: "github_comment"; href: string; owner: string; repo: string; commentId: number; request: string; repository: string }
  | { kind: "signed_storage"; href: string; host: string; expiresAt: number | null; request: string };

export type TargetOf = { target: CheckTarget } | { notChecked: NotCheckedReason };

/** A GitHub account or organization name, and a repository name, as GitHub allows them. */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}$/;
const PULL_PATH = /^\/([^/]+)\/([^/]+)\/(pull|issues)\/(\d{1,9})(?:\/(?:files|commits|checks))?\/?$/;
const COMMENT_HASH = /^#issuecomment-(\d{1,15})$/;
const SIGNED_PATH = /^\/storage\/v1\/object\/sign\/([^/]+)\/(.+)$/;

/** Names that point inside a network: never asked about, whatever a DNS answer would say. */
function localName(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan") ||
    host.endsWith(".home.arpa") ||
    !host.includes(".")
  );
}

/** An IPv4 or IPv6 literal, in any form the URL parser left it (it turns 0x7f.1 and 2130706433 into 127.0.0.1). */
function numericHost(host: string): boolean {
  return net.isIP(host) !== 0 || host.startsWith("[") || /^[0-9.]+$/.test(host);
}

/** The host of the workspace's own Supabase, from its configured address; null unless that is an https public name. */
export function storageHostOf(supabaseUrl: string | null | undefined): string | null {
  if (!supabaseUrl) return null;
  try {
    const url = new URL(supabaseUrl);
    if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") return null;
    const host = url.hostname.toLowerCase();
    return numericHost(host) || localName(host) ? null : host;
  } catch {
    return null;
  }
}

/** When a signed storage token stops opening, from its own `exp`; null when the token does not say. Never trusted for more. */
export function signedTokenExpiry(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** The URL's own rules, shared by a link and a redirect: https, no credentials, the default port, a public name. */
function checkedUrl(raw: string): { url: URL } | { notChecked: NotCheckedReason } {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > URL_MAX) return { notChecked: "invalid" };
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { notChecked: "invalid" };
  }
  if (url.protocol !== "https:") return { notChecked: "scheme" };
  if (url.username !== "" || url.password !== "") return { notChecked: "credentials" };
  // The parser drops the default port, so any port left is not 443.
  if (url.port !== "") return { notChecked: "port" };
  const host = url.hostname.toLowerCase();
  if (numericHost(host) || localName(host)) return { notChecked: "address" };
  return { url };
}

/**
 * How a link may be checked, or why it is not. `storageHost` is the workspace's own Supabase (`storageHostOf`); a link
 * to any other storage is not checked.
 */
export function checkTargetOf(raw: string, options: { storageHost?: string | null } = {}): TargetOf {
  const parsed = checkedUrl(raw);
  if ("notChecked" in parsed) return parsed;
  const { url } = parsed;
  const host = url.hostname.toLowerCase();

  if (host === GITHUB_WEB_HOST) {
    const match = PULL_PATH.exec(url.pathname);
    if (!match) return { notChecked: "path" };
    const [, owner, repo, kind, numberText] = match;
    if (!OWNER.test(owner) || !REPO.test(repo) || repo === "." || repo === "..") return { notChecked: "path" };
    const number = Number(numberText);
    if (!Number.isSafeInteger(number) || number < 1) return { notChecked: "path" };
    const repository = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const comment = COMMENT_HASH.exec(url.hash);
    if (comment) {
      const commentId = Number(comment[1]);
      if (!Number.isSafeInteger(commentId) || commentId < 1) return { notChecked: "path" };
      return { target: { kind: "github_comment", href: url.href, owner, repo, commentId, request: `${repository}/issues/comments/${commentId}`, repository } };
    }
    if (kind !== "pull") return { notChecked: "path" };
    return { target: { kind: "github_pull", href: url.href, owner, repo, number, request: `${repository}/pulls/${number}` } };
  }

  const storageHost = options.storageHost ?? null;
  if (storageHost && host === storageHost) {
    const token = url.searchParams.get("token");
    if (!SIGNED_PATH.test(url.pathname) || !token) return { notChecked: "path" };
    return { target: { kind: "signed_storage", href: url.href, host, expiresAt: signedTokenExpiry(token), request: url.href } };
  }

  return { notChecked: "host" };
}

/**
 * Whether the server may send a request to this address at all: the last check before any request, for a target and for
 * a redirect alike. Only GitHub's API, under a repository, or the workspace's own storage, signed.
 */
export function requestAllowed(raw: string, options: { storageHost?: string | null } = {}): boolean {
  const parsed = checkedUrl(raw);
  if ("notChecked" in parsed) return false;
  const host = parsed.url.hostname.toLowerCase();
  if (host === GITHUB_API_HOST) return parsed.url.pathname.startsWith("/repos/") || parsed.url.pathname.startsWith("/repositories/");
  const storageHost = options.storageHost ?? null;
  return Boolean(storageHost) && host === storageHost && SIGNED_PATH.test(parsed.url.pathname);
}
