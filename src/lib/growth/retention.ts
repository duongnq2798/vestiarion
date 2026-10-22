/**
 * Retention by week on the founder dashboard (docs/superpowers/specs/2026-10-22-growth-retention-design.md R1, R2): the
 * workspaces opened in each UTC week, and how many of them were active in each of their first weeks. Pure, so every
 * rule is tested here; src/lib/growth/retention-read.ts reads each workspace's activity.
 *
 * A workspace's week k is the 7 days from its opening plus 7k days, not a calendar week, so each workspace has the same
 * time to come back. It is active in a week when something real happened in it: a real bill added, or a person's
 * decision (approve, reject, return to the agent, a shadow-mode verdict).
 */

/** How many weeks the table shows: the opening week (week 0) and the seven after it. */
export const RETENTION_WEEKS = 8;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** One cell: of the cohort's workspaces whose week has begun, how many were active in it. */
export interface RetentionCell {
  active: number;
  /** The cohort's workspaces whose week k has begun; 0 for a week no workspace has reached yet. */
  eligible: number;
  /** `active / eligible`, or null when no workspace has reached the week. */
  value: number | null;
  /** Some workspace's week k is still running, so the cell can still rise. */
  partial: boolean;
}

export interface RetentionCohort {
  /** The Monday (UTC) of the week the cohort's workspaces opened, as YYYY-MM-DD. */
  weekOf: string;
  size: number;
  cells: RetentionCell[];
}

/** The Monday (UTC) of an instant's week, as YYYY-MM-DD. */
export function mondayOf(iso: string): string {
  const at = new Date(iso);
  const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const sinceMonday = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - sinceMonday * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The cohorts, oldest first. `activity` holds each workspace's active instants; a workspace with none is inactive in every
 * week, and one whose activity could not be read is left out of every cohort by its caller.
 */
export function retentionCohorts(
  workspaces: readonly { orgId: string; createdAt: string }[],
  activity: ReadonlyMap<string, readonly string[]>,
  now: Date,
  weeks: number = RETENTION_WEEKS
): RetentionCohort[] {
  const byWeek = new Map<string, { orgId: string; createdAt: string }[]>();
  for (const workspace of workspaces) {
    const week = mondayOf(workspace.createdAt);
    byWeek.set(week, [...(byWeek.get(week) ?? []), workspace]);
  }
  const nowMs = now.getTime();
  return [...byWeek.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([weekOf, members]) => {
      const cells: RetentionCell[] = [];
      for (let k = 0; k < weeks; k += 1) {
        let active = 0;
        let eligible = 0;
        let partial = false;
        for (const member of members) {
          const start = Date.parse(member.createdAt) + k * WEEK_MS;
          const end = start + WEEK_MS;
          if (start > nowMs) continue;
          eligible += 1;
          if (end > nowMs) partial = true;
          const instants = activity.get(member.orgId) ?? [];
          if (instants.some((iso) => {
            const at = Date.parse(iso);
            return at >= start && at < end;
          })) active += 1;
        }
        cells.push({ active, eligible, value: eligible > 0 ? active / eligible : null, partial });
      }
      return { weekOf, size: members.length, cells };
    });
}
