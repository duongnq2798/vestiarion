"use server";

import "server-only";

import { runAgentCycle } from "@/lib/agent/orchestrator";
import { SANDBOX_DAILY_CYCLES, sandboxCyclesUsedToday } from "@/lib/agent/sandbox-cap";
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
      if (auth.membership.mode === "sandbox" && (await sandboxCyclesUsedToday()) >= SANDBOX_DAILY_CYCLES) {
        return { ok: false, message: "This sandbox has run its 20 cycles for today (UTC). It resets at midnight UTC." };
      }
      const result = await runAgentCycle({ triggeredBy: auth.user.id });
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
      console.error("agent cycle failed", error);
      return { ok: false, message: error instanceof Error ? error.message : "The agent cycle did not complete." };
    }
  });
}
