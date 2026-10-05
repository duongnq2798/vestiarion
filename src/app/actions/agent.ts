"use server";

import "server-only";

import { AgentBudgetError, changeAgentBudget } from "@/lib/agent-budget";
import { raiseCycleEvent } from "@/lib/agent/cycle-soon";
import { authorize } from "@/lib/auth/authorize";
import { enforceSpendingLimit, SpendingLimitSetupError, turnOffSpendingLimit } from "@/lib/circle/spending-limit-setup";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { consoleActor } from "@/lib/commands/actor";
import { pauseWorkspaceAgent, resumeWorkspaceAgent, runWorkspaceCycle } from "@/lib/commands/agent";
import { inOrg } from "@/lib/dal/scope";
import { consoleAnswer } from "./command-result";
import { PaymentsDisabledError } from "@/lib/payments-switch";

export interface AgentActionResult {
  ok: boolean;
  message: string;
  day?: number;
  lines?: number;
}

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

/**
 * Run cycle, Pause and Resume. Each authorizes the session first, then runs the command every surface shares
 * (src/lib/commands/agent.ts); the cycle's sandbox cap is enforced inside begin_cycle_run (migration 0022).
 */
export async function runAgentCycleAction(orgSlug: string): Promise<AgentActionResult> {
  const auth = await authorize(orgSlug, "agent.run_cycle");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const outcome = await runWorkspaceCycle(consoleActor(auth));
    if (!outcome.ok) return { ok: false, message: outcome.message };
    revalidateOrgPages();
    return { ok: true, message: outcome.message, day: outcome.day, lines: outcome.lines };
  });
}

export async function pauseAgentAction(_previous: AgentActionResult, formData: FormData): Promise<AgentActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "agent.pause");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => consoleAnswer(await pauseWorkspaceAgent(consoleActor(auth), { reason: formString(formData, "reason") })));
}

export async function resumeAgentAction(_previous: AgentActionResult, formData: FormData): Promise<AgentActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "agent.resume");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => consoleAnswer(await resumeWorkspaceAgent(consoleActor(auth))));
}

/** What the agent may now pay on its own, as the form's answer says it. */
function budgetMessage(to: { dailyUsdc: number | null; weeklyUsdc: number | null }): string {
  if (to.dailyUsdc === null && to.weeklyUsdc === null) return "Spending limit removed. The agent pays within each counterparty's own limit.";
  if (to.weeklyUsdc === null) return `The agent may now pay up to ${to.dailyUsdc} USDC a day on its own, with no 7-day limit.`;
  if (to.dailyUsdc === null) return `The agent may now pay up to ${to.weeklyUsdc} USDC in 7 days on its own, with no daily limit.`;
  return `The agent may now pay up to ${to.dailyUsdc} USDC a day and ${to.weeklyUsdc} USDC in 7 days on its own.`;
}

/**
 * Sets the agent's spending limit (outflow budget spec R7). A looser limit may let a payment held
 * under the old one through, so the agent looks again within a minute; a tighter one frees nothing.
 */
export async function setAgentBudgetAction(_previous: AgentActionResult, formData: FormData): Promise<AgentActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "agent.budget");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const result = await changeAgentBudget({ actorId: auth.user.id, daily: formString(formData, "daily"), weekly: formString(formData, "weekly") });
      revalidateOrgPages();
      if (result.loosened) raiseCycleEvent(auth, "budget_raised");
      return { ok: true, message: budgetMessage(result.to) };
    } catch (error) {
      if (error instanceof AgentBudgetError) return { ok: false, message: error.message };
      console.error("agent budget change failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: "That did not work. Try again in a moment." };
    }
  });
}

const LIVE_ONLY = "Only a live workspace can enforce its limit on Arc: a sandbox's payments are simulated. Take this workspace live first.";

/**
 * Enforces the agent's spending limit on Arc (docs/superpowers/specs/2026-10-03-onchain-spending-limit-design.md R1,
 * R2): an owner's or admin's deliberate act, in a live workspace. Pressed again, it finishes a setup that was
 * interrupted; it never deploys twice.
 */
export async function enforceSpendingLimitAction(_previous: AgentActionResult, formData: FormData): Promise<AgentActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "agent.budget");
  if (!auth.ok) return { ok: false, message: auth.message };
  if (auth.membership.mode !== "live") return { ok: false, message: LIVE_ONLY };
  return inOrg(auth, async () => {
    try {
      const result = await enforceSpendingLimit({ actorId: auth.user.id });
      revalidateOrgPages();
      return {
        ok: true,
        message: result.alreadyEnforced
          ? "The limit is already enforced on Arc."
          : "The limit is enforced on Arc. The agent's own payments now go through its contract, which refuses anything past the limit.",
      };
    } catch (error) {
      if (error instanceof PaymentsDisabledError) return { ok: false, message: error.message };
      if (error instanceof SpendingLimitSetupError) {
        revalidateOrgPages();
        return { ok: false, message: error.message };
      }
      console.error("enforceSpendingLimitAction failed", error instanceof Error ? error.name : "unknown");
      return { ok: false, message: "Enforcing the limit on Arc did not finish. Try again: what was done is kept, and nothing is deployed twice." };
    }
  });
}

/** Stops enforcing the limit on Arc (R11): the operating wallet's approval goes to 0; the contract stays. */
export async function turnOffSpendingLimitAction(_previous: AgentActionResult, formData: FormData): Promise<AgentActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "agent.budget");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      await turnOffSpendingLimit({ actorId: auth.user.id });
      revalidateOrgPages();
      return { ok: true, message: "The limit is no longer enforced on Arc. The agent's payments are checked against it in code only." };
    } catch (error) {
      if (error instanceof SpendingLimitSetupError) return { ok: false, message: error.message };
      console.error("turnOffSpendingLimitAction failed", error instanceof Error ? error.name : "unknown");
      return { ok: false, message: "That did not work. Try again in a moment." };
    }
  });
}
