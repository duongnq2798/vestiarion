import { platformDb, unwrap } from "../dal";
import { withOrg } from "../dal/scope";

/** The `orgs` columns the cron needs to enter each organization's scope,
 * name it in a result, and tell whether its agent is paused. */
interface LiveOrgRow {
  id: string;
  slug: string;
  agent_paused_at: string | null;
}

export type CronRunResult<T> =
  | { slug: string; ok: true; result: T }
  | { slug: string; ok: true; skipped: "paused" }
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
 * from opening a run.
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
      console.error("cycle failed for", org.slug, error);
      results.push({ slug: org.slug, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}
