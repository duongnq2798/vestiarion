import { runCycleSoon } from "../agent/cycle-soon";
import { closeMilestone, MilestoneDecisionError, payHeldMilestone } from "../agent/milestone-decisions";
import { currentConfig } from "../context";
import type { MilestoneInput } from "../intake-validation";
import { createMilestone, type CreatedMilestone } from "../milestones/create";
import { sendNoticesSoon } from "../payment-notices-soon";
import { accessOf, cycleEventOf, provenanceOf, type Actor } from "./actor";
import { done, refused, type CommandOutcome, type Refused } from "./outcome";
import { gate } from "./policy";
import { APPROVAL_RECORDED } from "../two-approvals";

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
  // Above the workspace's figure, the first of two approvals is recorded and sends nothing (two approvals T4, T8).
  if (result.status === "approved") return done(APPROVAL_RECORDED, { status: result.status, txRef: null });
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

/**
 * Adds work a contractor is to be paid for, as the actor's pending milestone (write API part 2, W2, W4): the console's
 * Add milestone form and `POST /api/v1/milestones`. A GitHub pull request is checked by the cycle's GitHub check, which
 * needs a token: without one it only reports itself unavailable, so a cycle starts, and the check is promised, only
 * with one. Anything else waits for a person to verify the work on Contractors.
 */
export async function addMilestone(
  actor: Actor,
  input: { milestone: MilestoneInput }
): Promise<CommandOutcome<{ milestoneId: string; contractorName: string }>> {
  const refusal = gate(actor, "milestone.add");
  if (refusal) return refusal;
  let created: CreatedMilestone;
  try {
    created = await createMilestone({ actorId: actor.userId, milestone: input.milestone, ...provenanceOf(actor) });
  } catch (error) {
    console.error("adding a milestone failed", actor.orgId, error instanceof Error ? error.message : "unknown error");
    return refused("failed", "The milestone could not be added. Try again in a moment.");
  }
  if (!created.ok) {
    return created.reason === "client"
      ? refused("client", "A client is not paid for milestones. Choose a contractor or vendor.")
      : refused("contractor_not_found", "Contractor not found.");
  }
  const added = { milestoneId: created.id, contractorName: created.contractorName };
  if (created.pullRequest && currentConfig().githubToken) {
    runCycleSoon(cycleEventOf(actor, "milestone_added"));
    return done(`Milestone added for ${created.contractorName}. The agent checks the pull request within a minute, and decides on pay once it is merged.`, added);
  }
  return done(`Milestone added for ${created.contractorName}. Verify it once the work is delivered, and the agent decides on pay within a minute.`, added);
}
