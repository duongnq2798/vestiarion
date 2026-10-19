/**
 * Which stopped workspaces get a setup reminder, and when (docs/superpowers/specs/2026-10-19-activation-nudge-design.md):
 * a customer workspace with no real bill a day after it was opened (`first_bill`), and a customer workspace in shadow mode
 * whose agent decided its first real bill three days ago with no verdict since (`first_verdict`). Each moment is emailed
 * once per workspace (A1); nothing is sent about a workspace opened more than 30 days ago. Pure: the facts come from
 * `growth_workspaces`, and what was sent already is read in each workspace's scope.
 */

export const ACTIVATION_NUDGE_SENT = "activation_nudge_sent";
/** Signed when a reminder was claimed and no email went: a later tick tries again, up to `NUDGE_MAX_FAILURES` times (A6). */
export const ACTIVATION_NUDGE_FAILED = "activation_nudge_failed";

export const NUDGE_STAGES = ["first_bill", "first_verdict"] as const;
export type NudgeStage = (typeof NUDGE_STAGES)[number];

const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
/** A workspace with no real bill this long after it was opened gets the first-bill reminder. */
export const FIRST_BILL_AFTER_MS = 24 * HOUR_MS;
/** A shadow workspace with no verdict this long after the agent's first decision gets the first-verdict reminder. */
export const FIRST_VERDICT_AFTER_MS = 72 * HOUR_MS;
/** Nothing is sent about a workspace opened longer ago than this. */
export const NUDGE_WINDOW_MS = 30 * DAY_MS;
/** At most this many workspaces are reminded in one tick (A5). */
export const NUDGES_PER_TICK = 20;
/** A reminder that reached nobody this many times is not tried again (A6). */
export const NUDGE_MAX_FAILURES = 3;
/** At most this many members of a workspace get it (A3). */
export const NUDGE_MAX_RECIPIENTS = 5;

/** What `growth_workspaces` says of a workspace, as far as the reminders need it. */
export interface NudgeWorkspace {
  orgId: string;
  slug: string;
  side: "customers" | "ours";
  createdAt: string;
  shadow: boolean;
  realBills: number;
  firstDecisionAt: string | null;
  verdictsGiven: number;
}

export interface DueNudge {
  orgId: string;
  slug: string;
  stage: NudgeStage;
  createdAt: string;
  /** When the agent first decided a real bill (`first_verdict` only). */
  firstDecisionAt: string | null;
}

/** The moment due for a workspace now, if any (A1, A2). At most one: a first verdict needs a real bill. */
export function dueNudge(workspace: NudgeWorkspace, nowMs: number): NudgeStage | null {
  if (workspace.side !== "customers") return null;
  const opened = Date.parse(workspace.createdAt);
  if (!Number.isFinite(opened) || nowMs - opened > NUDGE_WINDOW_MS) return null;
  if (workspace.realBills === 0) return nowMs - opened >= FIRST_BILL_AFTER_MS ? "first_bill" : null;
  if (!workspace.shadow || workspace.verdictsGiven > 0 || workspace.firstDecisionAt === null) return null;
  const decided = Date.parse(workspace.firstDecisionAt);
  return Number.isFinite(decided) && nowMs - decided >= FIRST_VERDICT_AFTER_MS ? "first_verdict" : null;
}

/** The workspaces with a moment due now, oldest first, so the longest-waiting go first when a tick runs short (A5). */
export function dueNudges(workspaces: readonly NudgeWorkspace[], nowMs: number): DueNudge[] {
  return workspaces
    .flatMap((workspace) => {
      const stage = dueNudge(workspace, nowMs);
      return stage ? [{ orgId: workspace.orgId, slug: workspace.slug, stage, createdAt: workspace.createdAt, firstDecisionAt: workspace.firstDecisionAt }] : [];
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.orgId < b.orgId ? -1 : 1));
}

/**
 * Whether a moment may be sent, from its earlier entries in the workspace (A6). Each `activation_nudge_failed` lets one
 * claim go, so a claim still standing means it went; after `NUDGE_MAX_FAILURES` failures it is not tried again.
 */
export function nudgeOpen(actions: readonly string[]): boolean {
  return !nudgeWent(actions) && actions.filter((action) => action === ACTIVATION_NUDGE_FAILED).length < NUDGE_MAX_FAILURES;
}

/** Whether a claim for the moment still stands, so its email went (A6, A7). */
export function nudgeWent(actions: readonly string[]): boolean {
  const claimed = actions.filter((action) => action === ACTIVATION_NUDGE_SENT).length;
  return claimed > actions.filter((action) => action === ACTIVATION_NUDGE_FAILED).length;
}

/** Whole days between two moments, never below 1: "You opened it 1 day ago" a day on. */
export function wholeDays(fromMs: number, toMs: number): number {
  return Math.max(1, Math.floor((toMs - fromMs) / DAY_MS));
}
