"use server";

import "server-only";

import { raiseCycleEvent } from "@/lib/agent/cycle-soon";
import { ApprovalPolicyError, changeTwoApprovals } from "@/lib/approval-policy";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { inOrg } from "@/lib/dal/scope";
import { twoApprovalsApplied } from "@/lib/policy-replay-apply";
import { RuleReplayError } from "@/lib/policy-replay-read";

/**
 * Sets, raises, lowers or turns off the figure above which a payment needs two approvals, from Settings
 * (docs/superpowers/specs/2026-10-05-two-approvals-design.md T1): an owner's alone. The library refuses what would leave
 * nothing payable and writes the signed entry. A figure raised or turned off may free a payment held for two approvals,
 * so the agent looks again within a minute; a tighter one frees nothing. Applied after trying it on past decisions, the
 * form carries the figure tried and the window, and the change is refused once the figure is no longer that one (policy
 * replay P10).
 */

export interface TwoApprovalsActionResult {
  ok: boolean;
  message: string;
}

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

export async function setTwoApprovalsAction(_previous: TwoApprovalsActionResult, formData: FormData): Promise<TwoApprovalsActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "approval.policy");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const applied = await twoApprovalsApplied(formData);
      const { from, to } = await changeTwoApprovals({
        actorId: auth.user.id,
        value: formString(formData, "above"),
        ...(applied ? { expected: applied.expected, replay: applied.replay } : {}),
      });
      revalidateOrgPages();
      if (to === null || (from !== null && to > from)) raiseCycleEvent(auth, "two_approvals_raised");
      return { ok: true, message: to === null ? "Two approvals are off: one approval pays any payment." : `Payments above ${to} USDC now need two approvals.` };
    } catch (error) {
      if (error instanceof ApprovalPolicyError || error instanceof RuleReplayError) return { ok: false, message: error.message };
      console.error("two approvals change failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: "That did not work. Try again in a moment." };
    }
  });
}
