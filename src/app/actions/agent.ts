"use server";

import "server-only";

import { runAgentCycle } from "@/lib/agent/orchestrator";
import { authorizeMutation } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { inOrg } from "@/lib/dal/scope";

export interface AgentActionResult {
  ok: boolean;
  message: string;
  day?: number;
  lines?: number;
}

export async function runAgentCycleAction(orgSlug: string): Promise<AgentActionResult> {
  const auth = await authorizeMutation(orgSlug);
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
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
