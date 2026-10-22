import { counterpartyFrozen, frozenRefusal } from "./address-change-check";
import { CYCLE_IN_PROGRESS_MS } from "./agent/balances";
import { currentOrgId } from "./context";
import { db, unwrap, type OrgDb } from "./dal";
import { appendLedgerEntryBestEffort } from "./ledger-best-effort";
import { COOLING_HOURS_MAX, coolingOffLabel, inCoolingOff, PAYEE_LOCK_OFF, payeeLockFromRow, type PayeeLock } from "./payee-lock-rules";

export * from "./payee-lock-rules";

/**
 * The payee lock (docs/superpowers/specs/2026-10-20-payee-lock-design.md). Off by default; an owner turns it on in
 * Settings. With it on:
 * - confirming a changed payout address needs a record of how it was checked (PL2);
 * - whoever entered or asked for the address may not confirm it, unless no one else can (PL3);
 * - approving a payment no longer confirms its address (PL4);
 * - a changed address waits a cooling-off before it can be paid, confirmed or not (PL5).
 *
 * Lookalike addresses are named on Counterparties whether or not the lock is on (PL6). Every export that touches the
 * database runs inside an organization scope; who may change the setting (`approval.policy`, owners) is the caller's check.
 */

/**
 * The columns are 0135's: before it runs, a select names a column the table does not have (42703, Postgres's own), and
 * an upsert one PostgREST's schema cache does not know (PGRST204). Only those codes: any other failure, a permission
 * refused included, throws rather than read as no lock.
 */
export function payeeLockColumnsMissing(error: { code?: string; message?: string }): boolean {
  return error.code === "42703" || error.code === "PGRST204";
}

/**
 * The workspace's lock, and whether the database has it at all (`ready`, migration 0135). A workspace with no row, or
 * before 0135, reads as off. Any other failure throws: what reads it stops rather than pay past a lock it cannot read.
 */
export async function readPayeeLockStatus(orgDb: OrgDb): Promise<{ lock: PayeeLock; ready: boolean }> {
  const result = await orgDb.from("approval_policies").select("payee_lock, payee_lock_cooling_hours").limit(1);
  if (result.error) {
    if (payeeLockColumnsMissing(result.error)) return { lock: PAYEE_LOCK_OFF, ready: false };
    throw new Error(`approval_policies not read: ${result.error.message}`);
  }
  const row = ((result.data ?? []) as Array<{ payee_lock: boolean | null; payee_lock_cooling_hours: number | string | null }>)[0];
  return { lock: payeeLockFromRow(row), ready: true };
}

/** The workspace's lock (PL1); off before 0135 and for a workspace that never set it. */
export async function readPayeeLock(orgDb: OrgDb): Promise<PayeeLock> {
  return (await readPayeeLockStatus(orgDb)).lock;
}

/**
 * Why a person may not pay this counterparty now under the payee lock, or null when they may (PL4, PL5): an address
 * waiting for confirmation is confirmed on Counterparties with a record of how it was checked, never by approving a
 * payment; and a changed address waits out its cooling-off. Read before anything is claimed. The lock off, nothing, but
 * for a frozen payee, which no approval pays, lock or not (docs/superpowers/specs/2026-10-22-address-change-check-design.md AC3).
 */
export async function payeeLockRefusal(counterpartyId: string, payeeName: string, now: number = Date.now()): Promise<string | null> {
  // A frozen payee is never paid by a person's approval, lock or not (address change check AC3).
  if (await counterpartyFrozen(counterpartyId)) return frozenRefusal(payeeName);
  const lock = await readPayeeLock(db());
  if (!lock.on) return null;
  const found = await db().from("counterparties").select("address_changed_at, address_confirmed_at").eq("id", counterpartyId).maybeSingle();
  if (found.error) throw new Error(found.error.message);
  const row = found.data as { address_changed_at: string | null; address_confirmed_at: string | null } | null;
  if (!row) return null;
  // As `addressUnconfirmed` (./counterparty-address) reads it: changed, and no confirmation since.
  const changed = row.address_changed_at;
  if (changed && (!row.address_confirmed_at || Date.parse(row.address_confirmed_at) < Date.parse(changed))) {
    return `Confirm ${payeeName}'s address on Counterparties first, and record how you checked it.`;
  }
  const until = inCoolingOff(changed, lock, now);
  if (until) return `${payeeName}'s address changed recently, and the payee lock makes it wait: it can be paid from ${coolingOffLabel(until)}.`;
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Changing the setting (PL1)

export type PayeeLockErrorCode = "invalid" | "unchanged" | "cycle_running" | "not_ready";

const MESSAGES: Record<PayeeLockErrorCode, string> = {
  invalid: `Choose a wait from 0 to ${COOLING_HOURS_MAX} hours.`,
  unchanged: "The payee lock is already set this way.",
  cycle_running: "A cycle is running. Try again in a minute, once it has finished.",
  not_ready: "The payee lock is not available in this workspace yet.",
};

export class PayeeLockError extends Error {
  constructor(readonly code: PayeeLockErrorCode) {
    super(MESSAGES[code]);
    this.name = "PayeeLockError";
  }
}

function summary(from: PayeeLock, to: PayeeLock): string {
  const wait = (hours: number) => (hours > 0 ? `, with a ${hours}-hour wait after an address changes` : "");
  if (!to.on && !from.on) return `Changed the payee lock's wait after an address changes from ${from.coolingHours} to ${to.coolingHours} hours, with the lock off`;
  if (!to.on) return "Turned off the payee lock";
  if (!from.on) return `Turned on the payee lock${wait(to.coolingHours)}`;
  return `Changed the payee lock's wait after an address changes from ${from.coolingHours} to ${to.coolingHours} hours`;
}

/**
 * An owner turns the lock on or off, or changes its cooling-off (PL1), signed as `payee_lock_changed`. Refused while a
 * cycle runs, as the two approvals figure is: the cycle read the lock when it began. A wait is kept while the lock is
 * off, and applies only once it is on.
 */
export async function changePayeeLock(input: { actorId: string; on: boolean; coolingHours: number }): Promise<{ from: PayeeLock; to: PayeeLock }> {
  if (!Number.isInteger(input.coolingHours) || input.coolingHours < 0 || input.coolingHours > COOLING_HOURS_MAX) throw new PayeeLockError("invalid");
  const to: PayeeLock = { on: input.on, coolingHours: input.coolingHours };

  const { lock: from, ready } = await readPayeeLockStatus(db());
  if (!ready) throw new PayeeLockError("not_ready");
  if (from.on === to.on && from.coolingHours === to.coolingHours) throw new PayeeLockError("unchanged");

  const running = unwrap(
    await db()
      .from("cycle_runs")
      .select("id")
      .eq("status", "running")
      .gt("started_at", new Date(Date.now() - CYCLE_IN_PROGRESS_MS).toISOString())
      .limit(1)
  ) as Array<{ id: string }>;
  if (running.length > 0) throw new PayeeLockError("cycle_running");

  // A write that asks for nothing back: only its error says whether it happened.
  const write = await db()
    .from("approval_policies")
    .upsert(
      { payee_lock: to.on, payee_lock_cooling_hours: to.coolingHours, updated_by: input.actorId, updated_at: new Date().toISOString() },
      { onConflict: "org_id" }
    );
  if (write.error) {
    if (payeeLockColumnsMissing(write.error)) throw new PayeeLockError("not_ready");
    throw new Error(write.error.message);
  }

  await appendLedgerEntryBestEffort(currentOrgId(), {
    actor: "human",
    domain: "system",
    action: "payee_lock_changed",
    summary: summary(from, to),
    detail: { by: input.actorId, from, to },
  });

  return { from, to };
}
