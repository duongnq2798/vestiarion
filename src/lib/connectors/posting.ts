import { createHash } from "node:crypto";
import { billDigits } from "../bill-amount";
import type { Network } from "../network";
import type { PaymentAccount } from "./connections";
import type { ExternalBill, ExternalPayment, PaymentToBook, SourceStatus } from "./provider";

/**
 * Booking a payment made on Arc in the accounting tool (docs/superpowers/specs/2026-10-12-accounting-writeback-design.md
 * W1, W3, W4, W6, W7): the reality rule, what is written (amount and currency in the bill's currency, the day, the
 * reference), the fingerprint of what a person saw, the bill's check right before sending, and whether what the provider
 * holds is what was sent. Pure: the runs (`booking-run.ts`) read the rows and call the provider.
 */

export type PostingState = "draft" | "sending" | "sent" | "confirmed" | "failed" | "refused";

/** Why a booking was refused: final. */
export type RefusalReason = "reality" | "already_paid" | "bill_closed" | "currency" | "deleted_in_provider";
/** Why a send failed: approving it again tries once more. */
export type FailureReason = "no_answer" | "refused_by_provider" | "rate_limited" | "reconnect" | "mismatch";

/** The words every surface says of a payment the reality rule keeps out of real books (W1). */
export const REALITY_REFUSAL = "Not booked: payments in shadow mode and on Arc testnet are never booked into your real books.";
/** What a bill already paid in the tool says (W3, W7): its accountant booked it there by hand. */
export const alreadyPaid = (label: string) => `Already paid in ${label}.`;

/** The payment's reality: its network, and whether it was made in shadow mode. */
export interface PaymentReality {
  network: Network;
  shadow: boolean;
}

export type RealityOutcome = { ok: true } | { ok: false; refused: true; reason: "shadow" | "testnet" } | { ok: false; refused: false };

/**
 * A payment is only ever booked into a ledger of the same reality (W1). A payment on Arc mainnet outside shadow mode
 * moved real money: any organisation. Any other (Arc testnet, or shadow mode, where the business also pays the bill
 * from its bank) only into one the provider says is a demo company. `demo` null: not read, so not allowed yet, and not
 * refused either: it is read again, never guessed.
 */
export function bookingReality(payment: PaymentReality, demo: boolean | null): RealityOutcome {
  if (payment.network === "arc-mainnet" && !payment.shadow) return { ok: true };
  if (demo === true) return { ok: true };
  if (demo === false) return { ok: false, refused: true, reason: payment.shadow ? "shadow" : "testnet" };
  return { ok: false, refused: false };
}

/** Whether the rule needs the organisation read at all: only for a payment not on Arc mainnet outside shadow mode. */
export function needsOrganisation(payment: PaymentReality): boolean {
  return !(payment.network === "arc-mainnet" && !payment.shadow);
}

/** The payable as drafting reads it. */
export interface PaidInvoice {
  amount: number;
  /** USDC or EURC. */
  currency: string;
  /** What left, when an early-payment discount made it less than `amount`. */
  paidAmount: number | null;
  /** Shadow mode's bill in the business's own currency (0084): both or neither. */
  originalCurrency: string | null;
  originalAmount: number | null;
  txRef: string | null;
  settledAt: string | null;
}

/** The payment intent as drafting reads it. */
export interface ConfirmedIntent {
  txHash: string | null;
  confirmedAt: string | null;
  feeUsd: number | null;
  bridgeFee: number | null;
}

export interface PostingFacts {
  amount: string;
  currency: string;
  paidOn: string;
  reference: string;
  paidAmount: string;
  paidToken: "USDC" | "EURC";
  /** In USDC, shown apart, never booked (W5). */
  networkFee: string | null;
}

export type FactsOutcome = { ok: true; facts: PostingFacts } | { ok: false; reason: "currency"; message: string } | { ok: false; reason: "unreadable" };

const STABLECOIN_CURRENCY: Record<string, string> = { USDC: "USD", EURC: "EUR" };
const HASH = /^0x[0-9a-fA-F]{64}$/;

/** A positive amount to its currency's minor units, as a decimal string: "31.39", "4500". */
export function minorUnits(value: number, currency: string): string {
  const digits = billDigits(currency);
  const scale = 10 ** digits;
  // Through 15 significant digits first, so 31.385 (stored as 31.38499…) rounds as written.
  return (Math.round(Number((value * scale).toPrecision(15))) / scale).toFixed(digits);
}

/**
 * What the booking writes (W4): in the bill's currency. A bill kept in the business's own currency (shadow mode) is
 * booked at its original amount, less the same share an early-payment discount took off; otherwise USDC is booked as
 * USD and EURC as EUR, at what left. The currency must be the provider's bill's: another is refused, never converted.
 * The day is the UTC day the payment was confirmed; the reference, the Arc transaction hash.
 */
export function postingFacts(input: { invoice: PaidInvoice; intent: ConfirmedIntent; billCurrency: string }): FactsOutcome {
  const { invoice, intent } = input;
  const reference = intent.txHash && HASH.test(intent.txHash) ? intent.txHash : invoice.txRef && HASH.test(invoice.txRef) ? invoice.txRef : null;
  const confirmed = intent.confirmedAt ?? invoice.settledAt;
  const paidToken = invoice.currency === "EURC" ? "EURC" : invoice.currency === "USDC" ? "USDC" : null;
  if (!reference || !confirmed || Number.isNaN(Date.parse(confirmed)) || !paidToken || !(invoice.amount > 0)) return { ok: false, reason: "unreadable" };
  const paid = invoice.paidAmount !== null && invoice.paidAmount > 0 ? invoice.paidAmount : invoice.amount;
  let amount: number;
  let currency: string;
  if (invoice.originalCurrency && invoice.originalAmount !== null && invoice.originalAmount > 0) {
    currency = invoice.originalCurrency;
    amount = paid < invoice.amount ? (invoice.originalAmount * paid) / invoice.amount : invoice.originalAmount;
  } else {
    currency = STABLECOIN_CURRENCY[paidToken];
    amount = paid;
  }
  if (currency !== input.billCurrency) {
    return { ok: false, reason: "currency", message: `The bill is in ${input.billCurrency} in Xero, and this payment is in ${currency}: book it by hand.` };
  }
  const fees = [intent.feeUsd, intent.bridgeFee].filter((fee): fee is number => typeof fee === "number" && Number.isFinite(fee) && fee >= 0);
  return {
    ok: true,
    facts: {
      amount: minorUnits(amount, currency),
      currency,
      paidOn: new Date(confirmed).toISOString().slice(0, 10),
      reference,
      paidAmount: String(Number(paid.toFixed(6))),
      paidToken,
      networkFee: fees.length > 0 ? String(Number(fees.reduce((sum, fee) => sum + fee, 0).toFixed(6))) : null,
    },
  };
}

/** The bill as the review list shows it, from the last sync: what a person saw it say. */
export interface ShownBill {
  amountDue: string;
  status: SourceStatus;
}

/** Exactly what a person saw before approving (W6): the bill as last synced, and every field written. */
export interface FingerprintInput {
  billExternalId: string;
  bill: ShownBill;
  amount: string;
  currency: string;
  accountId: string;
  paidOn: string;
  reference: string;
}

export function postingFingerprint(input: FingerprintInput): string {
  const canonical = JSON.stringify([
    input.billExternalId,
    String(Number(input.bill.amountDue)),
    input.bill.status,
    String(Number(input.amount)),
    input.currency,
    input.accountId,
    input.paidOn,
    input.reference.toLowerCase(),
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** The provider's idempotency key for one booking as approved: a retry of the same booking is the same request. */
export function idempotencyKey(postingId: string, fingerprint: string): string {
  return `vestiarion-booking-${postingId}-${fingerprint.slice(0, 16)}`;
}

export type BillCheck =
  | { ok: true }
  | { ok: false; kind: "refused"; reason: "bill_closed" | "already_paid" | "currency"; message: string }
  | { ok: false; kind: "stale"; message: string };

const money = (value: string | number, currency: string) => `${Number(value).toLocaleString("en-US", { minimumFractionDigits: billDigits(currency), maximumFractionDigits: billDigits(currency) })} ${currency}`;

/**
 * The bill as the provider has it right before sending (W7, step 4): gone, voided or deleted is closed; paid, or nothing
 * due, is already paid; another currency is refused; an amount due other than the one the person saw is stale, and so
 * is a bill back in draft, which takes no payment until it is approved again.
 */
export function billCheck(bill: ExternalBill | null, posting: { amount: string; currency: string }, shown: ShownBill, label: string): BillCheck {
  if (bill === null || bill.status === "voided" || bill.status === "deleted") {
    return { ok: false, kind: "refused", reason: "bill_closed", message: `The bill was ${bill ? bill.status : "deleted"} in ${label}: nothing to book against.` };
  }
  if (bill.status === "paid" || Number(bill.amountDue) <= 0) return { ok: false, kind: "refused", reason: "already_paid", message: alreadyPaid(label) };
  if (bill.currency !== posting.currency) {
    return { ok: false, kind: "refused", reason: "currency", message: `The bill is in ${bill.currency} in ${label}, and this payment is in ${posting.currency}: book it by hand.` };
  }
  if (bill.status === "draft") return { ok: false, kind: "stale", message: `The bill is back in draft in ${label}. Approve it there, then look at this booking again.` };
  if (Number(bill.amountDue) !== Number(shown.amountDue)) {
    return { ok: false, kind: "stale", message: `${label} now says ${money(bill.amountDue, bill.currency)} is due on this bill. Sync now, then look at this booking again.` };
  }
  if (Number(bill.amountDue) < Number(posting.amount)) {
    return {
      ok: false,
      kind: "refused",
      reason: "already_paid",
      message: `${label} says only ${money(bill.amountDue, bill.currency)} is still due on this bill: part of it was paid there already. Book this payment by hand.`,
    };
  }
  return { ok: true };
}

export type PaymentCheck = { ok: true } | { ok: false; deleted: boolean; message: string };

/** Whether the payment the provider holds is the one sent: the same bill, amount, reference and account (W7, step 7). */
export function paymentMatches(expected: PaymentToBook, got: ExternalPayment, label: string): PaymentCheck {
  if (got.status === "deleted") return { ok: false, deleted: true, message: `The payment was deleted in ${label}. Vestiarion does not book it again; book it by hand if it belongs there.` };
  const same =
    got.billExternalId === expected.billExternalId &&
    Math.abs(Number(got.amount) - Number(expected.amount)) < 0.000001 &&
    (got.reference ?? "").toLowerCase() === expected.reference.toLowerCase() &&
    (got.accountExternalId === null || got.accountExternalId === expected.accountExternalId);
  return same ? { ok: true } : { ok: false, deleted: false, message: `${label} holds a payment with this reference that is not the one sent. Look at it in ${label}.` };
}

/** The payment to book, from a booking's facts and the account approved. */
export function paymentToBook(posting: { billExternalId: string; amount: string; currency: string; paidOn: string; reference: string }, account: PaymentAccount): PaymentToBook {
  return { billExternalId: posting.billExternalId, accountExternalId: account.id, amount: posting.amount, currency: posting.currency, date: posting.paidOn, reference: posting.reference };
}

/** Whether a connection's scopes hold every one booking needs (W8). */
export function hasScopes(granted: readonly string[], needed: readonly string[]): boolean {
  return needed.every((scope) => granted.includes(scope));
}
