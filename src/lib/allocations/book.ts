import { sumUsdcAmounts } from "../agent/obligations";
import { unwrap, type OrgDb } from "../dal";
import { allocationErrorFromDb, fromMicros, liveRows, toMicros, type AllocationBasis, type AllocationKind, type AllocationRow, type Coin, type PaymentIn, type ReceivableIn } from "./model";

/**
 * Reading what was applied (docs/superpowers/specs/2026-10-12-allocations-design.md L11): the rows of
 * `receivable_allocations` (0103) and the incoming payments on Arc they apply, in the organization in scope. Before
 * migration 0103 runs, a read says so (`available: false`, or null) rather than fail the page, the cycle or a reminder.
 */

export const ALLOCATION_COLUMNS = "id, kind, invoice_id, transfer_id, amount, currency, reverses, reason, basis, payment_seq, created_by, created_at";
export const PAYMENT_COLUMNS = "id, circle_tx_id, tx_hash, from_address, amount, token, received_at, invoice_id";

/** How many rows a page reads: a small business's year of applications many times over. */
export const ROWS_READ = 5000;
/** How many payments a page reads, newest first. */
export const PAYMENTS_READ = 500;

export interface AllocationDbRow {
  id: string;
  kind: AllocationKind;
  invoice_id: string;
  transfer_id: string | null;
  amount: string | number;
  currency: Coin;
  reverses: string | null;
  reason: string | null;
  basis: AllocationBasis | null;
  payment_seq: number | null;
  created_by: string | null;
  created_at: string;
}

export interface PaymentDbRow {
  id: string;
  circle_tx_id: string;
  tx_hash: string | null;
  from_address: string | null;
  amount: string | number;
  token: Coin;
  received_at: string;
  invoice_id: string | null;
}

export function toAllocationRow(row: AllocationDbRow): AllocationRow {
  return {
    id: row.id,
    kind: row.kind,
    invoiceId: row.invoice_id,
    transferId: row.transfer_id,
    amount: toMicros(row.amount),
    currency: row.currency,
    reverses: row.reverses,
    reason: row.reason,
    basis: row.basis,
    paymentSeq: row.payment_seq,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export function toPaymentIn(row: PaymentDbRow): PaymentIn {
  return {
    id: row.id,
    circleTxId: row.circle_tx_id,
    txHash: row.tx_hash,
    from: row.from_address,
    amount: toMicros(row.amount),
    currency: row.token,
    receivedAt: row.received_at,
    wholeMatch: row.invoice_id,
    reference: null,
  };
}

/** A receivable as the invoices list or a direct read has it. */
export function toReceivableIn(invoice: {
  id: string;
  counterparty_id: string;
  counterparty_name?: string | null;
  counterparties?: { name: string } | null;
  amount: number | string;
  currency?: string | null;
  status: string;
  due_date: string;
  created_at?: string | null;
  memo: string | null;
  po_reference: string | null;
}): ReceivableIn {
  return {
    id: invoice.id,
    counterpartyId: invoice.counterparty_id,
    customer: invoice.counterparty_name ?? invoice.counterparties?.name ?? "the customer",
    amount: toMicros(invoice.amount),
    currency: invoice.currency === "EURC" ? "EURC" : "USDC",
    status: invoice.status,
    dueDate: invoice.due_date,
    createdAt: invoice.created_at ?? invoice.due_date,
    memo: invoice.memo,
    poReference: invoice.po_reference,
  };
}

export const RECEIVABLE_COLUMNS = "id, counterparty_id, amount, currency, status, due_date, created_at, memo, po_reference, direction, counterparties(name)";

/**
 * The rows about some receivables or payments, or every row (to `ROWS_READ`); null before migration 0103 runs. A
 * failure of another kind throws.
 */
export async function readAllocationRows(orgDb: OrgDb, filter: { invoiceIds?: readonly string[]; transferIds?: readonly string[] } | "all"): Promise<AllocationRow[] | null> {
  const reads =
    filter === "all"
      ? [orgDb.from("receivable_allocations").select(ALLOCATION_COLUMNS).order("created_at", { ascending: true }).limit(ROWS_READ)]
      : [
          ...(filter.invoiceIds && filter.invoiceIds.length > 0 ? [orgDb.from("receivable_allocations").select(ALLOCATION_COLUMNS).in("invoice_id", [...filter.invoiceIds])] : []),
          ...(filter.transferIds && filter.transferIds.length > 0 ? [orgDb.from("receivable_allocations").select(ALLOCATION_COLUMNS).in("transfer_id", [...filter.transferIds])] : []),
        ];
  const byId = new Map<string, AllocationRow>();
  for (const result of await Promise.all(reads)) {
    if (result.error) {
      if (allocationErrorFromDb(result.error)?.code === "not_ready") return null;
      throw new Error(result.error.message);
    }
    for (const row of (result.data ?? []) as AllocationDbRow[]) byId.set(row.id, toAllocationRow(row));
  }
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export interface AllocationBook {
  /** False before migration 0103 runs: nothing can be applied yet. */
  available: boolean;
  rows: AllocationRow[];
  /** Incoming payments on Arc, newest first: the latest `PAYMENTS_READ`, and any older one a row names. */
  payments: PaymentIn[];
  /** Who sent test USDC from Vestiarion's float, lowercased: money in owed by no customer (test USDC T6). */
  floatSenders: ReadonlySet<string>;
}

/** Everything Bills & receivables shows about payments applied, in the organization in scope. */
export async function readAllocationBook(orgDb: OrgDb): Promise<AllocationBook> {
  const [rows, recent, grants] = await Promise.all([
    readAllocationRows(orgDb, "all"),
    orgDb.from("incoming_transfers").select(PAYMENT_COLUMNS).order("received_at", { ascending: false }).limit(PAYMENTS_READ),
    orgDb.from("ledger_entries").select("detail").eq("action", "test_usdc_added"),
  ]);
  const payments = (unwrap(recent) as PaymentDbRow[]).map(toPaymentIn);
  const known = new Set(payments.map((payment) => payment.id));
  const older = [...new Set((rows ?? []).flatMap((row) => (row.transferId && !known.has(row.transferId) ? [row.transferId] : [])))];
  if (older.length > 0) {
    payments.push(...(unwrap(await orgDb.from("incoming_transfers").select(PAYMENT_COLUMNS).in("id", older)) as PaymentDbRow[]).map(toPaymentIn));
  }
  const floatSenders = new Set(
    (unwrap(grants) as Array<{ detail: { from?: unknown } | null }>).flatMap((entry) => (typeof entry.detail?.from === "string" ? [entry.detail.from.toLowerCase()] : []))
  );
  return { available: rows !== null, rows: rows ?? [], payments, floatSenders };
}

/**
 * What the open USDC receivables are expected to bring in, as the cycle's forecast records it (`projected_inflow`): a
 * part-paid one for what is still owed, since what arrived is in the wallet already (L11). Best effort: before migration
 * 0103 runs, or on a failed read, each counts in full, as before.
 */
export async function projectedReceivableInflow(orgDb: OrgDb): Promise<number> {
  const receivables = unwrap(
    await orgDb.from("invoices").select("id, amount, currency").eq("direction", "receivable").in("status", ["pending", "matched"])
  ) as Array<{ id: string; amount: string; currency: string | null }>;
  const rows =
    receivables.length > 0
      ? await readAllocationRows(orgDb, { invoiceIds: receivables.map((row) => row.id) }).catch((error: unknown) => {
          console.error("forecast: payments applied not read", error instanceof Error ? error.message : error);
          return null;
        })
      : null;
  const applied = new Map<string, number>();
  for (const row of liveRows(rows ?? [])) applied.set(row.invoiceId, (applied.get(row.invoiceId) ?? 0) + row.amount);
  const owed = receivables.map((row) => ({ currency: row.currency, amount: fromMicros(Math.max(0, toMicros(row.amount) - (applied.get(row.id) ?? 0))) }));
  // USDC only: the forecast is set against USDC balances (EURC invoices design R3).
  return sumUsdcAmounts(owed);
}
