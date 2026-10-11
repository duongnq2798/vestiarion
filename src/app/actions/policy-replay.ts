"use server";

import "server-only";

import { authorize } from "@/lib/auth/authorize";
import { inOrg } from "@/lib/dal/scope";
import { RuleReplayError, ruleReplay, trialFromForm, type RuleReplayView } from "@/lib/policy-replay-read";

/**
 * Try it on past decisions (docs/superpowers/specs/2026-10-10-policy-replay-design.md P1): replays the code's checks on
 * the workspace's recorded decisions with a candidate figure, and changes nothing. Trying a setting asks for the
 * permission that changes it, so it is offered where the setting can be saved. Apply goes through the setting's own
 * action (`updateCounterpartyLimitAction`, `setTwoApprovalsAction`, `setAgentBudgetAction`).
 */

export type TryRuleResult = { ok: true; message: string; view: RuleReplayView } | { ok: false; message: string };

export async function tryRuleAction(formData: FormData): Promise<TryRuleResult> {
  const trial = trialFromForm(formData);
  if (!trial) return { ok: false, message: "Choose a setting and a window of 30 or 90 days." };
  // The permission that changes the setting: a counterparty's limit, two approvals, or the agent's spending limit.
  const slug = formData.get("orgSlug");
  const auth =
    trial.rule === "counterparty_limit"
      ? await authorize(slug, "records.write")
      : trial.rule === "two_approvals"
        ? await authorize(slug, "approval.policy")
        : await authorize(slug, "agent.budget");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      return { ok: true, message: "", view: await ruleReplay(trial) };
    } catch (error) {
      if (error instanceof RuleReplayError) return { ok: false, message: error.message };
      console.error("rule replay failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: "That did not work. Try again in a moment." };
    }
  });
}
