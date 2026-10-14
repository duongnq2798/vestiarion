import { ProviderError } from "../connectors/provider";
import { ASANA_API, GID, apiGet, asanaFetch, failureOf, jsonOf, reasonOf, type AsanaHttp } from "./http";
import {
  attachmentOf,
  choiceOf,
  commentOf,
  mapPage,
  mapTask,
  mapUser,
  mapWebhook,
  type AsanaChoice,
  type AsanaPage,
  type AttachmentFacts,
  type CommentFacts,
  type TaskFacts,
} from "./map";

/**
 * Asana's reads, and the webhooks Vestiarion makes on the tasks it reads
 * (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md A4, A6, A11). Every address is built here from ids that
 * are digits only; nothing a person or Asana gave as a link is ever requested. A refused call throws `ProviderError`,
 * but a task Asana no longer shows this connection (404, 403) is an answer, `gone`, not a failure.
 */

/** A task read whole: its facts, its attachments and its comments; or why Asana no longer shows it. */
export type TaskRead =
  | { kind: "task"; task: TaskFacts; attachments: AttachmentFacts[]; comments: CommentFacts[] }
  | { kind: "gone"; reason: "not_found" | "forbidden" };

const TASK_FIELDS = [
  "name",
  "notes",
  "completed",
  "completed_at",
  "completed_by.name",
  "assignee.name",
  "modified_at",
  "permalink_url",
  "workspace",
  "projects",
].join(",");
const ATTACHMENT_FIELDS = "name,host,created_at,permanent_url,view_url";
const STORY_FIELDS = "resource_subtype,type,text,created_at";

/** Pages read of one list at most: a picker shows the first 500, a task's comments the first 300. */
const PICKER_PAGES = 5;
const STORY_PAGES = 3;

function requireGid(value: string, what: string): string {
  if (!GID.test(value)) throw new ProviderError("bad_response", `Asana ${what}: not an id`);
  return value;
}

export interface AsanaReader {
  workspaces(accessToken: string): Promise<AsanaChoice[]>;
  projects(accessToken: string, workspaceGid: string): Promise<AsanaChoice[]>;
  tasks(accessToken: string, projectGid: string): Promise<AsanaChoice[]>;
  task(accessToken: string, taskGid: string): Promise<TaskRead>;
  /** The Asana user with this email, when the token can see one; null otherwise. */
  userByEmail(accessToken: string, email: string): Promise<string | null>;
  createWebhook(accessToken: string, input: { resource: string; target: string }): Promise<{ gid: string; secret: string | null }>;
  /** True once Asana has no such webhook, deleted now or before. */
  deleteWebhook(accessToken: string, webhookGid: string): Promise<boolean>;
}

export function asanaReader(deps: AsanaHttp = {}): AsanaReader {
  const now = deps.now ?? Date.now;

  async function get(url: string, accessToken: string, label: string): Promise<Response> {
    const response = await asanaFetch(url, apiGet(accessToken), label, deps);
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw failureOf(response, label, now());
    }
    return response;
  }

  async function list<T>(base: string, accessToken: string, label: string, pages: number, item: (raw: Record<string, unknown>) => T | null): Promise<T[]> {
    const items: T[] = [];
    let offset: string | null = null;
    for (let page = 0; page < pages; page += 1) {
      const url = new URL(base);
      url.searchParams.set("limit", "100");
      if (offset) url.searchParams.set("offset", offset);
      const read: AsanaPage<T> = mapPage(await jsonOf(await get(url.toString(), accessToken, label), label), label, item);
      items.push(...read.items);
      if (!read.next) break;
      offset = read.next;
    }
    return items;
  }

  return {
    workspaces: (accessToken) => list(`${ASANA_API}/workspaces?opt_fields=name`, accessToken, "workspaces", PICKER_PAGES, choiceOf),

    projects: async (accessToken, workspaceGid) =>
      list(`${ASANA_API}/projects?workspace=${requireGid(workspaceGid, "workspace")}&archived=false&opt_fields=name`, accessToken, "projects", PICKER_PAGES, choiceOf),

    tasks: async (accessToken, projectGid) =>
      list(`${ASANA_API}/tasks?project=${requireGid(projectGid, "project")}&opt_fields=name,completed`, accessToken, "tasks", PICKER_PAGES, choiceOf),

    async task(accessToken, taskGid) {
      const gid = requireGid(taskGid, "task");
      const response = await asanaFetch(`${ASANA_API}/tasks/${gid}?opt_fields=${TASK_FIELDS}`, apiGet(accessToken), "task", deps);
      // A task deleted, or one this connection's person can no longer see, is an answer about the task.
      if (response.status === 404) return { kind: "gone", reason: "not_found" };
      if (response.status === 403) return { kind: "gone", reason: "forbidden" };
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw failureOf(response, "task", now());
      }
      const task = mapTask(await jsonOf(response, "task"));
      if (task.gid !== gid) throw new ProviderError("bad_response", "Asana task: another task answered");
      const attachments = await list(`${ASANA_API}/attachments?parent=${gid}&opt_fields=${ATTACHMENT_FIELDS}`, accessToken, "attachments", 1, attachmentOf);
      const comments = await list(`${ASANA_API}/tasks/${gid}/stories?opt_fields=${STORY_FIELDS}`, accessToken, "stories", STORY_PAGES, commentOf);
      return { kind: "task", task, attachments, comments };
    },

    async userByEmail(accessToken, email) {
      const address = email.trim().toLowerCase();
      if (!/^[^\s@/?#]{1,64}@[^\s@/?#]{1,255}$/.test(address)) return null;
      // Asana takes a user's email where it takes a user's gid.
      const response = await asanaFetch(`${ASANA_API}/users/${encodeURIComponent(address)}?opt_fields=gid`, apiGet(accessToken), "user lookup", deps);
      if (response.status === 404 || response.status === 403 || response.status === 400) {
        await response.body?.cancel().catch(() => {});
        return null;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw failureOf(response, "user lookup", now());
      }
      return mapUser(await jsonOf(response, "user lookup")).gid;
    },

    async createWebhook(accessToken, input) {
      const resource = requireGid(input.resource, "webhook resource");
      const target = new URL(input.target);
      if (target.protocol !== "https:") throw new ProviderError("bad_response", "Asana webhook: the target is not https");
      // Asana answers once its handshake with the target finished, with the secret it sent there.
      const response = await asanaFetch(
        `${ASANA_API}/webhooks`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${accessToken}`, accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ data: { resource, target: target.toString() } }),
        },
        "webhook",
        deps
      );
      // Asana's reason is kept: a refused webhook leaves a link read only by the agent's cycle and the sweeper.
      if (!response.ok) throw failureOf(response, "webhook", now(), await reasonOf(response));
      // Asana documents the secret at the top of the 201's body, beside `data`; a header is taken too.
      const body = await jsonOf(response, "webhook");
      const inBody = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["X-Hook-Secret"] : undefined;
      const secret = typeof inBody === "string" && inBody.length > 0 ? inBody : response.headers.get("x-hook-secret");
      return { ...mapWebhook(body), secret: secret && secret.length <= 500 ? secret : null };
    },

    async deleteWebhook(accessToken, webhookGid) {
      const gid = requireGid(webhookGid, "webhook");
      const response = await asanaFetch(`${ASANA_API}/webhooks/${gid}`, { method: "DELETE", headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } }, "webhook delete", deps);
      if (response.ok || response.status === 404) {
        await response.body?.cancel().catch(() => {});
        return true;
      }
      throw failureOf(response, "webhook delete", now(), await reasonOf(response));
    },
  };
}
