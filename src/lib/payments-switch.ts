import { currentConfig } from "./context";

/**
 * The platform's stop switch (payment safety S1, docs/superpowers/specs/2026-10-05-payment-safety-design.md). When
 * the deployment sets PAYMENTS_DISABLED, nothing moves money in any workspace: no payment by any route, swap, reserve
 * move, Gateway deposit, escrow write or spending limit write. The agent does not run, and a person's payment is
 * refused before anything is claimed. Reads, every page and the status of a transfer already sent keep working.
 * Switching it on or off is an environment change and a redeploy.
 */

/** What every refusal says while payments are off (S4). */
export const PAYMENTS_OFF = "Payments are switched off for every workspace right now.";

/** Thrown wherever money would move while the deployment has payments switched off. */
export class PaymentsDisabledError extends Error {
  constructor() {
    super(PAYMENTS_OFF);
    this.name = "PaymentsDisabledError";
  }
}

/** Whether the deployment has payments switched off (PAYMENTS_DISABLED). */
export function paymentsDisabled(): boolean {
  return currentConfig().paymentsDisabled === true;
}

/** Refuses, before anything moves, while payments are switched off. */
export function assertPaymentsEnabled(): void {
  if (paymentsDisabled()) throw new PaymentsDisabledError();
}
