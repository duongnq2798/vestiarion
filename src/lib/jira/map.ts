import { httpsLink } from "../asana/map";
import { ProviderError, type ProviderTokens } from "../connectors/provider";
import { adfLinksIn } from "./deliverables";
import { ISSUE_ID, ISSUE_KEY, PROJECT_KEY, UUID } from "./http";
import { JIRA_SCOPES } from "./settings";

/**
 * Jira's JSON in the shapes Vestiarion keeps (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR2, JR3, JR8,
 * JR9, JR12, JR19). Pure: no I/O. Whatever does not read is left out, never guessed; a name is cut to 200 characters,
 * a title to 255, and a link is kept only when it is https. An issue's description and comments are read for their
 * links only: their words are not kept. No person field is read of an issue; a person's account id and email are read
 * only for the acceptance's check of who the payee is, and never kept.
 */

/** A Jira site a grant reaches: its cloudId, which every API address names, its name, and its address. */
export interface JiraSite {
  cloudId: string;
  name: string;
  /** `https://<host>`, in lower case, with no path: where a person opens the site, never where a request goes. */
  url: string;
}

export interface AttachmentFacts {
  /** Jira's numeric id for the file. */
  id: string;
  filename: string;
  /** Where a person opens it on the site: `<site>/secure/attachment/<id>/<filename>`. */
  href: string | null;
  /** When it was added: a new version of a file is a new attachment in Jira. */
  createdAt: string | null;
}

/** A web link on the issue (Jira's remote issue link): its id, its title, and the https address it opens. */
export interface RemoteLinkFacts {
  id: string;
  title: string;
  href: string;
}

/** A comment, as far as it is kept: its id, when it was made, and the links in it. Its words are not kept. */
export interface CommentFacts {
  id: string;
  createdAt: string | null;
  links: string[];
}

/** An issue as Jira says it is now. */
export interface IssueFacts {
  id: string;
  key: string;
  title: string;
  /** `<site>/browse/<KEY>`, on the connected site; null when the site's address does not read. */
  url: string | null;
  projectId: string | null;
  projectKey: string | null;
  /** The key of its status's category: `new`, `indeterminate`, `done` or `undefined`. Never its name (JR9). */
  statusCategory: string | null;
  statusName: string | null;
  resolutionName: string | null;
  /** Done, and not resolved as canceled. */
  completed: boolean;
  /** Done, and resolved as one of `CANCELED_RESOLUTIONS`. */
  canceled: boolean;
  completedAt: string | null;
  updatedAt: string | null;
  /** A status read asks for the facts above alone; a full read for the deliverables too (JR8). */
  depth: "status" | "full";
  descriptionLinks: string[];
  attachments: AttachmentFacts[];
  remoteLinks: RemoteLinkFacts[];
  comments: CommentFacts[];
  /** Jira had more attachments or web links than the 50 read, or more comments than the newest 50 read. */
  moreUnread: boolean;
  /** How many of each were read: at most 50 each. */
  counts: { attachments: number; remoteLinks: number; comments: number };
}

/**
 * At most this many of an issue's files and web links (the first by id) and comments (the newest) are read (JR8);
 * whether there were more is kept. Migration 0149 holds each count read to 50, so these may go down (L15), never up.
 */
export const ATTACHMENTS_READ = 50;
export const REMOTE_LINKS_READ = 50;
export const COMMENTS_READ = 50;

/**
 * The resolutions that say an issue in the Done category was not done (JR9), lower case, apostrophes straight. A site
 * whose admin named one otherwise reads as done: that only makes the link ready, and a person accepts against the
 * criteria with the resolution in front of them.
 */
export const CANCELED_RESOLUTIONS: readonly string[] = [
  "won't do",
  "won't fix",
  "cancelled",
  "canceled",
  "duplicate",
  "declined",
  "rejected",
  "cannot reproduce",
  "incomplete",
  "obsolete",
  "abandoned",
  "not a bug",
  "invalid",
];

const record = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
/** A name, trimmed and cut to `max` characters (not UTF-16 units, so no letter is split in two). */
const text = (value: unknown, max = 200): string | null => {
  if (typeof value !== "string" || value.trim() === "") return null;
  const letters = Array.from(value.trim());
  return letters.length > max ? letters.slice(0, max).join("") : value.trim();
};
/** A numeric id, as Jira writes it in a string, or as a number in a web link's answer. */
const numericId = (value: unknown): string | null => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return typeof value === "string" && ISSUE_ID.test(value) ? value : null;
};
const byNumber = (a: string, b: string) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

const JIRA_TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})$/;

/** Jira's time (`2026-11-09T15:30:00.000+0700`) as an ISO time in UTC; null when it does not read. */
export function jiraDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = JIRA_TIME.exec(value.trim());
  if (!match) return null;
  const [, base, fraction, offset] = match;
  const zone = offset === "Z" ? "Z" : `${offset.slice(0, 3)}:${offset.slice(-2)}`;
  const at = Date.parse(`${base}${fraction ? `.${fraction.slice(0, 3).padEnd(3, "0")}` : ""}${zone}`);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

export const emailOf = (value: unknown): string | null => (typeof value === "string" && /^[^\s@]{1,64}@[^\s@]{1,255}$/.test(value.trim()) ? value.trim().toLowerCase() : null);

/** An Atlassian account id (`5b10ac8d82e05b22cc7d4ef5`, `557058:f58131cb-...`): compared in memory, never kept (JR19). */
const ACCOUNT_ID = /^[A-Za-z0-9:_-]{1,128}$/;
const accountOf = (value: unknown): string | null => (typeof value === "string" && ACCOUNT_ID.test(value) ? value : null);

/**
 * The token answer (code exchange or refresh). Atlassian rotates the refresh token on each refresh (JR3); `keepRefresh`
 * is the one sent, kept only when an answer carries none. The access token lasts `expires_in` seconds, an hour when the
 * answer does not say.
 */
export function mapTokens(json: unknown, nowMs: number, keepRefresh?: string): ProviderTokens {
  const body = record(json);
  const accessToken = typeof body?.access_token === "string" ? body.access_token : "";
  const refreshToken = typeof body?.refresh_token === "string" && body.refresh_token !== "" ? body.refresh_token : (keepRefresh ?? "");
  const expiresIn = typeof body?.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
  if (!accessToken || !refreshToken) throw new ProviderError("bad_response", "Jira token answer: no token");
  // Atlassian says the scopes granted as one string, separated by spaces.
  const said = typeof body?.scope === "string" ? body.scope.split(/\s+/) : Array.isArray(body?.scope) ? body.scope : [];
  const scopes = said.filter((scope): scope is string => typeof scope === "string" && /^[a-z][a-z:_-]{0,59}$/.test(scope));
  return { accessToken, refreshToken, expiresAt: nowMs + expiresIn * 1000, scopes: scopes.length > 0 ? scopes : [...JIRA_SCOPES] };
}

/** A site's address, as Atlassian gives it: https, a host and nothing else, in lower case; null otherwise. */
function siteUrlOf(value: unknown): string | null {
  const href = httpsLink(value);
  if (!href) return null;
  const url = new URL(href);
  if (url.port !== "" || (url.pathname !== "/" && url.pathname !== "") || url.search !== "" || url.hash !== "") return null;
  const origin = `https://${url.hostname.toLowerCase()}`;
  return origin.length <= 261 && /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(origin) ? origin : null;
}

/**
 * `accessible-resources` (JR2): the Jira sites a grant reaches. Atlassian's ids are not unique across its products, so a
 * site counts only when its scopes include `read:jira-work`; its id must be a UUID and its address https. Each site once,
 * by its id, the first answer kept.
 */
export function mapSites(json: unknown): JiraSite[] {
  if (!Array.isArray(json)) throw new ProviderError("bad_response", "Jira sites: not a list");
  const sites: JiraSite[] = [];
  for (const raw of json.slice(0, 200)) {
    const site = record(raw);
    const cloudId = typeof site?.id === "string" ? site.id.trim().toLowerCase() : "";
    const url = siteUrlOf(site?.url);
    const scopes = Array.isArray(site?.scopes) ? site.scopes : [];
    if (!UUID.test(cloudId) || !url || !scopes.includes("read:jira-work")) continue;
    if (sites.some((kept) => kept.cloudId === cloudId)) continue;
    sites.push({ cloudId, name: text(site?.name) ?? new URL(url).hostname, url });
  }
  return sites;
}

/** Whether a resolution says the issue was not done (JR9): its name, lower case, trimmed, apostrophes straightened. */
export function cancels(resolutionName: string | null): boolean {
  if (resolutionName === null) return false;
  return CANCELED_RESOLUTIONS.includes(resolutionName.trim().toLowerCase().replace(/[\u{2018}\u{2019}]/gu, "'"));
}

/** A list read in a fixed order, oldest id first, whatever order Jira answered in: the first 50 are the same 50 each read. */
function oldestFirst(value: unknown, read: number): { items: Array<{ id: string; raw: Record<string, unknown> }>; more: boolean } {
  const items = (Array.isArray(value) ? value : []).flatMap((raw) => {
    const item = record(raw);
    const id = numericId(item?.id);
    return item && id ? [{ id, raw: item }] : [];
  });
  items.sort((a, b) => byNumber(a.id, b.id));
  return { items: items.slice(0, read), more: items.length > read };
}

function attachmentOf(id: string, raw: Record<string, unknown>, site: string | null): AttachmentFacts {
  const filename = text(raw.filename) ?? `Attachment ${id}`;
  return { id, filename, href: site ? httpsLink(`${site}/secure/attachment/${id}/${encodeURIComponent(filename)}`) : null, createdAt: jiraDate(raw.created) };
}

function remoteLinkOf(id: string, raw: Record<string, unknown>): RemoteLinkFacts | null {
  const target = record(raw.object);
  const href = httpsLink(target?.url);
  return href ? { id, title: text(target?.title) ?? new URL(href).hostname, href } : null;
}

/** An issue's comment page, embedded in its `comment` field or read on its own: the comments, and how many there are. */
function commentPageOf(value: unknown): { comments: Record<string, unknown>[]; total: number } {
  const page = record(value);
  const comments = (Array.isArray(page?.comments) ? page.comments : []).flatMap((raw) => (record(raw) ? [record(raw) as Record<string, unknown>] : []));
  const total = typeof page?.total === "number" && Number.isSafeInteger(page.total) ? page.total : comments.length;
  return { comments, total: Math.max(total, comments.length) };
}

/** Whether the comments embedded in an issue's answer are fewer than it has: then the newest 50 are read on their own (JR8). */
export function commentsTruncated(json: unknown): boolean {
  const page = record(record(record(json)?.fields)?.comment);
  if (!page) return false;
  const { comments, total } = commentPageOf(page);
  return comments.length < total;
}

/** The newest 50 comments, newest first, each with the links in it. */
function newestComments(value: unknown): { comments: CommentFacts[]; more: boolean } {
  const { comments, total } = commentPageOf(value);
  const read = comments.flatMap((raw) => {
    const id = numericId(raw.id);
    return id ? [{ id, createdAt: jiraDate(raw.created), body: raw.body }] : [];
  });
  read.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || byNumber(b.id, a.id));
  const kept = read.slice(0, COMMENTS_READ).map((comment) => ({ id: comment.id, createdAt: comment.createdAt, links: adfLinksIn(comment.body) }));
  return { comments: kept, more: total > COMMENTS_READ };
}

/**
 * An issue's answer (`GET /rest/api/3/issue/{id}`), with its web links (`remote`, null for a status read) and, when the
 * embedded comments were cut short, its newest comments read on their own (`commentPage`). `siteUrl` is the connected
 * site's address, which its browse link and its files' links are on.
 */
export function mapIssue(json: unknown, remote: unknown, siteUrl: string, commentPage: unknown = null): IssueFacts {
  const issue = record(json);
  const fields = record(issue?.fields);
  const id = typeof issue?.id === "string" && ISSUE_ID.test(issue.id) ? issue.id : null;
  const key = typeof issue?.key === "string" && ISSUE_KEY.test(issue.key) ? issue.key : null;
  if (!issue || !fields || !id || !key) throw new ProviderError("bad_response", "Jira issue: no id");
  const site = siteUrlOf(siteUrl);
  const status = record(fields.status);
  const category = record(status?.statusCategory);
  const statusCategory = typeof category?.key === "string" && /^[a-z_-]{1,40}$/.test(category.key) ? category.key : null;
  const resolutionName = text(record(fields.resolution)?.name);
  // Done is the category's key, never the status's name (JR9); a resolution may say it was not done after all.
  const done = statusCategory === "done";
  const canceled = done && cancels(resolutionName);
  const completed = done && !canceled;
  const project = record(fields.project);
  const browse = site ? `${site}/browse/${key}` : null;
  const facts: IssueFacts = {
    id,
    key,
    title: text(fields.summary, 255) ?? `Untitled issue (${key})`,
    url: browse && browse.length <= 500 ? browse : null,
    projectId: numericId(project?.id),
    projectKey: typeof project?.key === "string" && PROJECT_KEY.test(project.key) ? project.key : null,
    statusCategory,
    statusName: text(status?.name),
    resolutionName,
    completed,
    canceled,
    // The category's change moves each time the issue leaves Done and comes back, even where the resolution stays set.
    completedAt: completed ? (jiraDate(fields.statuscategorychangedate) ?? jiraDate(fields.resolutiondate)) : null,
    updatedAt: jiraDate(fields.updated),
    depth: remote === null ? "status" : "full",
    descriptionLinks: [],
    attachments: [],
    remoteLinks: [],
    comments: [],
    moreUnread: false,
    counts: { attachments: 0, remoteLinks: 0, comments: 0 },
  };
  if (remote === null) return facts;
  if (!Array.isArray(remote)) throw new ProviderError("bad_response", "Jira remote links: not a list");
  const attachments = oldestFirst(fields.attachment, ATTACHMENTS_READ);
  const remoteLinks = oldestFirst(remote, REMOTE_LINKS_READ);
  const comments = newestComments(commentPage ?? fields.comment);
  return {
    ...facts,
    descriptionLinks: adfLinksIn(fields.description),
    attachments: attachments.items.map((item) => attachmentOf(item.id, item.raw, site)),
    remoteLinks: remoteLinks.items.map((item) => remoteLinkOf(item.id, item.raw)).filter((item): item is RemoteLinkFacts => item !== null),
    comments: comments.comments,
    moreUnread: attachments.more || remoteLinks.more || comments.more,
    counts: { attachments: attachments.items.length, remoteLinks: remoteLinks.items.length, comments: comments.comments.length },
  };
}

/**
 * The change check's answer (`/search/jql`, `fields=updated`): each issue asked for and when it last changed. An issue
 * Jira did not answer for, or whose time does not read, is left out: the caller reads it again.
 */
export function mapUpdated(json: unknown, asked: ReadonlySet<string>): Map<string, string> {
  const issues = record(json)?.issues;
  if (!Array.isArray(issues)) throw new ProviderError("bad_response", "Jira search: no issues");
  const updated = new Map<string, string>();
  for (const raw of issues) {
    const issue = record(raw);
    const id = typeof issue?.id === "string" && asked.has(issue.id) ? issue.id : null;
    const at = jiraDate(record(issue?.fields)?.updated);
    if (id && at) updated.set(id, at);
  }
  return updated;
}

/**
 * A user search's answer (JR12): the accounts that may be the one with this email. One counts when its email is this
 * one, in any case, or is hidden by the person's profile settings: a hidden email errs toward refusing an acceptance,
 * the safe direction. One with another email is not it.
 */
export function mapPeople(json: unknown, email: string): string[] {
  if (!Array.isArray(json)) throw new ProviderError("bad_response", "Jira user search: not a list");
  const ids = json.flatMap((raw) => {
    const user = record(raw);
    const id = accountOf(user?.accountId);
    if (!id) return [];
    const shown = typeof user?.emailAddress === "string" && user.emailAddress.trim() !== "" ? emailOf(user.emailAddress) : null;
    const hidden = typeof user?.emailAddress !== "string" || user.emailAddress.trim() === "";
    return hidden || shown === email ? [id] : [];
  });
  return [...new Set(ids)];
}

/** `/myself`: the account the connection's token acts as. */
export function mapMyself(json: unknown): string {
  const id = accountOf(record(json)?.accountId);
  if (!id) throw new ProviderError("bad_response", "Jira myself: no account");
  return id;
}
