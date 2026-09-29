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
    await platformDb()
      .from("orgs")
      .select("id")
      .eq("mode", "sandbox")
      .lt("last_active_at", cutoffIso)
      .is("circle_api_key_enc", null)
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

/** W7: delivered and failed webhook rows are kept this long, then deleted by the daily cleanup. */
export const WEBHOOK_DELIVERY_RETENTION_DAYS = 30;

/**
 * Which finished deliveries expire, and from when: a delivered row from its
 * delivery, a failed one from its creation (it records no time of failure).
 * Pending and sending rows are never deleted here.
 */
const EXPIRING: { status: "delivered" | "failed"; since: "delivered_at" | "created_at" }[] = [
  { status: "delivered", since: "delivered_at" },
  { status: "failed", since: "created_at" },
];

/**
 * Deletes webhook deliveries that finished more than
 * `WEBHOOK_DELIVERY_RETENTION_DAYS` ago — delivered rows by `delivered_at`,
 * failed rows by `created_at` — and counts them. Best-effort: it never throws;
 * each failed delete is logged and counted in `failed`, does not stop the
 * other, and its rows are simply deleted by a later run.
 */
export async function deleteExpiredWebhookDeliveries(now: Date = new Date()): Promise<CleanupResult> {
  const cutoffIso = new Date(now.getTime() - WEBHOOK_DELIVERY_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let deleted = 0;
  let failed = 0;
  for (const { status, since } of EXPIRING) {
    try {
      const { count, error } = await platformDb()
        .from("webhook_deliveries")
        .delete({ count: "exact" })
        .eq("status", status)
        .lt(since, cutoffIso);
      if (error) {
        console.error("could not delete expired webhook deliveries", error.message);
        failed += 1;
        continue;
      }
      deleted += count ?? 0;
    } catch (err) {
      console.error("could not delete expired webhook deliveries", (err as Error).message);
      failed += 1;
    }
  }
  if (deleted > 0) console.log("deleted expired webhook deliveries", deleted);
  return { deleted, failed };
}
