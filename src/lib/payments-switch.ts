import { currentConfig } from "./context";
import { platformDb } from "./dal";

/**
 * The platform's stop switch (payment safety S1, S7, docs/superpowers/specs/2026-10-05-payment-safety-design.md).
 * While it is off, nothing moves money in any workspace: no payment by any route, swap, reserve move, Gateway deposit,
 * escrow write or spending limit write. The agent does not run, and a person's payment is refused before anything is
 * claimed. Reads, every page and the status of a transfer already sent keep working.
 *
 * It has two halves, and either stops payments:
 * - the deployment's `PAYMENTS_DISABLED`, an environment change and a redeploy;
 * - the database's `platform_controls` row (0074), which `npm run payments -- off "<reason>"` sets. Every running
 *   deployment reads it at once, a console tab Vercel's skew protection keeps on an older one included.
 */

/** What every refusal says while payments are off (S4). */
export const PAYMENTS_OFF = "Payments are switched off for every workspace right now.";

/** Thrown wherever money would move while payments are switched off. */
export class PaymentsDisabledError extends Error {
  constructor() {
    super(PAYMENTS_OFF);
    this.name = "PaymentsDisabledError";
  }
}

export interface PaymentsSwitchState {
  off: boolean;
  /** Why, when the database's switch gives a reason. */
  reason: string | null;
}

/** How long a read of the database's switch is kept (S7): a switch thrown takes at most this long to reach every instance. */
const SWITCH_TTL_MS = 10_000;
/** The last read of the database's switch: one database per deployment, so one value. */
let held: { at: number; state: PaymentsSwitchState } | null = null;

/** Forgets the last read, so the next check reads the database: after a change, and between tests. */
export function forgetPaymentsSwitch(): void {
  held = null;
}

/** PostgREST's "no such table" (PGRST205) or Postgres's (42P01): the switch's migration has not run here yet. */
function missingTable(error: { code?: string; message?: string }): boolean {
  return error.code === "PGRST205" || error.code === "42P01" || /platform_controls/.test(error.message ?? "") && /schema cache|does not exist/.test(error.message ?? "");
}

/** The database's half, read at most every 10 seconds per database. A table not created yet reads as on. Throws when it cannot be read. */
async function readSwitch(now: number): Promise<PaymentsSwitchState> {
  if (held && now - held.at <= SWITCH_TTL_MS) return held.state;
  const result = await platformDb().from("platform_controls").select("payments_disabled_at, payments_disabled_reason").maybeSingle();
  if (result.error) {
    if (missingTable(result.error)) return { off: false, reason: null };
    throw new Error(result.error.message);
  }
  const row = result.data as { payments_disabled_at: string | null; payments_disabled_reason: string | null } | null;
  const state = { off: Boolean(row?.payments_disabled_at), reason: row?.payments_disabled_reason ?? null };
  held = { at: now, state };
  return state;
}

/**
 * Whether payments are switched off, by either half. A read of the database's switch that fails counts as off: money
 * never moves on "could not tell", as a payment step never treats an unreadable pause as no pause.
 */
export async function paymentsDisabled(now: number = Date.now()): Promise<boolean> {
  if (currentConfig().paymentsDisabled === true) return true;
  try {
    return (await readSwitch(now)).off;
  } catch (error) {
    console.error("payments switch: not read", error instanceof Error ? error.message : String(error));
    return true;
  }
}

/** Refuses, before anything moves, while payments are switched off. */
export async function assertPaymentsEnabled(): Promise<void> {
  if (await paymentsDisabled()) throw new PaymentsDisabledError();
}

/**
 * What every workspace page says (S5): off, and why when the database says. A read that fails shows nothing, so the
 * switch never takes a page down.
 */
export async function paymentsSwitchForPages(): Promise<PaymentsSwitchState> {
  if (currentConfig().paymentsDisabled === true) return { off: true, reason: null };
  try {
    return await readSwitch(Date.now());
  } catch (error) {
    console.error("payments switch: not read for the page", error instanceof Error ? error.message : String(error));
    return { off: false, reason: null };
  }
}

/** Either half, as it is now: for `npm run payments`. Throws when the database's switch cannot be read. */
export async function readPaymentsSwitch(): Promise<PaymentsSwitchState> {
  if (currentConfig().paymentsDisabled === true) return { off: true, reason: "PAYMENTS_DISABLED is set" };
  // A status read is always fresh.
  forgetPaymentsSwitch();
  return readSwitch(Date.now());
}

/** Throws the database's switch (`npm run payments`): off with a reason, or back on. */
export async function setPaymentsSwitch(off: boolean, reason: string | null): Promise<void> {
  const why = reason?.trim() ? reason.trim().slice(0, 280) : null;
  const update = await platformDb()
    .from("platform_controls")
    .update({
      payments_disabled_at: off ? new Date().toISOString() : null,
      payments_disabled_reason: off ? why : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", true);
  if (update.error) throw new Error(update.error.message);
  forgetPaymentsSwitch();
}
