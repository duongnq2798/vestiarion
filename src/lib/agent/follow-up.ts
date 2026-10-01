/**
 * The reflection step: what the agent does about decisions it already made.
 *
 * Until this existed, the AP loop selected only `pending` and `matched`. An
 * invoice the agent held or asked a question about left that set permanently.
 * It asked a vendor for a purchase order and then never looked again — no
 * reminder, no escalation, no notion of "I asked five cycles ago and nothing
 * arrived" — while the invoice went on counting against the liquidity buffer.
 * The agent was holding cash for obligations it had itself frozen and
 * forgotten. That is a reactive system, not an agentic one.
 *
 * Two things are deliberately kept apart here, because conflating them is how
 * a follow-up loop turns into a token-burning treadmill:
 *
 *   **Reopening** happens when the *facts changed*. The purchase order arrived,
 *   the goods were received, screening moved the risk tier, the limit was
 *   raised. There is something new to decide, so the invoice goes back into the
 *   decision loop and the model rules on it again.
 *
 *   **Escalating** happens when *nothing changed and time passed*. Re-running
 *   the same decision over identical facts would produce the identical answer
 *   at the cost of another model call, every cycle, forever. What is needed is
 *   not another verdict; it is telling a human that the question went
 *   unanswered.
 *
 * Pure and I/O-free: the caller supplies the invoice's present state and the
 * facts recorded at the time of the original decision — which the ledger
 * already stores in `detail.observed` — so the comparison is testable and the
 * same reasons are written to the ledger and rendered in the UI.
 */

import { currentConfig } from "../context";
import type { FollowUpConfig } from "../config";

export type { FollowUpConfig };

export interface FrozenInvoice {
  id: string;
  status: string;
  amount: number;
  /** USDC unless the invoice is in EURC; the payment limit is always USDC. */
  currency?: string;
  dueDate: string;
  /** When the agent last ruled on it. Null means it never did. */
  decidedAt: string | null;
  /** When a human was last told it was stuck. Null means never. */
  escalatedAt: string | null;
  poReference: string | null;
  goodsReceived: boolean;
  riskLevel: string;
  paymentLimit: number | null;
}

/** The facts as they stood when the decision was taken, from the ledger. */
export interface DecisionFacts {
  poReference: string | null;
  goodsReceived: boolean;
  riskLevel: string;
  paymentLimit: number | null;
}

export type FollowUpAction = "reopen" | "escalate" | "wait";

export interface FollowUpPlan {
  action: FollowUpAction;
  /** Plain-language account, written to the ledger verbatim. */
  reason: string;
  /** Each fact that moved since the decision. Empty when nothing changed. */
  changes: string[];
  ageDays: number | null;
  pastDue: boolean;
}

const DAY_MS = 86_400_000;

/** The current business's follow-up cadence. Validation lives in configFromEnv. */
export function followUpConfig(): FollowUpConfig {
  return currentConfig().followUp;
}

function ageInDays(since: string | null, now: number): number | null {
  if (!since) return null;
  const parsed = Date.parse(since);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, (now - parsed) / DAY_MS);
}

const describeLimit = (value: number | null) => (value == null ? "none" : `${value} USDC`);

/**
 * Which of the facts the decision rested on have moved since. Only these four
 * are compared, because these are the four the AP decision actually reasons
 * from; a changed memo is not grounds to re-open a payment question.
 */
export function factChanges(current: DecisionFacts, atDecision: DecisionFacts): string[] {
  const changes: string[] = [];

  if ((current.poReference ?? null) !== (atDecision.poReference ?? null)) {
    changes.push(
      atDecision.poReference == null
        ? `purchase order ${current.poReference} has since been supplied`
        : `purchase order changed from ${atDecision.poReference} to ${current.poReference ?? "none"}`
    );
  }
  if (current.goodsReceived !== atDecision.goodsReceived) {
    changes.push(
      current.goodsReceived
        ? "goods have since been confirmed received"
        : "goods receipt has been withdrawn"
    );
  }
  if (current.riskLevel !== atDecision.riskLevel) {
    changes.push(`counterparty risk moved ${atDecision.riskLevel} → ${current.riskLevel}`);
  }
  if (current.paymentLimit !== atDecision.paymentLimit) {
    changes.push(
      `payment limit moved ${describeLimit(atDecision.paymentLimit)} → ${describeLimit(current.paymentLimit)}`
    );
  }

  return changes;
}

export function planFollowUp(
  invoice: FrozenInvoice,
  atDecision: DecisionFacts | null,
  now: number,
  config: FollowUpConfig
): FollowUpPlan {
  const ageDays = ageInDays(invoice.decidedAt, now);
  const pastDue = Date.parse(invoice.dueDate) < now;
  const base = { ageDays, pastDue };

  // No recorded decision to compare against — the invoice was frozen by a path
  // that left no facts behind. Re-deciding once is the only way to learn
  // anything; guessing that nothing changed would be an assumption.
  if (!atDecision) {
    return {
      ...base,
      action: "reopen",
      changes: [],
      reason: "No recorded decision facts for this invoice, so it is returned to the decision loop rather than left frozen on an assumption.",
    };
  }

  const changes = factChanges(
    {
      poReference: invoice.poReference,
      goodsReceived: invoice.goodsReceived,
      riskLevel: invoice.riskLevel,
      paymentLimit: invoice.paymentLimit,
    },
    atDecision
  );

  if (changes.length > 0) {
    return {
      ...base,
      action: "reopen",
      changes,
      reason: `The evidence this decision rested on has changed: ${changes.join("; ")}. Returning it to the decision loop.`,
    };
  }

  const escalationAge = ageInDays(invoice.escalatedAt, now);
  // Already raised recently. Telling a human the same thing every cycle is how
  // an alert stops being read.
  if (escalationAge != null && escalationAge < config.reEscalateAfterDays) {
    return {
      ...base,
      action: "wait",
      changes: [],
      reason: `Already escalated ${escalationAge.toFixed(1)} day(s) ago and nothing has changed since; holding until the ${config.reEscalateAfterDays}-day re-escalation window.`,
    };
  }

  if (pastDue) {
    return {
      ...base,
      action: "escalate",
      changes: [],
      reason: `Past its ${invoice.dueDate.slice(0, 10)} due date and still ${invoice.status.replace("_", " ")} with no change in the evidence. ${invoice.amount} ${invoice.currency ?? "USDC"} needs a human decision.`,
    };
  }

  if (ageDays != null && ageDays >= config.staleAfterDays) {
    return {
      ...base,
      action: "escalate",
      changes: [],
      reason: `Has been ${invoice.status.replace("_", " ")} for ${ageDays.toFixed(1)} days with no change in the evidence. The question the agent raised has gone unanswered.`,
    };
  }

  return {
    ...base,
    action: "wait",
    changes: [],
    reason: ageDays == null
      ? "Awaiting its first decision."
      : `Decided ${ageDays.toFixed(1)} day(s) ago; not yet stale and no evidence has changed.`,
  };
}

/**
 * A contractor milestone the agent held. It has no approval inbox, so until
 * this a held milestone stayed held for good unless a person revoked its
 * verification and verified it again (milestone form T6, known limit).
 */
export interface HeldMilestone {
  id: string;
  title: string;
  amount: number;
  riskLevel: string;
  paymentLimit: number | null;
  verificationSource: string | null;
}

/** What the milestone decision rested on, from its ledger entry's `observed` and `execution`. */
export interface MilestoneDecisionFacts {
  riskLevel: string;
  paymentLimit: number | null;
  verificationSource: string | null;
  /** Held only because the agent was paused (`execution.heldBecause`), not by the model or a guardrail. */
  heldBecausePaused: boolean;
}

export interface MilestoneFollowUpPlan {
  action: "reopen" | "wait";
  reason: string;
  changes: string[];
}

/**
 * Whether a held milestone goes back to the decision loop. Only reopening:
 * a held milestone has no approval path to escalate to, and re-deciding
 * identical facts would repeat the same answer at the cost of a model call.
 * The facts compared are the ones the milestone decision reasons from, plus
 * the pause: a milestone held because the agent was paused is released by the
 * first cycle that runs after it resumes (a paused agent runs no cycle).
 */
export function planMilestoneFollowUp(milestone: HeldMilestone, atDecision: MilestoneDecisionFacts | null): MilestoneFollowUpPlan {
  if (!atDecision) {
    return {
      action: "reopen",
      changes: [],
      reason: "No recorded decision facts for this milestone, so it is returned to the decision loop rather than left held on an assumption.",
    };
  }

  const changes: string[] = [];
  if (milestone.riskLevel !== atDecision.riskLevel) {
    changes.push(`contractor risk moved ${atDecision.riskLevel} → ${milestone.riskLevel}`);
  }
  if (milestone.paymentLimit !== atDecision.paymentLimit) {
    changes.push(`payment limit moved ${describeLimit(atDecision.paymentLimit)} → ${describeLimit(milestone.paymentLimit)}`);
  }
  if ((milestone.verificationSource ?? null) !== (atDecision.verificationSource ?? null)) {
    changes.push(`evidence of the work is now ${milestone.verificationSource ?? "none"}`);
  }
  if (atDecision.heldBecausePaused) {
    changes.push("the agent was paused when it was held, and is running again");
  }

  if (changes.length > 0) {
    return {
      action: "reopen",
      changes,
      reason: `The evidence this decision rested on has changed: ${changes.join("; ")}. Returning it to the decision loop.`,
    };
  }
  return { action: "wait", changes: [], reason: "Held, and nothing it rested on has changed since." };
}
