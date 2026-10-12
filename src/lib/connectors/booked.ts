import { PROVIDER_LABELS, PROVIDERS, type ProviderId } from "./provider";

/**
 * Where a payable's booking in the accounting tool is, from its signed entries alone
 * (docs/superpowers/specs/2026-10-12-accounting-writeback-design.md W9, W10): the card's badge, the last row of Where
 * the payment is, and the evidence chain's step read this, so they never disagree. Pure and browser-safe.
 */

export const BOOKING_ACTIONS = [
  "accounting_payment_drafted",
  "accounting_payment_approved",
  "accounting_payment_sent",
  "accounting_payment_confirmed",
  "accounting_payment_failed",
  "accounting_payment_refused",
] as const;

export type BookingAction = (typeof BOOKING_ACTIONS)[number];

const STATE_OF: Record<BookingAction, BookedMark["state"]> = {
  accounting_payment_drafted: "drafted",
  accounting_payment_approved: "approved",
  accounting_payment_sent: "sent",
  accounting_payment_confirmed: "confirmed",
  accounting_payment_failed: "failed",
  accounting_payment_refused: "refused",
};

export interface BookedEntry {
  seq: number;
  ts: string;
  action: string;
  detail: Record<string, unknown>;
}

export interface BookedMark {
  provider: ProviderId;
  /** "Xero" */
  label: string;
  state: "drafted" | "approved" | "sent" | "confirmed" | "failed" | "refused";
  /** When it reached this state, and the entry that says so. */
  at: string;
  seq: number;
  /** The provider's payment id, once one is known. */
  paymentId: string | null;
  /** The account it was booked from, as `Name (code)`. */
  account: string | null;
  amount: string | null;
  currency: string | null;
  reason: string | null;
  message: string | null;
  /** Who approved it, by user id, and the entry that says so. */
  approvedBy: string | null;
  approvedSeq: number | null;
}

const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);

function accountWords(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const { name, code } = value as Record<string, unknown>;
  if (typeof name !== "string") return null;
  return typeof code === "string" && code ? `${name} (${code})` : name;
}

export function isBookingAction(action: string): action is BookingAction {
  return (BOOKING_ACTIONS as readonly string[]).includes(action);
}

/** The booking of one payable as its entries tell it; null when none is about it. */
export function bookingFromEntries(entries: readonly BookedEntry[], invoiceId: string): BookedMark | null {
  const own = entries.filter((entry) => isBookingAction(entry.action) && entry.detail.invoiceId === invoiceId).sort((a, b) => a.seq - b.seq);
  const latest = own.at(-1);
  if (!latest) return null;
  const provider = PROVIDERS.find((id) => id === latest.detail.provider) ?? "xero";
  const newest = (pick: (entry: BookedEntry) => unknown) => [...own].reverse().map(pick).find((value) => value !== null && value !== undefined) ?? null;
  const approved = [...own].reverse().find((entry) => entry.action === "accounting_payment_approved") ?? null;
  return {
    provider,
    label: PROVIDER_LABELS[provider],
    state: STATE_OF[latest.action as BookingAction],
    at: latest.ts,
    seq: latest.seq,
    paymentId: text(newest((entry) => text(entry.detail.paymentId))),
    account: (newest((entry) => accountWords(entry.detail.account)) as string | null) ?? null,
    amount: text(newest((entry) => text(entry.detail.amount))),
    currency: text(newest((entry) => text(entry.detail.currency))),
    reason: latest.action === "accounting_payment_refused" || latest.action === "accounting_payment_failed" ? text(latest.detail.reason) : null,
    message: latest.action === "accounting_payment_refused" || latest.action === "accounting_payment_failed" ? text(latest.detail.message) : null,
    approvedBy: approved ? text(approved.detail.by) : null,
    approvedSeq: approved?.seq ?? null,
  };
}

/** A payment id, short enough for a line: its first eight characters. */
export function shortPaymentId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

/** The card's badge, for a booking that reached the tool; none otherwise. */
export function bookedBadge(mark: BookedMark | null | undefined): string | null {
  if (!mark) return null;
  if (mark.state === "confirmed") return `Booked in ${mark.label}`;
  if (mark.state === "sent") return `Sent to ${mark.label}`;
  return null;
}

/** The last row of Where the payment is: its title and its line. */
export function bookedLine(mark: BookedMark): { title: string; text: string; reached: boolean } {
  const id = mark.paymentId ? ` (${mark.paymentId})` : "";
  switch (mark.state) {
    case "confirmed":
      return { title: `Booked in ${mark.label}`, text: `Payment${id}${mark.account ? ` from ${mark.account}` : ""}: stated by ${mark.label} when Vestiarion read it back.`, reached: true };
    case "sent":
      return { title: `Sent to ${mark.label}`, text: `${mark.label} took the payment${id}. Vestiarion reads it back at the next sync to confirm it.`, reached: true };
    case "approved":
      return { title: `Being booked in ${mark.label}`, text: `A person approved booking it; ${mark.label} has not answered yet.`, reached: false };
    case "drafted":
      return { title: `Not booked in ${mark.label} yet`, text: `Waiting for an owner or admin to review it under To book in ${mark.label} on Bills & receivables.`, reached: false };
    case "failed":
      return { title: `Not booked in ${mark.label} yet`, text: mark.message ?? `The last try did not book it. Approve it again on Bills & receivables.`, reached: false };
    case "refused":
      return { title: `Not booked in ${mark.label}`, text: mark.message ?? "Not booked.", reached: false };
  }
}
