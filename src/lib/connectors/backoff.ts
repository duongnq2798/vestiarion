/**
 * Waiting on a provider (docs/superpowers/specs/2026-10-12-xero-connector-design.md X8, I13). Pure: no I/O, no clock
 * of its own.
 */

/** However long a provider asks to wait, a sync is tried again within a day. */
export const MAX_RETRY_AFTER_MS = 24 * 60 * 60_000;

/** A wait this short is spent inside the run; anything longer ends the run, and a later one resumes at its checkpoint. */
export const WAIT_IN_RUN_MS = 5_000;

const MINUTE = 60_000;
const MAX_FAILURE_DELAY_MS = 60 * MINUTE;

/** `Retry-After`, in seconds or as an HTTP date, as milliseconds from `nowMs`; null when absent or unreadable. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  const text = value?.trim() ?? "";
  if (text === "") return null;
  if (/^\d+$/.test(text)) return Math.min(Number(text) * 1000, MAX_RETRY_AFTER_MS);
  if (!/[a-z]/i.test(text)) return null;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return null;
  return Math.min(Math.max(at - nowMs, 0), MAX_RETRY_AFTER_MS);
}

export function waitInRun(retryAfterMs: number | null): boolean {
  return retryAfterMs !== null && retryAfterMs <= WAIT_IN_RUN_MS;
}

/** How long to wait after `failures` failures in a row: a minute, doubling, at most an hour. */
export function failureDelayMs(failures: number): number {
  const n = Math.max(1, Math.floor(failures));
  return Math.min(MINUTE * 2 ** Math.min(n - 1, 10), MAX_FAILURE_DELAY_MS);
}
