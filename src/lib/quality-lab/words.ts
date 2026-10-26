import { ruleWords } from "@/lib/rule-words";
import type { QualityLabOutcome, QualityLabResult, QualityLabSummary } from "./judge";
import type { ShadowAction, ShadowVerdict } from "./shadow-export";
import type { ShadowAnswer, ShadowOutcome, ShadowReplayClass, ShadowReplayResult, ShadowReplaySummary } from "./shadow-replay";

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

/** Whether a scenario was right, as its table's last column says it: a wrong payment is named as one. */
export function rightWords(result: Pick<QualityLabResult, "right" | "wrongPayment">): string {
  if (result.wrongPayment) return "No: a wrong payment";
  return result.right ? "Yes" : "No";
}

/** "38 of 39 scenarios right". */
export function scoreWords(summary: QualityLabSummary): string {
  return `${summary.right} of ${summary.scenarios} scenarios right`;
}

/** "0 wrong payments", with the real number. */
export function wrongPaymentWords(count: number): string {
  return `${count} wrong payment${count === 1 ? "" : "s"}`;
}

// The replay of the team's shadow-mode decisions in words (docs/superpowers/specs/2026-10-26-quality-lab-shadow-
// replay-design.md SR10, SR11), the same on the result block, the docs page and its Markdown view.

/**
 * "46 real decisions from the team's own shadow-mode workspaces, replayed through today's code: 37 reach the same
 * outcome, 9 cannot be rebuilt from the record, 0 wrong payments.", with the real numbers and only the classes that are
 * not zero. The summary counts each decision once, a wrong payment only as one (`summarizeReplay`), so the parts add up
 * to the decisions and a stop code recorded while money moved is never said as stopped. It names no network, as the
 * block does not (QL7).
 */
export function shadowReplayWords(summary: ShadowReplaySummary): string {
  const one = (count: number, single: string, many: string) => `${count} ${count === 1 ? single : many}`;
  const parts = [
    summary.same > 0 ? one(summary.same, "reaches the same outcome", "reach the same outcome") : null,
    summary.nowStopped > 0 ? one(summary.nowStopped, "is now stopped by a rule that did not stop it then", "are now stopped by a rule that did not stop them then") : null,
    summary.nowLetThrough > 0 ? one(summary.nowLetThrough, "is now let through where code stopped it then", "are now let through where code stopped them then") : null,
    summary.cannotRebuild > 0 ? `${summary.cannotRebuild} cannot be rebuilt from the record` : null,
  ].filter((part): part is string => part !== null);
  const decisions = one(summary.decisions, "real decision", "real decisions");
  return `${decisions} from the team's own shadow-mode workspaces, replayed through today's code: ${[...parts, wrongPaymentWords(summary.wrongPayments)].join(", ")}.`;
}

const ANSWERED: Record<ShadowAction, string> = {
  pay: "Let through to pay",
  schedule: "Let through to schedule",
  hold: "Held, as the model answered",
  flag_fraud: "Flagged, as the model answered",
  request_info: "Information asked for, as the model answered",
};

/**
 * What code did with a decision, then or now: "Let through to pay", "Stopped because the payee had no address yet". A
 * stop code recorded while money moved all the same is said as that, never as stopped (shadow replay SR7).
 */
export function replayOutcomeWords(outcome: ShadowOutcome | null): string {
  if (!outcome) return "Not known";
  if (outcome.rule) {
    const because = ruleWords(outcome.rule) ?? `a check in code (${outcome.rule})`;
    return outcome.money === "moves" ? `Recorded as stopped because ${because}, but money moved` : `Stopped because ${because}`;
  }
  return ANSWERED[outcome.action];
}

/** The model's answer as the replay scripted it: "Pay now", "Schedule in 4 days". */
export function answerWords(answer: ShadowAnswer): string {
  switch (answer.action) {
    case "pay":
      return "Pay now";
    case "schedule":
      return answer.payOnInDays === null ? "Schedule" : `Schedule in ${answer.payOnInDays} day${answer.payOnInDays === 1 ? "" : "s"}`;
    case "hold":
      return "Hold";
    case "request_info":
      return "Ask for information";
    case "flag_fraud":
      return "Flag as fraud";
  }
}

/** The person's verdict: "Agreed", "Disagreed", or "None" when none was given. */
export function verdictWords(verdict: ShadowVerdict | null): string {
  return verdict === "agree" ? "Agreed" : verdict === "disagree" ? "Disagreed" : "None";
}

const CLASS_WORDS: Record<ShadowReplayClass, string> = {
  same: "Same",
  now_stopped: "Now stopped",
  now_let_through: "Now let through",
  cannot_rebuild: "Cannot rebuild",
};

/**
 * A decision's class with its reason, a wrong payment named as one: "Cannot rebuild. The payee's address changed...". A
 * wrong payment classed now stopped is a stop code recorded while money moved (shadow replay SR6, SR7): it is named only
 * as a wrong payment, never as stopped.
 */
export function replayClassWords(result: Pick<ShadowReplayResult, "class" | "reason" | "wrongPayment">): string {
  const head = !result.wrongPayment
    ? CLASS_WORDS[result.class]
    : result.class === "now_stopped"
      ? "A wrong payment"
      : `${CLASS_WORDS[result.class]}, a wrong payment`;
  return result.reason ? `${head}. ${result.reason}` : head;
}
