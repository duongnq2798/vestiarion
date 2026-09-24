export type CycleClockMode = "real" | "simulate";

/**
 * Production follows wall-clock time by default. A disposable demo can opt
 * back into the numbered simulation with CYCLE_CLOCK_MODE=simulate.
 */
export function cycleClockMode(environment: { CYCLE_CLOCK_MODE?: string; NODE_ENV?: string } = process.env): CycleClockMode {
  const configured = environment.CYCLE_CLOCK_MODE?.trim().toLowerCase();
  if (configured === "real" || configured === "simulate") return configured;
  return environment.NODE_ENV === "production" ? "real" : "simulate";
}
