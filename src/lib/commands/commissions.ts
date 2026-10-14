import { runCycleSoon } from "../agent/cycle-soon";
import { amountWords, CommissionError, ratePercent, type CommissionCurrency, type PlanDraft } from "../commissions/model";
import { createPayable, endPlan, setPlan } from "../commissions/write";
import { listMembers } from "../platform/members";
import { cycleEventOf, type Actor } from "./actor";
import { done, refused, TRY_AGAIN, type CommandOutcome, type Refused } from "./outcome";
import { gate } from "./policy";

/**
 * Commissions on money received (docs/superpowers/specs/2026-10-14-commissions-design.md C2, C10, C11, C13): setting a
 * partner's plan, ending it, and creating the payable for what a partner is due. Each is entering a record, as adding a
 * bill is (`records.write`, owners and admins), from the console. A partner a plan names as a member never does any of
 * them for their own commission: the database refuses it, and the refusal reads in plain words.
 */

/** A refusal in the commission's own words; one about a page that changed refreshes it. Anything else is logged. */
function refusalOf(error: unknown, what: string, actor: Actor): Refused {
  if (error instanceof CommissionError) {
    return refused(error.code, error.message, ["plan_changed", "plan_not_found", "changed", "nothing_due"].includes(error.code) ? { changed: true } : {});
  }
  console.error(what, actor.orgId, error instanceof Error ? error.message : "unknown error");
  return refused("failed", TRY_AGAIN);
}

/** Sets a partner's plan, or changes the one in force (`replaces`), as its next version. */
export async function setCommissionPlan(actor: Actor, input: { draft: PlanDraft; replaces: string | null }): Promise<CommandOutcome<{ planId: string }>> {
  const refusal = gate(actor, "commission.set_plan");
  if (refusal) return refusal;
  try {
    // The member named as this partner must be one of the workspace's (C11).
    if (input.draft.memberId) {
      const members = await listMembers(actor.orgId);
      if (!members.some((member) => member.userId === input.draft.memberId)) throw new CommissionError("member_not_found");
    }
    const { plan, partner } = await setPlan({ actorId: actor.userId, draft: input.draft, replaces: input.replaces });
    const deals = plan.scope === "all_deals" ? "every deal" : `${plan.dealIds.length} ${plan.dealIds.length === 1 ? "deal" : "deals"}`;
    return done(`${input.replaces ? "Changed" : "Set"} the plan of ${partner}: ${ratePercent(plan.rateBps)} ${plan.basis} on ${deals}, paid ${plan.holdDays} days after the money is applied.`, {
      planId: plan.id,
    });
  } catch (error) {
    return refusalOf(error, "setting a commission plan failed", actor);
  }
}

/** Ends a partner's plan: what it earned stays, and money applied from now on earns nothing under it. */
export async function endCommissionPlan(actor: Actor, input: { planId: string }): Promise<CommandOutcome> {
  const refusal = gate(actor, "commission.end_plan");
  if (refusal) return refusal;
  try {
    const { partner } = await endPlan({ actorId: actor.userId, planId: input.planId });
    return done(`Ended the plan of ${partner}. What it earned so far stays to review.`);
  } catch (error) {
    return refusalOf(error, "ending a commission plan failed", actor);
  }
}

/** Creates one payable for exactly the commissions shown as due for a partner; the agent decides it within seconds. */
export async function createCommissionPayable(
  actor: Actor,
  input: { beneficiaryId: string; currency: CommissionCurrency; lineIds: string[] }
): Promise<CommandOutcome<{ invoiceId: string; statement: string }>> {
  const refusal = gate(actor, "commission.create_payable");
  if (refusal) return refusal;
  try {
    const made = await createPayable({ actorId: actor.userId, beneficiaryId: input.beneficiaryId, currency: input.currency, lineIds: input.lineIds });
    // A payable gives the agent a decision to make, as an invoice added does.
    runCycleSoon(cycleEventOf(actor, "invoice_added"));
    return done(`Created a payable of ${amountWords(Math.round(made.amount * 1_000_000), made.currency)} for ${made.partner} (${made.statement}). The agent decides it like any other bill.`, {
      invoiceId: made.invoiceId,
      statement: made.statement,
    });
  } catch (error) {
    return refusalOf(error, "creating a commission payable failed", actor);
  }
}
