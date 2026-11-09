import { ProviderError } from "../connectors/provider";
import { apiInit, apiUrl, cappedText, discard, failureOf, ISSUE_ID, jiraFetch, jsonOf, JSON_BYTES, type JiraHttp } from "./http";
import { jiraDate, type JiraSite } from "./map";

/**
 * The one webhook a connection keeps on its Jira site (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR14):
 * Jira's dynamic webhooks, registered, renewed, listed and deleted with the connecting person's token through the REST
 * API, `/rest/api/3/webhook`. A webhook only nudges: a delivery says which issue changed, and the issue is read again
 * through the API (JR15). It is told of issue changes and comments in the projects of the linked issues only, by a JQL
 * filter of their numeric ids, which never change when a project's key does; no field filter, since a new file or a
 * comment must arrive. Jira ends a webhook 30 days after it was made or last renewed.
 *
 * A refusal to make one is said in Jira's own short words, never thrown: the card shows them, and the sweeper reads the
 * linked issues every 15 minutes anyway. A refused token, a rate limit or an outage throws, as every call does.
 */

/** What the webhook is told of: an issue changed or deleted, and a comment made, changed or deleted. */
export const JIRA_EVENTS = ["jira:issue_updated", "jira:issue_deleted", "comment_created", "comment_updated", "comment_deleted"] as const;
export type JiraEvent = (typeof JIRA_EVENTS)[number];

/** At most this many projects are named in one webhook's filter. */
export const JQL_PROJECTS = 100;
/** At most this many webhook ids are sent in one call: an app has at most 5 per person on a site. */
const IDS_PER_CALL = 100;
/** The pages of the webhook list read at most, of 100 each. */
const LIST_PAGES = 3;
const REFUSAL_CHARS = 200;

const record = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const byNumber = (a: string, b: string) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

/**
 * The filter the webhook should have (JR14): `project in (10000, 10001)`, the numeric ids of the projects of the open
 * links, each once, in order, at most 100; null when there is none, and then there should be no webhook.
 */
export function desiredJql(projectIds: Iterable<string | null>): string | null {
  const ids = [...new Set([...projectIds].filter((id): id is string => typeof id === "string" && ISSUE_ID.test(id)))].sort(byNumber).slice(0, JQL_PROJECTS);
  return ids.length > 0 ? `project in (${ids.join(", ")})` : null;
}

/** A webhook id as Jira gives one: a positive whole number. */
export function webhookIdOf(value: unknown): number | null {
  const number = typeof value === "string" && /^[0-9]{1,15}$/.test(value) ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** When Jira will end a webhook: epoch milliseconds, or a time in Jira's own form. */
export function expiryOf(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return new Date(value).toISOString();
  return jiraDate(value);
}

/** A webhook as Jira lists it. Its address is there only where Jira says it. */
export interface ListedWebhook {
  id: number;
  jql: string | null;
  events: string[];
  expiresAt: string | null;
  url: string | null;
}

export type Registration = { ok: true; id: number } | { ok: false; error: string };

export interface JiraWebhookApi {
  /** Makes one webhook to `url` for `jql`, or answers why Jira would not. */
  register(accessToken: string, site: Pick<JiraSite, "cloudId">, input: { url: string; jql: string }): Promise<Registration>;
  /**
   * Extends these webhooks' lives: `PUT /webhook/refresh`, as the REST reference says, then `PUT /webhook`, as the guide
   * says, when the first is not there (404, 405). The new expiry, or null when neither gave one.
   */
  renew(accessToken: string, site: Pick<JiraSite, "cloudId">, ids: readonly number[]): Promise<string | null>;
  /** The app's webhooks on the site, made with this person's token: the truth about which of them Jira still has. */
  list(accessToken: string, site: Pick<JiraSite, "cloudId">): Promise<ListedWebhook[]>;
  /** Deletes these webhooks: true once Jira has none of them, deleted now or before. */
  remove(accessToken: string, site: Pick<JiraSite, "cloudId">, ids: readonly number[]): Promise<boolean>;
}

function checkedIds(ids: readonly number[]): number[] {
  const unique = [...new Set(ids)];
  if (unique.length === 0 || unique.length > IDS_PER_CALL || unique.some((id) => webhookIdOf(id) === null)) throw new ProviderError("bad_response", "Jira webhook: not webhook ids");
  return unique;
}

/**
 * Jira's own words for a refusal, from its `errorMessages`, its `errors`, or a registration's `errors`: printable
 * characters, any web address replaced (one could be Vestiarion's own), at most 200 characters.
 */
export function refusalWords(said: readonly unknown[], status: number): string {
  const words = said
    .filter((one): one is string => typeof one === "string")
    .join("; ")
    .replace(/https?:\/\/\S+/gi, "[an address]")
    .replace(/\S*[a-z0-9-]\.[a-z]{2,}\/\S*/gi, "[an address]")
    .replace(/[^\x20-\x7e]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (words.length === 0) return `Jira answered ${status}`;
  return words.length > REFUSAL_CHARS ? `${words.slice(0, REFUSAL_CHARS - 1)}…` : words;
}

/** What a refusal's body says, its first 8,000 bytes only. */
async function refusalOf(response: Response): Promise<string> {
  let body: Record<string, unknown> | null = null;
  try {
    body = record(JSON.parse((await cappedText(response, 8_000)) ?? ""));
  } catch {
    body = null;
  }
  const messages = Array.isArray(body?.errorMessages) ? body.errorMessages.slice(0, 10) : [];
  const errors = record(body?.errors) ? Object.values(record(body?.errors) as Record<string, unknown>).slice(0, 10) : [];
  return refusalWords([...messages, ...errors], response.status);
}

/** A status that is the call's own failure, thrown, rather than Jira's refusal of what was asked. */
const thrown = (status: number) => status === 401 || status === 429 || status >= 500;

export function jiraWebhookApi(deps: JiraHttp = {}): JiraWebhookApi {
  const now = deps.now ?? Date.now;

  return {
    async register(accessToken, site, input) {
      const target = new URL(input.url);
      if (target.protocol !== "https:") throw new ProviderError("bad_response", "Jira webhook: the address is not https");
      if (input.jql.length === 0 || input.jql.length > 4000) throw new ProviderError("bad_response", "Jira webhook: no filter");
      const body = { url: target.toString(), webhooks: [{ events: [...JIRA_EVENTS], jqlFilter: input.jql }] };
      const response = await jiraFetch(apiUrl(site.cloudId, "/webhook"), apiInit(accessToken, "POST", body), "webhook", deps);
      if (thrown(response.status)) {
        await discard(response);
        throw failureOf(response, "webhook", now());
      }
      if (!response.ok) return { ok: false, error: await refusalOf(response) };
      // Jira answers 200 with one result per webhook asked for: its new id, or why it was not made.
      const results = record(await jsonOf(response, "webhook", JSON_BYTES))?.webhookRegistrationResult;
      const first = Array.isArray(results) ? record(results[0]) : null;
      const id = webhookIdOf(first?.createdWebhookId);
      if (id !== null) return { ok: true, id };
      return { ok: false, error: refusalWords(Array.isArray(first?.errors) ? first.errors.slice(0, 10) : [], response.status) };
    },

    async renew(accessToken, site, ids) {
      const body = { webhookIds: checkedIds(ids) };
      let response = await jiraFetch(apiUrl(site.cloudId, "/webhook/refresh"), apiInit(accessToken, "PUT", body), "webhook refresh", deps);
      if (response.status === 404 || response.status === 405) {
        await discard(response);
        response = await jiraFetch(apiUrl(site.cloudId, "/webhook"), apiInit(accessToken, "PUT", body), "webhook refresh", deps);
      }
      if (thrown(response.status)) {
        await discard(response);
        throw failureOf(response, "webhook refresh", now());
      }
      if (!response.ok) {
        console.error("jira: a webhook was not renewed", response.status, await refusalOf(response));
        return null;
      }
      return expiryOf(record(await jsonOf(response, "webhook refresh", JSON_BYTES))?.expirationDate);
    },

    async list(accessToken, site) {
      const hooks: ListedWebhook[] = [];
      let startAt = 0;
      for (let page = 0; page < LIST_PAGES; page += 1) {
        const response = await jiraFetch(apiUrl(site.cloudId, "/webhook", { startAt: String(startAt), maxResults: "100" }), apiInit(accessToken), "webhooks", deps);
        if (!response.ok) {
          await discard(response);
          throw failureOf(response, "webhooks", now());
        }
        const answer = record(await jsonOf(response, "webhooks", JSON_BYTES));
        if (!answer || !Array.isArray(answer.values)) throw new ProviderError("bad_response", "Jira webhooks: no values");
        for (const raw of answer.values) {
          const hook = record(raw);
          const id = webhookIdOf(hook?.id);
          if (!hook || id === null) continue;
          hooks.push({
            id,
            jql: typeof hook.jqlFilter === "string" && hook.jqlFilter.length > 0 ? hook.jqlFilter.slice(0, 4000) : null,
            events: Array.isArray(hook.events) ? hook.events.filter((event): event is string => typeof event === "string" && /^[a-z:_]{1,60}$/.test(event)) : [],
            expiresAt: expiryOf(hook.expirationDate),
            url: typeof hook.url === "string" && hook.url.length <= 2000 ? hook.url : null,
          });
        }
        if (answer.isLast !== false || answer.values.length === 0) break;
        startAt += answer.values.length;
      }
      return hooks;
    },

    async remove(accessToken, site, ids) {
      const body = { webhookIds: checkedIds(ids) };
      const response = await jiraFetch(apiUrl(site.cloudId, "/webhook"), apiInit(accessToken, "DELETE", body), "webhook delete", deps);
      if (response.ok || response.status === 404) {
        await discard(response);
        return true;
      }
      if (thrown(response.status)) {
        await discard(response);
        throw failureOf(response, "webhook delete", now());
      }
      console.error("jira: a webhook was not deleted", response.status, await refusalOf(response));
      return false;
    },
  };
}
