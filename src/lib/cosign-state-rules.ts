import { needsTwoApprovals, type WeighedPayment } from "./two-approvals";

/**
 * Whether an accountant can co-sign a bill now (docs/superpowers/specs/2026-10-22-accountant-queue-design.md AQ1), as a
 * rule that touches no database: the states, the reasons in words, and `cosignState`. Pure, so the approval card imports
 * them without the server's modules; ./cosign-state re-exports them beside the read of their facts.
 */

/** Why a bill above the figure cannot be co-signed yet, in the order `approveAndPay` refuses them. */
export const COSIGN_BLOCKED = {
  verdict: "Waiting for a verdict in shadow mode",
  disagreed: "Someone disagreed with it in shadow mode",
  deciding: "Being decided right now",
  high_risk: "Screened high risk",
  no_address: "The payee has no payment address yet",
  frozen: "The payee is frozen",
  unconfirmed: "Confirm the address first",
  cooling: "Waiting for the payee lock's wait to end",
} as const;

export type CosignBlockedReason = (typeof COSIGN_BLOCKED)[keyof typeof COSIGN_BLOCKED];

export type CosignState =
  /** One of its two approvals is still to give, and the viewer may give it: the figure, and how many others gave one (0 or 1). */
  | { state: "can_cosign"; above: number; approvals: number }
  /** The viewer's co-sign stands. */
  | { state: "cosigned" }
  /** One approval pays it, its transfer was already sent, or the approvals that stand already let it be paid. */
  | { state: "not_needed" }
  | { state: "blocked"; reason: CosignBlockedReason };

/** What `cosignState` weighs about one bill. */
export interface CosignFacts {
  /** The workspace's figure for two approvals; null when it has none. */
  above: number | null;
  /** The bill, weighed as the agent weighs it: a EURC bill by its recorded USDC value, unknown counted above. */
  payment: WeighedPayment;
  /** A transfer for it exists, so approving it only records it, on one approval. */
  sent: boolean;
  /** The approvals that stand, and whether each is a co-signing accountant's. */
  approvals: ReadonlyArray<{ by: string; cosign: boolean }>;
  /** Its newest decision waits for a shadow-mode verdict, or one was given and disagreed. */
  verdict: "waiting" | "disagreed" | null;
  /** Someone's claim on it is in progress. */
  deciding: boolean;
  riskLevel: string | null;
  /** Payments are real here, and the payee has neither an address nor a bank account (counterparty.no_address). */
  noAddress: boolean;
  frozen: boolean;
  /** What the payee lock holds it for: an address to confirm, or a wait after a change. */
  lock: "unconfirmed" | "cooling" | null;
}

/**
 * The rule (AQ1). Not needed below the figure, once a transfer exists, or when the approvals that stand already pay it:
 * two of them, or one by another accountant, since accountants fill one of the two approvals at most. Otherwise the
 * viewer's own co-sign, then what `approveAndPay` would refuse, in its order, and only then a co-sign to give.
 */
export function cosignState(facts: CosignFacts, viewerId: string): CosignState {
  if (facts.sent || !needsTwoApprovals(facts.payment, facts.above)) return { state: "not_needed" };
  if (facts.approvals.some((approval) => approval.by === viewerId)) return { state: "cosigned" };
  const others = facts.approvals.filter((approval) => approval.by !== viewerId);
  if (others.length >= 2 || others.some((approval) => approval.cosign)) return { state: "not_needed" };
  const blocked = (reason: CosignBlockedReason): CosignState => ({ state: "blocked", reason });
  if (facts.verdict === "waiting") return blocked(COSIGN_BLOCKED.verdict);
  if (facts.verdict === "disagreed") return blocked(COSIGN_BLOCKED.disagreed);
  if (facts.deciding) return blocked(COSIGN_BLOCKED.deciding);
  if (facts.riskLevel === "high") return blocked(COSIGN_BLOCKED.high_risk);
  if (facts.noAddress) return blocked(COSIGN_BLOCKED.no_address);
  if (facts.frozen) return blocked(COSIGN_BLOCKED.frozen);
  if (facts.lock === "unconfirmed") return blocked(COSIGN_BLOCKED.unconfirmed);
  if (facts.lock === "cooling") return blocked(COSIGN_BLOCKED.cooling);
  return { state: "can_cosign", above: facts.above as number, approvals: others.length };
}
