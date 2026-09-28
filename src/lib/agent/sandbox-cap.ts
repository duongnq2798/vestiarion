import { db } from "../dal";

/** Spec §4.4 / §10 step 5a: at most this many cycles per sandbox organization per UTC day. */
export const SANDBOX_DAILY_CYCLES = 20;

function startOfUtcDay(date: Date): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())).toISOString();
}

/**
 * How many cycles the organization in scope has already run today (UTC).
 * Counted from `cycle_runs` rather than kept in memory, so the cap holds
 * across serverless instances (spec §10 step 5a).
 */
export async function sandboxCyclesUsedToday(now: Date = new Date()): Promise<number> {
  const result = await db()
    .from("cycle_runs")
    .select("*", { count: "exact", head: true })
    .gte("started_at", startOfUtcDay(now));
  if (result.error) throw new Error(result.error.message);
  return result.count ?? 0;
}
