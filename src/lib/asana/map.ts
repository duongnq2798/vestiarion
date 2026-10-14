import { ProviderError, type ProviderTokens } from "../connectors/provider";
import { GID } from "./http";
import { ASANA_SCOPES } from "./settings";

/**
 * Asana's JSON in the shapes Vestiarion keeps (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md A1, A6).
 * Pure: no I/O. Whatever does not read is left out, never guessed; a name is cut to 200 characters, and a link is kept
 * only when it is https. A task's description and comments are read for their links only: their words are not kept.
 */

export interface AsanaUser {
  gid: string;
  name: string;
}

/** A workspace, a project or a task, as a picker offers it. */
export interface AsanaChoice {
  gid: string;
  name: string;
  /** A task's: whether Asana says it is completed. */
  completed?: boolean;
}

export interface AsanaPerson {
  gid: string;
  name: string | null;
}

/** A task as Asana says it is now. */
export interface TaskFacts {
  gid: string;
  name: string;
  /** Asana's own link to it, kept only when it is on app.asana.com. */
  url: string | null;
  workspaceGid: string | null;
  projectGids: string[];
  completed: boolean;
  completedAt: string | null;
  completedBy: AsanaPerson | null;
  assignee: AsanaPerson | null;
  modifiedAt: string | null;
  /** The description, for its links only. */
  notes: string;
}

export interface AttachmentFacts {
  gid: string;
  name: string;
  /** `asana` for a file uploaded to Asana; `dropbox`, `gdrive`, `box`, `onedrive`, `vimeo` or `external` otherwise. */
  host: string;
  createdAt: string | null;
  /** Where a person opens it: Asana's permanent link for a file in Asana, the service's own page otherwise. */
  href: string | null;
}

export interface CommentFacts {
  gid: string;
  text: string;
  createdAt: string | null;
}

/** One page of a list, and the offset of the next, if any. */
export interface AsanaPage<T> {
  items: T[];
  next: string | null;
}

const record = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const text = (value: unknown, max = 200): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, max) : null);
const gidOf = (value: unknown): string | null => (typeof value === "string" && GID.test(value) ? value : null);
const timeOf = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
};

/** An https link, cut of nothing: a link longer than 500 characters, or not https, is not kept. */
export function httpsLink(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 500) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && url.username === "" && url.password === "" ? url.href : null;
  } catch {
    return null;
  }
}

/** Asana's own link: https on app.asana.com only. */
export function asanaLink(value: unknown): string | null {
  const href = httpsLink(value);
  return href && new URL(href).hostname === "app.asana.com" && new URL(href).port === "" ? href : null;
}

/** `{ data: ... }`, Asana's envelope. */
function dataOf(json: unknown, label: string): unknown {
  const body = record(json);
  if (!body || !("data" in body)) throw new ProviderError("bad_response", `Asana ${label}: no data`);
  return body.data;
}

function personOf(value: unknown): AsanaPerson | null {
  const person = record(value);
  const gid = gidOf(person?.gid);
  return gid ? { gid, name: text(person?.name) } : null;
}

/** The token answer (code exchange or refresh). `keepRefresh` when Asana sends no new refresh token: the one sent stays. */
export function mapTokens(json: unknown, nowMs: number, keepRefresh?: string): { tokens: ProviderTokens; user: AsanaUser | null } {
  const body = record(json);
  const accessToken = typeof body?.access_token === "string" ? body.access_token : "";
  const refreshToken = typeof body?.refresh_token === "string" && body.refresh_token !== "" ? body.refresh_token : (keepRefresh ?? "");
  const expiresIn = typeof body?.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
  if (!accessToken || !refreshToken) throw new ProviderError("bad_response", "Asana token answer: no token");
  const data = record(body?.data);
  const gid = gidOf(data?.gid) ?? (typeof data?.id === "number" && Number.isSafeInteger(data.id) ? String(data.id) : null);
  return {
    tokens: { accessToken, refreshToken, expiresAt: nowMs + expiresIn * 1000, scopes: [...ASANA_SCOPES] },
    user: gid ? { gid, name: text(data?.name) ?? `Asana user ${gid}` } : null,
  };
}

export function mapUser(json: unknown): AsanaUser {
  const data = record(dataOf(json, "user"));
  const gid = gidOf(data?.gid);
  if (!gid) throw new ProviderError("bad_response", "Asana user: no gid");
  return { gid, name: text(data?.name) ?? `Asana user ${gid}` };
}

/** A list page: its readable items, and the next page's offset. */
export function mapPage<T>(json: unknown, label: string, item: (raw: Record<string, unknown>) => T | null): AsanaPage<T> {
  const list = dataOf(json, label);
  if (!Array.isArray(list)) throw new ProviderError("bad_response", `Asana ${label}: not a list`);
  const next = record(record(json)?.next_page);
  const offset = typeof next?.offset === "string" && next.offset.length <= 500 ? next.offset : null;
  return { items: list.flatMap((raw) => (record(raw) ? [item(record(raw) as Record<string, unknown>)] : [])).filter((value): value is T => value !== null), next: offset };
}

export function choiceOf(raw: Record<string, unknown>): AsanaChoice | null {
  const gid = gidOf(raw.gid);
  const name = text(raw.name);
  if (!gid) return null;
  return { gid, name: name ?? `Untitled (${gid})`, ...(typeof raw.completed === "boolean" ? { completed: raw.completed } : {}) };
}

export function mapTask(json: unknown): TaskFacts {
  const data = record(dataOf(json, "task"));
  const gid = gidOf(data?.gid);
  if (!data || !gid) throw new ProviderError("bad_response", "Asana task: no gid");
  const completed = data.completed === true;
  const projects = Array.isArray(data.projects) ? data.projects.flatMap((project) => (gidOf(record(project)?.gid) ? [gidOf(record(project)?.gid) as string] : [])) : [];
  return {
    gid,
    name: text(data.name) ?? `Untitled task (${gid})`,
    url: asanaLink(data.permalink_url),
    workspaceGid: gidOf(record(data.workspace)?.gid),
    projectGids: projects,
    completed,
    completedAt: completed ? timeOf(data.completed_at) : null,
    completedBy: completed ? personOf(data.completed_by) : null,
    assignee: personOf(data.assignee),
    modifiedAt: timeOf(data.modified_at),
    notes: typeof data.notes === "string" ? data.notes.slice(0, 20_000) : "",
  };
}

const HOSTS = new Set(["asana", "dropbox", "gdrive", "box", "onedrive", "vimeo", "external"]);

export function attachmentOf(raw: Record<string, unknown>): AttachmentFacts | null {
  const gid = gidOf(raw.gid);
  if (!gid) return null;
  const host = typeof raw.host === "string" && HOSTS.has(raw.host) ? raw.host : "external";
  return {
    gid,
    name: text(raw.name) ?? `Attachment ${gid}`,
    host,
    createdAt: timeOf(raw.created_at),
    // A file in Asana opens at its permanent link, which needs an Asana sign-in; another service's at its own page.
    href: host === "asana" ? asanaLink(raw.permanent_url) : (httpsLink(raw.view_url) ?? httpsLink(raw.permanent_url)),
  };
}

/** A comment: a story whose subtype says a person wrote it. System stories (completed, assigned) are left out. */
export function commentOf(raw: Record<string, unknown>): CommentFacts | null {
  const gid = gidOf(raw.gid);
  if (!gid || (raw.resource_subtype !== "comment_added" && raw.type !== "comment")) return null;
  return { gid, text: typeof raw.text === "string" ? raw.text.slice(0, 10_000) : "", createdAt: timeOf(raw.created_at) };
}

/** A webhook Asana made: its gid. */
export function mapWebhook(json: unknown): { gid: string } {
  const data = record(dataOf(json, "webhook"));
  const gid = gidOf(data?.gid);
  if (!gid) throw new ProviderError("bad_response", "Asana webhook: no gid");
  return { gid };
}
