import { db, unwrap } from "../dal";
import { CYCLE_IN_PROGRESS_MS } from "./balances";

/**
 * One cycle at a time in a workspace (event-driven cycles, E3). The cycle's AP
 * stage does not claim the payables it decides, so two cycles at once could
 * each record a decision for the same payable, and the later write could move
 * a paid invoice's status back. Every cycle — the schedule's, a person's "Run
 * cycle", an event's — checks here before it opens its run.
 */
export class CycleRunningError extends Error {
  constructor() {
    super("A cycle is already running. Its decisions appear here in a moment.");
    this.name = "CycleRunningError";
  }
}

/** Whether the workspace in scope has a cycle running: a row still `running` that started within `CYCLE_IN_PROGRESS_MS`. */
export async function hasRunningCycle(now: number = Date.now()): Promise<boolean> {
  const rows = unwrap(
    await db()
      .from("cycle_runs")
      .select("id")
      .eq("status", "running")
      .gt("started_at", new Date(now - CYCLE_IN_PROGRESS_MS).toISOString())
      .limit(1)
  ) as Array<{ id: string }>;
  return rows.length > 0;
}
