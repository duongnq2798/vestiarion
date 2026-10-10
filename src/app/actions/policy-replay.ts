"use server";

import "server-only";

import { authorize } from "@/lib/auth/authorize";
import type { Permission } from "@/lib/auth/roles";
import { inOrg } from "@/lib/dal/scope";
import type { RuleKind } from "@/lib/policy-replay";
import { RuleReplayError, ruleReplay, trialFromForm, type RuleReplayView } from "@/lib/policy-replay-read";

/**
 * Try it on past decisions (docs/superpowers/specs/2026-10-10-policy-replay-design.md P1): replays the code's checks on
 * the workspace's recorded decisions with a candidate figure, and changes nothing. Trying a setting asks for the
 * permission that changes it, so it is offered where the setting can be saved. Apply goes through the setting's own
 * action (`updateCounterpartyLimitAction`, `setTwoApprovalsAction`, `setAgentBudgetAction`).
 */

export type TryRuleResult = { ok: true; message: string; view: RuleReplayView } | { ok: false; message: string };

const PERMISSION: Record<RuleKind, Permission> = {
  counterparty_limit: "records.write",
  two_approvals: "approval.policy",
  spending_limit: "agent.budget",
};

export async function tryRuleAction(formData: FormData): Promise<TryRuleResult> {
  const trial = trialFromForm(formData);
  if (!trial) return { ok: false, message: "Choose a setting and a window of 30 or 90 days." };
  const auth = await authorize(formData.get("orgSlug"), PERMISSION[trial.rule]);
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async (): Promise<TryRuleResult> => {
    try {
      return { ok: true, message: "", view: await ruleReplay(trial) };
    } catch (error) {
      if (error instanceof RuleReplayError) return { ok: false, message: error.message };
      console.error("rule replay failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: "That did not work. Try again in a moment." };
    }
  });
}
