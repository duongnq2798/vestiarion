import { CycleRunningError } from "../agent/cycle-running";
import { runCycleSoon } from "../agent/cycle-soon";
import { agentCycleSuccessMessage, runAgentCycle } from "../agent/orchestrator";
import { AgentPausedError } from "../agent/pause";
import { SANDBOX_DAILY_CYCLES, SandboxCapReachedError } from "../agent/sandbox-cap";
import { pauseAgent, PauseError, resumeAgent } from "../platform/pause";
import { cycleEventOf, provenanceOf, type Actor } from "./actor";
import { done, refused, TRY_AGAIN, type CommandOutcome, type Refused } from "./outcome";
import { gate } from "./policy";

/**
 * Stopping, starting and running the workspace's agent (integrations design §9). Pausing is open to anyone who may
 * approve money leaving; resuming and running a cycle are an owner's or admin's (the permission map). A sandbox's
 * cycles are capped inside `begin_cycle_run` (migration 0022); this only says which workspaces are capped.
 */

/** A `PauseError` carries a message safe to show; anything else goes to the server log under `label`. */
function pauseRefusal(error: unknown, label: string): Refused {
  if (error instanceof PauseError) return refused(error.code, error.message);
  console.error(label, error);
  return refused("failed", TRY_AGAIN);
}

export async function pauseWorkspaceAgent(actor: Actor, input: { reason: string }): Promise<CommandOutcome> {
  const refusal = gate(actor, "agent.pause");
  if (refusal) return refusal;
  try {
    await pauseAgent({ orgId: actor.orgId, actorId: actor.userId, reason: input.reason, ...provenanceOf(actor) });
  } catch (error) {
    return pauseRefusal(error, "pause agent failed");
  }
  return done("Agent paused.");
}

export async function resumeWorkspaceAgent(actor: Actor): Promise<CommandOutcome> {
  const refusal = gate(actor, "agent.resume");
  if (refusal) return refusal;
  try {
    await resumeAgent({ orgId: actor.orgId, actorId: actor.userId, ...provenanceOf(actor) });
  } catch (error) {
    return pauseRefusal(error, "resume agent failed");
  }
  runCycleSoon(cycleEventOf(actor, "agent_resumed"));
  return done("Agent resumed.");
}

export async function runWorkspaceCycle(actor: Actor): Promise<CommandOutcome<{ day: number; lines: number }>> {
  const refusal = gate(actor, "agent.run_cycle");
  if (refusal) return refusal;
  try {
    const result = await runAgentCycle({
      triggeredBy: actor.userId,
      dailyCap: actor.mode === "sandbox" ? SANDBOX_DAILY_CYCLES : undefined,
      trigger: { kind: "manual" },
    });
    return done(agentCycleSuccessMessage(result), { day: result.day, lines: result.lines.length });
  } catch (error) {
    if (error instanceof SandboxCapReachedError) return refused("sandbox_cap_reached", error.message);
    if (error instanceof AgentPausedError) return refused("agent_paused", error.message);
    if (error instanceof CycleRunningError) return refused("cycle_running", error.message);
    console.error("agent cycle failed", error);
    return refused("failed", error instanceof Error ? error.message : "The agent cycle did not complete.");
  }
}
