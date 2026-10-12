import { sameAddress } from "../counterparty-address";
import { paymentMatches, type SearchQuery } from "../invoice-search";
import type { AllocationBook } from "./book";
import {
  fromMicros,
  OPEN_STATUSES,
  paymentBalance,
  receivableBalance,
  type Book,
  type Coin,
  type PaymentIn,
  type ReceivableBalance,
  type ReceivableIn,
} from "./model";
import { receivableLabel, suggestAllocations, type Customer, type SuggestionRule } from "./suggest";

/**
 * What Bills & receivables shows about payments applied (docs/superpowers/specs/2026-10-12-allocations-design.md L11),
 * built from the rows the page read. Pure, and in units rather than millionths, as the page's components take amounts.
 */

export interface AppliedLineView {
  allocationId: string;
  kind: "payment" | "fee";
  amount: number;
  currency: Coin;
  txHash: string | null;
  from: string | null;
  receivedAt: string | null;
  reason: string | null;
  /** Applied by the agent itself (the rest of a part-paid receivable), not a person. */
  byAgent: boolean;
  at: string;
}

export interface ReceivableView {
  invoiceId: string;
  state: ReceivableBalance["state"];
  currency: Coin;
  amount: number;
  paid: number;
  fees: number;
  applied: number;
  outstanding: number;
  lines: AppliedLineView[];
  /** A fee can be recorded now: open, with a payment applied and something owed. */
  canRecordFee: boolean;
}

/** Each receivable a payment was applied to, by id. One matched whole, or with nothing applied, has none. */
export function receivableViews(book: Pick<AllocationBook, "rows" | "payments">, receivables: readonly ReceivableIn[]): Map<string, ReceivableView> {
  const payments = new Map(book.payments.map((payment) => [payment.id, payment]));
  const named = new Set(book.rows.map((row) => row.invoiceId));
  const views = new Map<string, ReceivableView>();
  for (const receivable of receivables) {
    if (!named.has(receivable.id)) continue;
    const balance = receivableBalance(receivable, book.rows, false);
    const lines = balance.lines.map((line): AppliedLineView => {
      const payment = line.transferId ? payments.get(line.transferId) : undefined;
      return {
        allocationId: line.allocationId,
        kind: line.kind,
        amount: fromMicros(line.amount),
        currency: receivable.currency,
        txHash: payment?.txHash ?? null,
        from: payment?.from ?? null,
        receivedAt: payment?.receivedAt ?? null,
        reason: line.reason,
        byAgent: line.kind === "payment" && line.createdBy === null && line.basis !== "person",
        at: line.createdAt,
      };
    });
    views.set(receivable.id, {
      invoiceId: receivable.id,
      state: balance.state,
      currency: receivable.currency,
      amount: fromMicros(balance.amount),
      paid: fromMicros(balance.paid),
      fees: fromMicros(balance.fees),
      applied: fromMicros(balance.applied),
      outstanding: fromMicros(balance.outstanding),
      lines,
      canRecordFee: OPEN_STATUSES.has(receivable.status) && balance.paid > 0 && balance.outstanding > 0,
    });
  }
  return views;
}

export interface ReceivableChoice {
  invoiceId: string;
  label: string;
  customer: string;
  customerId: string;
  outstanding: number;
  dueDate: string;
}

export interface SuggestionView {
  rule: SuggestionRule;
  why: string;
  customer: string;
  lines: Array<{ invoiceId: string; label: string; amount: number }>;
  fee: { invoiceId: string; label: string; amount: number } | null;
  creditLeft: number;
}

export interface PaymentView {
  id: string;
  circleTxId: string;
  txHash: string | null;
  from: string | null;
  receivedAt: string;
  currency: Coin;
  amount: number;
  applied: number;
  unapplied: number;
  /** The version a person's application names. */
  version: number;
  /** The customer its applications name: what is left is that customer's credit. */
  creditFor: string | null;
  /** Who sent it, when a counterparty's address on file says so. */
  sender: string | null;
  suggestions: SuggestionView[];
  /** Open receivables in its currency it can be applied to by hand: its customer's, once it names one. */
  choices: ReceivableChoice[];
}

/** How many receivables a payment offers to apply to by hand. */
export const CHOICES_SHOWN = 50;

/**
 * Every payment with something not applied yet, newest first, with what to do about it. Test USDC from Vestiarion's
 * float is no customer's money and is left out; a search keeps the payments it finds.
 */
export function applyPaymentsView(
  book: AllocationBook,
  receivables: readonly ReceivableIn[],
  customers: readonly Customer[],
  options: { query?: SearchQuery | null } = {}
): PaymentView[] {
  const byId = new Map(receivables.map((receivable) => [receivable.id, receivable]));
  const wholeMatched = new Set(book.payments.flatMap((payment) => (payment.wholeMatch ? [payment.wholeMatch] : [])));
  const pool: Book = { receivables, rows: book.rows, wholeMatched };
  const label = (id: string) => {
    const receivable = byId.get(id);
    return receivable ? receivableLabel(receivable) : "an invoice";
  };
  const nameOf = (id: string | null) => (id ? (customers.find((customer) => customer.id === id)?.name ?? receivables.find((receivable) => receivable.counterpartyId === id)?.customer ?? null) : null);

  return book.payments
    .filter((payment) => !payment.wholeMatch && !(payment.from && book.floatSenders.has(payment.from.toLowerCase())))
    .filter((payment) => !options.query || paymentMatches(options.query, payment))
    .map((payment) => ({ payment, balance: paymentBalance(payment, book.rows, byId) }))
    .filter(({ balance }) => balance.unapplied > 0)
    .sort((a, b) => b.payment.receivedAt.localeCompare(a.payment.receivedAt) || a.payment.id.localeCompare(b.payment.id))
    .map(({ payment, balance }): PaymentView => {
      const senders = payment.from ? customers.filter((customer) => customer.address && sameAddress(customer.address, payment.from as string)) : [];
      const choices = receivables
        .filter(
          (receivable) =>
            OPEN_STATUSES.has(receivable.status) &&
            receivable.currency === payment.currency &&
            !wholeMatched.has(receivable.id) &&
            (!balance.customerId || receivable.counterpartyId === balance.customerId)
        )
        .map((receivable) => ({ receivable, outstanding: receivableBalance(receivable, book.rows, false).outstanding }))
        .filter((entry) => entry.outstanding > 0)
        .sort((a, b) => a.receivable.dueDate.localeCompare(b.receivable.dueDate) || a.receivable.id.localeCompare(b.receivable.id))
        .slice(0, CHOICES_SHOWN)
        .map(({ receivable, outstanding }) => ({
          invoiceId: receivable.id,
          label: receivableLabel(receivable),
          customer: receivable.customer,
          customerId: receivable.counterpartyId,
          outstanding: fromMicros(outstanding),
          dueDate: receivable.dueDate,
        }));
      return {
        id: payment.id,
        circleTxId: payment.circleTxId,
        txHash: payment.txHash,
        from: payment.from,
        receivedAt: payment.receivedAt,
        currency: payment.currency,
        amount: fromMicros(payment.amount),
        applied: fromMicros(balance.applied),
        unapplied: fromMicros(balance.unapplied),
        version: balance.version,
        creditFor: balance.applied > 0 ? nameOf(balance.customerId) : null,
        sender: senders.length === 1 ? senders[0].name : null,
        suggestions: suggestAllocations({ payment, book: pool, customers }).map((suggestion) => ({
          rule: suggestion.rule,
          why: suggestion.why,
          customer: suggestion.customer,
          lines: suggestion.lines.map((line) => ({ invoiceId: line.invoiceId, label: label(line.invoiceId), amount: fromMicros(line.amount) })),
          fee: suggestion.fee ? { invoiceId: suggestion.fee.invoiceId, label: label(suggestion.fee.invoiceId), amount: fromMicros(suggestion.fee.amount) } : null,
          creditLeft: fromMicros(suggestion.creditLeft),
        })),
        choices,
      };
    });
}

/** The payments applied to each receivable, or matched to it whole, for search. */
export function paymentsByReceivable(book: Pick<AllocationBook, "rows" | "payments">): Map<string, PaymentIn[]> {
  const payments = new Map(book.payments.map((payment) => [payment.id, payment]));
  const found = new Map<string, PaymentIn[]>();
  const add = (invoiceId: string, payment: PaymentIn | undefined) => {
    if (!payment) return;
    const list = found.get(invoiceId) ?? [];
    if (!list.includes(payment)) list.push(payment);
    found.set(invoiceId, list);
  };
  for (const payment of book.payments) if (payment.wholeMatch) add(payment.wholeMatch, payment);
  for (const row of book.rows) if (row.transferId) add(row.invoiceId, payments.get(row.transferId));
  return found;
}
