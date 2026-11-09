import { siteOrigin } from "../auth/env";
import type { Connection } from "../connectors/connections";
import { ProviderError } from "../connectors/provider";
import { connectionTokenStore } from "../connectors/token-store";
import { currentOrgId } from "../context";
import { apiInit, apiUrl, cappedText, discard, failureOf, ISSUE_ID, jiraFetch, jsonOf, JSON_BYTES, type JiraHttp } from "./http";
import { linksOfMilestones } from "./links";
import { jiraDate, type JiraSite } from "./map";
import type { JiraProvider } from "./provider";
import { jiraSession, type JiraSession } from "./session";
import { clearSite, markChecked, markMissing, retire, routedRetired, saveSite, setWebhooks, siteFor, sitesForWebhooks, type StoredSite } from "./sites";
import { siteHost } from "./urls";

/**
 * The one webhook a connection keeps on its Jira site (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR14):
 * Jira's dynamic webhooks, registered, renewed, listed and deleted with the connecting person's token through the REST
 * API, `/rest/api/3/webhook`. A webhook only nudges: a delivery says which issue changed, and the issue is read again
 * through the API (JR15). It is told of issue changes and comments in the projects of the linked issues only, by a JQL
 * filter of their numeric ids, which never change when a project's key does; no field filter, since a new file or a
 * comment must arrive. Jira ends a webhook 30 days after it was made or last renewed.
 *
 * A refusal to make one is said in Jira's own short words, never thrown: the card shows them, and the sweeper reads the
 * linked issues every 15 minutes anyway. A refused token, a rate limit or an outage throws, as every call does. After the
 * REST calls comes the upkeep that keeps the webhook to what the open links need, which is also the connection's daily
 * keep-alive (JR3), and its end on disconnect (JR4).
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

/*
 * The upkeep (JR3, JR14): the one webhook kept to what the open links need, and the daily keep-alive that goes with it.
 * Housekeeping, not in the ledger, as Asana's webhooks are not; what it learnt is on the site row, and so on the card.
 */

/** What the upkeep needs of a workspace's Jira: its connection, Jira's calls, and a session on the connection's token. */
export interface JiraUpkeepContext {
  connection: Pick<Connection, "id" | "orgId" | "externalOrgId" | "externalOrgName">;
  provider: Pick<JiraProvider, "reader" | "hooks">;
  session: JiraSession;
}

export interface UpkeepOptions {
  now?: () => number;
  /** Look now, however recently the row was checked: on connect, after a link or an unlink, on Check linked issues now. */
  force?: boolean;
  /** Delete the app's webhooks no row holds before registering: the first upkeep after a connect (JR2). */
  orphans?: boolean;
  /** This deployment's origin, where Jira sends deliveries; `siteOrigin()` unless a test names one. */
  origin?: string;
}

export type UpkeepOutcome =
  /** Checked within the day, with the filter wanted and a webhook far from lapsing: no request. */
  | "fresh"
  /** No open link, and no webhook. */
  | "none"
  | "registered"
  | "renewed"
  | "present"
  /** No open link left: the webhook was deleted. */
  | "removed"
  /** Jira would not take the webhook, or delete it: its words are on the row (JR22). */
  | "refused"
  /** This deployment cannot be reached by Jira (a local one): no webhook is made. */
  | "skipped"
  /** Atlassian answered without the site, the first time: marked, and looked at again by the next sweep. */
  | "site_missing";

export interface Upkeep {
  outcome: UpkeepOutcome;
  /** The site row as the upkeep left it; null when there is none yet. */
  site: StoredSite | null;
}

const DAY_MS = 24 * 60 * 60_000;
/** The row is looked at once a day at most, unless forced. */
export const UPKEEP_EVERY_MS = DAY_MS;
/** A webhook that lapses within a week is renewed. */
export const RENEW_WITHIN_MS = 7 * DAY_MS;
/** How long Jira keeps a webhook after it was made or renewed, when the list does not say. */
export const WEBHOOK_LIFE_MS = 30 * DAY_MS;
/** A webhook replaced or deleted is still routed to its row this long, for a delivery already on its way. */
export const RETIRED_FOR_MS = 2 * 60 * 60_000;
/** A site missing from two answers at least this far apart is gone (JR3). */
export const SITE_GONE_AFTER_MS = 10 * 60_000;
/** The milestones whose links the filter names: open ones (JR14). */
const OPEN_STATUSES = ["verified", "held", "pending"] as const;
/** The links the filter is built from, at most. */
const FILTER_LINKS = 500;

/** Where Jira sends a delivery: one address per deployment. */
export const jiraWebhookUrl = (origin: string) => `${origin}/api/integrations/jira/webhook`;

/** Whether Jira can reach this deployment: an https origin, never a local one. */
export function reachable(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && !url.hostname.endsWith(".localhost");
  } catch {
    return false;
  }
}

/**
 * Atlassian no longer lists the connection's site (JR3): it was removed, or the person who connected Jira lost access to
 * it. `final` once the second answer without it came at least 10 minutes after the first: the connection then needs a
 * person to reconnect, in these words.
 */
export class JiraSiteGoneError extends Error {
  constructor(
    readonly siteName: string,
    readonly final: boolean
  ) {
    super(`Jira no longer shows Vestiarion the ${siteName} site: the site was removed, or the person who connected Jira lost access to it. Reconnect Jira.`);
    this.name = "JiraSiteGoneError";
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

/** The filter the open links of this site want: their projects' numeric ids (JR14). */
async function wantedJql(cloudId: string): Promise<string | null> {
  const links = await linksOfMilestones({ statuses: OPEN_STATUSES, limit: FILTER_LINKS });
  return desiredJql(links.filter((link) => link.cloudId === cloudId).map((link) => link.projectId));
}

/** Whether the row needs no look today: checked within the day, its filter the one wanted, its webhook far from lapsing. */
function fresh(site: StoredSite | null, wanted: string | null, nowMs: number): boolean {
  if (!site || site.siteMissingAt !== null || site.webhookCheckedAt === null) return false;
  if (nowMs - Date.parse(site.webhookCheckedAt) >= UPKEEP_EVERY_MS) return false;
  if (site.webhookJql !== wanted) return false;
  if (wanted === null) return site.webhookIds.length === 0;
  return site.webhookIds.length > 0 && site.webhookExpiresAt !== null && Date.parse(site.webhookExpiresAt) - nowMs > RENEW_WITHIN_MS;
}

/**
 * The app's webhooks on the site to this deployment that no `jira_sites` row of the site holds, current or retired within
 * its two hours, in any workspace: deleted, which is also how Jira's 5 per person are kept to (JR14). A webhook Jira
 * lists without its address counts as this deployment's: Jira lists only the ones this app made with this person's token.
 * Answers how many were deleted.
 */
export async function cleanOrphans(ctx: JiraUpkeepContext, site: Pick<StoredSite, "cloudId">, url: string, nowMs: number = Date.now()): Promise<number> {
  const listed = await ctx.session.call((token) => ctx.provider.hooks.list(token, { cloudId: site.cloudId }));
  const ours = listed.filter((hook) => hook.url === null || hook.url === url).map((hook) => hook.id);
  if (ours.length === 0) return 0;
  const rows = await sitesForWebhooks(ours, iso(nowMs));
  const held = new Set(rows.filter((row) => row.cloudId === site.cloudId).flatMap((row) => [...row.webhookIds, ...routedRetired(row, nowMs)]));
  const orphans = ours.filter((id) => !held.has(id)).slice(0, 100);
  if (orphans.length === 0) return 0;
  const removed = await ctx.session.call((token) => ctx.provider.hooks.remove(token, { cloudId: site.cloudId }, orphans));
  return removed ? orphans.length : 0;
}

/**
 * A webhook registered (JR14): when Jira refuses it, the orphans are cleaned once, unless this upkeep cleaned them
 * already, and it is tried once more.
 */
async function registerOnce(ctx: JiraUpkeepContext, site: StoredSite, input: { url: string; jql: string }, nowMs: number, cleaned: boolean): Promise<Registration> {
  const register = () => ctx.session.call((token) => ctx.provider.hooks.register(token, { cloudId: site.cloudId }, input));
  const first = await register();
  if (first.ok) return first;
  if (!cleaned) await cleanOrphans(ctx, site, input.url, nowMs);
  return register();
}

/** Old webhooks retired (still routed for two hours) and deleted at Jira; a failed delete is left to the orphan clean. */
async function retireOld(ctx: JiraUpkeepContext, site: StoredSite, ids: readonly number[], nowMs: number): Promise<void> {
  if (ids.length === 0) return;
  await retire(site.orgId, site.connectionId, ids, iso(nowMs), iso(nowMs + RETIRED_FOR_MS));
  try {
    await ctx.session.call((token) => ctx.provider.hooks.remove(token, { cloudId: site.cloudId }, ids));
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    console.warn("jira: an old webhook was not deleted", error.failure);
  }
}

/** A new webhook for the filter wanted, and the old ones retired; or Jira's refusal, kept on the row. */
async function replaceWebhook(ctx: JiraUpkeepContext, site: StoredSite, jql: string, url: string, nowMs: number, cleaned: boolean): Promise<Upkeep> {
  const made = await registerOnce(ctx, site, { url, jql }, nowMs, cleaned);
  if (!made.ok) {
    // The old webhook, if any, is kept: it still tells of the projects it names. The next sweep tries again.
    await markChecked(site.orgId, site.connectionId, iso(nowMs), { error: made.error });
    return { outcome: "refused", site: await siteFor(site.orgId, site.connectionId) };
  }
  await setWebhooks(site.orgId, site.connectionId, { webhookIds: [made.id], jql, expiresAt: iso(nowMs + WEBHOOK_LIFE_MS), registeredAt: iso(nowMs), error: null }, iso(nowMs));
  await retireOld(ctx, site, site.webhookIds.filter((id) => id !== made.id), nowMs);
  return { outcome: "registered", site: await siteFor(site.orgId, site.connectionId) };
}

/**
 * Makes sure the connection's one webhook is what its open links need (JR14), and, once a day, that the connection still
 * reaches its site (JR3). No request when the row was checked within the day, its filter is the one wanted, and its
 * webhook does not lapse within 7 days. Otherwise: the sites the token reaches, which keeps the grant alive; then no
 * webhook without an open link, a new one when the filter changed or there is none, and the list as the truth when it is
 * the same, renewing one that lapses within 7 days and rotating it when renewing gives no later expiry.
 *
 * Jira's refusal to take a webhook is kept on the row, never thrown. Atlassian answering without the site is marked the
 * first time, and thrown as a final `JiraSiteGoneError` the second, at least 10 minutes later. A connection failure, a
 * rate limit or an outage throws, as every call does.
 */
export async function ensureJiraWebhook(ctx: JiraUpkeepContext, options: UpkeepOptions = {}): Promise<Upkeep> {
  const now = options.now ?? Date.now;
  const { id: connectionId, orgId, externalOrgId: cloudId } = ctx.connection;
  const stored = await siteFor(orgId, connectionId);
  const wanted = await wantedJql(cloudId);
  if (!options.force && fresh(stored, wanted, now())) return { outcome: "fresh", site: stored };

  // 1. The sites the token reaches: the keep-alive, and the check that the site is still there.
  const reached = await ctx.session.call((token) => ctx.provider.reader.sites(token));
  const found = reached.find((one) => one.cloudId === cloudId);
  if (!found) {
    const name = ctx.connection.externalOrgName ?? (stored ? siteHost(stored.siteUrl) : null) ?? "connected";
    if (!stored) {
      console.warn("jira: Atlassian did not list the connection's site", connectionId);
      return { outcome: "site_missing", site: null };
    }
    if (stored.siteMissingAt !== null && now() - Date.parse(stored.siteMissingAt) >= SITE_GONE_AFTER_MS) throw new JiraSiteGoneError(name, true);
    await markMissing(orgId, connectionId, iso(now()));
    return { outcome: "site_missing", site: await siteFor(orgId, connectionId) };
  }
  const site = await saveSite(orgId, { connectionId, cloudId, siteUrl: found.url }, iso(now()));
  const origin = options.origin ?? siteOrigin();
  const url = jiraWebhookUrl(origin);

  // 2. No open link: no webhook.
  if (wanted === null) {
    if (site.webhookIds.length === 0) {
      await setWebhooks(orgId, connectionId, { webhookIds: [], jql: null, expiresAt: null, registeredAt: null, error: null }, iso(now()));
      return { outcome: "none", site: await siteFor(orgId, connectionId) };
    }
    const removed = await ctx.session.call((token) => ctx.provider.hooks.remove(token, { cloudId }, site.webhookIds));
    if (!removed) {
      await markChecked(orgId, connectionId, iso(now()));
      return { outcome: "refused", site: await siteFor(orgId, connectionId) };
    }
    await setWebhooks(orgId, connectionId, { webhookIds: [], jql: null, expiresAt: null, registeredAt: null, error: null }, iso(now()));
    await retire(orgId, connectionId, site.webhookIds, iso(now()), iso(now() + RETIRED_FOR_MS));
    return { outcome: "removed", site: await siteFor(orgId, connectionId) };
  }
  if (!reachable(origin)) return { outcome: "skipped", site };

  let cleaned = false;
  if (options.orphans) {
    await cleanOrphans(ctx, site, url, now());
    cleaned = true;
  }

  // 3. Another filter, or none yet: a new webhook, and the old one retired.
  if (site.webhookIds.length === 0 || site.webhookJql !== wanted) return replaceWebhook(ctx, site, wanted, url, now(), cleaned);

  // 4. The same filter: Jira's list is the truth.
  const listed = await ctx.session.call((token) => ctx.provider.hooks.list(token, { cloudId }));
  const ours = listed.filter((hook) => site.webhookIds.includes(hook.id));
  if (ours.length === 0) return replaceWebhook(ctx, site, wanted, url, now(), cleaned);
  const ids = ours.map((hook) => hook.id);
  const listedExpiry = ours.map((hook) => hook.expiresAt).filter((at): at is string => at !== null).sort()[0] ?? null;
  const expiresAt = listedExpiry ?? (site.webhookRegisteredAt ? iso(Date.parse(site.webhookRegisteredAt) + WEBHOOK_LIFE_MS) : null);
  if (expiresAt !== null && Date.parse(expiresAt) - now() > RENEW_WITHIN_MS) {
    await setWebhooks(orgId, connectionId, { webhookIds: ids, jql: wanted, expiresAt, registeredAt: site.webhookRegisteredAt, error: null }, iso(now()));
    return { outcome: "present", site: await siteFor(orgId, connectionId) };
  }
  const renewed = await ctx.session.call((token) => ctx.provider.hooks.renew(token, { cloudId }, ids));
  if (renewed !== null && Date.parse(renewed) - now() > RENEW_WITHIN_MS) {
    await setWebhooks(orgId, connectionId, { webhookIds: ids, jql: wanted, expiresAt: renewed, registeredAt: site.webhookRegisteredAt, error: null }, iso(now()));
    return { outcome: "renewed", site: await siteFor(orgId, connectionId) };
  }
  // Renewing gave no later expiry: a new webhook takes over, and the old one is retired.
  return replaceWebhook(ctx, site, wanted, url, now(), cleaned);
}

/**
 * The connect flow's first upkeep (JR2), once the answer was sent, in the workspace's scope: the site row saved, the
 * app's orphan webhooks on the site deleted, and the webhook made only when links exist.
 */
export async function ensureJiraSite(connection: Pick<Connection, "id" | "orgId" | "externalOrgId" | "externalOrgName">, provider: JiraProvider, options: UpkeepOptions = {}): Promise<Upkeep> {
  const session = jiraSession({ provider, tokens: connectionTokenStore(currentOrgId(), connection.id), ...(options.now ? { now: options.now } : {}) });
  return ensureJiraWebhook({ connection, provider, session }, { ...options, force: true, orphans: true });
}

/**
 * On disconnect (JR4), before the connection is: its webhooks deleted at Jira, current and retired, with the token while
 * it still works, then its site row, whether or not Jira answered. Jira ends a webhook it still has within 30 days, and
 * a delivery for it finds no row. `deleted` is whether Jira has none of them now.
 */
export async function stopJiraWebhooks(ctx: JiraUpkeepContext): Promise<{ deleted: boolean }> {
  const site = await siteFor(ctx.connection.orgId, ctx.connection.id);
  if (!site) return { deleted: true };
  const ids = [...new Set([...site.webhookIds, ...site.retiredWebhookIds])];
  let deleted = ids.length === 0;
  if (!deleted) {
    try {
      deleted = await ctx.session.call((token) => ctx.provider.hooks.remove(token, { cloudId: site.cloudId }, ids));
    } catch (error) {
      console.warn("jira: the webhook was not deleted on disconnect", error instanceof Error ? error.name : "unknown");
    }
  }
  await clearSite(ctx.connection.orgId, ctx.connection.id);
  return { deleted };
}
