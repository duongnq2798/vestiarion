import { httpsLink } from "../asana/map";
import { ProviderError, type ProviderTokens } from "../connectors/provider";
import { IDENTIFIER, LINEAR_WEB_HOST, UUID } from "./http";
import { LINEAR_SCOPES } from "./settings";

/**
 * Linear's JSON in the shapes Vestiarion keeps (docs/superpowers/specs/2026-10-31-linear-acceptance-design.md LN2, LN6).
 * Pure: no I/O. Whatever does not read is left out, never guessed; a name is cut to 200 characters, and a link is kept
 * only when it is https. An issue's description and comments are read for their links only: their words are not kept.
 * A person's email is read only for the acceptance's check of who the payee is, and never kept (LN9).
 */

/** The Linear user a token acts as, and the Linear workspace (organization) it reads. */
export interface LinearViewer {
  userId: string;
  userName: string | null;
  organizationId: string;
  organizationName: string;
}

export interface LinearPerson {
  id: string;
  name: string | null;
}

export interface AttachmentFacts {
  id: string;
  /** The attachment's own link: Linear attachments are links (a pull request, a design file, an upload). */
  href: string | null;
  title: string;
  updatedAt: string | null;
}

export interface CommentFacts {
  id: string;
  body: string;
  createdAt: string | null;
}

/** An issue as Linear says it is now. */
export interface IssueFacts {
  id: string;
  identifier: string;
  title: string;
  /** Linear's own link to it, kept only when it is on linear.app. */
  url: string | null;
  teamId: string | null;
  teamKey: string | null;
  /** The type of its workflow state: `completed`, `canceled`, `started`, `unstarted`, `backlog` or `triage`. */
  stateType: string | null;
  stateName: string | null;
  completed: boolean;
  canceled: boolean;
  completedAt: string | null;
  /** Who moved it to a completed state, where its history says; null when Linear does not (an integration did it). */
  completedBy: LinearPerson | null;
  assignee: LinearPerson | null;
  /** Archived, or in the trash (deleted). */
  archived: boolean;
  updatedAt: string | null;
  /** The description, for its links only. */
  description: string;
  attachments: AttachmentFacts[];
  comments: CommentFacts[];
  /** Linear had more attachments than the 50 read, or more comments than the 100 read. */
  moreUnread: boolean;
}

/** Who the token acts as, and the Linear users with the payee's and the member's emails: for the payee check alone (LN9). */
export interface AcceptancePeople {
  /** Null when it was not asked. */
  viewerId: string | null;
  payee: string[];
  member: string[];
}

const record = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const text = (value: unknown, max = 200): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, max) : null);
const idOf = (value: unknown): string | null => (typeof value === "string" && UUID.test(value) ? value : null);
const timeOf = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
};
export const emailOf = (value: unknown): string | null => (typeof value === "string" && /^[^\s@]{1,64}@[^\s@]{1,255}$/.test(value) ? value.trim().toLowerCase() : null);

/** Linear's own link to an issue: https on linear.app only. */
export function linearLink(value: unknown): string | null {
  const href = httpsLink(value);
  return href && new URL(href).hostname === LINEAR_WEB_HOST && new URL(href).port === "" ? href : null;
}

/**
 * The token answer (code exchange or refresh). Linear sends a new refresh token with each refresh and keeps the old one
 * working for 30 minutes; `keepRefresh` is the one sent, kept only when an answer carries none.
 */
export function mapTokens(json: unknown, nowMs: number, keepRefresh?: string): ProviderTokens {
  const body = record(json);
  const accessToken = typeof body?.access_token === "string" ? body.access_token : "";
  const refreshToken = typeof body?.refresh_token === "string" && body.refresh_token !== "" ? body.refresh_token : (keepRefresh ?? "");
  const expiresIn = typeof body?.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 86_400;
  if (!accessToken || !refreshToken) throw new ProviderError("bad_response", "Linear token answer: no token");
  // Linear says the scopes granted as a list, or as one string; read is always among them.
  const said = Array.isArray(body?.scope) ? body.scope : typeof body?.scope === "string" ? body.scope.split(/[\s,]+/) : [];
  const scopes = said.filter((scope): scope is string => typeof scope === "string" && /^[a-z:_]{1,40}$/.test(scope));
  return { accessToken, refreshToken, expiresAt: nowMs + expiresIn * 1000, scopes: scopes.length > 0 ? scopes : [...LINEAR_SCOPES] };
}

/** `viewer { id name organization { id name } }`: the person and the workspace of a fresh grant (LN2). */
export function mapViewer(data: Record<string, unknown> | null): LinearViewer {
  const viewer = record(data?.viewer);
  const organization = record(viewer?.organization);
  const userId = idOf(viewer?.id);
  const organizationId = idOf(organization?.id);
  if (!userId || !organizationId) throw new ProviderError("bad_response", "Linear viewer: no ids");
  return { userId, userName: text(viewer?.name), organizationId, organizationName: text(organization?.name) ?? "Linear workspace" };
}

function personOf(value: unknown): LinearPerson | null {
  const person = record(value);
  const id = idOf(person?.id);
  return id ? { id, name: text(person?.name) } : null;
}

function nodesOf(value: unknown): { nodes: Record<string, unknown>[]; more: boolean } {
  const connection = record(value);
  const nodes = Array.isArray(connection?.nodes) ? connection.nodes.flatMap((node) => (record(node) ? [record(node) as Record<string, unknown>] : [])) : [];
  return { nodes, more: record(connection?.pageInfo)?.hasNextPage === true };
}

/** The one who last moved the issue to a completed state, from its history, newest first whatever order Linear sent. */
function completerOf(history: unknown): LinearPerson | null {
  const moves = nodesOf(history)
    .nodes.filter((node) => record(node.toState)?.type === "completed" && personOf(node.actor) !== null && timeOf(node.createdAt) !== null)
    .sort((a, b) => Date.parse(String(b.createdAt)) - Date.parse(String(a.createdAt)));
  return moves[0] ? personOf(moves[0].actor) : null;
}

export function attachmentOf(raw: Record<string, unknown>): AttachmentFacts | null {
  const id = idOf(raw.id);
  if (!id) return null;
  const href = httpsLink(raw.url);
  return { id, href, title: text(raw.title) ?? (href ? new URL(href).hostname : `Attachment ${id.slice(0, 8)}`), updatedAt: timeOf(raw.updatedAt) };
}

export function commentOf(raw: Record<string, unknown>): CommentFacts | null {
  const id = idOf(raw.id);
  if (!id) return null;
  return { id, body: typeof raw.body === "string" ? raw.body.slice(0, 10_000) : "", createdAt: timeOf(raw.createdAt) };
}

/** `issue(id:)`'s answer, the issue node itself. */
export function mapIssue(value: unknown): IssueFacts {
  const issue = record(value);
  const id = idOf(issue?.id);
  const identifier = typeof issue?.identifier === "string" && IDENTIFIER.test(issue.identifier) ? issue.identifier : null;
  if (!issue || !id || !identifier) throw new ProviderError("bad_response", "Linear issue: no id");
  const state = record(issue.state);
  const stateType = typeof state?.type === "string" && /^[a-z_]{1,40}$/.test(state.type) ? state.type : null;
  const completed = stateType === "completed";
  const team = record(issue.team);
  const attachments = nodesOf(issue.attachments);
  const comments = nodesOf(issue.comments);
  return {
    id,
    identifier,
    title: text(issue.title) ?? `Untitled issue (${identifier})`,
    url: linearLink(issue.url),
    teamId: idOf(team?.id),
    teamKey: typeof team?.key === "string" && /^[A-Z][A-Z0-9_]{0,9}$/.test(team.key) ? team.key : null,
    stateType,
    stateName: text(state?.name),
    completed,
    canceled: stateType === "canceled",
    completedAt: completed ? timeOf(issue.completedAt) : null,
    completedBy: completed ? completerOf(issue.history) : null,
    assignee: personOf(issue.assignee),
    archived: timeOf(issue.archivedAt) !== null || issue.trashed === true,
    updatedAt: timeOf(issue.updatedAt),
    description: typeof issue.description === "string" ? issue.description.slice(0, 20_000) : "",
    attachments: attachments.nodes.map(attachmentOf).filter((item): item is AttachmentFacts => item !== null),
    comments: comments.nodes.map(commentOf).filter((item): item is CommentFacts => item !== null),
    moreUnread: attachments.more || comments.more,
  };
}

/**
 * The payee check's answer (LN9): the viewer's id, when asked, and the ids of the Linear users whose own email is the one
 * asked, whatever else Linear answered. A part asked and not answered does not read: the check is never made on a guess.
 */
export function mapAcceptancePeople(data: Record<string, unknown> | null, asked: { viewer: boolean; payee: string | null; member: string | null }): AcceptancePeople {
  const viewerId = asked.viewer ? idOf(record(data?.viewer)?.id) : null;
  if (asked.viewer && !viewerId) throw new ProviderError("bad_response", "Linear people: no viewer");
  const usersWith = (alias: "payee" | "member", email: string | null): string[] => {
    if (email === null) return [];
    const users = record(data?.[alias]);
    if (!users || !Array.isArray(users.nodes)) throw new ProviderError("bad_response", `Linear people: no ${alias}`);
    const ids = nodesOf(users).nodes.filter((node) => emailOf(node.email) === email).map((node) => idOf(node.id));
    return [...new Set(ids.filter((id): id is string => id !== null))];
  };
  return { viewerId, payee: usersWith("payee", asked.payee), member: usersWith("member", asked.member) };
}
