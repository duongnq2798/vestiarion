import { platformDb, unwrap } from "../dal";
import { withOrg } from "../dal/scope";

/** The `orgs` columns the cron needs to enter each organization's scope and name it in a result. */
interface LiveOrgRow {
  id: string;
  slug: string;
}

export type CronRunResult<T> =
  | { slug: string; ok: true; result: T }
  | { slug: string; ok: false; error: string };

/**
 * Runs `run` once inside every `live` organization's scope, spec §4.4: one
 * organization's failure is its own — it is recorded and logged, and never
 * stops the rest from running. Sandbox organizations are not in the cron;
 * their cycles run when a member presses "Run cycle" (see sandbox-cap.ts).
 */
export async function runLiveOrganizations<T>(run: () => Promise<T>): Promise<CronRunResult<T>[]> {
  const orgs = unwrap(
    await platformDb().from("orgs").select("id, slug").eq("mode", "live").order("slug")
  ) as unknown as LiveOrgRow[];

  const results: CronRunResult<T>[] = [];
  for (const org of orgs) {
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
