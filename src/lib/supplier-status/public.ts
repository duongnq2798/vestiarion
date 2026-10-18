import { z } from "zod";
import { db, platformDb, unwrap } from "../dal";
import { withOrg } from "../dal/scope";
import { networkOf, type Network } from "../network";
import { homeChain } from "../payee-chains";
import { buildSupplierStatus, OPEN_PAYABLE_STATUSES, RECENT_PAID_DAYS, RECENT_PAID_MAX, type SupplierBillIn, type SupplierStatusView } from "./model";
import { supplierStatusTokenHash } from "./token";

/**
 * What a supplier's payment status link reads (docs/superpowers/specs/2026-10-18-supplier-status-design.md V2-V4). No
 * session and no wallet: the link is the credential, and it reaches one supplier's own bills and nothing else of the
 * workspace. A malformed link is never looked up; a well-formed one is looked up by the SHA-256 of its secret through the
 * service role's `supplier_status_by_token` (0131), which answers null for a stopped or unknown link and only the day for
 * an expired one. A live link's bills are then read inside that workspace's own scope, filtered to the link's supplier
 * and to payables: the open ones, the ones paid recently, and their payments' transactions. Read only: nothing here
 * writes, signs or tells anyone. The workspace's and the supplier's ids go no further than this file.
 */

const foundSchema = z.union([
  z.object({ expired: z.literal(true), expiresAt: z.string() }),
  z.object({
    expired: z.literal(false),
    linkId: z.string().uuid(),
    orgId: z.string().uuid(),
    counterpartyId: z.string().uuid(),
    expiresAt: z.string(),
    orgName: z.string(),
    supplierName: z.string(),
    mode: z.string(),
    network: z.string().nullable(),
  }),
]);

type Found = z.infer<typeof foundSchema>;
type LiveLink = Extract<Found, { expired: false }>;

/** PostgREST's "no such function" (PGRST202) or Postgres's (42883): migration 0131 has not run here yet. */
const missingFunction = (error: { code?: string }) => error.code === "PGRST202" || error.code === "42883";

async function lookUp(tokenHash: string): Promise<Found | null> {
  const answer = await platformDb().rpc("supplier_status_by_token", { p_token_hash: tokenHash });
  if (answer.error) {
    if (missingFunction(answer.error)) return null;
    throw new Error(answer.error.message);
  }
  if (answer.data === null || answer.data === undefined) return null;
  return foundSchema.parse(answer.data);
}

export type SupplierStatusRead =
  | { state: "dead" }
  | { state: "expired"; expiresAt: string }
  | { state: "live"; view: SupplierStatusView; network: Network; sandbox: boolean };

type InvoiceRow = {
  id: string;
  amount: string | number;
  currency: string | null;
  due_date: string;
  memo: string | null;
  po_reference: string | null;
  status: string;
  scheduled_for: string | null;
  settled_at: string | null;
};

type IntentRow = { source_id: string; status: string; tx_hash: string | null; created_at: string };

/** The most of one supplier's open bills a page reads. */
const BILLS_READ = 500;
const BILL_COLUMNS = "id, amount, currency, due_date, memo, po_reference, status, scheduled_for, settled_at";
/** A payment started and not yet settled either way (0004's statuses). */
const IN_FLIGHT = new Set(["created", "submitting", "pending"]);

/** The page behind a link: dead, expired (with its day), or the supplier's own bills. */
export async function readSupplierStatus(token: string, now: number = Date.now()): Promise<SupplierStatusRead> {
  const tokenHash = supplierStatusTokenHash(token);
  if (!tokenHash) return { state: "dead" };
  const found = await lookUp(tokenHash);
  if (!found) return { state: "dead" };
  if (found.expired) return { state: "expired", expiresAt: found.expiresAt };
  const link: LiveLink = found;
  const network = networkOf(link.network);

  return withOrg(link.orgId, async () => {
    const since = new Date(now - RECENT_PAID_DAYS * 86_400_000).toISOString();
    // The open bills, and apart the ones paid recently, so a long history never hides an open one.
    const [openRows, paidRows] = await Promise.all([
      db()
        .from("invoices")
        .select(BILL_COLUMNS)
        .eq("counterparty_id", link.counterpartyId)
        .eq("direction", "payable")
        .in("status", [...OPEN_PAYABLE_STATUSES])
        .order("due_date", { ascending: true })
        .limit(BILLS_READ),
      db()
        .from("invoices")
        .select(BILL_COLUMNS)
        .eq("counterparty_id", link.counterpartyId)
        .eq("direction", "payable")
        .eq("status", "paid")
        .gte("settled_at", since)
        .order("settled_at", { ascending: false })
        .limit(RECENT_PAID_MAX),
    ]);
    const bills = [...new Map([...(unwrap(openRows) as InvoiceRow[]), ...(unwrap(paidRows) as InvoiceRow[])].map((row) => [row.id, row])).values()];

    // Each bill's payments: a confirmed one's transaction, and whether one is on its way.
    const intents = new Map<string, { txHash: string | null; inFlight: boolean }>();
    if (bills.length > 0) {
      const read = await db()
        .from("payment_intents")
        .select("source_id, status, tx_hash, created_at")
        .eq("source_type", "invoice")
        .in(
          "source_id",
          bills.map((bill) => bill.id)
        )
        .order("created_at", { ascending: true });
      if (read.error) console.error("supplier status: payments not read", read.error.message);
      for (const row of (read.data ?? []) as IntentRow[]) {
        const entry = intents.get(row.source_id) ?? { txHash: null, inFlight: false };
        if (row.status === "confirmed" && row.tx_hash) entry.txHash = row.tx_hash;
        if (IN_FLIGHT.has(row.status)) entry.inFlight = true;
        intents.set(row.source_id, entry);
      }
    }

    const input: SupplierBillIn[] = bills.map((bill) => ({
      id: bill.id,
      amount: Number(bill.amount),
      currency: bill.currency ?? "USDC",
      dueDate: bill.due_date,
      memo: bill.memo,
      poReference: bill.po_reference,
      status: bill.status,
      scheduledFor: bill.scheduled_for,
      settledAt: bill.settled_at,
      txHash: intents.get(bill.id)?.txHash ?? null,
      inFlight: intents.get(bill.id)?.inFlight ?? false,
    }));
    const view = buildSupplierStatus({
      orgName: link.orgName,
      supplierName: link.supplierName,
      expiresAt: link.expiresAt,
      now,
      bills: input,
      explorerTx: homeChain(network).explorerTx,
    });
    return { state: "live" as const, view, network, sandbox: link.mode !== "live" };
  });
}
