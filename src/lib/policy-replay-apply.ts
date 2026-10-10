import type { OutflowBudget } from "./agent/outflow-budget";
import type { ReplaySummary, RuleKind } from "./policy-replay";
import { replayForApply, RuleReplayError, trialFromForm } from "./policy-replay-read";

/**
 * Apply this figure (docs/superpowers/specs/2026-10-10-policy-replay-design.md P10): what a setting's own action reads
 * from a form that tried the figure first. The figure in force when the replay ran, which the library refuses the change
 * against once it is no longer the one in force, and the replay run again here, on the server, whose summary the change's
 * signed entry records. Null for a form that tried nothing: Save, as before.
 */

export interface AppliedReplay<Expected> {
  expected: Expected;
  replay: ReplaySummary;
}

const AGAIN = "Try it on past decisions again before you apply it.";

/** A figure the form carried back: blank for none; missing or unreadable is refused. */
function triedFigure(formData: FormData, key: string): number | null {
  const raw = formData.get(key);
  if (typeof raw !== "string") throw new RuleReplayError("invalid", AGAIN);
  if (raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new RuleReplayError("invalid", AGAIN);
  return value;
}

async function applied<Expected>(formData: FormData, rule: RuleKind, expected: () => Expected): Promise<AppliedReplay<Expected> | null> {
  if (!formData.has("replayDays")) return null;
  const tried = expected();
  const trial = trialFromForm(formData, rule);
  if (!trial) throw new RuleReplayError("invalid", AGAIN);
  return { expected: tried, replay: await replayForApply(trial) };
}

export function limitApplied(formData: FormData): Promise<AppliedReplay<number | null> | null> {
  return applied(formData, "counterparty_limit", () => triedFigure(formData, "expectedLimit"));
}

export function twoApprovalsApplied(formData: FormData): Promise<AppliedReplay<number | null> | null> {
  return applied(formData, "two_approvals", () => triedFigure(formData, "expectedAbove"));
}

export function spendingLimitApplied(formData: FormData): Promise<AppliedReplay<OutflowBudget> | null> {
  return applied(formData, "spending_limit", () => ({ dailyUsdc: triedFigure(formData, "expectedDaily"), weeklyUsdc: triedFigure(formData, "expectedWeekly") }));
}
