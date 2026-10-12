import { currentOrgId } from "../context";
import { platformDb } from "../dal";
import { withOrg } from "../dal/scope";
import { isNotSetUp } from "./connections";
import type { AccountingProvider, ProviderId } from "./provider";
import { syncConnection, type SyncResult } from "./sync";
import { syncStore } from "./sync-store";
import { connectionTokenStore, deleteTokens, expiredPendingGrants, refreshTokenOf } from "./token-store";

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

/** Runs one connection's sync in the workspace already in scope, with the database's stores. */
export function syncInScope(connectionId: string, provider: AccountingProvider, options: { maxPages?: number } = {}): Promise<SyncResult> {
  return syncConnection({ connectionId, provider, db: syncStore, tokens: connectionTokenStore(currentOrgId(), connectionId), ...options });
}

export async function sweepAccounting(deps: {
  providerFor: (id: ProviderId) => AccountingProvider | null;
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
    const provider = deps.providerFor(row.provider);
    if (!provider) continue;
    summary.connections += 1;
    try {
      const result = await withOrg(row.org_id, () => syncInScope(row.connection_id, provider));
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
        const provider = deps.providerFor(grant.provider);
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
