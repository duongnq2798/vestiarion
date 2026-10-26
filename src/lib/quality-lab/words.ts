import { ruleWords } from "@/lib/rule-words";
import type { QualityLabOutcome, QualityLabSummary } from "./judge";

/**
 * The Quality Lab's outcomes in words (docs/superpowers/specs/2026-10-26-quality-lab-design.md QL7, QL8), the same on
 * the result block, the docs page and the page's Markdown view: what happened to the bill, why, and what was sent.
 */

const STATUS_WORDS: Record<string, string> = {
  paid: "Paid",
  scheduled: "Scheduled",
  matched: "Sent, not yet confirmed",
  held: "Held",
  flagged: "Flagged",
  awaiting_info: "Waiting for information",
};

/** Why a decision was held when no rule held it (`execution.heldBecause`). */
const HELD_BECAUSE_WORDS: Record<string, string> = {
  agent_paused: "the agent was paused",
  shadow_verdict: "shadow mode waits for a person's verdict",
};

function transferWords(outcome: QualityLabOutcome): string {
  if (outcome.transfers === 0) return outcome.status === "scheduled" ? "no transfer yet" : "no transfer";
  return outcome.transfers === 1 ? "one transfer" : `${outcome.transfers} transfers`;
}

/** "Held because the payee was screened high risk; no transfer", "Paid; one transfer". */
export function outcomeWords(outcome: QualityLabOutcome): string {
  const status = STATUS_WORDS[outcome.status] ?? outcome.status;
  const reason = ruleWords(outcome.rule) ?? (outcome.heldBecause ? (HELD_BECAUSE_WORDS[outcome.heldBecause] ?? null) : null);
  const stopped = outcome.status === "held" || outcome.status === "flagged";
  const head = reason ? `${status} because ${reason}` : stopped ? `${status} for a person` : status;
  return `${head}; ${transferWords(outcome)}`;
}

/** "38 of 39 scenarios right". */
export function scoreWords(summary: QualityLabSummary): string {
  return `${summary.right} of ${summary.scenarios} scenarios right`;
}

/** "0 wrong payments", with the real number. */
export function wrongPaymentWords(count: number): string {
  return `${count} wrong payment${count === 1 ? "" : "s"}`;
}
