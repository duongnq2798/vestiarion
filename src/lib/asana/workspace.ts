import { siteOrigin } from "../auth/env";
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
import { AsanaNotSetUpError, asanaReady, linkById, liveLinks, milestonesForAcceptance, type TaskLink } from "./links";
import { asanaProviderFromEnv, type AsanaProvider } from "./provider";
import { readLinks, type ReadSummary } from "./reads";
import { AsanaAccessError, asanaSession, type AsanaSession } from "./session";
import { activateWebhook, liveWebhooks, markWebhookDeleted, newWebhook, webhookSecret, type StoredWebhook } from "./webhook-store";

/**
 * A workspace's Asana, as every path uses it (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md A2, A11):
 * its connection and a session on the connection's own token; the webhooks made on linked tasks; and the three ways a
 * linked task is read again without a person: before the agent decides contractors, every 15 minutes from the sweeper,
 * and after a signed webhook delivery. All of it in the workspace's own scope.
 */

export interface AsanaContext {
  connection: Connection;
  provider: AsanaProvider;
  session: AsanaSession;
}

export type AsanaMissing = "off" | "not_set_up" | "not_connected" | "reconnect";

/** The workspace's Asana connection, ready to call, or why there is none. */
export async function asanaContext(given?: AsanaProvider | null): Promise<AsanaContext | { missing: AsanaMissing; connection?: Connection | null }> {
  const provider = given === undefined ? asanaProviderFromEnv() : given;
  if (!provider) return { missing: "off" };
  let connection: Connection | null;
  try {
    connection = await connectionFor("asana");
    await asanaReady();
  } catch (error) {
    if (error instanceof NotSetUpError || error instanceof AsanaNotSetUpError) return { missing: "not_set_up" };
    throw error;
  }
  if (!connection || connection.status === "revoked") return { missing: "not_connected", connection };
  if (connection.status === "needs_reconnect") return { missing: "reconnect", connection };
  return { connection, provider, session: asanaSession({ provider, tokens: connectionTokenStore(currentOrgId(), connection.id) }) };
}

/**
 * The workspace's Asana connection's access token, fresh, for the evidence link check (A13); null without a connection
 * Asana takes. It is sent to Asana's API only.
 */
export async function asanaAccessToken(): Promise<string | null> {
  const context = await asanaContext();
  if ("missing" in context) return null;
  return context.session.call(async (token) => token);
}

/** A connection Asana no longer takes: it needs a person, and says so. Only a connected one moves. */
export async function markReconnect(connection: Connection, nowIso: string): Promise<void> {
  const updated = await db()
    .from("accounting_connections")
    .update({ status: "needs_reconnect", last_error: syncErrorWords("reconnect", "Asana", null), last_error_at: nowIso, next_sync_after: null })
    .eq("id", connection.id)
    .eq("status", "connected")
    .select("id");
  if (updated.error) throw new Error(updated.error.message);
}

/** When a connection-level failure means the person must reconnect. */
export const needsReconnect = (error: unknown) =>
  error instanceof AsanaAccessError ? error.outcome.reason === "reconnect" || error.outcome.reason === "missing" : false;

/**
 * Makes the webhook for a linked task (A11): a row first, so the handshake finds it, then Asana is asked, then the
 * secret in Asana's answer is held to the one the handshake kept. Best effort: a link works without one, read again by
 * the agent's cycle and the sweeper. Never on an address that is not https, as on a laptop.
 */
export async function startWebhook(link: TaskLink, ctx: AsanaContext, origin: string = siteOrigin()): Promise<boolean> {
  if (!origin.startsWith("https://")) return false;
  const orgId = currentOrgId();
  const nowIso = () => new Date().toISOString();
  const id = await newWebhook({ orgId, connectionId: ctx.connection.id, linkId: link.id, resourceGid: link.taskGid });
  let made: { gid: string; secret: string | null };
  try {
    made = await ctx.session.call((token) => ctx.provider.reader.createWebhook(token, { resource: link.taskGid, target: `${origin}/api/integrations/asana/webhook/${id}` }));
  } catch (error) {
    await markWebhookDeleted(orgId, id, nowIso());
    console.error("asana: the webhook was not made", link.id, error instanceof Error ? error.message : "unknown error");
    return false;
  }
  const kept = await webhookSecret(orgId, id);
  // The secret Asana answered with must be the one its handshake sent here; anything else is not Asana's handshake.
  if (!kept || (made.secret !== null && made.secret !== kept) || !(await activateWebhook(orgId, id, made.gid))) {
    console.error("asana: a webhook's handshake did not match, so it is deleted", link.id);
    await ctx.session.call((token) => ctx.provider.reader.deleteWebhook(token, made.gid)).catch(() => false);
    await markWebhookDeleted(orgId, id, nowIso());
    return false;
  }
  return true;
}

/** Deletes the webhooks of a link or of the whole connection, at Asana (best effort) and here. */
export async function stopWebhooks(ctx: { provider: AsanaProvider | null; session: AsanaSession | null }, where: { linkId: string } | { connectionId: string }): Promise<number> {
  const orgId = currentOrgId();
  const hooks = await liveWebhooks(orgId, where);
  for (const hook of hooks) {
    const { provider, session } = ctx;
    if (hook.webhookGid && session && provider) {
      const gid = hook.webhookGid;
      await session.call((token) => provider.reader.deleteWebhook(token, gid)).catch((error: unknown) => {
        console.error("asana: a webhook was not deleted at Asana", hook.id, error instanceof Error ? error.message : "unknown error");
        return false;
      });
    }
    // Marked deleted either way: its address answers 410 from now, and Asana deletes a webhook that answers 410.
    await markWebhookDeleted(orgId, hook.id, new Date().toISOString());
  }
  return hooks.length;
}

/** Accepted links the agent's cycle reads before it decides contractors, at most this many. */
export const CYCLE_READS = 20;
/** The reads a cycle makes stop starting after this long. */
export const CYCLE_BUDGET_MS = 30_000;

/**
 * Before the agent decides contractors (A11), as GitHub's pull requests are read: each accepted task whose milestone is
 * not paid is read again, so a task reopened or changed since takes the acceptance back in this same cycle, before the
 * contractor stage reads which milestones are verified. Never throws: a failure leaves the acceptance as it was, and the
 * webhook and the sweeper read it again.
 */
export async function refreshAsanaMilestones(given?: AsanaProvider | null): Promise<ReadSummary & { checked: number }> {
  const none = { checked: 0, read: 0, failed: 0, ready: 0, withdrawn: 0, deferred: 0 };
  try {
    const context = await asanaContext(given);
    if ("missing" in context) return none;
    // Read with the workspace's connection now, whichever connection linked them: a task the person who connected Asana
    // since cannot see is held, never left accepted unwatched.
    const links = await liveLinks({ states: ["accepted"], limit: CYCLE_READS });
    if (links.length === 0) return none;
    try {
      const summary = await readLinks(links, { session: context.session, reader: context.provider.reader, budgetMs: CYCLE_BUDGET_MS });
      return { ...summary, checked: links.length };
    } catch (error) {
      if (needsReconnect(error)) await markReconnect(context.connection, new Date().toISOString());
      return { ...none, checked: links.length, failed: links.length };
    }
  } catch (error) {
    if (error instanceof AsanaNotSetUpError || error instanceof NotSetUpError) return none;
    console.error("asana: the cycle's read failed", error instanceof Error ? error.message : "unknown error");
    return none;
  }
}

/** The links one sweep reads per connection, and how long it may take. */
export const SWEEP_READS = 100;
export const SWEEP_LINK_BUDGET_MS = 60_000;
const SYNC_LEASE_MS = 5 * 60_000;

export type AsanaSyncOutcome = "synced" | "busy" | "reconnect" | "failed" | "rate_limited" | "unavailable";

/**
 * The sweeper's run for an Asana connection (A11), every 15 minutes, under the connection's sync lease: every live
 * link whose milestone is still open is read again, the webhooks' fallback. A connection Asana no longer takes is
 * marked to reconnect; any other failure waits (1, 2, 4 minutes and so on up to an hour).
 */
export async function syncAsanaConnection(connectionId: string, provider: AsanaProvider, options: { now?: () => number } = {}): Promise<{ outcome: AsanaSyncOutcome; summary?: ReadSummary }> {
  const now = options.now ?? Date.now;
  const iso = (ms: number) => new Date(ms).toISOString();
  const connection = await syncStore.claim(connectionId, iso(now()), iso(now() + SYNC_LEASE_MS));
  if (!connection) return { outcome: "busy" };
  const fail = async (kind: "rate_limited" | "unavailable" | "bad_response" | "failed", retryAfterMs: number | null): Promise<{ outcome: AsanaSyncOutcome }> => {
    const failures = connection.failures + 1;
    const next = iso(now() + (retryAfterMs ?? failureDelayMs(failures)));
    await syncStore.finish(connection.id, { kind: "failed", at: iso(now()), failures, nextSyncAfter: next, error: syncErrorWords(kind, "Asana", next, now()) });
    return { outcome: kind === "rate_limited" ? "rate_limited" : kind === "failed" ? "failed" : "unavailable" };
  };
  try {
    // One Asana connection per workspace: every live link is read with it, whichever connection linked it.
    const links = await liveLinks({ limit: SWEEP_READS });
    const open = await milestonesForAcceptance([...new Set(links.map((link) => link.milestoneId))]);
    const toRead = links.filter((link) => {
      const status = open.get(link.milestoneId)?.status;
      return status !== undefined && status !== "paid" && status !== "closed";
    });
    const session = asanaSession({ provider, tokens: connectionTokenStore(currentOrgId(), connectionId), now });
    const summary = await readLinks(toRead, { session, reader: provider.reader, now, budgetMs: SWEEP_LINK_BUDGET_MS });
    await syncStore.finish(connection.id, { kind: "synced", at: iso(now()) });
    if (toRead.length > 0) await recordUsage({ kind: "connector_sync", action: "asana", provider: "asana", ok: summary.failed === 0 });
    return { outcome: "synced", summary };
  } catch (error) {
    if (error instanceof AsanaAccessError) {
      if (needsReconnect(error)) {
        await syncStore.finish(connection.id, { kind: "reconnect", at: iso(now()), error: syncErrorWords("reconnect", "Asana", null) });
        return { outcome: "reconnect" };
      }
      if (error.outcome.reason === "busy") {
        await syncStore.finish(connection.id, { kind: "released", at: iso(now()) });
        return { outcome: "busy" };
      }
      return fail("unavailable", error.outcome.reason === "unavailable" ? error.outcome.retryAfterMs : null);
    }
    if (error instanceof ProviderError) return fail(error.failure === "rate_limited" ? "rate_limited" : error.failure === "bad_response" ? "bad_response" : "unavailable", error.retryAfterMs);
    console.error("asana: a sweep of a connection failed", connectionId, error instanceof Error ? error.message : "unknown error");
    return fail("failed", null);
  }
}

/**
 * After a signed webhook delivery (A11, A12): the webhook's task is read again in its workspace's scope. A webhook whose
 * link was unlinked, or whose milestone was paid or closed, is deleted instead: nothing more is read for it.
 */
export async function rereadForWebhook(webhook: StoredWebhook, given?: AsanaProvider | null): Promise<void> {
  await withOrg(webhook.orgId, () => rereadInScope(webhook, given));
}

/** `rereadForWebhook`, in the webhook's workspace's scope already entered. */
export async function rereadInScope(webhook: StoredWebhook, given?: AsanaProvider | null): Promise<void> {
  if (currentOrgId() !== webhook.orgId) throw new Error("A webhook's task is read only in its own workspace's scope");
  const context = await asanaContext(given);
  if ("missing" in context) return;
  const link = await linkById(webhook.linkId);
  const milestone = link ? (await milestonesForAcceptance([link.milestoneId])).get(link.milestoneId) : undefined;
  if (!link || !milestone || milestone.status === "paid" || milestone.status === "closed") {
    await stopWebhooks(context, { linkId: webhook.linkId });
    return;
  }
  try {
    await readLinks([link], { session: context.session, reader: context.provider.reader });
  } catch (error) {
    if (needsReconnect(error)) await markReconnect(context.connection, new Date().toISOString());
    else throw error;
  }
}
