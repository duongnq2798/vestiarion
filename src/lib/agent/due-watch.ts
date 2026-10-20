import { db, unwrap, type OrgDb } from "../dal";
import { coolingOffUntil, readPayeeLock, type PayeeLock } from "../payee-lock";
import { runLiveOrganizations, runScheduledCycle, type CronRunResult } from "./cron";
import type { CycleEventKind } from "./cycle-soon";
import { runAgentCycle } from "./orchestrator";

/**
 * The due-work watch (docs/superpowers/specs/2026-10-21-due-work-watch-design.md): every 5 minutes
 * (`POST /api/agent/due-watch`, from Supabase Cron), it runs a cycle in a live workspace whose work became due only
 * because time passed, which no event starts a cycle for:
 * - a scheduled cycle the tick missed in it (DW4);
 * - the end of the payee lock's wait on a confirmed address that holds a payment back (DW5).
 *
 * Each due time is compared with the start of the workspace's latest cycle (DW3), so a cycle that started after it has
 * covered it and the watch never repeats one. With nothing due it runs no cycle, writes nothing and calls no model
 * (DW6). Live workspaces only, through the tick's own runner: a paused agent, payments switched off, a cycle already
 * running, a failure and the time budget behave as they do in the tick (DW2, DW7).
 */

/** The tick's schedule in `supabase/cron/watches.sql`: 17 minutes past every sixth hour, UTC. */
export const TICK_MINUTE = 17;
export const TICK_EVERY_HOURS = 6;
/** How long after a tick its cycles are left to the tick itself, which starts its last one within 180 seconds (DW4). */
export const TICK_GRACE_MS = 15 * 60_000;
/** No workspace's check or cycle starts later than this into a run; one left over waits for the next run (DW7). */
export const DUE_WATCH_LAST_START_MS = 180_000;

export type DueWork = "none" | "missed_schedule" | "payee_lock_wait_ended";

export interface DueWatchOutcome {
  due: DueWork;
  /** With `payee_lock_wait_ended`: how many counterparties' waits ended with something held back. */
  counterparties?: number;
}

const HOUR_MS = 3_600_000;

/** The latest scheduled tick at or before `now` (DW4). */
export function lastScheduledTick(now: number): number {
  const date = new Date(now);
  const hour = date.getUTCHours() - (date.getUTCHours() % TICK_EVERY_HOURS);
  const tick = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, TICK_MINUTE);
  return tick > now ? tick - TICK_EVERY_HOURS * HOUR_MS : tick;
}

/** Whether the workspace has had no cycle since the latest tick, once the tick's own time has passed (DW4). */
export function missedSchedule(lastCycleStart: number | null, now: number): boolean {
  const tick = lastScheduledTick(now);
  return now >= tick + TICK_GRACE_MS && (lastCycleStart === null || lastCycleStart < tick);
}

export interface AddressChange {
  id: string;
  address_changed_at: string | null;
  address_confirmed_at: string | null;
}

/**
 * The counterparties whose confirmed address change's wait ended after `since` and at or before `now` (DW5). An
 * unconfirmed change is left out: it cannot be paid yet, and confirming it starts a cycle of its own.
 */
export function waitsEnded(changes: readonly AddressChange[], lock: PayeeLock, since: number | null, now: number): string[] {
  if (!lock.on || lock.coolingHours <= 0) return [];
  return changes
    .filter((change) => {
      if (!change.address_changed_at || !change.address_confirmed_at) return false;
      if (Date.parse(change.address_confirmed_at) < Date.parse(change.address_changed_at)) return false;
      const until = coolingOffUntil(change.address_changed_at, lock)?.getTime();
      return until !== undefined && until <= now && (since === null || until > since);
    })
    .map((change) => change.id);
}

/** How many of the workspace's counterparties had a wait end since `since` with a payable still open or a verified milestone unsent (DW5). */
async function lockWaitsEnded(orgDb: OrgDb, lock: PayeeLock, since: number | null, now: number): Promise<number> {
  if (!lock.on || lock.coolingHours <= 0) return 0;
  const waitMs = lock.coolingHours * HOUR_MS;
  // Only a change whose wait could have ended in (since, now] is read.
  let changed = orgDb
    .from("counterparties")
    .select("id, address_changed_at, address_confirmed_at")
    .lte("address_changed_at", new Date(now - waitMs).toISOString());
  if (since !== null) changed = changed.gt("address_changed_at", new Date(since - waitMs).toISOString());
  const ids = waitsEnded(unwrap(await changed) as AddressChange[], lock, since, now);
  if (ids.length === 0) return 0;

  const [payables, milestones] = await Promise.all([
    orgDb.from("invoices").select("counterparty_id").eq("direction", "payable").in("counterparty_id", ids).not("status", "in", "(paid,received,rejected)"),
    orgDb.from("milestones").select("contractor_id").in("contractor_id", ids).eq("status", "verified").is("tx_ref", null),
  ]);
  const held = new Set([
    ...(unwrap(payables) as Array<{ counterparty_id: string }>).map((row) => row.counterparty_id),
    ...(unwrap(milestones) as Array<{ contractor_id: string }>).map((row) => row.contractor_id),
  ]);
  return held.size;
}

/** What is due in the workspace in scope, and the one cycle that does it (DW3 to DW6). */
async function checkWorkspace(now: number): Promise<DueWatchOutcome> {
  const orgDb = db();
  const latest = unwrap(
    await orgDb.from("cycle_runs").select("started_at").order("started_at", { ascending: false }).limit(1)
  ) as Array<{ started_at: string }>;
  const since = latest[0] ? Date.parse(latest[0].started_at) : null;

  // The scheduled cycle does everything an event's would, so it goes first (DW6).
  if (missedSchedule(since, now)) {
    await runScheduledCycle();
    return { due: "missed_schedule" };
  }

  const counterparties = await lockWaitsEnded(orgDb, await readPayeeLock(orgDb), since, now);
  if (counterparties === 0) return { due: "none" };
  const event: CycleEventKind = "payee_lock_wait_ended";
  await runAgentCycle({ trigger: { kind: "event", events: [event] } });
  return { due: "payee_lock_wait_ended", counterparties };
}

/** One run of the watch across the live workspaces (DW1, DW2, DW7). */
export async function watchDueWork(deps: { now?: () => number } = {}): Promise<CronRunResult<DueWatchOutcome>[]> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  return runLiveOrganizations(() => checkWorkspace(now()), { startBy: startedAt + DUE_WATCH_LAST_START_MS, now });
}
