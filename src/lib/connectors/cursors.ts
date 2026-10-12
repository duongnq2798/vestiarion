/**
 * Where a sync stopped, per connection and object type (docs/superpowers/specs/2026-10-12-xero-connector-design.md X8,
 * I13). A run reads pages in the provider's update order; after each page written, the cursor keeps the next page and
 * the latest change read, so a run stopped by a rate limit or an outage resumes there. Pure.
 *
 * Paging in update order has one gap: a row on a page already read that changes during the run moves to the end, and
 * the first row of the next page moves up into the page already read, unseen. So a run of more than one page that read
 * a change made during it starts over from page 1, with the same time; re-reading is harmless, since a version already
 * kept is ignored.
 */

export interface SyncCursor {
  phase: "backfill" | "incremental";
  /** Incremental: changes since this ISO time. */
  since: string | null;
  /** The next page of the run under way; null when none is under way. */
  page: number | null;
  /** The latest change the run under way has read. */
  highWater: string | null;
  backfillStartedAt: string | null;
  runStartedAt: string | null;
  /** Whether the run under way read a change made during it. */
  changedInRun: boolean;
  completedAt: string | null;
}

export const NEW_CURSOR: SyncCursor = {
  phase: "backfill",
  since: null,
  page: null,
  highWater: null,
  backfillStartedAt: null,
  runStartedAt: null,
  changedInRun: false,
  completedAt: null,
};

/** Clocks differ: a change this close to a run's start counts as made during it, and a backfill's end reads this far back. */
export const CLOCK_MARGIN_MS = 5 * 60_000;

const minus = (iso: string, ms: number) => new Date(Date.parse(iso) - ms).toISOString();
const latest = (a: string | null, b: string | null) => (a === null ? b : b === null ? a : a >= b ? a : b);

export interface PageAsked {
  phase: SyncCursor["phase"];
  since: string | null;
  page: number;
}

/** The page to read next, starting a run when none is under way. */
export function nextRequest(cursor: SyncCursor, nowIso: string): { cursor: SyncCursor; request: PageAsked } {
  const running: SyncCursor =
    cursor.page === null
      ? {
          ...cursor,
          page: 1,
          highWater: null,
          runStartedAt: nowIso,
          changedInRun: false,
          backfillStartedAt: cursor.phase === "backfill" ? (cursor.backfillStartedAt ?? nowIso) : cursor.backfillStartedAt,
        }
      : cursor;
  return { cursor: running, request: { phase: running.phase, since: running.phase === "backfill" ? null : running.since, page: running.page as number } };
}

/** The cursor once a page was read and written. */
export function afterPage(cursor: SyncCursor, read: { page: number; last: boolean; updatedAts: readonly string[] }, nowIso: string): SyncCursor {
  const highWater = read.updatedAts.reduce<string | null>((max, at) => latest(max, at), cursor.highWater);
  const runStart = cursor.runStartedAt ?? nowIso;
  const changedInRun = cursor.changedInRun || read.updatedAts.some((at) => at >= minus(runStart, CLOCK_MARGIN_MS));
  if (!read.last) return { ...cursor, page: read.page + 1, highWater, changedInRun };
  const idle = { page: null, highWater: null, runStartedAt: null, changedInRun: false } as const;
  if (read.page > 1 && changedInRun) return { ...cursor, ...idle };
  if (cursor.phase === "backfill") {
    return { ...cursor, ...idle, phase: "incremental", since: minus(cursor.backfillStartedAt ?? runStart, CLOCK_MARGIN_MS), completedAt: nowIso };
  }
  return { ...cursor, ...idle, since: highWater ?? cursor.since, completedAt: nowIso };
}

/** How many pages the run under way has read: for "Syncing: 2 of Xero's pages read so far". */
export function pagesRead(cursor: SyncCursor): number {
  return cursor.page === null ? 0 : cursor.page - 1;
}
