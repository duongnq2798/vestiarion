/**
 * Where a sync stopped, per connection and object type (docs/superpowers/specs/2026-10-12-xero-connector-design.md X8,
 * I13). A run reads pages in the provider's update order; after each page written, the cursor keeps the next page and
 * the latest change read, so a run stopped by a rate limit or an outage resumes there. Pure.
 *
 * Paging in update order has one gap: a row on a page already read that changes during the run moves to the end, and
 * the first row of the next page moves up into the page already read, unseen. So a run of more than one page that read
 * a change made during it starts over from page 1, with the same time; re-reading is harmless, since a version already
 * kept is ignored. A row can also leave the read on a page already read (a backfill reads open bills only, and one is
 * paid), moving the next row up just the same; the provider's count of what the read matches then falls, and the run
 * starts over too.
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
  /** Whether the run under way read a change made during it, or saw fewer records match than before. */
  changedInRun: boolean;
  /** How many records the read matched on the run's last page read, where the provider says; null otherwise. */
  total: number | null;
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
  total: null,
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
          total: null,
          backfillStartedAt: cursor.phase === "backfill" ? (cursor.backfillStartedAt ?? nowIso) : cursor.backfillStartedAt,
        }
      : cursor;
  return { cursor: running, request: { phase: running.phase, since: running.phase === "backfill" ? null : running.since, page: running.page as number } };
}

export interface PageRead {
  page: number;
  last: boolean;
  updatedAts: readonly string[];
  /** How many records the read matches now, where the provider says. */
  total?: number | null;
  /**
   * The provider reads no further for this query (HubSpot's search stops at 10,000 results): the page is the run's last,
   * and the run never starts over, which would read the same pages again (HubSpot connector H6).
   */
  capped?: boolean;
}

/**
 * The cursor once a page was read and written, and whether the run goes on (`more`), reached its end (`done`), or
 * starts over from page 1 because paging may have skipped a row (`restart`).
 */
export function pageOutcome(cursor: SyncCursor, read: PageRead, nowIso: string): { cursor: SyncCursor; run: "more" | "done" | "restart" } {
  const highWater = read.updatedAts.reduce<string | null>((max, at) => latest(max, at), cursor.highWater);
  const runStart = cursor.runStartedAt ?? nowIso;
  const total = read.total ?? null;
  // Fewer records than on the page before: one left the read, and the next moved up into a page already read.
  const shrank = total !== null && cursor.total !== null && total < cursor.total;
  const changedInRun = cursor.changedInRun || shrank || read.updatedAts.some((at) => at >= minus(runStart, CLOCK_MARGIN_MS));
  if (!read.last) return { cursor: { ...cursor, page: read.page + 1, highWater, changedInRun, total: total ?? cursor.total }, run: "more" };
  const idle = { page: null, highWater: null, runStartedAt: null, changedInRun: false, total: null } as const;
  if (read.page > 1 && changedInRun && !read.capped) return { cursor: { ...cursor, ...idle }, run: "restart" };
  if (cursor.phase === "backfill") {
    return {
      cursor: { ...cursor, ...idle, phase: "incremental", since: minus(cursor.backfillStartedAt ?? runStart, CLOCK_MARGIN_MS), completedAt: nowIso },
      run: "done",
    };
  }
  if (read.capped && highWater !== null) {
    // The provider asks for the changes since `since` less CLOCK_MARGIN_MS (HubSpot's search, H6). Past its cap, the next
    // run starts at the latest change read, not that margin before it: more changes than the cap within the margin would
    // be read again, the same ones, run after run, and nothing after them ever. Changes at that very instant are read
    // again. When every result read shares the instant the run started at, the next starts just after it: a search in
    // the order of that instant reaches no further.
    const asked = cursor.since === null ? null : minus(cursor.since, CLOCK_MARGIN_MS);
    const from = asked !== null && highWater <= asked ? minus(asked, -1) : highWater;
    return { cursor: { ...cursor, ...idle, since: minus(from, -CLOCK_MARGIN_MS), completedAt: nowIso }, run: "done" };
  }
  return { cursor: { ...cursor, ...idle, since: highWater ?? cursor.since, completedAt: nowIso }, run: "done" };
}

/** The cursor once a page was read and written. */
export function afterPage(cursor: SyncCursor, read: PageRead, nowIso: string): SyncCursor {
  return pageOutcome(cursor, read, nowIso).cursor;
}

/** How many pages the run under way has read: for "Syncing: 2 of Xero's pages read so far". */
export function pagesRead(cursor: SyncCursor): number {
  return cursor.page === null ? 0 : cursor.page - 1;
}
