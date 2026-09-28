"use server";

import "server-only";

import { runAgentCycle } from "@/lib/agent/orchestrator";
import { SANDBOX_DAILY_CYCLES, SandboxCapReachedError } from "@/lib/agent/sandbox-cap";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { inOrg } from "@/lib/dal/scope";

export interface AgentActionResult {
  ok: boolean;
  message: string;
  day?: number;
  lines?: number;
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
        message: result.clockMode === "simulate"
          ? `Day ${result.day} complete · ${result.lines.length} decisions logged.`
          : `Cycle complete at ${new Date(result.finishedAt).toLocaleString()} · ${result.lines.length} decisions logged.`,
        day: result.day,
        lines: result.lines.length,
      };
    } catch (error) {
      if (error instanceof SandboxCapReachedError) {
        return { ok: false, message: error.message };
      }
      console.error("agent cycle failed", error);
      return { ok: false, message: error instanceof Error ? error.message : "The agent cycle did not complete." };
    }
  });
}
