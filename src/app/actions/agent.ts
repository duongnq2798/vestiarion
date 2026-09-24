"use server";

import "server-only";

import { revalidatePath } from "next/cache";
import { runAgentCycle } from "@/lib/agent/orchestrator";
import { evaluateResetGuard } from "@/lib/agent-security";
import { createAgentControlSession, hasAgentControlSession } from "@/lib/agent-session";
import { seedDatabase } from "@/lib/seed";

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
  revalidatePath("/", "layout");
  return { ok: true, message: "Controls unlocked for one hour." };
}

export async function runAgentCycleAction(): Promise<AgentActionResult> {
  if (!(await hasAgentControlSession())) return { ok: false, message: "Control session expired." };

  try {
    const result = await runAgentCycle();
    revalidatePath("/", "layout");
    return {
      ok: true,
      message: `Day ${result.day} complete · ${result.lines.length} decisions logged.`,
      day: result.day,
      lines: result.lines.length,
    };
  } catch (error) {
    console.error("agent cycle failed", error);
    return { ok: false, message: error instanceof Error ? error.message : "The agent cycle did not complete." };
  }
}

export async function resetDemoAction(confirmation: string): Promise<AgentActionResult> {
  const guard = evaluateResetGuard({
    authorized: await hasAgentControlSession(),
    confirmation,
    isProduction: process.env.NODE_ENV === "production",
    allowDestructiveReset: process.env.ALLOW_DESTRUCTIVE_RESET === "true",
  });
  if (!guard.allowed) return { ok: false, message: guard.error };

  try {
    await seedDatabase();
    revalidatePath("/", "layout");
    return { ok: true, message: "Demo data reset to day 0." };
  } catch (error) {
    console.error("demo reset failed", error);
    return { ok: false, message: error instanceof Error ? error.message : "The demo could not be reset." };
  }
}
