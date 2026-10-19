import { db, unwrap } from "../dal";
import { parseGitHubPullRequestUrl } from "../github-verification";
import type { MilestoneInput } from "../intake-validation";
import { appendLedgerEntry } from "../ledger";
import { paidAcrossChains } from "../payee-chains";
import type { Provenance } from "../provenance";

export type CreatedMilestone =
  | { ok: true; id: string; contractorName: string; pullRequest: boolean }
  | { ok: false; reason: "not_found" | "client" | "another_chain" };

/**
 * Records work a contractor is to be paid for, as a pending milestone of the workspace in scope (write API part 2,
 * W2): the one write behind the console's Add milestone form and `POST /api/v1/milestones`.
 *
 * - A GitHub pull request link is kept in its canonical form, so the cycle's GitHub check (`refreshGitHubMilestones`)
 *   verifies it once it is merged. Any other link is evidence for the person who verifies the work by hand.
 * - The milestone is the actor's (`created_by`), so a person cannot pay their own held milestone unless they are the
 *   workspace's only approver.
 * - `provenance` names the surface it came from in the ledger entry; the console passes none.
 *
 * Either way the agent pays only a verified milestone, and only after its own release decision and guardrails.
 */
export async function createMilestone(input: {
  actorId: string;
  milestone: MilestoneInput;
  provenance?: Provenance;
  /** The purchase order the work was agreed under (0111), from the console's form; never written when absent. */
  poReference?: string | null;
}): Promise<CreatedMilestone> {
  const { milestone } = input;
  // Scoped to the organization: another organization's counterparty id is answered exactly like one that does not exist.
  const lookup = await db()
    .from("counterparties")
    .select("id, name, role, chain")
    .eq("id", milestone.contractorId)
    .maybeSingle<{ id: string; name: string; role: string; chain: string | null }>();
  if (lookup.error) throw new Error(lookup.error.message);
  const contractor = lookup.data;
  if (!contractor) return { ok: false, reason: "not_found" };
  if (contractor.role === "client") return { ok: false, reason: "client" };
  // A milestone is released on the workspace's own chain (CCTP payouts review C1): a vendor paid on another chain would
  // be sent USDC on Arc at its address there, which it may never reach (mainnet Base payouts B4).
  if (paidAcrossChains(contractor.chain)) return { ok: false, reason: "another_chain" };

  const pullRequest = parseGitHubPullRequestUrl(milestone.evidence);
  const verificationSource = pullRequest?.url ?? milestone.evidence;
  const row = unwrap(
    await db()
      .from("milestones")
      .insert({
        contractor_id: contractor.id,
        title: milestone.title,
        amount: milestone.amount,
        verification_source: verificationSource,
        created_by: input.actorId,
        // Only when given: before migration 0111 there is no such column (project budgets P9).
        ...(input.poReference ? { po_reference: input.poReference } : {}),
      })
      .select("id")
      .single<{ id: string }>()
  );

  await appendLedgerEntry({
    actor: "human",
    domain: "contractor",
    action: "create_milestone",
    summary: `Added milestone “${milestone.title}” for ${contractor.name}: ${milestone.amount} USDC`,
    detail: {
      by: input.actorId,
      milestoneId: row.id,
      counterpartyId: contractor.id,
      counterpartyName: contractor.name,
      amount: milestone.amount,
      verificationSource,
      ...(input.poReference ? { poReference: input.poReference } : {}),
      ...input.provenance,
    },
  });
  return { ok: true, id: row.id, contractorName: contractor.name, pullRequest: pullRequest !== null };
}
