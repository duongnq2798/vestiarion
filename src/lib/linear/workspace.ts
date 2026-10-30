import { failureDelayMs } from "../connectors/backoff";
import { connectionFor, connectionsByExternal, NotSetUpError, type Connection } from "../connectors/connections";
import { syncErrorWords } from "../connectors/status";
import { syncStore } from "../connectors/sync-store";
import { connectionTokenStore } from "../connectors/token-store";
import { ProviderError } from "../connectors/provider";
import { currentOrgId } from "../context";
import { db } from "../dal";
import { withOrg } from "../dal/scope";
import { recordUsage } from "../usage/record";
import { LinearNotSetUpError, linearReady, linksOfMilestones, liveLinks, type IssueLink } from "./links";
import { linearProviderFromEnv, type LinearProvider } from "./provider";
import { readLinks, type ReadSummary } from "./reads";
import { LinearAccessError, linearSession, type LinearSession } from "./session";

/**
 * A workspace's Linear, as every path uses it (docs/superpowers/specs/2026-10-31-linear-acceptance-design.md LN2, LN11,
 * LN12), as Asana's (`../asana/workspace`): its connection and a session on the connection's own token, and the ways a
 * linked issue is read again without a person: before the agent decides contractors, right before it sends their
 * releases, every 15 minutes from the sweeper, and after a signed webhook delivery, with Asana's budgets. All of it in
 * the workspace's own scope; a delivery, which names a Linear workspace and no Vestiarion one, enters each workspace
 * connected to it in turn.
 */

export interface LinearContext {
  connection: Connection;
  provider: LinearProvider;
  session: LinearSession;
}

export type LinearMissing = "off" | "not_set_up" | "not_connected" | "reconnect";

/** The workspace's Linear connection, ready to call, or why there is none. */
export async function linearContext(given?: LinearProvider | null): Promise<LinearContext | { missing: LinearMissing; connection?: Connection | null }> {
  const provider = given === undefined ? linearProviderFromEnv() : given;
  if (!provider) return { missing: "off" };
  let connection: Connection | null;
  try {
    connection = await connectionFor("linear");
    await linearReady();
  } catch (error) {
    if (error instanceof NotSetUpError || error instanceof LinearNotSetUpError) return { missing: "not_set_up" };
    throw error;
  }
  if (!connection || connection.status === "revoked") return { missing: "not_connected", connection };
  if (connection.status === "needs_reconnect") return { missing: "reconnect", connection };
  return { connection, provider, session: linearSession({ provider, tokens: connectionTokenStore(currentOrgId(), connection.id) }) };
}

/**
 * The workspace's Linear connection's access token, fresh, for the evidence link check (LN14); null without a
 * connection Linear takes. It is sent to Linear's API only.
 */
export async function linearAccessToken(): Promise<string | null> {
  const context = await linearContext();
  if ("missing" in context) return null;
  return context.session.call(async (token) => token);
}

/** A connection Linear no longer takes: it needs a person, and says so. Only a connected one moves. */
export async function markReconnect(connection: Pick<Connection, "id">, nowIso: string): Promise<boolean> {
  const updated = await db()
    .from("accounting_connections")
    .update({ status: "needs_reconnect", last_error: syncErrorWords("reconnect", "Linear", null), last_error_at: nowIso, next_sync_after: null })
    .eq("id", connection.id)
    .eq("status", "connected")
    .select("id");
  if (updated.error) throw new Error(updated.error.message);
  return (updated.data ?? []).length === 1;
}

/** When a connection-level failure means the person must reconnect. */
export const needsReconnect = (error: unknown) =>
  error instanceof LinearAccessError ? error.outcome.reason === "reconnect" || error.outcome.reason === "missing" : false;

/** Accepted links the agent's cycle reads before it decides contractors, at most this many (Asana's: LN12). */
export const CYCLE_READS = 20;
/** The reads a cycle makes stop starting after this long. */
export const CYCLE_BUDGET_MS = 30_000;

/**
 * Before the agent decides contractors (LN12): each accepted issue whose milestone the agent may still pay (verified,
 * or held) is read again, at most `CYCLE_READS`, so an issue reopened or changed since takes the acceptance back in this
 * same cycle, before the contractor stage reads which milestones are verified. Never throws: a failure leaves the
 * acceptance as it was, and the webhook and the sweeper read it again.
 */
export async function refreshLinearMilestones(given?: LinearProvider | null): Promise<ReadSummary & { checked: number }> {
  // Read with the workspace's connection now, whichever connection linked them: an issue the person who connected Linear
  // since cannot see is held, never left accepted unwatched. Never the paid ones, whose links stay accepted.
  return readAccepted(given, () => linksOfMilestones({ statuses: ["verified", "held"], method: "linear", states: ["accepted"], limit: CYCLE_READS }), CYCLE_BUDGET_MS, "the cycle's read");
}

/**
 * The reads made right before the contractor stage sends its releases stop starting after `SEND_BUDGET_MS`, and the
 * stage waits for them at most `SEND_DEADLINE_MS`, as Asana's.
 */
export const SEND_BUDGET_MS = 10_000;
export const SEND_DEADLINE_MS = 20_000;
const SEND_ID_CHUNK = 100;

/**
 * Right before the contractor stage sends its releases (LN10, LN12), the accepted issues of exactly those milestones are
 * read once more, so an issue reopened or changed while the stage decided takes its acceptance back here, which the
 * stage's still-verified check then holds to. Never throws, and never waits past the deadline: a read that fails or is
 * not done by then leaves the acceptance as it was, and `complete` is false.
 */
export async function recheckLinearBeforeSending(
  milestoneIds: readonly string[],
  given?: LinearProvider | null,
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

/** Reads accepted links with the workspace's connection, within a budget; never throws. */
async function readAccepted(given: LinearProvider | null | undefined, find: () => Promise<IssueLink[]>, budgetMs: number, what: string): Promise<ReadSummary & { checked: number }> {
  const none = { checked: 0, read: 0, failed: 0, ready: 0, withdrawn: 0, deferred: 0 };
  try {
    const context = await linearContext(given);
    if ("missing" in context) return none;
    const links = await find();
    if (links.length === 0) return none;
    try {
      const summary = await readLinks(links, { session: context.session, reader: context.provider.reader, budgetMs });
      return { ...summary, checked: links.length };
    } catch (error) {
      if (needsReconnect(error)) await markReconnect(context.connection, new Date().toISOString());
      return { ...none, checked: links.length, failed: links.length };
    }
  } catch (error) {
    if (error instanceof LinearNotSetUpError || error instanceof NotSetUpError) return none;
    console.error(`linear: ${what} failed`, error instanceof Error ? error.message : "unknown error");
    return none;
  }
}

/** The links one sweep reads per connection, and how long it may take. */
export const SWEEP_READS = 100;
export const SWEEP_LINK_BUDGET_MS = 60_000;
const SYNC_LEASE_MS = 5 * 60_000;

export type LinearSyncOutcome = "synced" | "busy" | "reconnect" | "failed" | "rate_limited" | "unavailable";

/**
 * The sweeper's run for a Linear connection (LN12), every 15 minutes, under the connection's sync lease: every live link
 * whose milestone is still open is read again, the webhook's fallback. A connection Linear no longer takes is marked to
 * reconnect; any other failure waits (1, 2, 4 minutes and so on up to an hour).
 */
export async function syncLinearConnection(connectionId: string, provider: LinearProvider, options: { now?: () => number } = {}): Promise<{ outcome: LinearSyncOutcome; summary?: ReadSummary }> {
  const now = options.now ?? Date.now;
  const iso = (ms: number) => new Date(ms).toISOString();
  const connection = await syncStore.claim(connectionId, iso(now()), iso(now() + SYNC_LEASE_MS));
  if (!connection) return { outcome: "busy" };
  const fail = async (kind: "rate_limited" | "unavailable" | "bad_response" | "failed", retryAfterMs: number | null): Promise<{ outcome: LinearSyncOutcome }> => {
    const failures = connection.failures + 1;
    const next = iso(now() + (retryAfterMs ?? failureDelayMs(failures)));
    await syncStore.finish(connection.id, { kind: "failed", at: iso(now()), failures, nextSyncAfter: next, error: syncErrorWords(kind, "Linear", next, now()) });
    return { outcome: kind === "rate_limited" ? "rate_limited" : kind === "failed" ? "failed" : "unavailable" };
  };
  try {
    // One Linear connection per workspace: every live link is read with it, whichever connection linked it. Only those of
    // milestones still open, verified ones first: a paid or closed milestone's link stays live, as its history.
    const toRead = await linksOfMilestones({ statuses: ["verified", "held", "pending"], limit: SWEEP_READS });
    const session = linearSession({ provider, tokens: connectionTokenStore(currentOrgId(), connectionId), now });
    const summary = await readLinks(toRead, { session, reader: provider.reader, now, budgetMs: SWEEP_LINK_BUDGET_MS });
    await syncStore.finish(connection.id, { kind: "synced", at: iso(now()) });
    if (toRead.length > 0) await recordUsage({ kind: "connector_sync", action: "linear", provider: "linear", ok: summary.failed === 0 });
    return { outcome: "synced", summary };
  } catch (error) {
    if (error instanceof LinearAccessError) {
      if (needsReconnect(error)) {
        await syncStore.finish(connection.id, { kind: "reconnect", at: iso(now()), error: syncErrorWords("reconnect", "Linear", null) });
        return { outcome: "reconnect" };
      }
      if (error.outcome.reason === "busy") {
        await syncStore.finish(connection.id, { kind: "released", at: iso(now()) });
        return { outcome: "busy" };
      }
      return fail("unavailable", error.outcome.reason === "unavailable" ? error.outcome.retryAfterMs : null);
    }
    if (error instanceof ProviderError) return fail(error.failure === "rate_limited" ? "rate_limited" : error.failure === "bad_response" ? "bad_response" : "unavailable", error.retryAfterMs);
    console.error("linear: a sweep of a connection failed", connectionId, error instanceof Error ? error.message : "unknown error");
    return fail("failed", null);
  }
}

/** The most links one delivery reads in one workspace: one issue has one live link there (0147). */
const DELIVERY_READS = 5;

/**
 * After a signed webhook delivery (LN11), in a workspace's scope already entered: the live links of the one issue the
 * delivery named are read again with the workspace's connection, when that connection is the one to the delivery's
 * Linear workspace. Nothing in the delivery is used but which issue to read. Answers how many links were read.
 */
export async function rereadIssueInScope(input: { connectionId: string; issueId: string }, given?: LinearProvider | null): Promise<number> {
  const context = await linearContext(given);
  if ("missing" in context || context.connection.id !== input.connectionId) return 0;
  const links = await liveLinks({ issueIds: [input.issueId], limit: DELIVERY_READS });
  if (links.length === 0) return 0;
  try {
    const summary = await readLinks(links, { session: context.session, reader: context.provider.reader });
    return summary.read + summary.failed;
  } catch (error) {
    if (needsReconnect(error)) {
      await markReconnect(context.connection, new Date().toISOString());
      return 0;
    }
    throw error;
  }
}

/**
 * Every Vestiarion workspace connected to this Linear workspace, by its connection (LN2: one Linear workspace may be
 * connected to several): the connector core's lookup across workspaces, which answers ids and a status, nothing else.
 */
async function connectedTo(organizationId: string): Promise<Array<{ orgId: string; connectionId: string; status: string }>> {
  return (await connectionsByExternal("linear", [organizationId])).map((match) => ({ orgId: match.orgId, connectionId: match.connectionId, status: match.status }));
}

/** A delivery's issue read again in each workspace connected to its Linear workspace; one workspace's failure is its own. */
export async function rereadForDelivery(event: { organizationId: string; issueId: string }, given?: LinearProvider | null): Promise<number> {
  let read = 0;
  for (const match of await connectedTo(event.organizationId)) {
    if (match.status !== "connected") continue;
    try {
      read += await withOrg(match.orgId, () => rereadIssueInScope({ connectionId: match.connectionId, issueId: event.issueId }, given));
    } catch (error) {
      if (error instanceof LinearNotSetUpError || error instanceof NotSetUpError) continue;
      console.error("linear webhook: an issue was not read again", match.connectionId, error instanceof Error ? error.name : "unknown");
    }
  }
  return read;
}

/**
 * Linear says the app was revoked in a Linear workspace (an `OAuthApp` revoked delivery, LN11): each connection to it
 * needs a person to reconnect. Nothing is revoked here, and no token is used: Linear ended them already.
 */
export async function markRevokedAtLinear(organizationId: string, nowIso: string = new Date().toISOString()): Promise<number> {
  let marked = 0;
  for (const match of await connectedTo(organizationId)) {
    if (match.status !== "connected") continue;
    try {
      if (await withOrg(match.orgId, () => markReconnect({ id: match.connectionId }, nowIso))) marked += 1;
    } catch (error) {
      console.error("linear webhook: a connection was not marked to reconnect", match.connectionId, error instanceof Error ? error.name : "unknown");
    }
  }
  return marked;
}
