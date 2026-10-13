import { NETWORKS, type Network } from "../network";
import { inForce } from "./lines";
import type { DealRecord } from "./read";

/**
 * What a deal has collected (docs/superpowers/specs/2026-10-13-crm-receipts-design.md R1): the one figure for money
 * received on a deal. Its page's Paid and Outstanding, the Deals list, and the receipts written back to the CRM it was
 * planned from all read it from here, so they never disagree. Only money that arrived on Arc, confirmed by Circle, and
 * was applied to one of the deal's invoices counts: nothing submitted, pending or promised; a part payment is part; a fee
 * a person marked settles its invoice and is never collected. Pure and browser-safe: the database's rows are read in
 * `collection-read.ts`.
 */

export const COLLECTION_STATUSES = ["paid_in_full", "paid_to_date", "partly_paid", "overdue", "awaiting_payment", "nothing_invoiced"] as const;
export type CollectionStatus = (typeof COLLECTION_STATUSES)[number];

export const COLLECTION_STATUS_WORDS: Record<CollectionStatus, string> = {
  paid_in_full: "Paid in full",
  paid_to_date: "Paid to date",
  partly_paid: "Partly paid",
  overdue: "Overdue",
  awaiting_payment: "Awaiting payment",
  nothing_invoiced: "Nothing invoiced yet",
};

export const RECONCILIATIONS = ["reconciled", "needs_review", "no_receipts"] as const;
export type Reconciliation = (typeof RECONCILIATIONS)[number];

export const RECONCILIATION_WORDS: Record<Reconciliation, string> = {
  reconciled: "Reconciled",
  needs_review: "Needs review",
  no_receipts: "No receipts yet",
};

/** A receivable made from one of the deal's lines. Amounts in the receivable's own currency, as numbers of it. */
export interface DealReceivable {
  id: string;
  amount: number;
  currency: string;
  status: string;
  /** `YYYY-MM-DD` */
  dueOn: string;
  /** Shadow mode's invoice in the business's own currency (0084): both or neither. */
  originalCurrency: string | null;
  originalAmount: number | null;
}

/**
 * A payment that arrived on Arc (`incoming_transfers`: recorded only once Circle reported it complete) and was applied to
 * one of the receivables: a whole match, or a live allocation. Its amount is what it brought to that receivable.
 */
export interface AppliedPayment {
  transferId: string;
  invoiceId: string;
  amount: number;
  receivedAt: string;
  txHash: string | null;
  /** Circle's blockchain name the payment arrived on (`ARC-TESTNET`, `ARC`). */
  chain: string;
}

export interface CollectionInput {
  deal: { currency: string; digits: 0 | 2; status: "active" | "cancelled" };
  receivables: readonly DealReceivable[];
  payments: readonly AppliedPayment[];
  /** Live fees a person marked on a receivable: they settle it, and are never collected. */
  fees: ReadonlyArray<{ invoiceId: string; amount: number }>;
  /** Charges in force not invoiced yet, in the deal's minor units. */
  notInvoicedMinor: number;
  /** `YYYY-MM-DD` */
  today: string;
}

export interface LastReceipt {
  /** `YYYY-MM-DD`, UTC. */
  on: string;
  minor: number;
  txHash: string | null;
  network: Network;
}

export interface Collection {
  currency: string;
  digits: 0 | 2;
  collectedMinor: number;
  stillOwedMinor: number;
  invoicedMinor: number;
  feesMinor: number;
  overdueMinor: number;
  notInvoicedMinor: number;
  /** Marked received with no payment on Arc behind it: never counted (R1). */
  unverifiedMinor: number;
  /** Receivables in a currency the deal cannot be told in: left out, and said. */
  leftOut: number;
  receipts: number;
  status: CollectionStatus;
  reconciliation: Reconciliation;
  lastReceipt: LastReceipt | null;
}

const SETTLED = new Set(["received", "paid"]);
const CLOSED = new Set(["rejected"]);

/** The network a payment arrived on, by Circle's blockchain name: Arc mainnet only when it says so. */
export function networkOfChain(chain: string): Network {
  return chain === NETWORKS["arc-mainnet"].circleBlockchain ? "arc-mainnet" : "arc-testnet";
}

/**
 * What a deal has collected (R1). Only money that arrived on Arc, confirmed by Circle, and was applied to one of its
 * invoices counts: nothing submitted, pending or promised. A part payment is part: the rest of that invoice is still
 * owed. A fee a person marked settles its invoice and is not collected. An invoice marked received with no payment on
 * Arc is not counted, and makes the reconciliation "needs review". In the deal's currency: a shadow-mode invoice kept in
 * it is converted at its own rate; one in another currency is left out.
 */
export function dealCollection(input: CollectionInput): Collection {
  const { deal } = input;
  const scale = 10 ** deal.digits;
  const totals = { collected: 0, owed: 0, invoiced: 0, fees: 0, overdue: 0, unverified: 0 };
  let leftOut = 0;
  const factorOf = new Map<string, number>();
  for (const receivable of input.receivables) {
    if (CLOSED.has(receivable.status) || !(receivable.amount > 0)) continue;
    const factor =
      receivable.originalCurrency === deal.currency && receivable.originalAmount !== null && receivable.originalAmount > 0
        ? receivable.originalAmount / receivable.amount
        : receivable.currency === deal.currency
          ? 1
          : null;
    if (factor === null) {
      leftOut += 1;
      continue;
    }
    factorOf.set(receivable.id, factor);
    const minor = (value: number) => Math.round(Number((value * factor * scale).toPrecision(15)));
    const paid = input.payments.filter((payment) => payment.invoiceId === receivable.id).reduce((sum, payment) => sum + payment.amount, 0);
    const fees = input.fees.filter((fee) => fee.invoiceId === receivable.id).reduce((sum, fee) => sum + fee.amount, 0);
    const settled = SETTLED.has(receivable.status);
    const owed = settled ? 0 : Math.max(0, receivable.amount - paid - fees);
    totals.invoiced += minor(receivable.amount);
    totals.collected += minor(Math.min(paid, receivable.amount));
    totals.fees += minor(fees);
    totals.owed += minor(owed);
    if (owed > 0 && receivable.dueOn < input.today) totals.overdue += minor(owed);
    if (settled && paid + fees <= 0) totals.unverified += minor(receivable.amount);
  }

  // The latest payment: what it brought to this deal's invoices, all of them.
  const counted = input.payments.filter((payment) => factorOf.has(payment.invoiceId));
  const transfers = [...new Set(counted.map((payment) => payment.transferId))];
  const latest = [...counted].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || b.transferId.localeCompare(a.transferId))[0];
  const lastReceipt: LastReceipt | null = latest
    ? {
        on: new Date(latest.receivedAt).toISOString().slice(0, 10),
        minor: counted
          .filter((payment) => payment.transferId === latest.transferId)
          .reduce((sum, payment) => sum + Math.round(Number((payment.amount * (factorOf.get(payment.invoiceId) ?? 1) * scale).toPrecision(15))), 0),
        txHash: latest.txHash,
        network: networkOfChain(latest.chain),
      }
    : null;

  const status: CollectionStatus =
    totals.invoiced === 0 && totals.collected === 0
      ? "nothing_invoiced"
      : totals.owed === 0
        ? input.notInvoicedMinor > 0 && deal.status === "active"
          ? "paid_to_date"
          : "paid_in_full"
        : totals.collected > 0
          ? "partly_paid"
          : totals.overdue > 0
            ? "overdue"
            : "awaiting_payment";
  const reconciliation: Reconciliation = totals.unverified > 0 ? "needs_review" : transfers.length === 0 ? "no_receipts" : "reconciled";
  return {
    currency: deal.currency,
    digits: deal.digits,
    collectedMinor: totals.collected,
    stillOwedMinor: totals.owed,
    invoicedMinor: totals.invoiced,
    feesMinor: totals.fees,
    overdueMinor: totals.overdue,
    notInvoicedMinor: Math.max(0, input.notInvoicedMinor),
    unverifiedMinor: totals.unverified,
    leftOut,
    receipts: transfers.length,
    status,
    reconciliation,
    lastReceipt,
  };
}

// ---------------------------------------------------------------------------
// From the database's rows

/** A receivable of the deal as `invoices` holds it. */
export interface ReceivableRow {
  id: string;
  deal_id: string;
  amount: number | string;
  currency: string | null;
  status: string;
  due_date: string;
  original_currency: string | null;
  original_amount: number | string | null;
}

/** A row of `receivable_allocations` (0103): a payment or a fee applied, or a reversal of one. */
export interface AllocationDbRow {
  id: string;
  kind: "payment" | "fee" | "reversal";
  invoice_id: string;
  transfer_id: string | null;
  amount: number | string;
  reverses: string | null;
}

/** A payment that arrived on Arc (`incoming_transfers`), with the receivable a whole match settled with it, if any. */
export interface TransferRow {
  id: string;
  invoice_id: string | null;
  amount: number | string;
  received_at: string;
  tx_hash: string | null;
  chain: string;
}

/** The rows a deal's collection is read from: its receivables, the allocations on them, and the payments behind both. */
export interface CollectionRows {
  receivables: readonly ReceivableRow[];
  allocations: readonly AllocationDbRow[];
  /** The payments the allocations name, by id. */
  transfers: ReadonlyMap<string, TransferRow>;
  /** The payments matched whole to a receivable (0050's `invoice_id`). */
  wholeMatches: readonly TransferRow[];
}

/**
 * What a deal collected (R1), from records already read: its receivables, the live allocations on them (a reversal
 * undoes its row), and the payments that arrived on Arc and were applied, whole or in part. The rows may hold other
 * deals' too: only this deal's are read.
 */
export function collectionOfRows(deal: Pick<DealRecord, "facts" | "digits">, rows: CollectionRows, today: string): Collection {
  const own = rows.receivables.filter((row) => row.deal_id === deal.facts.id);
  const ids = new Set(own.map((row) => row.id));
  const allocations = rows.allocations.filter((row) => ids.has(row.invoice_id));
  const reversed = new Set(allocations.flatMap((row) => (row.kind === "reversal" && row.reverses ? [row.reverses] : [])));
  const live = allocations.filter((row) => row.kind !== "reversal" && !reversed.has(row.id));
  const receivables: DealReceivable[] = own.map((row) => ({
    id: row.id,
    amount: Number(row.amount),
    currency: row.currency ?? "USDC",
    status: row.status,
    dueOn: String(row.due_date).slice(0, 10),
    originalCurrency: row.original_currency,
    originalAmount: row.original_amount === null ? null : Number(row.original_amount),
  }));
  const payments: AppliedPayment[] = [];
  for (const row of live) {
    if (row.kind !== "payment" || !row.transfer_id) continue;
    const transfer = rows.transfers.get(row.transfer_id);
    if (!transfer) continue;
    payments.push({ transferId: transfer.id, invoiceId: row.invoice_id, amount: Number(row.amount), receivedAt: transfer.received_at, txHash: transfer.tx_hash, chain: transfer.chain });
  }
  // A whole match settled its receivable with all of the payment (0050): what the receivable asked.
  for (const transfer of rows.wholeMatches) {
    const receivable = receivables.find((row) => row.id === transfer.invoice_id);
    if (!receivable || !SETTLED.has(receivable.status)) continue;
    payments.push({ transferId: transfer.id, invoiceId: receivable.id, amount: receivable.amount, receivedAt: transfer.received_at, txHash: transfer.tx_hash, chain: transfer.chain });
  }
  const fees = live.filter((row) => row.kind === "fee").map((row) => ({ invoiceId: row.invoice_id, amount: Number(row.amount) }));
  const notInvoicedMinor = inForce(deal.facts.lines)
    .filter((line) => line.status === "planned" && line.kind === "charge")
    .reduce((sum, line) => sum + line.amountMinor, 0);
  return dealCollection({
    deal: { currency: deal.facts.currency, digits: deal.digits, status: deal.facts.status },
    receivables,
    payments,
    fees,
    notInvoicedMinor,
    today,
  });
}
