import { platformDb, unwrap } from "../dal";

/** Spec §6 "Abandoned sandboxes": a sandbox with no activity this long is deleted by the daily cleanup. */
export const SANDBOX_IDLE_DAYS = 60;

interface SandboxRow {
  id: string;
}

/**
 * Counts only. The response is printed into the scheduled workflow's log, and
 * sandbox slugs derive from people's workspace names, so per-organization
 * detail goes to the server log, by organization id.
 */
export interface CleanupResult {
  deleted: number;
  failed: number;
}

/**
 * Deletes every sandbox organization that has been inactive since the
 * cutoff. Each organization is its own call to `delete_sandbox_org`
 * (migration 0022), so one organization's failure never stops the rest: it
 * is logged and counted in `failed` instead. `delete_sandbox_org` itself
 * re-checks `last_active_at` against the cutoff it is given, so a sandbox
 * that became active between the listing and the delete survives — that call
 * simply returns `false`, and the organization is counted nowhere.
 */
export async function deleteAbandonedSandboxes(now: Date = new Date()): Promise<CleanupResult> {
  const cutoff = new Date(now.getTime() - SANDBOX_IDLE_DAYS * 24 * 60 * 60 * 1000);
  const cutoffIso = cutoff.toISOString();

  const sandboxes = unwrap(
    await platformDb().from("orgs").select("id").eq("mode", "sandbox").lt("last_active_at", cutoffIso)
  ) as unknown as SandboxRow[];

  let deleted = 0;
  let failed = 0;

  for (const org of sandboxes) {
    const { data, error } = await platformDb().rpc("delete_sandbox_org", {
      p_org_id: org.id,
      p_inactive_before: cutoffIso,
    });
    if (error) {
      failed += 1;
      console.error("could not delete abandoned sandbox", org.id, error.message);
      continue;
    }
    if (data === true) {
      deleted += 1;
      console.log("deleted abandoned sandbox", org.id);
    }
  }

  return { deleted, failed };
}

/** W7: delivered webhook rows are kept this long, then deleted by the daily cleanup. */
export const WEBHOOK_DELIVERY_RETENTION_DAYS = 30;

/**
 * Deletes webhook deliveries that were delivered more than
 * `WEBHOOK_DELIVERY_RETENTION_DAYS` ago, and counts them. Best-effort: it
 * never throws; a failed delete is logged and counted in `failed`, and the
 * rows are simply deleted by a later run.
 */
export async function deleteExpiredWebhookDeliveries(now: Date = new Date()): Promise<CleanupResult> {
  const cutoffIso = new Date(now.getTime() - WEBHOOK_DELIVERY_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  try {
    const { count, error } = await platformDb()
      .from("webhook_deliveries")
      .delete({ count: "exact" })
      .eq("status", "delivered")
      .lt("delivered_at", cutoffIso);
    if (error) {
      console.error("could not delete expired webhook deliveries", error.message);
      return { deleted: 0, failed: 1 };
    }
    const deleted = count ?? 0;
    if (deleted > 0) console.log("deleted expired webhook deliveries", deleted);
    return { deleted, failed: 0 };
  } catch (err) {
    console.error("could not delete expired webhook deliveries", (err as Error).message);
    return { deleted: 0, failed: 1 };
  }
}
