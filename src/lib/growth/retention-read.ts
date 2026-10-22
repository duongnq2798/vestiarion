import "server-only";
import { db, unwrap } from "@/lib/dal";
import { withOrg } from "@/lib/dal/scope";

/**
 * Each workspace's active instants for the retention table (docs/superpowers/specs/2026-10-22-growth-retention-design.md
 * R1): when a real bill was added (a payable whose counterparty is not sample data) and when a person decided one
 * (approved, rejected, returned to the agent, or gave a shadow-mode verdict), from its own records, in its own scope.
 * Read only after the team gate, a few workspaces at a time.
 */

/** A person's decision, as each workspace's ledger names it. */
export const DECISION_ACTIONS = ["approval_paid", "approval_rejected", "approval_returned", "decision_verdict"] as const;

/** At most this many workspaces are read for the table. */
export const RETENTION_READ_LIMIT = 200;
const LANES = 6;
/** Each workspace's rows read, of each kind: far more than eight weeks of a small business's bills. */
const ROWS = 1000;

export interface RetentionActivity {
  /** Each workspace read, with its active instants (none for a workspace that did nothing). */
  activity: Map<string, string[]>;
  /** Workspaces whose records could not be read: left out of the table, and counted beside it. */
  unread: string[];
}

export async function readRetentionActivity(workspaces: readonly { orgId: string; createdAt: string }[]): Promise<RetentionActivity> {
  const list = workspaces.slice(0, RETENTION_READ_LIMIT);
  const activity = new Map<string, string[]>();
  const unread: string[] = [];
  const readOne = (workspace: { orgId: string; createdAt: string }) =>
    withOrg(workspace.orgId, async () => {
      const [bills, decisions] = await Promise.all([
        db()
          .from("invoices")
          .select("created_at, counterparties!inner(sample)")
          .eq("direction", "payable")
          .eq("counterparties.sample", false)
          .gte("created_at", workspace.createdAt)
          .order("created_at", { ascending: true })
          .limit(ROWS),
        db()
          .from("ledger_entries")
          .select("ts")
          .eq("actor", "human")
          .in("action", [...DECISION_ACTIONS])
          .gte("ts", workspace.createdAt)
          .order("seq", { ascending: true })
          .limit(ROWS),
      ]);
      const billRows = unwrap(bills) as Array<{ created_at: string }>;
      const decisionRows = unwrap(decisions) as Array<{ ts: string }>;
      activity.set(workspace.orgId, [...billRows.map((row) => row.created_at), ...decisionRows.map((row) => row.ts)]);
    }).catch((error: unknown) => {
      console.error("growth: retention not read", workspace.orgId, error instanceof Error ? error.message : "unknown error");
      unread.push(workspace.orgId);
    });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(LANES, list.length) }, async () => {
      while (next < list.length) {
        const workspace = list[next];
        next += 1;
        await readOne(workspace);
      }
    })
  );
  return { activity, unread };
}
