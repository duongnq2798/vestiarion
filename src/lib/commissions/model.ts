import { amountWords, fromMicros, toMicros } from "../allocations/model";
import { plural } from "../copy";

/**
 * Commissions on money received, pure (docs/superpowers/specs/2026-10-14-commissions-design.md C2-C10): a plan as a
 * person types it, the commission's formula in words, and each partner's review (what is due now, what is still held,
 * what went into each payable, what is carried forward). Browser-safe: the plan form, the page and the server read the
 * same rules. Amounts are whole millionths, as `receivable_allocations` keeps them (allocations L4); currencies are
 * never added together.
 */

export type CommissionCurrency = "USDC" | "EURC";
export type CommissionBasis = "net" | "gross";
export type CommissionScope = "all_deals" | "chosen_deals";
export type CommissionSource = "payment" | "fee" | "whole_match";

/** The signed entries (C12), domain `ap`. */
export const COMMISSION_ACTIONS = {
  planSet: "commission_plan_set",
  planEnded: "commission_plan_ended",
  accrued: "commission_accrued",
  adjusted: "commission_adjusted",
  payableCreated: "commission_payable_created",
} as const;

export const HOLD_DAYS_DEFAULT = 30;
export const HOLD_DAYS_MAX = 365;
export const REFERENCE_MAX = 80;
/** 100% in basis points. */
export const RATE_BPS_MAX = 10_000;

const RATE = /^(\d{1,3})(?:\.(\d{1,2}))?$/;

/** A rate typed in percent ("10", "12.5", "0.01", "10%"), in basis points; null unless above 0 and at most 100. */
export function parseRate(typed: string): number | null {
  const match = RATE.exec(typed.trim().replace(/\s*%$/, ""));
  if (!match) return null;
  const bps = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return bps >= 1 && bps <= RATE_BPS_MAX ? bps : null;
}

/** A rate in basis points as people read it: 1000 is "10%", 1250 "12.5%", 1 "0.01%". */
export function ratePercent(bps: number): string {
  const whole = Math.floor(bps / 100);
  const cents = bps % 100;
  if (cents === 0) return `${whole}%`;
  return `${whole}.${String(cents).padStart(2, "0").replace(/0$/, "")}%`;
}

/** The rate as typed back into the form: "10", "12.5". */
export const rateTyped = (bps: number): string => ratePercent(bps).slice(0, -1);

/**
 * The commission on a base, in millionths: the base times the rate, rounded down to the millionth (C4), exactly as
 * `record_commissions` (0118) computes it. In BigInt, so no amount a business holds ever rounds on the way.
 */
export function commissionMicros(baseMicros: number, rateBps: number): number {
  return Number((BigInt(baseMicros) * BigInt(rateBps)) / BigInt(RATE_BPS_MAX));
}

export const BASIS_WORDS: Record<CommissionBasis, string> = {
  net: "Net: the money that arrived on Arc",
  gross: "Gross: also what was recorded as a fee on the invoice",
};

export interface PlanDraft {
  beneficiaryId: string;
  rateBps: number;
  basis: CommissionBasis;
  scope: CommissionScope;
  dealIds: string[];
  holdDays: number;
  reference: string | null;
  /** The workspace member who is this partner, when one is (C11). */
  memberId: string | null;
}

export type PlanFormField = "beneficiary" | "rate" | "basis" | "deals" | "holdDays" | "reference" | "member";

export type PlanFormRead = { ok: true; draft: PlanDraft } | { ok: false; field: PlanFormField; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PLAN_FORM_MESSAGES: Record<PlanFormField, string> = {
  beneficiary: "Choose who earns the commission.",
  rate: "Type a rate above 0 and up to 100, such as 10 or 12.5.",
  basis: "Choose net or gross.",
  deals: "Choose at least one deal, or cover every deal.",
  holdDays: `Type a whole number of days from 0 to ${HOLD_DAYS_MAX}.`,
  reference: `Keep the reference to ${REFERENCE_MAX} characters.`,
  member: "Choose a member of this workspace, or nobody.",
};

const refuse = (field: PlanFormField): PlanFormRead => ({ ok: false, field, message: PLAN_FORM_MESSAGES[field] });

/** The plan form, read the same in the browser and on the server (C2). */
export function parsePlanForm(input: {
  beneficiaryId: string;
  rate: string;
  basis: string;
  scope: string;
  dealIds: readonly string[];
  holdDays: string;
  reference: string;
  memberId: string;
}): PlanFormRead {
  if (!UUID.test(input.beneficiaryId.trim())) return refuse("beneficiary");
  const rateBps = parseRate(input.rate);
  if (rateBps === null) return refuse("rate");
  if (input.basis !== "net" && input.basis !== "gross") return refuse("basis");
  if (input.scope !== "all_deals" && input.scope !== "chosen_deals") return refuse("deals");
  const dealIds = [...new Set(input.dealIds.map((id) => id.trim()).filter((id) => UUID.test(id)))];
  if (input.scope === "chosen_deals" && dealIds.length === 0) return refuse("deals");
  const holdText = input.holdDays.trim() === "" ? String(HOLD_DAYS_DEFAULT) : input.holdDays.trim();
  if (!/^\d{1,3}$/.test(holdText) || Number(holdText) > HOLD_DAYS_MAX) return refuse("holdDays");
  const reference = input.reference.trim();
  if (reference.length > REFERENCE_MAX) return refuse("reference");
  const member = input.memberId.trim();
  if (member !== "" && member !== "none" && !UUID.test(member)) return refuse("member");
  return {
    ok: true,
    draft: {
      beneficiaryId: input.beneficiaryId.trim(),
      rateBps,
      basis: input.basis,
      scope: input.scope,
      dealIds: input.scope === "chosen_deals" ? dealIds : [],
      holdDays: Number(holdText),
      reference: reference === "" ? null : reference,
      memberId: member === "" || member === "none" ? null : member,
    },
  };
}

/** One version of a partner's plan (`commission_plans`). */
export interface CommissionPlan {
  id: string;
  beneficiaryId: string;
  memberId: string | null;
  rateBps: number;
  basis: CommissionBasis;
  scope: CommissionScope;
  dealIds: string[];
  holdDays: number;
  reference: string | null;
  startedAt: string;
  endedAt: string | null;
  replaces: string | null;
  createdBy: string | null;
}

/** An accrual or an adjustment (`commission_lines`), its amounts in millionths; an adjustment's amount is negative. */
export interface CommissionLine {
  id: string;
  kind: "accrual" | "adjustment";
  planId: string;
  beneficiaryId: string;
  invoiceId: string;
  dealId: string;
  source: CommissionSource;
  allocationId: string | null;
  transferId: string | null;
  adjusts: string | null;
  basis: CommissionBasis;
  base: number;
  rateBps: number;
  amount: number;
  currency: CommissionCurrency;
  appliedAt: string;
  dueAt: string;
  reason: "allocation_reversed" | "whole_match_released" | null;
  payoutId: string | null;
}

/** A payable made from a review (`commission_payouts`), with its payable's status now. */
export interface CommissionPayout {
  id: string;
  beneficiaryId: string;
  invoiceId: string;
  statement: string;
  currency: CommissionCurrency;
  amount: number;
  lineCount: number;
  createdBy: string | null;
  createdAt: string;
  /** The payable's status, or null when it was not read (deleted with its lines freed). */
  invoiceStatus: string | null;
}

/** The commission's formula, in words (C4): "300.00 USDC received × 10% = 30.00 USDC". */
export function formulaWords(line: Pick<CommissionLine, "kind" | "source" | "base" | "rateBps" | "amount" | "currency" | "reason">): string {
  const rate = ratePercent(line.rateBps);
  if (line.kind === "adjustment") {
    const why = line.reason === "whole_match_released" ? "the payment was unmatched from the invoice" : "the payment it was earned on was reversed";
    return `−${amountWords(-line.amount, line.currency)}: ${why} (${amountWords(line.base, line.currency)} × ${rate})`;
  }
  const what = line.source === "fee" ? "recorded as a fee on the invoice" : "received";
  return `${amountWords(line.base, line.currency)} ${what} × ${rate} = ${amountWords(line.amount, line.currency)}`;
}

/** A line is open while it is in no payout, or only in one whose payable was rejected (C10). */
export function lineOpen(line: Pick<CommissionLine, "payoutId">, payouts: ReadonlyMap<string, CommissionPayout>): boolean {
  if (!line.payoutId) return true;
  const payout = payouts.get(line.payoutId);
  return !payout || payout.invoiceStatus === "rejected";
}

export interface PartnerReview {
  beneficiaryId: string;
  currency: CommissionCurrency;
  /** Open lines past their hold window, oldest first: what a payable would pay. */
  due: CommissionLine[];
  dueTotal: number;
  /** Open lines still in their hold window, soonest due first. */
  held: CommissionLine[];
  heldTotal: number;
  /** When the next held line falls due, or null. */
  nextDueAt: string | null;
  /** Each payable made for this partner in this currency, newest first, with the lines it pays. */
  paidOut: Array<{ payout: CommissionPayout; lines: CommissionLine[] }>;
  /** What is due adds up to more than zero: a payable can be made. */
  payable: boolean;
  /** What is due adds up to less than zero: carried to the next payable (C7, C9). */
  carriedForward: number;
}

const byTime = (a: CommissionLine, b: CommissionLine, key: "appliedAt" | "dueAt") => a[key].localeCompare(b[key]) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id);

/** Each partner's commissions per currency, at `now` (C10). Partners in `order` first, in that order; then the rest. */
export function reviewCommissions(
  lines: readonly CommissionLine[],
  payouts: readonly CommissionPayout[],
  now: Date,
  order: readonly string[] = []
): PartnerReview[] {
  const payoutsById = new Map(payouts.map((payout) => [payout.id, payout]));
  const groups = new Map<string, PartnerReview>();
  const group = (beneficiaryId: string, currency: CommissionCurrency): PartnerReview => {
    const key = `${beneficiaryId}:${currency}`;
    let found = groups.get(key);
    if (!found) {
      found = { beneficiaryId, currency, due: [], dueTotal: 0, held: [], heldTotal: 0, nextDueAt: null, paidOut: [], payable: false, carriedForward: 0 };
      groups.set(key, found);
    }
    return found;
  };
  const at = now.getTime();
  const inPayout = new Map<string, CommissionLine[]>();
  for (const line of lines) {
    const review = group(line.beneficiaryId, line.currency);
    if (!lineOpen(line, payoutsById)) {
      inPayout.set(line.payoutId as string, [...(inPayout.get(line.payoutId as string) ?? []), line]);
      continue;
    }
    if (Date.parse(line.dueAt) <= at) review.due.push(line);
    else review.held.push(line);
  }
  for (const payout of payouts) {
    group(payout.beneficiaryId, payout.currency).paidOut.push({ payout, lines: (inPayout.get(payout.id) ?? []).sort((a, b) => byTime(a, b, "appliedAt")) });
  }
  for (const review of groups.values()) {
    review.due.sort((a, b) => byTime(a, b, "appliedAt"));
    review.held.sort((a, b) => byTime(a, b, "dueAt"));
    review.dueTotal = review.due.reduce((total, line) => total + line.amount, 0);
    review.heldTotal = review.held.reduce((total, line) => total + line.amount, 0);
    review.nextDueAt = review.held[0]?.dueAt ?? null;
    review.paidOut.sort((a, b) => b.payout.createdAt.localeCompare(a.payout.createdAt) || b.payout.id.localeCompare(a.payout.id));
    review.payable = review.due.length > 0 && review.dueTotal > 0;
    review.carriedForward = review.dueTotal < 0 ? review.dueTotal : 0;
  }
  const rank = (id: string) => {
    const index = order.indexOf(id);
    return index === -1 ? order.length : index;
  };
  return [...groups.values()].sort((a, b) => rank(a.beneficiaryId) - rank(b.beneficiaryId) || a.beneficiaryId.localeCompare(b.beneficiaryId) || a.currency.localeCompare(b.currency));
}

/** The payable's memo (C10): what it pays, in a line. The statement number is its purchase order. */
export function payableMemo(due: readonly Pick<CommissionLine, "kind">[], reference: string | null): string {
  const accruals = due.filter((line) => line.kind === "accrual").length;
  const adjustments = due.length - accruals;
  const parts = [
    accruals > 0 ? `${accruals} ${plural(accruals, "commission", "commissions")}` : "",
    adjustments > 0 ? `${adjustments} ${plural(adjustments, "adjustment", "adjustments")}` : "",
  ].filter(Boolean);
  const under = reference ? ` under ${reference}` : "";
  return `Commissions on money received: ${parts.join(" and ")}${under}`.slice(0, 280);
}

/** An amount in millionths as the number a signed entry carries. */
export const units = (micros: number): number => fromMicros(micros);
export { amountWords, toMicros };

export type CommissionErrorCode =
  | "not_ready"
  | "no_beneficiary"
  | "beneficiary_client"
  | "plan_changed"
  | "plan_not_found"
  | "beneficiary"
  | "no_deals"
  | "deal_not_found"
  | "member_not_found"
  | "changed"
  | "nothing_due";

export const COMMISSION_MESSAGES: Record<CommissionErrorCode, string> = {
  not_ready: "Commissions are not set up on this deployment yet.",
  no_beneficiary: "That partner is not on file in this workspace. Reload the page.",
  beneficiary_client: "A client pays this business, so it earns no commission. Choose a vendor or contractor.",
  plan_changed: "This plan changed a moment ago. Reload the page to see it as it is now.",
  plan_not_found: "That plan was not found. Reload the page.",
  beneficiary: "This commission is yours, so someone else sets its plan and creates its payable.",
  no_deals: PLAN_FORM_MESSAGES.deals,
  deal_not_found: "One of those deals is not in this workspace. Reload the page.",
  member_not_found: "That person is not a member of this workspace.",
  changed: "The commissions due changed since this page was read. Reload the page to see them as they are now.",
  nothing_due: "Nothing is due to pay: what is due adds up to zero or less, and is carried forward.",
};

export class CommissionError extends Error {
  constructor(readonly code: CommissionErrorCode) {
    super(COMMISSION_MESSAGES[code]);
    this.name = "CommissionError";
  }
}

type DbError = { code?: string; message?: string; details?: string } | null;

/** PostgREST's or Postgres's word that a table or a function of 0118 is not there yet. */
export function commissionsNotReady(error: DbError): boolean {
  if (!error) return false;
  if (["PGRST205", "PGRST202", "42P01", "42883"].includes(error.code ?? "")) return true;
  return /commission/.test(error.message ?? "") && /schema cache|does not exist|could not find/i.test(error.message ?? "");
}

/** The refusals of 0118's functions, by the word that starts each message. */
const DB_CODES: Record<string, CommissionErrorCode> = {
  commission_no_beneficiary: "no_beneficiary",
  commission_beneficiary_client: "beneficiary_client",
  commission_plan_changed: "plan_changed",
  commission_plan_not_found: "plan_not_found",
  commission_beneficiary: "beneficiary",
  commission_no_deals: "no_deals",
  commission_changed: "changed",
  commission_nothing_due: "nothing_due",
  commission_line_paid_out: "changed",
  commission_line_not_due: "changed",
};

/** A refusal of 0118 as one of ours; null for any other failure. */
export function commissionErrorFromDb(error: DbError): CommissionError | null {
  if (!error) return null;
  if (commissionsNotReady(error)) return new CommissionError("not_ready");
  const text = `${error.message ?? ""} ${error.details ?? ""}`;
  if (error.code === "23505" && /commission_plans_one_active/.test(text)) return new CommissionError("plan_changed");
  if (error.code === "23503" && /commission_plan_deals_deal_fkey/.test(text)) return new CommissionError("deal_not_found");
  if (error.code === "23503" && /commission_plans_beneficiary_fkey/.test(text)) return new CommissionError("no_beneficiary");
  const word = /^(\w+):/.exec(error.message ?? "")?.[1];
  const code = word ? DB_CODES[word] : undefined;
  return code ? new CommissionError(code) : null;
}
