import { db } from "../dal";
import type { BookingSample } from "./booking";
import { connectionFor, NotSetUpError, waitingCount, type PaymentAccount } from "./connections";
import { pagesRead, type SyncCursor } from "./cursors";
import { PROVIDER_LABELS, type ProviderId } from "./provider";
import { connectionStatus, type StatusView } from "./status";

/**
 * What an accounting tool's card in Settings shows (docs/superpowers/specs/2026-10-12-xero-connector-design.md X15,
 * X16, X19), read in the workspace's scope from the connection's rows: never a token, so all of it can cross into the
 * client component. Before migration 0101 has run, it says the feature is not set up yet.
 */

export type AccountingPanelView =
  | { state: "not_set_up" }
  | { state: "not_connected" }
  | {
      state: "connection";
      connectionId: string;
      status: StatusView;
      connected: boolean;
      revoked: boolean;
      organisation: string | null;
      waiting: number;
      /** Bills added that the tool says were paid, voided or deleted since. */
      closedAfterAdded: number;
      paymentAccount: PaymentAccount | null;
      /** A bill of the workspace's, to preview how a payment will be booked. */
      sample: BookingSample | null;
    };

export async function accountingPanelView(provider: ProviderId, nowMs: number = Date.now()): Promise<AccountingPanelView> {
  let connection;
  try {
    connection = await connectionFor(provider);
  } catch (error) {
    if (error instanceof NotSetUpError) return { state: "not_set_up" };
    throw error;
  }
  if (!connection) return { state: "not_connected" };
  const revoked = connection.status === "revoked";
  const [waiting, closed, cursors, latest] = await Promise.all([
    revoked ? Promise.resolve(0) : waitingCount(connection.id),
    revoked
      ? Promise.resolve(0)
      : db()
          .from("accounting_bills")
          .select("id", { count: "exact", head: true })
          .eq("connection_id", connection.id)
          .eq("review_state", "added")
          .in("source_status", ["paid", "voided", "deleted"])
          .then((result) => result.count ?? 0),
    db().from("accounting_sync_cursors").select("page").eq("connection_id", connection.id).not("page", "is", null),
    db()
      .from("accounting_bills")
      .select("contact_name, number, amount_due, currency")
      .eq("connection_id", connection.id)
      .order("changed_at", { ascending: false })
      .limit(1),
  ]);
  const bill = ((latest.data ?? []) as Array<{ contact_name: string; number: string | null; amount_due: number | string; currency: string }>)[0];
  const read = ((cursors.data ?? []) as Array<{ page: number }>).reduce((sum, row) => sum + pagesRead({ page: row.page } as SyncCursor), 0);
  return {
    state: "connection",
    connectionId: connection.id,
    status: connectionStatus(
      {
        providerLabel: PROVIDER_LABELS[provider],
        status: connection.status,
        externalOrgName: connection.externalOrgName,
        lastSyncedAt: connection.lastSyncedAt,
        lastError: connection.lastError,
        lastErrorAt: connection.lastErrorAt,
        syncing: read > 0 ? { pagesRead: read } : null,
      },
      nowMs
    ),
    connected: connection.status === "connected",
    revoked,
    organisation: connection.externalOrgName,
    waiting,
    closedAfterAdded: closed,
    paymentAccount: connection.paymentAccount,
    sample: bill ? { supplier: bill.contact_name, number: bill.number, amount: String(Number(bill.amount_due)), currency: bill.currency } : null,
  };
}
