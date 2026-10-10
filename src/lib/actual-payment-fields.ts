/**
 * What a record of a payment the business made outside Vestiarion holds, and how each field is read
 * (docs/superpowers/specs/2026-10-10-actual-payments-design.md A1, A2). Browser-safe: the form checks what the server
 * checks again, with the same words.
 */

export const ACTUAL_METHODS = ["bank_transfer", "card", "cash", "other"] as const;
export type ActualMethod = (typeof ACTUAL_METHODS)[number];

/** Each method in words, for the form and the comparison. */
export const METHOD_WORDS: Record<ActualMethod, string> = {
  bank_transfer: "Bank transfer",
  card: "Card",
  cash: "Cash",
  other: "Other",
};

export const REFERENCE_MAX = 140;
export const NOTE_MAX = 280;
export const REASON_MAX = 280;

/** One row of `payment_actuals` (0090): what the business paid, or that it did not, as a member recorded it. */
export interface ActualRecord {
  id: string;
  invoiceId: string;
  outcome: "paid" | "not_paid";
  /** The day paid, YYYY-MM-DD; null when not paid. */
  paidOn: string | null;
  amount: number | null;
  currency: string | null;
  method: ActualMethod | null;
  reference: string | null;
  note: string | null;
  /** Why it was not paid; null when paid. */
  reason: string | null;
  /** The record this one corrects. */
  replaces: string | null;
  source: "form" | "csv";
  recordedBy: string | null;
  recordedAt: string;
}

/** A currency as paid, in capitals: three letters, or USDC or EURC. Null otherwise. */
export function actualCurrency(typed: string): string | null {
  const code = typed.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) || code === "USDC" || code === "EURC" ? code : null;
}

export function isActualMethod(value: unknown): value is ActualMethod {
  return typeof value === "string" && (ACTUAL_METHODS as readonly string[]).includes(value);
}

/** A method as typed in a CSV: its code or its words, any case; blank is other. Null when it is neither. */
export function actualMethod(typed: string): ActualMethod | null {
  const text = typed.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (text === "") return "other";
  if (isActualMethod(text)) return text;
  if (text === "bank" || text === "transfer" || text === "wire") return "bank_transfer";
  return null;
}

/**
 * A paid day as typed, YYYY-MM-DD, that is a real day, not before 2000 and not after `today` (UTC) plus one day, for
 * a business a day ahead of UTC. Null otherwise.
 */
export function paidDay(typed: string, today: string): string | null {
  const day = typed.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const at = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(at) || new Date(at).toISOString().slice(0, 10) !== day) return null;
  const latest = Date.parse(`${today}T00:00:00Z`) + 86_400_000;
  return day >= "2000-01-01" && at <= latest ? day : null;
}
