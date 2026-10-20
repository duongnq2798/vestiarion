import { payeeNotReady } from "./counterparty-address";
import { inCoolingOff, type PayeeLock } from "./payee-lock-rules";

/** What a verified milestone waits for before the agent pays it, as its card on Contractors says it. */
export type MilestoneWait = "unconfirmed" | "no_address" | "cooling_off";

export interface MilestoneWaiting {
  waiting: MilestoneWait | null;
  /** With `waiting: "cooling_off"`, when the payee lock's wait ends. */
  waitsUntil: Date | null;
}

const NOT_WAITING: MilestoneWaiting = { waiting: null, waitsUntil: null };

/**
 * What a milestone waits for, in the contractor stage's order, so its card says what the agent does
 * (docs/superpowers/specs/2026-10-20-payee-lock-design.md PL5):
 * - only a verified milestone waits; a held one waits on a person's decision instead;
 * - a release already sent (`tx_ref`) never waits: the stage completes it whatever its address now is;
 * - an address to confirm, or one the payee has still to add (payeeNotReady), comes first;
 * - then the payee lock's wait after the address changed.
 */
export function milestoneWaiting(
  milestone: { status: string; tx_ref: string | null },
  contractor: { address: string | null; address_changed_at: string | null; address_confirmed_at: string | null } | undefined,
  options: { live: boolean; lock: PayeeLock; now: number }
): MilestoneWaiting {
  if (milestone.status !== "verified" || milestone.tx_ref || !contractor) return NOT_WAITING;
  const notReady = payeeNotReady(contractor, options.live);
  if (notReady) return { waiting: notReady, waitsUntil: null };
  const until = inCoolingOff(contractor.address_changed_at, options.lock, options.now);
  return until ? { waiting: "cooling_off", waitsUntil: until } : NOT_WAITING;
}
