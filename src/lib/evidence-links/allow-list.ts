import net from "node:net";
import { attachmentGidOf, taskRefOf } from "../asana/urls";
import { issueRefOf } from "../linear/urls";

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
/**
 * Asana's web pages and its API share one host (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md A13): a
 * task's or an attachment's link is asked about at Asana's API, `/api/1.0/tasks/<id>` or `/api/1.0/attachments/<id>`,
 * built here from the id alone, with the workspace's own Asana connection. The page a person typed is never requested.
 */
export const ASANA_HOST = "app.asana.com";
const ASANA_API = `https://${ASANA_HOST}/api/1.0`;
const ASANA_API_PATH = /^\/api\/1\.0\/(tasks|attachments)\/[0-9]{1,32}$/;
/**
 * Linear's web pages and its API are on two hosts (docs/superpowers/specs/2026-10-31-linear-acceptance-design.md LN14):
 * an issue's link on `linear.app` is asked about at Linear's GraphQL API, `api.linear.app/graphql`, with a query built
 * here from the issue's identifier alone, and the workspace's own Linear connection. The page a person typed is never
 * requested. Linear finds an identifier in the connection's own Linear workspace, so the issue's own link is asked for
 * too: the issue answered is the link's only when it is in the Linear workspace the link names (`./check`).
 */
export const LINEAR_WEB_HOST = "linear.app";
export const LINEAR_API_HOST = "api.linear.app";
const LINEAR_GRAPHQL = `https://${LINEAR_API_HOST}/graphql`;
const LINEAR_ISSUE_QUERY = "query IssueExists($id: String!) { issue(id: $id) { id url } }";
/**
 * A Jira site's pages and Jira's API are on two hosts (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md
 * JR20): an issue's link on the site the workspace connected, `https://<site>/browse/<KEY>`, is asked about at
 * Atlassian's API, `api.atlassian.com/ex/jira/<cloudId>/rest/api/3/issue/<KEY>?fields=summary`, at an address built here
 * from the site's cloudId and the issue's key alone, with the workspace's own Jira connection. The page a person typed is
 * never requested. Only the connected site is known here (`jiraSite`): a link on any other Atlassian site, and any other
 * page on the connected one, is not checked.
 */
export const JIRA_API_HOST = "api.atlassian.com";
const JIRA_CLOUD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** An issue's own page on the site, `/browse/ENG-142`; Jira takes its key in any case. */
const JIRA_BROWSE_PATH = /^\/browse\/([A-Za-z][A-Za-z0-9_]{0,49}-[0-9]{1,18})\/?$/;
/** The one request a Jira link is checked with: one issue, by its key in capitals, on one site, for its summary only. */
const JIRA_API_PATH = /^\/ex\/jira\/([0-9a-f-]{36})\/rest\/api\/3\/issue\/[A-Z][A-Z0-9_]{0,49}-[0-9]{1,18}$/;
const JIRA_API_QUERY = "?fields=summary";

/** The Jira site the workspace connected: its host, as its address names it, and the cloudId Jira's API names it by. */
export interface JiraLinkSite {
  host: string;
  cloudId: string;
}

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
  host: "Vestiarion checks links on GitHub, Asana, Linear, the connected Jira site and its own file storage only, and never opens other sites.",
  path: "On GitHub, Vestiarion checks pull requests and their comments; on Asana, tasks and attachments; on Linear and the connected Jira site, issues; on its own storage, signed links.",
};

export type CheckTarget =
  | { kind: "github_pull"; href: string; owner: string; repo: string; number: number; request: string }
  | { kind: "github_comment"; href: string; owner: string; repo: string; commentId: number; request: string; repository: string }
  | { kind: "signed_storage"; href: string; host: string; expiresAt: number | null; request: string }
  | { kind: "asana_task"; href: string; taskGid: string; request: string }
  | { kind: "asana_attachment"; href: string; attachmentGid: string; request: string }
  /** Asked with a POST of `body`, a GraphQL query for the issue by its identifier, to `request`; `workspaceKey` is the link's. */
  | { kind: "linear_issue"; href: string; identifier: string; workspaceKey: string; request: string; body: string }
  /** Asked with a GET of `request`, Jira's API for the issue by its key on the connected site, whose cloudId it names. */
  | { kind: "jira_issue"; href: string; key: string; cloudId: string; request: string };

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

/**
 * The connected Jira site, when it is what Atlassian names a site by: a cloudId, and a public host name that is none of
 * the hosts checked otherwise. Null for anything else, so no link is checked on it.
 */
function jiraSiteOf(site: JiraLinkSite | null | undefined): JiraLinkSite | null {
  if (!site || typeof site.host !== "string" || typeof site.cloudId !== "string" || !JIRA_CLOUD_ID.test(site.cloudId)) return null;
  const host = site.host.toLowerCase();
  if (numericHost(host) || localName(host)) return null;
  if ([GITHUB_WEB_HOST, GITHUB_API_HOST, ASANA_HOST, LINEAR_WEB_HOST, LINEAR_API_HOST, JIRA_API_HOST].includes(host)) return null;
  return { host, cloudId: site.cloudId };
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
 * to any other storage is not checked. `jiraSite` is the Jira site the workspace connected; without it, no Jira link is
 * checked.
 */
export function checkTargetOf(raw: string, options: { storageHost?: string | null; jiraSite?: JiraLinkSite | null } = {}): TargetOf {
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

  if (host === ASANA_HOST) {
    const task = taskRefOf(url.href);
    if (task) return { target: { kind: "asana_task", href: url.href, taskGid: task.taskGid, request: `${ASANA_API}/tasks/${task.taskGid}?opt_fields=gid` } };
    const attachment = attachmentGidOf(url.href);
    if (attachment) return { target: { kind: "asana_attachment", href: url.href, attachmentGid: attachment, request: `${ASANA_API}/attachments/${attachment}?opt_fields=gid` } };
    return { notChecked: "path" };
  }

  if (host === LINEAR_WEB_HOST) {
    const issue = issueRefOf(url.href);
    if (!issue || issue.workspaceKey === null) return { notChecked: "path" };
    const body = JSON.stringify({ query: LINEAR_ISSUE_QUERY, variables: { id: issue.identifier } });
    return { target: { kind: "linear_issue", href: url.href, identifier: issue.identifier, workspaceKey: issue.workspaceKey, request: LINEAR_GRAPHQL, body } };
  }

  // An issue's own page on the connected Jira site only (Jira acceptance JR20): its attachments, boards and filters are
  // other pages, and another site, Atlassian's own included, is another host.
  const jiraSite = jiraSiteOf(options.jiraSite);
  if (jiraSite && host === jiraSite.host) {
    const browse = JIRA_BROWSE_PATH.exec(url.pathname);
    if (!browse) return { notChecked: "path" };
    const key = browse[1].toUpperCase();
    return { target: { kind: "jira_issue", href: url.href, key, cloudId: jiraSite.cloudId, request: `https://${JIRA_API_HOST}/ex/jira/${jiraSite.cloudId}/rest/api/3/issue/${key}${JIRA_API_QUERY}` } };
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
 * a redirect alike. Only GitHub's API, under a repository; Asana's API, for one task or one attachment; Linear's
 * GraphQL API; Jira's API, for one issue's summary on the connected site and in exactly the shape `checkTargetOf`
 * builds; or the workspace's own storage, signed.
 */
export function requestAllowed(raw: string, options: { storageHost?: string | null; jiraSite?: JiraLinkSite | null } = {}): boolean {
  const parsed = checkedUrl(raw);
  if ("notChecked" in parsed) return false;
  const host = parsed.url.hostname.toLowerCase();
  if (host === GITHUB_API_HOST) return parsed.url.pathname.startsWith("/repos/") || parsed.url.pathname.startsWith("/repositories/");
  if (host === ASANA_HOST) return ASANA_API_PATH.test(parsed.url.pathname);
  if (host === LINEAR_API_HOST) return parsed.url.pathname === "/graphql" && parsed.url.search === "";
  if (host === JIRA_API_HOST) {
    const jiraSite = jiraSiteOf(options.jiraSite);
    const issue = JIRA_API_PATH.exec(parsed.url.pathname);
    return jiraSite !== null && issue !== null && issue[1] === jiraSite.cloudId && parsed.url.search === JIRA_API_QUERY && parsed.url.hash === "";
  }
  const storageHost = options.storageHost ?? null;
  return Boolean(storageHost) && host === storageHost && SIGNED_PATH.test(parsed.url.pathname);
}
