import { sameAddress } from "../counterparty-address";
import { utcDay } from "../copy";
import {
  amountWords,
  MICROS,
  OPEN_STATUSES,
  paymentBalance,
  receivableBalance,
  type Book,
  type PaymentIn,
  type ReceivableIn,
} from "./model";

/**
 * How to apply a payment, suggested (docs/superpowers/specs/2026-10-12-allocations-design.md L9). Pure, bounded and
 * deterministic: the same rows in any order give the same suggestions. Each says why; a person confirms one, or applies
 * by hand. In order: the payment's reference; then, for the customer it comes from (its earlier applications, else
 * the counterparty whose address on file sent it), the receivable it pays exactly, 2 to 4 that add up to it, one it is a
 * fee short of, and oldest due first with any rest as credit; with no customer known, a receivable it pays exactly,
 * receivables of one customer that add up to it, and one it is a fee short of.
 */

export interface Customer {
  id: string;
  name: string;
  /** The counterparty's payment address on file, which tells who sent a payment. */
  address: string | null;
}

export type SuggestionRule = "reference" | "exact" | "combination" | "short_fee" | "oldest_first";

export interface Suggestion {
  paymentId: string;
  customerId: string;
  customer: string;
  rule: SuggestionRule;
  lines: Array<{ invoiceId: string; amount: number }>;
  /** A difference a person may record as a fee, with a reason they give; null when there is none. */
  fee: { invoiceId: string; amount: number } | null;
  /** What stays on the payment as the customer's credit. */
  creditLeft: number;
  why: string;
}

export const SUGGESTIONS_PER_PAYMENT = 3;
/** Sums are looked for among a customer's oldest due receivables, this many. */
export const COMBINATION_POOL = 12;
/** And among sets of 2 to this many. */
export const COMBINATION_MAX = 4;
/** A payment short of a receivable by at most 1%, and at most 5.00, may be a fee. */
export const FEE_MARGIN_PERCENT = 1;
export const FEE_MARGIN_MAX = 5 * MICROS;

interface Open {
  receivable: ReceivableIn;
  outstanding: number;
}

/** A receivable as a person names it: its memo, which starts with its invoice number, or its due day. */
export function receivableLabel(receivable: Pick<ReceivableIn, "memo" | "dueDate">): string {
  const memo = receivable.memo?.trim();
  return memo ? memo : `the invoice due ${utcDay(receivable.dueDate)}`;
}

/** "Acme Corp's", "Beacon Labs'". */
export function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

function listWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

const byDue = (a: Open, b: Open) =>
  a.receivable.dueDate.localeCompare(b.receivable.dueDate) || a.receivable.createdAt.localeCompare(b.receivable.createdAt) || a.receivable.id.localeCompare(b.receivable.id);

const withinFee = (short: number, outstanding: number) => short > 0 && short * 100 <= outstanding * FEE_MARGIN_PERCENT && short <= FEE_MARGIN_MAX;

/** The first set of 2 to 4 among the pool, smallest sets first and in order, whose outstanding adds up to `target`. */
function exactSet(pool: Open[], target: number): Open[] | null {
  const candidates = pool.slice(0, COMBINATION_POOL);
  for (let size = 2; size <= Math.min(COMBINATION_MAX, candidates.length); size += 1) {
    const picks = Array.from({ length: size }, (_, index) => index);
    for (;;) {
      if (picks.reduce((total, index) => total + candidates[index].outstanding, 0) === target) return picks.map((index) => candidates[index]);
      let position = size - 1;
      while (position >= 0 && picks[position] === candidates.length - size + position) position -= 1;
      if (position < 0) break;
      picks[position] += 1;
      for (let next = position + 1; next < size; next += 1) picks[next] = picks[next - 1] + 1;
    }
  }
  return null;
}

/** Whole words of a memo or a purchase order, or the start of a Vestiarion id, that name the reference. */
function namesReference(receivable: ReceivableIn, reference: string): boolean {
  const wanted = reference.trim().toLowerCase();
  if (wanted.length < 3) return false;
  const words = (text: string | null) => (text ?? "").toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean);
  if (words(receivable.memo).includes(wanted) || words(receivable.poReference).includes(wanted)) return true;
  return wanted.length >= 8 && receivable.id.toLowerCase().startsWith(wanted);
}

export function suggestAllocations(input: { payment: PaymentIn; book: Book; customers: readonly Customer[] }): Suggestion[] {
  const { payment, book } = input;
  const byId = new Map(book.receivables.map((receivable) => [receivable.id, receivable]));
  const state = paymentBalance(payment, book.rows, byId);
  const left = state.unapplied;
  if (left <= 0) return [];

  const open: Open[] = book.receivables
    .filter((receivable) => OPEN_STATUSES.has(receivable.status) && receivable.currency === payment.currency && !book.wholeMatched.has(receivable.id))
    .map((receivable) => ({ receivable, outstanding: receivableBalance(receivable, book.rows, false).outstanding }))
    .filter((entry) => entry.outstanding > 0)
    .sort(byDue);
  if (open.length === 0) return [];

  const customers = [...input.customers].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const nameOf = (id: string) => customers.find((customer) => customer.id === id)?.name ?? open.find((entry) => entry.receivable.counterpartyId === id)?.receivable.customer ?? "the customer";
  const money = (micros: number) => amountWords(micros, payment.currency);
  const suggestion = (customerId: string, rule: SuggestionRule, lines: Suggestion["lines"], why: string, fee: Suggestion["fee"] = null): Suggestion => ({
    paymentId: payment.id,
    customerId,
    customer: nameOf(customerId),
    rule,
    lines,
    fee,
    creditLeft: left - lines.reduce((total, line) => total + line.amount, 0),
    why,
  });

  const found: Suggestion[] = [];

  // 1. The payment's own reference (an Arc transfer carries none today).
  if (payment.reference) {
    const named = open.filter((entry) => namesReference(entry.receivable, payment.reference as string) && (!state.customerId || entry.receivable.counterpartyId === state.customerId));
    const customerId = named[0]?.receivable.counterpartyId;
    const same = named.filter((entry) => entry.receivable.counterpartyId === customerId);
    if (customerId && same.length > 0) {
      let rest = left;
      const lines = same.flatMap((entry) => {
        const amount = Math.min(rest, entry.outstanding);
        rest -= amount;
        return amount > 0 ? [{ invoiceId: entry.receivable.id, amount }] : [];
      });
      found.push(suggestion(customerId, "reference", lines, `Its reference, ${payment.reference.trim()}, is on ${listWords(same.map((entry) => receivableLabel(entry.receivable)))}.`));
    }
  }

  // 2. The customer it comes from: its earlier applications, else the address on file that sent it.
  const senders = payment.from ? customers.filter((customer) => customer.address && sameAddress(customer.address, payment.from as string)) : [];
  const known = state.customerId ?? (senders.length === 1 ? senders[0].id : null);
  if (known) {
    const from = state.customerId ? `Left from a payment applied to ${nameOf(known)} before` : `From ${possessive(nameOf(known))} address on file`;
    const pool = open.filter((entry) => entry.receivable.counterpartyId === known);
    const exact = pool.find((entry) => entry.outstanding === left);
    if (exact) found.push(suggestion(known, "exact", [{ invoiceId: exact.receivable.id, amount: left }], `${from}, and exactly what is still owed on ${receivableLabel(exact.receivable)}.`));
    const set = exact ? null : exactSet(pool, left);
    if (set) {
      found.push(
        suggestion(
          known,
          "combination",
          set.map((entry) => ({ invoiceId: entry.receivable.id, amount: entry.outstanding })),
          `${from}, and it pays ${listWords(set.map((entry) => receivableLabel(entry.receivable)))} exactly: ${money(left)}.`
        )
      );
    }
    const short = pool.find((entry) => withinFee(entry.outstanding - left, entry.outstanding));
    if (short) {
      const difference = short.outstanding - left;
      found.push(
        suggestion(
          known,
          "short_fee",
          [{ invoiceId: short.receivable.id, amount: left }],
          `${from}, and ${money(difference)} short of what is owed on ${receivableLabel(short.receivable)}, which may be a fee: mark it as one with a reason, or leave it owed.`,
          { invoiceId: short.receivable.id, amount: difference }
        )
      );
    }
    if (pool.length > 0) {
      let rest = left;
      const lines = pool.flatMap((entry) => {
        const amount = Math.min(rest, entry.outstanding);
        rest -= amount;
        return amount > 0 ? [{ invoiceId: entry.receivable.id, amount, whole: amount === entry.outstanding, entry }] : [];
      });
      const whole = lines.filter((line) => line.whole).map((line) => receivableLabel(line.entry.receivable));
      const part = lines.find((line) => !line.whole);
      const said = [
        whole.length > 0 ? `${listWords(whole)} in full` : "",
        part ? `${money(part.amount)} of ${receivableLabel(part.entry.receivable)}, which stays part paid` : "",
      ]
        .filter(Boolean)
        .join(", and ");
      const credit = rest > 0 ? ` ${money(rest)} is left as credit for ${nameOf(known)}.` : "";
      found.push(suggestion(known, "oldest_first", lines.map(({ invoiceId, amount }) => ({ invoiceId, amount })), `${from}. Oldest due first: ${said}.${credit}`));
    }
  } else {
    // 3. No customer known: amounts alone, saying how sure they are.
    const exact = open.filter((entry) => entry.outstanding === left);
    for (const entry of exact) {
      const how = exact.length === 1 ? "the only open invoice of that amount" : `one of ${exact.length} open invoices of that amount: check who sent it`;
      found.push(
        suggestion(entry.receivable.counterpartyId, "exact", [{ invoiceId: entry.receivable.id, amount: left }], `Exactly what is still owed on ${receivableLabel(entry.receivable)} from ${entry.receivable.customer}, ${how}.`)
      );
    }
    const owing = [...new Set(open.map((entry) => entry.receivable.counterpartyId))].sort((a, b) => nameOf(a).localeCompare(nameOf(b)) || a.localeCompare(b));
    for (const customerId of owing) {
      const set = exactSet(open.filter((entry) => entry.receivable.counterpartyId === customerId), left);
      if (!set) continue;
      found.push(
        suggestion(
          customerId,
          "combination",
          set.map((entry) => ({ invoiceId: entry.receivable.id, amount: entry.outstanding })),
          `It pays ${possessive(nameOf(customerId))} ${listWords(set.map((entry) => receivableLabel(entry.receivable)))} exactly: ${money(left)}.`
        )
      );
    }
    const short = open.filter((entry) => withinFee(entry.outstanding - left, entry.outstanding));
    if (short.length === 1) {
      const [entry] = short;
      found.push(
        suggestion(
          entry.receivable.counterpartyId,
          "short_fee",
          [{ invoiceId: entry.receivable.id, amount: left }],
          `${money(entry.outstanding - left)} short of what ${entry.receivable.customer} owes on ${receivableLabel(entry.receivable)}, which may be a fee: mark it as one with a reason, or leave it owed.`,
          { invoiceId: entry.receivable.id, amount: entry.outstanding - left }
        )
      );
    }
  }

  const seen = new Set<string>();
  return found
    .filter((candidate) => {
      // The same lines with or without a fee are one suggestion: a fee's suggestion also offers to leave the rest owed.
      const key = candidate.lines.map((line) => `${line.invoiceId}:${line.amount}`).join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, SUGGESTIONS_PER_PAYMENT);
}
