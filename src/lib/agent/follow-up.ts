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

export interface FrozenInvoice {
  id: string;
  status: string;
  amount: number;
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

export interface FollowUpConfig {
  /** Days a frozen invoice may sit unchanged before a human is told. */
  staleAfterDays: number;
  /** Days before the same invoice may be escalated again. */
  reEscalateAfterDays: number;
}

const DAY_MS = 86_400_000;

export function followUpConfig(): FollowUpConfig {
  const stale = Number(process.env.FOLLOW_UP_STALE_DAYS ?? 3);
  const reEscalate = Number(process.env.FOLLOW_UP_RE_ESCALATE_DAYS ?? 7);
  return {
    staleAfterDays: Number.isFinite(stale) && stale > 0 ? stale : 3,
    reEscalateAfterDays: Number.isFinite(reEscalate) && reEscalate > 0 ? reEscalate : 7,
  };
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
      reason: `Past its ${invoice.dueDate.slice(0, 10)} due date and still ${invoice.status.replace("_", " ")} with no change in the evidence. ${invoice.amount} USDC needs a human decision.`,
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
