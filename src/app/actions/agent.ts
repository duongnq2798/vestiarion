"use server";

import "server-only";

import { agentCycleSuccessMessage, runAgentCycle } from "@/lib/agent/orchestrator";
import { AgentPausedError } from "@/lib/agent/pause";
import { SANDBOX_DAILY_CYCLES, SandboxCapReachedError } from "@/lib/agent/sandbox-cap";
import { authorize } from "@/lib/auth/authorize";
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
      });
      revalidateOrgPages();
      return {
        ok: true,
        message: agentCycleSuccessMessage(result),
        day: result.day,
        lines: result.lines.length,
      };
    } catch (error) {
      if (error instanceof SandboxCapReachedError || error instanceof AgentPausedError) {
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
      return { ok: true, message: "Agent resumed." };
    } catch (error) {
      if (error instanceof PauseError) return { ok: false, message: error.message };
      console.error("resume agent failed", error);
      return { ok: false, message: "That did not work. Try again in a moment." };
    }
  });
}
