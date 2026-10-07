import { utcDay } from "./copy";

/**
 * How recently a workspace was in use, for the workspaces page
 * (docs/superpowers/specs/2026-10-07-workspaces-page-design.md). It reads
 * `orgs.last_active_at`, which touchOrgActivity refreshes when a member opens
 * the workspace, at most once an hour: the last visit fell within the hour
 * after it, so the line never claims more precision than that.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** "Active in the last hour", "Active 3 hours ago", "Active yesterday", "Active 5 days ago", then "Last active Sep 2, 2026". */
export function activeLine(lastActiveAt: string, now: number = Date.now()): string {
  const at = Date.parse(lastActiveAt);
  if (Number.isNaN(at)) return "";
  const ago = Math.max(0, now - at);
  if (ago < HOUR_MS) return "Active in the last hour";
  if (ago < DAY_MS) {
    const hours = Math.floor(ago / HOUR_MS);
    return `Active ${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  }
  const days = Math.floor(ago / DAY_MS);
  if (days === 1) return "Active yesterday";
  if (days <= 30) return `Active ${days} days ago`;
  return `Last active ${utcDay(new Date(at).toISOString())}`;
}

/** Most recently active first; a workspace with no time last, and a tie by name. */
export function byRecentActivity<T extends { name: string; lastActiveAt?: string }>(workspaces: readonly T[]): T[] {
  const time = (workspace: T) => (workspace.lastActiveAt ? Date.parse(workspace.lastActiveAt) || 0 : 0);
  return [...workspaces].sort((a, b) => time(b) - time(a) || a.name.localeCompare(b.name));
}
