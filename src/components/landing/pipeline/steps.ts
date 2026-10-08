/**
 * Where each step of the loop stands while the reader scrolls through it (docs/superpowers/specs/2026-10-08-landing-
 * motion-design.md M1). `lit` is every step before one is chosen, as in the server's HTML: nothing is dimmed until the
 * script knows which step is being read.
 */
export type StepState = "lit" | "idle" | "active" | "done";

export const STEP_COUNT = 5;

export function stepState(index: number, active: number | null): StepState {
  if (active === null) return "lit";
  if (index === active) return "active";
  return index < active ? "done" : "idle";
}
