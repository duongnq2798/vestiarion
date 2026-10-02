"use server";

import "server-only";

import { AgentBudgetError, changeAgentBudget } from "@/lib/agent-budget";
import { agentCycleSuccessMessage, runAgentCycle } from "@/lib/agent/orchestrator";
import { CycleRunningError } from "@/lib/agent/cycle-running";
import { AgentPausedError } from "@/lib/agent/pause";
import { SANDBOX_DAILY_CYCLES, SandboxCapReachedError } from "@/lib/agent/sandbox-cap";
import { raiseCycleEvent } from "@/lib/agent/cycle-soon";
import { authorize } from "@/lib/auth/authorize";
import { enforceSpendingLimit, SpendingLimitSetupError, turnOffSpendingLimit } from "@/lib/circle/spending-limit-setup";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { inOrg } from "@/lib/dal/scope";
import { pauseAgent, PauseError, resumeAgent } from "@/lib/platform/pause";

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

export async function runAgentCycleAction(orgSlug: string): Promise<AgentActionResult> {
  const auth = await authorize(orgSlug, "agent.run_cycle");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      // The cap itself is enforced inside begin_cycle_run (migration 0022);
      // this only tells it which organizations are capped at all.
      const result = await runAgentCycle({
        triggeredBy: auth.user.id,
        dailyCap: auth.membership.mode === "sandbox" ? SANDBOX_DAILY_CYCLES : undefined,
        trigger: { kind: "manual" },
      });
      revalidateOrgPages();
      return {
        ok: true,
        message: agentCycleSuccessMessage(result),
        day: result.day,
        lines: result.lines.length,
      };
    } catch (error) {
      if (error instanceof SandboxCapReachedError || error instanceof AgentPausedError || error instanceof CycleRunningError) {
        return { ok: false, message: error.message };
      }
      console.error("agent cycle failed", error);
      return { ok: false, message: error instanceof Error ? error.message : "The agent cycle did not complete." };
    }
  });
}

export async function pauseAgentAction(_previous: AgentActionResult, formData: FormData): Promise<AgentActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "agent.pause");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      await pauseAgent({ orgId: auth.membership.orgId, actorId: auth.user.id, reason: formString(formData, "reason") });
      revalidateOrgPages();
      return { ok: true, message: "Agent paused." };
    } catch (error) {
      if (error instanceof PauseError) return { ok: false, message: error.message };
      console.error("pause agent failed", error);
      return { ok: false, message: "That did not work. Try again in a moment." };
    }
  });
}

export async function resumeAgentAction(_previous: AgentActionResult, formData: FormData): Promise<AgentActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "agent.resume");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      await resumeAgent({ orgId: auth.membership.orgId, actorId: auth.user.id });
      revalidateOrgPages();
      raiseCycleEvent(auth, "agent_resumed");
      return { ok: true, message: "Agent resumed." };
    } catch (error) {
      if (error instanceof PauseError) return { ok: false, message: error.message };
      console.error("resume agent failed", error);
      return { ok: false, message: "That did not work. Try again in a moment." };
    }
  });
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
