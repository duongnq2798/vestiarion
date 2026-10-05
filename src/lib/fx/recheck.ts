import { SWAP_COST_CAP_PERCENT } from "./swap-limits";
import { swapUnavailableForFx } from "./swap-service";

/**
 * When a EURC payable held for FX is decided again (docs/superpowers/specs/2026-10-05-fx-reevaluation-design.md).
 *
 * What held it is read from its latest decision's own ledger entry, never from the reasoning (F1). It is cleared by a
 * fresh quote crossing the one threshold that held it (F2): a rate where there was none, a swap where Circle gave
 * none, a swap within the cap, or a value within the counterparty's limit. A rate that moves without crossing one
 * changes nothing. After a reopen for FX the payable is not re-checked for 30 minutes (F5), so a route that comes and
 * goes cannot reopen it every few minutes. Pure: the cycle's follow-up stage and the watcher both use it.
 */

export type FxBlocker = "no_rate" | "no_swap" | "swap_cost" | "over_limit";
export type FxTrigger = "rate_available" | "swap_available" | "swap_cost_within_cap" | "value_within_limit";

const FX_TRIGGERS: readonly FxTrigger[] = ["rate_available", "swap_available", "swap_cost_within_cap", "value_within_limit"];

/** How long after a reopen for FX the payable is left alone (F5). */
export const FX_RECHECK_COOLDOWN_MS = 30 * 60_000;

/** The rules a held EURC payable may carry and still be held for FX alone: any other rule waits for its own fact. */
const FX_RULES = new Set(["fx.rate_unavailable", "fx.swap_cost_above_cap", "treasury.insufficient_eurc", "counterparty.payment_limit"]);

/** What held a EURC payable, from its latest decision (F1). */
export interface FxHold {
  blocker: FxBlocker;
  decisionSeq: number;
  /** What the decision chose: the model's or the policy's action, before any refusal by code. */
  action: string | null;
  guardrailRule: string | null;
  /** The payable's amount, in EURC. */
  amount: number;
  rate: number | null;
  usdcValue: number | null;
  swapCostPercent: number | null;
  /** The EURC a swap had to bring: what the payable needed beyond the wallet's EURC; null when that is not known. */
  eurcShort: number | null;
}

/** What a fresh quote says now; a field is null when it was not asked or not answered. */
export interface FxNow {
  rate: number | null;
  usdcValue: number | null;
  swapCostPercent: number | null;
  swapAvailable: boolean | null;
  quotedAt: string;
}

/** A blocker a fresh quote cleared: what the reopen records (F6). */
export interface FxChange {
  trigger: FxTrigger;
  sentence: string;
  before: { rate: number | null; usdcValue: number | null; swapCostPercent: number | null };
  after: { rate: number | null; usdcValue: number | null; swapCostPercent: number | null; quotedAt: string };
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const number = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const EPSILON = 0.0000005;

/** What held the EURC payable a decision entry left held, or null when nothing a quote can change held it (F1). */
export function fxHoldOf(entry: { seq: number; detail: Record<string, unknown> }): FxHold | null {
  const detail = entry.detail;
  // Only a EURC payable's decision records `fx`, the quote it was weighed at or null.
  if (!("fx" in detail)) return null;
  if (record(detail.execution)?.resultingStatus !== "held") return null;
  const guardrailRule = typeof detail.guardrailRule === "string" ? detail.guardrailRule : null;
  if (guardrailRule !== null && !FX_RULES.has(guardrailRule)) return null;
  const observed = record(detail.observed) ?? {};
  const amount = number(observed.amount);
  if (amount === null || amount <= 0) return null;

  const fx = record(detail.fx);
  const rate = number(fx?.rate);
  const usdcValue = number(detail.usdcValue);
  const limit = number(observed.paymentLimit);
  const eurcBalance = number(detail.eurcBalance);
  const eurcShort = eurcBalance === null ? null : Number(Math.max(0, amount - eurcBalance).toFixed(6));
  const offer = record(detail.swapOffer);
  const swapCostPercent = number(offer?.costPercent);
  const hold = (blocker: FxBlocker): FxHold => ({
    blocker,
    decisionSeq: entry.seq,
    action: typeof record(detail.decision)?.action === "string" ? (record(detail.decision)?.action as string) : null,
    guardrailRule,
    amount,
    rate,
    usdcValue,
    swapCostPercent,
    eurcShort,
  });

  if (detail.fx === null) return hold("no_rate");
  if (usdcValue !== null && limit !== null && usdcValue > limit + EPSILON) return hold("over_limit");
  // A swap can only be sized again with what the wallet was short of (a sandbox tracks no EURC).
  if (eurcShort === null || eurcShort <= 0) return null;
  if (swapCostPercent !== null && swapCostPercent > SWAP_COST_CAP_PERCENT) return hold("swap_cost");
  if (offer === null && swapUnavailableForFx(typeof detail.swapUnavailable === "string" ? detail.swapUnavailable : null)) return hold("no_swap");
  return null;
}

/** The blocker a fresh quote cleared, or null when none (F2). `limit` is the counterparty's limit now. */
export function fxChange(hold: FxHold, now: FxNow, limit: number | null): FxChange | null {
  const change = (trigger: FxTrigger, sentence: string): FxChange => ({
    trigger,
    sentence,
    before: { rate: hold.rate, usdcValue: hold.usdcValue, swapCostPercent: hold.swapCostPercent },
    after: { rate: now.rate, usdcValue: now.usdcValue, swapCostPercent: now.swapCostPercent, quotedAt: now.quotedAt },
  });
  switch (hold.blocker) {
    case "no_rate":
      if (now.rate === null || now.usdcValue === null) return null;
      return change(
        "rate_available",
        `a EURC rate is quoted again: ${hold.amount} EURC is worth ${now.usdcValue} USDC at ${now.rate} USDC per EURC, where there was none at the decision`
      );
    case "over_limit":
      if (now.usdcValue === null || (limit !== null && now.usdcValue > limit + EPSILON)) return null;
      return change(
        "value_within_limit",
        `at the new rate ${hold.amount} EURC is worth ${now.usdcValue} USDC, ${limit === null ? "with no limit set" : `within the ${limit} USDC limit`}, where it was ${hold.usdcValue} USDC at the decision`
      );
    case "swap_cost":
      if (now.swapAvailable !== true || now.swapCostPercent === null || now.swapCostPercent > SWAP_COST_CAP_PERCENT) return null;
      return change(
        "swap_cost_within_cap",
        `a USDC→EURC swap now costs ${now.swapCostPercent}% above the quoted rate, within the ${SWAP_COST_CAP_PERCENT}% cap, where it cost ${hold.swapCostPercent}% at the decision`
      );
    case "no_swap":
      if (now.swapAvailable !== true || now.swapCostPercent === null || now.swapCostPercent > SWAP_COST_CAP_PERCENT) return null;
      return change("swap_available", `a USDC→EURC swap is quoted again, at ${now.swapCostPercent}% above the quoted rate`);
  }
}

/** Whether a payable held for FX is due a re-check: never reopened for FX, or not within the last 30 minutes (F5). */
export function fxRecheckDue(lastFxReopen: string | null | undefined, now: number): boolean {
  if (!lastFxReopen) return true;
  const at = Date.parse(lastFxReopen);
  return !Number.isFinite(at) || now - at >= FX_RECHECK_COOLDOWN_MS;
}

/** When an invoice was last reopened for FX, from its ledger entries newest first; null when never. */
export function lastFxReopenAt(entries: ReadonlyArray<{ ts: string; action: string; detail: Record<string, unknown> }>): string | null {
  const reopened = entries.find(
    (entry) => entry.action === "invoice_reopened" && FX_TRIGGERS.includes(record(entry.detail.reevaluation)?.trigger as FxTrigger)
  );
  return reopened?.ts ?? null;
}
