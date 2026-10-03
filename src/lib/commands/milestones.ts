import { closeMilestone, MilestoneDecisionError, payHeldMilestone } from "../agent/milestone-decisions";
import { sendNoticesSoon } from "../payment-notices-soon";
import { accessOf, provenanceOf, type Actor } from "./actor";
import { done, refused, type CommandOutcome, type Refused } from "./outcome";
import { gate } from "./policy";

/**
 * A person's decisions on a milestone the agent held (held milestone actions R2, R3; integrations design §9). The
 * release still passes the contractor's risk, limit and address checks inside `payHeldMilestone`.
 */

/** A `MilestoneDecisionError` carries a message safe to show; anything else goes to the server log. */
function decisionRefusal(error: unknown): Refused {
  if (error instanceof MilestoneDecisionError) return refused(error.code, error.message);
  console.error("milestone decision failed", error instanceof Error ? error.message : error);
  return refused("failed", "That did not work. Try again in a moment: nothing is sent twice.");
}

export async function payMilestoneNow(
  actor: Actor,
  input: { milestoneId: string }
): Promise<CommandOutcome<{ status: string; txRef: string | null }>> {
  const refusal = gate(actor, "milestone.pay");
  if (refusal) return refusal;
  let result: Awaited<ReturnType<typeof payHeldMilestone>>;
  try {
    result = await payHeldMilestone({ actorId: actor.userId, milestoneId: input.milestoneId, ...provenanceOf(actor) });
  } catch (error) {
    return decisionRefusal(error);
  }
  if (result.status === "paid") {
    sendNoticesSoon(accessOf(actor));
    return done("Paid.", { status: result.status, txRef: result.txRef });
  }
  if (result.status === "verified") return done("Payment submitted; waiting for Circle to confirm it.", { status: result.status, txRef: result.txRef });
  const reason = /\[(?:transfer|execution) failed:\s*(.+?)\]\s*$/.exec(result.note)?.[1] ?? /\[not paid:\s*(.+?)\]\s*$/.exec(result.note)?.[1];
  return refused("not_paid", reason ? `Not paid: ${reason}. The milestone is still held.` : "Not paid. The milestone is still held.", { changed: true });
}

export async function closeMilestoneUnpaid(actor: Actor, input: { milestoneId: string; reason: string }): Promise<CommandOutcome> {
  const refusal = gate(actor, "milestone.close");
  if (refusal) return refusal;
  try {
    await closeMilestone({ actorId: actor.userId, milestoneId: input.milestoneId, reason: input.reason, ...provenanceOf(actor) });
  } catch (error) {
    return decisionRefusal(error);
  }
  return done("Closed without paying.");
}
