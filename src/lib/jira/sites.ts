import { currentOrgId } from "../context";
import { platformDb } from "../dal";
import type { SiteRef } from "./api";

/**
 * The one module that reads or writes `jira_sites` (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR3,
 * JR5, JR14, JR15, JR21): for each Jira connection, the site it reads (its cloudId and its address) and its one webhook
 * there, with what is known of how that webhook is doing. It is a platform table only the service role reaches
 * (migration 0149), as `asana_webhooks` is, because a delivery names webhook ids and no workspace: the webhook route
 * finds the rows a delivery matched, and notes when it came, before any workspace is known. Every other function names
 * the workspace in scope, and refuses any other.
 *
 * Before migration 0149 has run, a read says Jira is not set up rather than failing.
 */

/** A table, column or function migration 0149 adds, missing because it has not run here yet (JR5). */
export function isJiraNotSetUp(error: { code?: string | null; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code && ["PGRST205", "PGRST202", "PGRST204", "42P01", "42703", "42883"].includes(error.code)) return true;
  return /could not find the (table|function|column)|does not exist/i.test(error.message ?? "");
}

/** Jira's tables are not in this database yet (migration 0149). */
export class JiraNotSetUpError extends Error {
  constructor() {
    super("The Jira tables are not in this database yet");
    this.name = "JiraNotSetUpError";
  }
}

function raise(error: { code?: string | null; message: string }): never {
  if (isJiraNotSetUp(error)) throw new JiraNotSetUpError();
  throw new Error(error.message);
}

/** A connection's site and its webhook, as kept. */
export interface StoredSite {
  connectionId: string;
  orgId: string;
  cloudId: string;
  /** `https://<host>`, as Atlassian names the site now. */
  siteUrl: string;
  /** The webhook Jira has for this connection now: one, or none. */
  webhookIds: number[];
  /** Webhooks deleted or replaced, still routed to this row until `retiredUntil`, so a delivery on its way finds it. */
  retiredWebhookIds: number[];
  retiredUntil: string | null;
  webhookJql: string | null;
  webhookExpiresAt: string | null;
  webhookRegisteredAt: string | null;
  webhookCheckedAt: string | null;
  /** Jira's own words for its last refusal to take the webhook, for the card. */
  webhookError: string | null;
  lastDeliveryAt: string | null;
  /** When a sweep read a change no delivery told of (JR21). */
  missedChangeAt: string | null;
  /** When Atlassian first answered without this site (JR3). */
  siteMissingAt: string | null;
  updatedAt: string;
}

interface SiteRow {
  connection_id: string;
  org_id: string;
  cloud_id: string;
  site_url: string;
  webhook_ids: unknown;
  retired_webhook_ids: unknown;
  retired_until: string | null;
  webhook_jql: string | null;
  webhook_expires_at: string | null;
  webhook_registered_at: string | null;
  webhook_checked_at: string | null;
  webhook_error: string | null;
  last_delivery_at: string | null;
  missed_change_at: string | null;
  site_missing_at: string | null;
  updated_at: string;
}

const COLUMNS =
  "connection_id, org_id, cloud_id, site_url, webhook_ids, retired_webhook_ids, retired_until, webhook_jql, webhook_expires_at, webhook_registered_at, webhook_checked_at, webhook_error, last_delivery_at, missed_change_at, site_missing_at, updated_at";

/** Jira allows an app 5 webhooks per person on a site; 0149 holds each list to 5. */
export const MAX_IDS = 5;
/** At most this many rows answer one delivery (JR15). */
export const DELIVERY_ROWS = 20;

const iso = (value: string | null) => (value === null ? null : new Date(value).toISOString());
/** A webhook id as PostgREST answers a bigint: a number, or its digits. */
const idsOf = (value: unknown): number[] =>
  (Array.isArray(value) ? value : []).flatMap((one) => {
    const id = typeof one === "string" && /^[0-9]{1,15}$/.test(one) ? Number(one) : one;
    return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? [id] : [];
  });

function toSite(row: SiteRow): StoredSite {
  return {
    connectionId: row.connection_id,
    orgId: row.org_id,
    cloudId: row.cloud_id,
    siteUrl: row.site_url,
    webhookIds: idsOf(row.webhook_ids),
    retiredWebhookIds: idsOf(row.retired_webhook_ids),
    retiredUntil: iso(row.retired_until),
    webhookJql: row.webhook_jql,
    webhookExpiresAt: iso(row.webhook_expires_at),
    webhookRegisteredAt: iso(row.webhook_registered_at),
    webhookCheckedAt: iso(row.webhook_checked_at),
    webhookError: row.webhook_error,
    lastDeliveryAt: iso(row.last_delivery_at),
    missedChangeAt: iso(row.missed_change_at),
    siteMissingAt: iso(row.site_missing_at),
    updatedAt: iso(row.updated_at) ?? row.updated_at,
  };
}

/** The site's two parts a read needs: the cloudId its address names, and its own address, links are compared with. */
export const siteRef = (site: Pick<StoredSite, "cloudId" | "siteUrl">): SiteRef => ({ cloudId: site.cloudId, url: site.siteUrl });

/** The retired ids still routed at `nowMs`: none once their two hours are over. */
export const routedRetired = (site: Pick<StoredSite, "retiredWebhookIds" | "retiredUntil">, nowMs: number): number[] =>
  site.retiredUntil !== null && Date.parse(site.retiredUntil) > nowMs ? site.retiredWebhookIds : [];

function requireScope(orgId: string): void {
  if (currentOrgId() !== orgId) throw new Error("A Jira site is reached only in its own workspace's scope");
}

const sites = () => platformDb().from("jira_sites");

/** Writes these values on the connection's row in the workspace in scope; how many rows it changed, one or none. */
async function update(orgId: string, connectionId: string, values: Record<string, unknown>, options: { unlessMissing?: boolean } = {}): Promise<number> {
  requireScope(orgId);
  const query = sites().update(values).eq("connection_id", connectionId).eq("org_id", orgId);
  const result = await (options.unlessMissing ? query.is("site_missing_at", null) : query).select("connection_id");
  if (result.error) raise(result.error);
  return (result.data ?? []).length;
}

/** The connection's site row, in the workspace in scope; null before it was saved. */
export async function siteFor(orgId: string, connectionId: string): Promise<StoredSite | null> {
  requireScope(orgId);
  const result = await sites().select(COLUMNS).eq("connection_id", connectionId).eq("org_id", orgId).limit(1);
  if (result.error) raise(result.error);
  const row = ((result.data ?? []) as unknown as SiteRow[])[0];
  return row ? toSite(row) : null;
}

/**
 * The site as Atlassian names it now (JR2, JR3): made on connect, its address updated when the site was renamed, and its
 * missing mark cleared, since Atlassian answered with it. A reconnect to the same site keeps its row and its webhook.
 */
export async function saveSite(orgId: string, site: { connectionId: string; cloudId: string; siteUrl: string }, nowIso: string): Promise<StoredSite> {
  requireScope(orgId);
  const facts = { cloud_id: site.cloudId, site_url: site.siteUrl, site_missing_at: null, updated_at: nowIso };
  if ((await update(orgId, site.connectionId, facts)) === 0) {
    const inserted = await sites().insert({ connection_id: site.connectionId, org_id: orgId, ...facts }).select("connection_id");
    // Made by another call in the meantime: it is the same site, so its facts are written over it.
    if (inserted.error && inserted.error.code === "23505") await update(orgId, site.connectionId, facts);
    else if (inserted.error) raise(inserted.error);
  }
  const saved = await siteFor(orgId, site.connectionId);
  if (!saved) throw new Error("The Jira site was not saved");
  return saved;
}

/** The webhook the connection has now, by Jira's id, or none, and when it was last looked at (JR14). */
export async function setWebhooks(
  orgId: string,
  connectionId: string,
  state: { webhookIds: readonly number[]; jql: string | null; expiresAt: string | null; registeredAt: string | null; error: string | null },
  nowIso: string
): Promise<void> {
  await update(orgId, connectionId, {
    webhook_ids: [...new Set(state.webhookIds)].slice(0, MAX_IDS),
    webhook_jql: state.jql,
    webhook_expires_at: state.expiresAt,
    webhook_registered_at: state.registeredAt,
    webhook_error: state.error === null ? null : state.error.slice(0, 300),
    webhook_checked_at: nowIso,
    updated_at: nowIso,
  });
}

/**
 * Webhooks just replaced or deleted (JR14): still routed to this row until `untilIso`, two hours, so a delivery Jira had
 * already sent for one finds it. Ids retired before and still routed stay with them; at most the newest five are kept.
 */
export async function retire(orgId: string, connectionId: string, ids: readonly number[], nowIso: string, untilIso: string): Promise<void> {
  const site = await siteFor(orgId, connectionId);
  if (!site || ids.length === 0) return;
  const kept = routedRetired(site, Date.parse(nowIso)).filter((id) => !ids.includes(id));
  await update(orgId, connectionId, { retired_webhook_ids: [...kept, ...new Set(ids)].slice(-MAX_IDS), retired_until: untilIso, updated_at: nowIso });
}

/** The webhook looked at now, with what was learnt: Jira's refusal in its words, or a new expiry. */
export async function markChecked(orgId: string, connectionId: string, nowIso: string, learnt: { error?: string | null; expiresAt?: string | null } = {}): Promise<void> {
  await update(orgId, connectionId, {
    webhook_checked_at: nowIso,
    updated_at: nowIso,
    ...("error" in learnt ? { webhook_error: learnt.error === null || learnt.error === undefined ? null : learnt.error.slice(0, 300) } : {}),
    ...(learnt.expiresAt ? { webhook_expires_at: learnt.expiresAt } : {}),
  });
}

/** Atlassian answered without the site (JR3): the first time only is noted, so the second miss is measured from it. */
export async function markMissing(orgId: string, connectionId: string, nowIso: string): Promise<void> {
  await update(orgId, connectionId, { site_missing_at: nowIso, updated_at: nowIso }, { unlessMissing: true });
}

/** A sweep read a change no delivery told of (JR21): the card says Jira's notices are not reaching Vestiarion. */
export async function markMissedChange(orgId: string, connectionId: string, nowIso: string): Promise<void> {
  await update(orgId, connectionId, { missed_change_at: nowIso, updated_at: nowIso });
}

/** The row deleted on disconnect (JR4), after its webhooks were. */
export async function clearSite(orgId: string, connectionId: string): Promise<void> {
  requireScope(orgId);
  const result = await sites().delete().eq("connection_id", connectionId).eq("org_id", orgId).select("connection_id");
  if (result.error) raise(result.error);
}

/**
 * The rows a delivery's webhook ids name (JR15), in every workspace, before any is known: those whose current ids, or
 * whose retired ids within their two hours, overlap them, at most 20. The webhook route's lookup; ids and the site only.
 */
export async function sitesForWebhooks(ids: readonly number[], nowIso: string): Promise<StoredSite[]> {
  const wanted = [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (wanted.length === 0) return [];
  const current = await sites().select(COLUMNS).overlaps("webhook_ids", wanted).limit(DELIVERY_ROWS);
  if (current.error) raise(current.error);
  const retired = await sites().select(COLUMNS).overlaps("retired_webhook_ids", wanted).gt("retired_until", nowIso).limit(DELIVERY_ROWS);
  if (retired.error) raise(retired.error);
  const found = new Map<string, StoredSite>();
  for (const row of [...((current.data ?? []) as unknown as SiteRow[]), ...((retired.data ?? []) as unknown as SiteRow[])]) {
    const site = toSite(row);
    const held = [...site.webhookIds, ...routedRetired(site, Date.parse(nowIso))];
    if (held.some((id) => wanted.includes(id)) && !found.has(site.connectionId)) found.set(site.connectionId, site);
  }
  return [...found.values()].slice(0, DELIVERY_ROWS);
}

/** When a delivery last came for these rows: the webhook route's note, before any workspace is known (JR15, JR21). */
export async function touchDelivery(connectionIds: readonly string[], nowIso: string): Promise<void> {
  if (connectionIds.length === 0) return;
  const result = await sites().update({ last_delivery_at: nowIso }).in("connection_id", [...new Set(connectionIds)]).select("connection_id");
  if (result.error) raise(result.error);
}

/** A probe: throws `JiraNotSetUpError` before migration 0149. */
export async function siteTableReady(): Promise<void> {
  const result = await sites().select("connection_id").limit(1);
  if (result.error) raise(result.error);
}
