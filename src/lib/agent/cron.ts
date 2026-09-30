import { currentOrgId } from "../context";
import { platformDb, unwrap } from "../dal";
import { withOrg } from "../dal/scope";
import { notifyWaitingDecisions } from "../notifications/waiting";
import { CycleRunningError } from "./cycle-running";
import { runAgentCycle, type CycleResult } from "./orchestrator";
import { AgentPausedError } from "./pause";

/** The `orgs` columns the cron needs to enter each organization's scope,
 * name it in a result, and tell whether its agent is paused. */
interface LiveOrgRow {
  id: string;
  slug: string;
  agent_paused_at: string | null;
}

export type CronRunResult<T> =
  | { slug: string; ok: true; result: T }
  | { slug: string; ok: true; skipped: "paused" | "running" }
  | { slug: string; ok: false; error: string };

/**
 * Runs `run` once inside every `live` organization's scope, spec §4.4: one
 * organization's failure is its own — it is recorded and logged, and never
 * stops the rest from running. Sandbox organizations are not in the cron;
 * their cycles run when a member presses "Run cycle" (see sandbox-cap.ts).
 *
 * A paused organization is skipped outright — `run` never executes and its
 * scope is never entered — rather than relying on `begin_cycle_run` to
 * refuse it: the pause must stop the cron from doing anything, not merely
 * from opening a run. A pause that lands after this listing but before
 * `begin_cycle_run` is refused there instead; that `AgentPausedError` is the
 * same correct refusal, so it is reported as skipped, not as a failure. So is
 * a workspace whose cycle is already running — an event's cycle, or a
 * person's — since one cycle at a time is the rule (event-driven cycles E3).
 */
export async function runLiveOrganizations<T>(run: () => Promise<T>): Promise<CronRunResult<T>[]> {
  const orgs = unwrap(
    await platformDb().from("orgs").select("id, slug, agent_paused_at").eq("mode", "live").order("slug")
  ) as unknown as LiveOrgRow[];

  const results: CronRunResult<T>[] = [];
  for (const org of orgs) {
    if (org.agent_paused_at) {
      results.push({ slug: org.slug, ok: true, skipped: "paused" });
      continue;
    }
    try {
      const result = await withOrg(org.id, run);
      results.push({ slug: org.slug, ok: true, result });
    } catch (error) {
      if (error instanceof AgentPausedError) {
        results.push({ slug: org.slug, ok: true, skipped: "paused" });
        continue;
      }
      if (error instanceof CycleRunningError) {
        results.push({ slug: org.slug, ok: true, skipped: "running" });
        continue;
      }
      console.error("cycle failed for", org.slug, error);
      results.push({ slug: org.slug, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

/**
 * One scheduled cycle for the organization in scope: the cycle, then the
 * digest of payables waiting for a decision (notifications design N1, N2).
 * Only the cron runs this; a cycle started from the console has a person
 * watching it and sends nothing.
 *
 * A cycle that throws is never followed by a digest, and a paused one throws
 * `AgentPausedError`, so neither notifies. Notifying never changes the
 * cycle's result: `notifyWaitingDecisions` does not throw, and if it ever
 * did, the error is logged here by organization id and the result still
 * returned.
 */
export async function runScheduledCycle(): Promise<CycleResult> {
  const result = await runAgentCycle({ trigger: { kind: "schedule" } });
  try {
    await notifyWaitingDecisions();
  } catch (error) {
    console.error("notifications failed after the cycle", currentOrgId(), error instanceof Error ? error.message : String(error));
  }
  return result;
}
