import { currentOrgId } from "../context";
import { platformDb } from "../dal";
import { withOrg } from "../dal/scope";
import { bookingInScope } from "./booking-sync";
import { isNotSetUp, NotSetUpError } from "./connections";
import type { CrmProvider } from "./crm";
import type { AccountingProvider, ConnectingProvider, ProviderId } from "./provider";
import { syncConnection, type SyncResult } from "./sync";
import { syncStore } from "./sync-store";
import { connectionTokenStore, deleteTokens, expiredPendingGrants, refreshTokenOf } from "./token-store";
import { recordUsage } from "../usage/record";

/**
 * Syncing without a person (docs/superpowers/specs/2026-10-12-xero-connector-design.md X4, X7): every 15 minutes from
 * Supabase Cron, `POST /api/platform/accounting-sync` runs each connection due, in its own workspace's scope, one
 * after another until its time is spent; then revokes and deletes the grants nobody finished choosing for. One
 * workspace's failure is its own. Before migration 0101 has run, it has nothing to do.
 */

export interface SweepSummary {
  setUp: boolean;
  connections: number;
  synced: number;
  partial: number;
  /** Stopped by a rate limit, an outage or an error: tried again later. */
  failed: number;
  reconnect: number;
  busy: number;
  pendingRevoked: number;
}

/** A sweep stops starting syncs after this long; the route may run 300 seconds. */
export const SWEEP_BUDGET_MS = 240_000;

/**
 * Runs one connection's sync in the workspace already in scope, with the database's stores; then its bookings
 * (docs/superpowers/specs/2026-10-12-accounting-writeback-design.md W3): the payments confirmed on Arc since are drafted
 * for review, and those sent are read back. Best effort: a booking step that fails never fails the sync, and before
 * migration 0106 it has nothing to do.
 */
export async function syncInScope(connectionId: string, provider: AccountingProvider, options: { maxPages?: number } = {}): Promise<SyncResult> {
  const result = await syncConnection({ connectionId, provider, db: syncStore, tokens: connectionTokenStore(currentOrgId(), connectionId), ...options });
  // A sync that ran is metered in the workspace, worked or not (accountant console U1); one already running elsewhere did not run.
  if (result.outcome !== "busy") await recordUsage({ kind: "connector_sync", action: provider.id, provider: provider.id, ok: result.outcome === "synced" || result.outcome === "partial" });
  if (provider.booking && result.outcome !== "reconnect" && result.outcome !== "busy") {
    try {
      await bookingInScope(connectionId, provider);
    } catch (error) {
      if (!(error instanceof NotSetUpError)) console.error("accounting: the bookings step failed", connectionId, error instanceof Error ? error.message : "unknown error");
    }
  }
  return result;
}

export async function sweepAccounting<P extends ConnectingProvider = ConnectingProvider>(deps: {
  providerFor: (id: ProviderId) => AccountingProvider | null;
  /**
   * A CRM's provider, and its runner, for a connection of one (HubSpot connector H7): the sweeper syncs it with the CRM
   * runner instead. A deployment without one leaves CRM connections alone.
   */
  crm?: { providerFor: (id: ProviderId) => CrmProvider | null; sync: (connectionId: string, provider: CrmProvider) => Promise<{ outcome: SyncResult["outcome"] }> };
  /**
   * A work tool's provider, and its runner (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md A11): Asana's
   * tasks and Linear's issues linked to milestones are read again, the webhooks' fallback (Linear acceptance LN12). A
   * deployment without one leaves them alone.
   */
  work?: { providerFor: (id: ProviderId) => P | null; sync: (connectionId: string, provider: P) => Promise<{ outcome: string }> };
  now?: () => number;
  budgetMs?: number;
}): Promise<SweepSummary> {
  const now = deps.now ?? Date.now;
  const started = now();
  const summary: SweepSummary = { setUp: true, connections: 0, synced: 0, partial: 0, failed: 0, reconnect: 0, busy: 0, pendingRevoked: 0 };
  const due = await platformDb().rpc("accounting_connections_due", { p_limit: 50 });
  if (due.error) {
    if (isNotSetUp(due.error)) return { ...summary, setUp: false };
    throw new Error(due.error.message);
  }
  for (const row of (due.data ?? []) as Array<{ org_id: string; connection_id: string; provider: ProviderId }>) {
    if (now() - started > (deps.budgetMs ?? SWEEP_BUDGET_MS)) break;
    const crmProvider = deps.crm?.providerFor(row.provider) ?? null;
    const workProvider = crmProvider ? null : (deps.work?.providerFor(row.provider) ?? null);
    const provider = crmProvider || workProvider ? null : deps.providerFor(row.provider);
    if (!provider && !crmProvider && !workProvider) continue;
    summary.connections += 1;
    try {
      const result = await withOrg(row.org_id, () =>
        crmProvider && deps.crm
          ? deps.crm.sync(row.connection_id, crmProvider)
          : workProvider && deps.work
            ? deps.work.sync(row.connection_id, workProvider)
            : syncInScope(row.connection_id, provider as AccountingProvider)
      );
      if (result.outcome === "synced") summary.synced += 1;
      else if (result.outcome === "partial") summary.partial += 1;
      else if (result.outcome === "reconnect") summary.reconnect += 1;
      else if (result.outcome === "busy") summary.busy += 1;
      else summary.failed += 1;
    } catch (error) {
      summary.failed += 1;
      console.error("accounting sweep: a connection failed", row.connection_id, error instanceof Error ? error.message : "unknown error");
    }
  }
  for (const grant of await expiredPendingGrants(now())) {
    try {
      await withOrg(grant.orgId, async () => {
        const refreshToken = await refreshTokenOf(grant.orgId, { tokenId: grant.tokenId });
        const provider = deps.providerFor(grant.provider) ?? deps.crm?.providerFor(grant.provider) ?? deps.work?.providerFor(grant.provider) ?? null;
        if (refreshToken && provider) await provider.revoke(refreshToken);
        await deleteTokens(grant.orgId, { tokenId: grant.tokenId });
      });
      summary.pendingRevoked += 1;
    } catch (error) {
      console.error("accounting sweep: a pending grant was not cleared", grant.tokenId, error instanceof Error ? error.message : "unknown error");
    }
  }
  return summary;
}
