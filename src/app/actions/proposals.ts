"use server";

import "server-only";

import { z } from "zod";
import { raiseCycleEvent } from "@/lib/agent/cycle-soon";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { CounterpartyLimitError } from "@/lib/counterparty-limit";
import { inOrg } from "@/lib/dal/scope";
import { acceptProposal, dismissProposal, ProposalError } from "@/lib/policy-proposals";

/**
 * The agent's suggestions in Approvals (docs/superpowers/specs/2026-10-02-limit-proposals-design.md
 * R4, R5): an owner or admin (`records.write`, as for any limit change) accepts or dismisses one.
 * Accepting raises the limit and starts a cycle, so held payments are decided again.
 */

export interface ProposalActionResult {
  ok: boolean;
  message: string;
}

const idSchema = z.string().uuid();

function failure(error: unknown, what: string): ProposalActionResult {
  if (error instanceof ProposalError || error instanceof CounterpartyLimitError) return { ok: false, message: error.message };
  console.error(what, error instanceof Error ? error.message : "unknown error");
  return { ok: false, message: "That did not work. Try again in a moment." };
}

export async function acceptProposalAction(_previous: ProposalActionResult, formData: FormData): Promise<ProposalActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  const id = idSchema.safeParse(formData.get("proposalId"));
  if (!id.success) return { ok: false, message: "That suggestion was not found." };
  return inOrg(auth, async () => {
    try {
      const accepted = await acceptProposal({ actorId: auth.user.id, id: id.data });
      revalidateOrgPages();
      if ((accepted.current ?? 0) > 0) raiseCycleEvent(auth, "limit_raised");
      return {
        ok: true,
        message:
          accepted.current === accepted.to
            ? `${accepted.counterpartyName}'s payment limit is now ${accepted.to} USDC. Payments held under the old one are decided again within a minute.`
            : `${accepted.counterpartyName}'s payment limit is now ${accepted.to} USDC; screening allows ${accepted.current} USDC for its risk.`,
      };
    } catch (error) {
      return failure(error, "proposal not accepted");
    }
  });
}

export async function dismissProposalAction(_previous: ProposalActionResult, formData: FormData): Promise<ProposalActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  const id = idSchema.safeParse(formData.get("proposalId"));
  if (!id.success) return { ok: false, message: "That suggestion was not found." };
  return inOrg(auth, async () => {
    try {
      const dismissed = await dismissProposal({ actorId: auth.user.id, id: id.data });
      revalidateOrgPages();
      return { ok: true, message: `Dismissed. The agent suggests a limit for ${dismissed.counterpartyName} again only after a new approval above it.` };
    } catch (error) {
      return failure(error, "proposal not dismissed");
    }
  });
}
