import { currentConfig } from "./context";

export type CycleClockMode = "real" | "simulate";

/**
 * Production follows wall-clock time by default. A disposable demo can opt
 * back into the numbered simulation with CYCLE_CLOCK_MODE=simulate.
 *
 * The decision itself moved into `configFromEnv`, so a caller who builds a
 * config by hand chooses a clock the same way it chooses a database, rather
 * than by arranging for the right variable to be in the process environment.
 */
export function cycleClockMode(): CycleClockMode {
  return currentConfig().clockMode;
}
