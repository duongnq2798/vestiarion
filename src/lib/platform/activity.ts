import { platformDb } from "../dal";

/**
 * Last-seen tracking for the sandbox cleanup (spec §6, §10 step 5b).
 *
 * `orgs.last_active_at` is what `delete_sandbox_org` reads to decide whether
 * a sandbox is abandoned, so it has to move on real use — but a page view
 * happens far more often than once an hour, and the database function itself
 * already skips the write when the row is fresh (migration 0022). This
 * module-level map is a second, in-process skip in front of that: it saves
 * the round trip entirely for the common case of the same organization being
 * touched repeatedly inside one hour, on one instance.
 */

const lastRefreshed = new Map<string, number>();
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Refreshes an organization's activity timestamp, at most once an hour per
 * process. Never throws: a failed refresh is not worth failing the request
 * that triggered it, so it is logged and swallowed instead.
 */
export async function touchOrgActivity(orgId: string, now: number = Date.now()): Promise<void> {
  const last = lastRefreshed.get(orgId);
  if (last !== undefined && now - last < REFRESH_INTERVAL_MS) return;
  try {
    const { error } = await platformDb().rpc("touch_org_activity", { p_org_id: orgId });
    if (error) throw new Error(error.message);
    lastRefreshed.set(orgId, now);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("could not record workspace activity", orgId, message);
  }
}

/** For tests only: clears the in-process memory of when each organization was last refreshed. */
export function resetActivityMemory(): void {
  lastRefreshed.clear();
}
