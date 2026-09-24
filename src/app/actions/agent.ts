"use server";

import "server-only";

import { revalidatePath } from "next/cache";
import { runAgentCycle } from "@/lib/agent/orchestrator";
import { createAgentControlSession, hasAgentControlSession } from "@/lib/agent-session";

export interface AgentActionResult {
  ok: boolean;
  message: string;
  day?: number;
  lines?: number;
}

export async function unlockAgentControls(
  _previous: AgentActionResult,
  formData: FormData
): Promise<AgentActionResult> {
  const candidate = formData.get("agentToken");
  if (typeof candidate !== "string" || !(await createAgentControlSession(candidate))) {
    return { ok: false, message: "Invalid control token." };
  }
  revalidatePath("/console", "layout");
  return { ok: true, message: "Controls unlocked for one hour." };
}

export async function runAgentCycleAction(): Promise<AgentActionResult> {
  if (!(await hasAgentControlSession())) return { ok: false, message: "Control session expired." };

  try {
    const result = await runAgentCycle();
    revalidatePath("/console", "layout");
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
}
