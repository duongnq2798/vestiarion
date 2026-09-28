/** Spec §4.4 / §10 step 5a: at most this many cycles per sandbox organization per UTC day. */
export const SANDBOX_DAILY_CYCLES = 20;

/**
 * Thrown when `begin_cycle_run` (migration 0022) reports that a sandbox
 * organization has already started its daily cycles. The count and the cap
 * itself live in the database now — this class only translates the raised
 * `sandbox_cap_reached: …` error into the message a member sees (spec §10
 * step 5a).
 */
export class SandboxCapReachedError extends Error {
  constructor() {
    super(`This sandbox has run its ${SANDBOX_DAILY_CYCLES} cycles for today (UTC). It resets at midnight UTC.`);
    this.name = "SandboxCapReachedError";
  }
}
