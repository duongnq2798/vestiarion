import { failureDelayMs } from "../connectors/backoff";
import { connectionFor, NotSetUpError, type Connection } from "../connectors/connections";
import { syncErrorWords } from "../connectors/status";
import { syncStore } from "../connectors/sync-store";
import { connectionTokenStore } from "../connectors/token-store";
import { ProviderError } from "../connectors/provider";
import { currentOrgId } from "../context";
import { db } from "../dal";
import { withOrg } from "../dal/scope";
import { recordUsage } from "../usage/record";
import { JiraNotSetUpError, jiraReady, linksOfMilestones, liveLinks, type IssueLink } from "./links";
import { jiraProviderFromEnv, type JiraProvider } from "./provider";
import { readLinks, type LinkReadOutcome, type ReadSummary } from "./reads";
import { JiraAccessError, jiraSession, type JiraSession } from "./session";
import { markMissedChange, siteFor, siteRef, sitesForWebhooks, touchDelivery, type StoredSite } from "./sites";
import { siteHost } from "./urls";
import type { JiraDeliveryEvent, SelfRef } from "./webhook";
import { ensureJiraWebhook, JiraSiteGoneError, type Upkeep } from "./webhooks";

/**
 * A workspace's Jira, as every path uses it (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR3, JR13 to
 * JR17, JR21), as Linear's (`../linear/workspace`): its connection, a session on the connection's own token and the site
 * it reads, and the ways a linked issue is read again without a person: before the agent decides contractors, right
 * before it sends their releases, every 15 minutes from the sweeper, and after a signed webhook delivery. All of it in
 * the workspace's own scope; a delivery, which names webhook ids and no workspace, enters each workspace whose site row
 * holds one of them in turn.
 *
 * Jira's rate limit is one pool for every tenant of the app (JR17), so the sweep spends it with care: status reads for
 * open issues, a change check over many issues in one request, floors for the rest, at most `SWEEP_READS` reads that make
 * a request in one run, and none at all while Atlassian's shared limit is spent.
 */

export interface JiraContext {
  connection: Connection;
  provider: JiraProvider;
  session: JiraSession;
  /** The connection's site as kept; null until an upkeep has saved it. */
  site: StoredSite | null;
}

export type JiraMissing = "off" | "not_set_up" | "not_connected" | "reconnect";

/** The workspace's Jira connection, ready to call, or why there is none. */
export async function jiraContext(given?: JiraProvider | null): Promise<JiraContext | { missing: JiraMissing; connection?: Connection | null }> {
  const provider = given === undefined ? jiraProviderFromEnv() : given;
  if (!provider) return { missing: "off" };
  let connection: Connection | null;
  try {
    connection = await connectionFor("jira");
    await jiraReady();
  } catch (error) {
    if (error instanceof NotSetUpError || error instanceof JiraNotSetUpError) return { missing: "not_set_up" };
    throw error;
  }
  if (!connection || connection.status === "revoked") return { missing: "not_connected", connection };
  if (connection.status === "needs_reconnect") return { missing: "reconnect", connection };
  const site = await siteFor(currentOrgId(), connection.id);
  return { connection, provider, session: jiraSession({ provider, tokens: connectionTokenStore(currentOrgId(), connection.id) }), site };
}

/**
 * The site to read on: the one kept, or, before the first upkeep saved it, the one the upkeep saves now (JR2). Null when
 * Atlassian did not list it.
 */
export async function siteOf(context: JiraContext, options: { now?: () => number } = {}): Promise<StoredSite | null> {
  if (context.site) return context.site;
  const upkeep = await ensureJiraWebhook(context, { force: true, ...(options.now ? { now: options.now } : {}) });
  context.site = upkeep.site;
  return upkeep.site;
}

/**
 * A connection Jira no longer takes: it needs a person, and says so, in the core's words or the site-gone ones (JR3).
 * Only a connected one moves.
 */
export async function markReconnect(connection: Pick<Connection, "id">, nowIso: string, words: string = syncErrorWords("reconnect", "Jira", null)): Promise<boolean> {
  const updated = await db()
    .from("accounting_connections")
    .update({ status: "needs_reconnect", last_error: words, last_error_at: nowIso, next_sync_after: null })
    .eq("id", connection.id)
    .eq("status", "connected")
    .select("id");
  if (updated.error) throw new Error(updated.error.message);
  return (updated.data ?? []).length === 1;
}

/** When a connection-level failure means the person must reconnect: a refused grant, or a site gone twice (JR3). */
export const needsReconnect = (error: unknown) =>
  error instanceof JiraAccessError ? error.outcome.reason === "reconnect" || error.outcome.reason === "missing" : error instanceof JiraSiteGoneError && error.final;

/** The words a connection that must be reconnected says. */
const reconnectWords = (error: unknown) => (error instanceof JiraSiteGoneError ? error.message : syncErrorWords("reconnect", "Jira", null));

/** Accepted links the agent's cycle reads before it decides contractors, at most this many, in full (JR16). */
export const CYCLE_READS = 10;
/** The reads a cycle makes stop starting after this long. */
export const CYCLE_BUDGET_MS = 30_000;

/**
 * Before the agent decides contractors (JR16): each accepted issue whose milestone the agent may still pay (verified by
 * Jira, verified or held) is read again in full, at most `CYCLE_READS`, so an issue reopened or changed since takes the
 * acceptance back in this same cycle, before the contractor stage reads which milestones are verified. Never throws: a
 * failure leaves the acceptance as it was, and the webhook and the sweeper read it again.
 */
export async function refreshJiraMilestones(given?: JiraProvider | null): Promise<ReadSummary & { checked: number }> {
  return readAccepted(given, () => linksOfMilestones({ statuses: ["verified", "held"], method: "jira", states: ["accepted"], limit: CYCLE_READS }), CYCLE_BUDGET_MS, "the cycle's read");
}

/**
 * The reads made right before the contractor stage sends its releases stop starting after `SEND_BUDGET_MS`, and the
 * stage waits for them at most `SEND_DEADLINE_MS`, as Linear's.
 */
export const SEND_BUDGET_MS = 10_000;
export const SEND_DEADLINE_MS = 20_000;
const SEND_ID_CHUNK = 100;

/**
 * Right before the contractor stage sends its releases (JR13, JR16), the accepted issues of exactly those milestones are
 * read once more, so an issue reopened or changed while the stage decided takes its acceptance back here, which the
 * stage's still-verified check then holds to. Never throws, and never waits past the deadline: a read that fails, is
 * paused, or is not done by then leaves the acceptance as it was, and `complete` is false.
 */
export async function recheckJiraBeforeSending(
  milestoneIds: readonly string[],
  given?: JiraProvider | null,
  options: { deadlineMs?: number } = {}
): Promise<ReadSummary & { checked: number; complete: boolean }> {
  const reading = readAccepted(
    given,
    async () => {
      const links: IssueLink[] = [];
      for (let at = 0; at < milestoneIds.length; at += SEND_ID_CHUNK) {
        links.push(...(await liveLinks({ milestoneIds: milestoneIds.slice(at, at + SEND_ID_CHUNK), states: ["accepted"], limit: SEND_ID_CHUNK })));
      }
      return links;
    },
    SEND_BUDGET_MS,
    "the read before sending"
  ).then((summary) => ({ ...summary, complete: summary.failed === 0 && summary.read >= summary.checked }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<ReadSummary & { checked: number; complete: boolean }>((resolve) => {
    timer = setTimeout(() => resolve({ checked: 0, read: 0, failed: 0, ready: 0, withdrawn: 0, deferred: 0, complete: false }), options.deadlineMs ?? SEND_DEADLINE_MS);
  });
  try {
    return await Promise.race([reading, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Reads accepted links in full with the workspace's connection, within a budget; never throws. */
async function readAccepted(given: JiraProvider | null | undefined, find: () => Promise<IssueLink[]>, budgetMs: number, what: string): Promise<ReadSummary & { checked: number }> {
  const none = { checked: 0, read: 0, failed: 0, ready: 0, withdrawn: 0, deferred: 0 };
  try {
    const context = await jiraContext(given);
    if ("missing" in context) return none;
    const links = await find();
    if (links.length === 0) return none;
    // Atlassian's shared limit is spent (JR17): nothing is asked, and the acceptances stand as given, unread.
    if (context.provider.pausedUntil() !== null || !context.site) return { ...none, checked: links.length };
    try {
      const summary = await readLinks(links, { session: context.session, reader: context.provider.reader, site: siteRef(context.site), budgetMs, depth: "full" });
      return { ...summary, checked: links.length };
    } catch (error) {
      if (needsReconnect(error)) await markReconnect(context.connection, new Date().toISOString(), reconnectWords(error));
      return { ...none, checked: links.length, failed: links.length };
    }
  } catch (error) {
    if (error instanceof JiraNotSetUpError || error instanceof NotSetUpError) return none;
    console.error(`jira: ${what} failed`, error instanceof Error ? error.message : "unknown error");
    return none;
  }
}

/** The links one sweep takes, of open milestones; the reads that make a request it makes; and how long they may take. */
export const SWEEP_LINKS = 100;
export const SWEEP_READS = 20;
export const SWEEP_LINK_BUDGET_MS = 60_000;
/** An accepted link is read at least hourly, any other daily: web-link edits may not move an issue's `updated` (JR16). */
export const ACCEPTED_FLOOR_MS = 60 * 60_000;
export const OTHER_FLOOR_MS = 24 * 60 * 60_000;
/** A change at least this old, with no delivery since, is one Jira's notices did not tell of (JR21). */
export const MISSED_AFTER_MS = 120_000;
const SYNC_LEASE_MS = 5 * 60_000;

export type JiraSyncOutcome = "synced" | "busy" | "reconnect" | "failed" | "rate_limited" | "unavailable";

/** Accepted links first, then ready, held and waiting (JR16). */
const STATE_RANK: Record<IssueLink["state"], number> = { accepted: 0, ready: 1, held: 2, waiting: 3 };
const sameInstant = (a: string | null, b: string | null) => (a === null || b === null ? a === b : Date.parse(a) === Date.parse(b));
const readAt = (link: IssueLink) => (link.lastReadAt === null ? 0 : Date.parse(link.lastReadAt));
/** A link held because Jira no longer shows its issue: the change check leaves it out, since Jira would refuse its id. */
const unreachable = (link: IssueLink) => link.state === "held" && link.heldReason === "issue_unreachable";

/**
 * Which of this site's links one sweep reads (JR16), at most `SWEEP_READS`: those never read or whose last read failed;
 * those the change check says changed, or did not answer for (every one, when it was refused or the sweep is forced);
 * then those past their floor. Within that order, accepted links first, then ready, held and waiting, the oldest read
 * first.
 */
export function chooseReads(links: readonly IssueLink[], changed: Map<string, string> | "refused" | "all", nowMs: number): IssueLink[] {
  const tier = (link: IssueLink): number | null => {
    if (link.lastReadAt === null || link.readError !== null) return 0;
    if (changed === "all" || (changed === "refused" && !unreachable(link))) return 1;
    if (changed !== "refused" && !unreachable(link)) {
      const updated = changed.get(link.issueId);
      if (updated === undefined || !sameInstant(updated, link.issueUpdatedAt)) return 1;
    }
    const floor = link.state === "accepted" ? ACCEPTED_FLOOR_MS : OTHER_FLOOR_MS;
    return nowMs - readAt(link) >= floor ? 2 : null;
  };
  return links
    .flatMap((link) => {
      const rank = tier(link);
      return rank === null ? [] : [{ link, rank }];
    })
    .sort((a, b) => a.rank - b.rank || STATE_RANK[a.link.state] - STATE_RANK[b.link.state] || readAt(a.link) - readAt(b.link))
    .slice(0, SWEEP_READS)
    .map(({ link }) => link);
}

/**
 * The sweeper's run for a Jira connection (JR16), every 15 minutes, under the connection's sync lease. While Atlassian's
 * shared limit is spent it asks nothing and waits for the pause's end. Otherwise the webhook is made sure of (a refusal
 * is kept on the site row and the run goes on); the live links of open milestones are taken, at most `SWEEP_LINKS`; one
 * of another site is held with no request, since its issue id may be another issue on this one; unless forced, one change
 * check asks Jira when this site's issues last changed; and the links chosen are read. A connection Jira no longer takes,
 * or whose site is gone, is marked to reconnect; any other failure waits (1, 2, 4 minutes and so on up to an hour).
 */
export async function syncJiraConnection(
  connectionId: string,
  provider: JiraProvider,
  options: { now?: () => number; force?: boolean; origin?: string } = {}
): Promise<{ outcome: JiraSyncOutcome; summary?: ReadSummary; upkeep?: Upkeep["outcome"] }> {
  const now = options.now ?? Date.now;
  const iso = (ms: number) => new Date(ms).toISOString();
  const connection = await syncStore.claim(connectionId, iso(now()), iso(now() + SYNC_LEASE_MS));
  if (!connection) return { outcome: "busy" };
  const fail = async (kind: "rate_limited" | "unavailable" | "bad_response" | "failed", retryAfterMs: number | null): Promise<{ outcome: JiraSyncOutcome }> => {
    const failures = connection.failures + 1;
    const next = iso(now() + (retryAfterMs ?? failureDelayMs(failures)));
    await syncStore.finish(connection.id, { kind: "failed", at: iso(now()), failures, nextSyncAfter: next, error: syncErrorWords(kind, "Jira", next, now()) });
    return { outcome: kind === "rate_limited" ? "rate_limited" : kind === "failed" ? "failed" : "unavailable" };
  };
  const paused = () => {
    const until = provider.pausedUntil();
    return until === null ? null : Math.max(until - now(), 0);
  };
  // 1. Atlassian's shared limit is spent (JR17): no request, and the next run after the pause.
  const waitFirst = paused();
  if (waitFirst !== null) return fail("rate_limited", waitFirst);
  try {
    const session = jiraSession({ provider, tokens: connectionTokenStore(currentOrgId(), connectionId), now });
    // 2. The webhook, and the daily keep-alive. Jira's refusal is on the row; a site gone twice needs a person.
    let upkeep: Upkeep;
    try {
      upkeep = await ensureJiraWebhook({ connection, provider, session }, { now, ...(options.force ? { force: true } : {}), ...(options.origin ? { origin: options.origin } : {}) });
    } catch (error) {
      if (error instanceof JiraAccessError || error instanceof JiraSiteGoneError || !(error instanceof ProviderError)) throw error;
      console.warn("jira: the webhook upkeep did not finish", error.failure);
      upkeep = { outcome: "refused", site: await siteFor(currentOrgId(), connectionId) };
    }
    const waitUpkeep = paused();
    if (waitUpkeep !== null) return { ...(await fail("rate_limited", waitUpkeep)), upkeep: upkeep.outcome };
    const site = upkeep.site;
    if (!site) return { ...(await fail("unavailable", null)), upkeep: upkeep.outcome };

    // 3. The links of open milestones, verified ones first: a paid or closed milestone's link stays live, as its history.
    const links = await linksOfMilestones({ statuses: ["verified", "held", "pending"], limit: SWEEP_LINKS });
    const here = links.filter((link) => link.cloudId === site.cloudId);
    // Another site's links are read as gone, with no request (`readLink`), once each.
    const elsewhere = links.filter((link) => link.cloudId !== site.cloudId && !unreachable(link));

    // 4. One change check over this site's links whose last read worked, unless forced.
    let changed: Map<string, string> | "refused" | "all" = "all";
    if (!options.force) {
      const checkable = here.filter((link) => link.lastReadAt !== null && link.readError === null && !unreachable(link));
      changed = checkable.length === 0 ? new Map() : await session.call((token) => provider.reader.changed(token, siteRef(site), checkable.map((link) => link.issueId)));
      if (changed === "refused") console.warn("jira: the change check was refused (an issue deleted or hidden); reading the oldest first", connectionId);
    }

    // 5 and 6. The links chosen, read within the budget; Atlassian's limit spent mid-run stops the reads.
    const chosen = [...elsewhere, ...chooseReads(here, changed, now())];
    const seen: { missed: string | null } = { missed: null };
    const onRead = (link: IssueLink, outcome: LinkReadOutcome) => {
      if (outcome.kind !== "read" || outcome.updatedAt === null || link.issueUpdatedAt === null || sameInstant(outcome.updatedAt, link.issueUpdatedAt)) return;
      const changedAt = Date.parse(outcome.updatedAt);
      // A change Jira did not tell of (JR21): old enough that its notice would have come, and none came since.
      if (now() - changedAt >= MISSED_AFTER_MS && (site.lastDeliveryAt === null || Date.parse(site.lastDeliveryAt) < changedAt)) seen.missed = iso(now());
    };
    const summary = await readLinks(chosen, {
      session,
      reader: provider.reader,
      site: siteRef(site),
      now,
      budgetMs: SWEEP_LINK_BUDGET_MS,
      stop: () => paused() !== null,
      onRead,
    });
    if (seen.missed !== null) await markMissedChange(currentOrgId(), connectionId, seen.missed);
    const waitReads = paused();
    if (waitReads !== null) return { ...(await fail("rate_limited", waitReads)), summary, upkeep: upkeep.outcome };

    // 7. Done.
    await syncStore.finish(connection.id, { kind: "synced", at: iso(now()) });
    if (chosen.length > 0) await recordUsage({ kind: "connector_sync", action: "jira", provider: "jira", ok: summary.failed === 0 });
    return { outcome: "synced", summary, upkeep: upkeep.outcome };
  } catch (error) {
    if (needsReconnect(error)) {
      await syncStore.finish(connection.id, { kind: "reconnect", at: iso(now()), error: reconnectWords(error) });
      return { outcome: "reconnect" };
    }
    if (error instanceof JiraAccessError) {
      if (error.outcome.reason === "busy") {
        await syncStore.finish(connection.id, { kind: "released", at: iso(now()) });
        return { outcome: "busy" };
      }
      return fail("unavailable", error.outcome.reason === "unavailable" ? error.outcome.retryAfterMs : null);
    }
    if (error instanceof ProviderError) return fail(error.failure === "rate_limited" ? "rate_limited" : error.failure === "bad_response" ? "bad_response" : "unavailable", error.retryAfterMs);
    if (error instanceof JiraSiteGoneError) return fail("unavailable", null);
    console.error("jira: a sweep of a connection failed", connectionId, error instanceof Error ? error.message : "unknown error");
    return fail("failed", null);
  }
}

/** The most links one delivery reads in one workspace: one issue has one live link there (0149). */
export const DELIVERY_READS = 5;
/** A read that started this long after a delivery was sent already saw its change (JR15). */
export const DELIVERY_SEEN_MS = 5_000;

/**
 * After a signed webhook delivery (JR15), in a workspace's scope already entered: the live links of the one issue the
 * delivery named, on the site it named, are read again with the workspace's connection, when that connection is still
 * the workspace's live one to that site. A link whose last read started at least 5 s after the delivery was sent is
 * skipped: that read saw the change. Nothing in the delivery is used but which issue to read and when it was sent.
 * Answers how many links were read.
 */
export async function rereadIssueInScope(
  input: { connectionId: string; cloudId: string; issueId: string; timestamp: number | null },
  given?: JiraProvider | null,
  options: { now?: () => number } = {}
): Promise<number> {
  const context = await jiraContext(given);
  if ("missing" in context || context.connection.id !== input.connectionId || !context.site || context.site.cloudId !== input.cloudId) return 0;
  const links = await liveLinks({ cloudId: input.cloudId, issueIds: [input.issueId], limit: DELIVERY_READS });
  const due = links.filter((link) => input.timestamp === null || link.lastReadAt === null || Date.parse(link.lastReadAt) < input.timestamp + DELIVERY_SEEN_MS);
  if (due.length === 0) return 0;
  try {
    const summary = await readLinks(due, { session: context.session, reader: context.provider.reader, site: siteRef(context.site), ...(options.now ? { now: options.now } : {}) });
    return summary.read + summary.failed;
  } catch (error) {
    if (needsReconnect(error)) {
      await markReconnect(context.connection, new Date((options.now ?? Date.now)()).toISOString(), reconnectWords(error));
      return 0;
    }
    throw error;
  }
}

/** Whether a delivery's issue address names this row's site, or names none that can be read (JR15). */
function sameSite(site: Pick<StoredSite, "cloudId" | "siteUrl">, self: SelfRef | null): boolean {
  if (self === null) return true;
  if ("cloudId" in self) return self.cloudId === site.cloudId;
  return self.host === siteHost(site.siteUrl);
}

/**
 * A delivery's issue read again in each workspace whose site row holds one of the webhooks it matched (JR15), current or
 * retired within its two hours, at most 20 rows, skipping a row whose site the issue's address does not name. Each row's
 * last delivery is noted first; one workspace's failure is its own.
 */
export async function rereadForDelivery(event: JiraDeliveryEvent, given?: JiraProvider | null, options: { now?: () => number } = {}): Promise<number> {
  const now = options.now ?? Date.now;
  let rows: StoredSite[];
  try {
    rows = (await sitesForWebhooks(event.webhookIds, new Date(now()).toISOString())).filter((site) => sameSite(site, event.self));
    await touchDelivery(
      rows.map((site) => site.connectionId),
      new Date(now()).toISOString()
    );
  } catch (error) {
    if (error instanceof JiraNotSetUpError) return 0;
    throw error;
  }
  let read = 0;
  for (const site of rows) {
    try {
      read += await withOrg(site.orgId, () => rereadIssueInScope({ connectionId: site.connectionId, cloudId: site.cloudId, issueId: event.issueId, timestamp: event.timestamp }, given, options));
    } catch (error) {
      if (error instanceof JiraNotSetUpError || error instanceof NotSetUpError) continue;
      console.error("jira webhook: an issue was not read again", site.connectionId, error instanceof Error ? error.name : "unknown");
    }
  }
  return read;
}
