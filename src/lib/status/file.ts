import { GITHUB_URL } from "@/lib/site-links";

/**
 * The production check's status file, as `scripts/synthetic-check.mjs` publishes it to the repository's `status` branch
 * after every round (docs/superpowers/specs/2026-11-04-status-page-design.md SP1, SP2). The status page reads it from
 * GitHub, never from Vestiarion's own database: the check runs outside Vercel and Supabase.
 */

/** The branch the check replaces after every round. */
export const STATUS_BRANCH = "status";

/** Where the page reads the file: GitHub's raw file host, which keeps it up to 5 minutes (SP6). By the branch's full
 * ref, so a tag of the same name could never stand in for it. */
export const STATUS_FILE_URL = `https://raw.githubusercontent.com/duongnq2798/vestiarion/refs/heads/${STATUS_BRANCH}/status.json`;

/** The branch on GitHub, whose README shows the same state while vestiarion.xyz does not answer (SP1). */
export const STATUS_BRANCH_URL = `${GITHUB_URL}/tree/${STATUS_BRANCH}`;

/** The longest reason the check keeps for a failure (`STATUS_REASON_MAX` in the script). */
export const STATUS_REASON_MAX = 120;

/** `[1, ms]` for a pass; `[0, ms, reason]` for a failure, the reason as the job log gives it. */
export type StatusResult = readonly [1, number] | readonly [0, number, string];

export interface StatusRound {
  at: string;
  results: Readonly<Record<string, StatusResult>>;
}

export interface StatusFile {
  version: 1;
  source: string;
  origin: string;
  everyMinutes: number;
  updatedAt: string;
  checks: ReadonlyArray<{ path: string; budgetMs: number }>;
  /** Every round of the last 7 days, oldest first. */
  rounds: readonly StatusRound[];
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isIso = (value: unknown): value is string => typeof value === "string" && ISO.test(value) && Number.isFinite(Date.parse(value));
const isPath = (value: unknown): value is string => typeof value === "string" && value.startsWith("/") && value.length <= 200;
const isMs = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function result(value: unknown): StatusResult | null {
  if (!Array.isArray(value)) return null;
  if (value.length === 2 && value[0] === 1 && isMs(value[1])) return [1, value[1]];
  if (value.length === 3 && value[0] === 0 && isMs(value[1]) && typeof value[2] === "string" && value[2].length <= STATUS_REASON_MAX) {
    return [0, value[1], value[2]];
  }
  return null;
}

/** At most a week of rounds every minute, far more than a round every 10 minutes makes. */
const ROUNDS_MAX = 10_080;
const CHECKS_MAX = 50;

/**
 * The file, or null when it is not one the script writes (SP7): any field missing or of another type refuses the whole
 * file, so the page never shows half of one.
 */
export function parseStatusFile(value: unknown): StatusFile | null {
  if (!isObject(value) || value.version !== 1) return null;
  const { source, origin, everyMinutes, updatedAt, checks, rounds } = value;
  if (typeof source !== "string" || typeof origin !== "string" || !/^https?:\/\/[^\s/]+$/.test(origin)) return null;
  if (!Number.isSafeInteger(everyMinutes) || (everyMinutes as number) < 1 || (everyMinutes as number) > 60 || !isIso(updatedAt)) return null;
  if (!Array.isArray(checks) || checks.length === 0 || checks.length > CHECKS_MAX || !Array.isArray(rounds) || rounds.length > ROUNDS_MAX) return null;

  const keptChecks: Array<{ path: string; budgetMs: number }> = [];
  for (const check of checks) {
    if (!isObject(check) || !isPath(check.path) || !isMs(check.budgetMs)) return null;
    keptChecks.push({ path: check.path, budgetMs: check.budgetMs });
  }
  const keptRounds: StatusRound[] = [];
  for (const round of rounds) {
    if (!isObject(round) || !isIso(round.at) || !isObject(round.results)) return null;
    const results: Record<string, StatusResult> = {};
    for (const [path, raw] of Object.entries(round.results)) {
      const parsed = result(raw);
      if (!isPath(path) || parsed === null) return null;
      results[path] = parsed;
    }
    keptRounds.push({ at: round.at, results });
  }
  keptRounds.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { version: 1, source, origin, everyMinutes: everyMinutes as number, updatedAt, checks: keptChecks, rounds: keptRounds };
}

/** A read that cannot finish in 5 seconds counts as unread (SP6). */
const READ_DEADLINE_MS = 5_000;
/** A week of every page failing with the longest reason is about 1.6 MB (SP2); anything past this is not the check's. */
const FILE_MAX = 3_000_000;

/**
 * The published file (SP6): `missing` while GitHub answers 404, before the check's first published round, and
 * `unreadable` when GitHub did not answer, or answered with something that is not a file the check writes.
 */
export type StatusRead = { state: "read"; file: StatusFile } | { state: "missing" } | { state: "unreadable" };

export async function readStatusFile(fetchImpl: typeof fetch = fetch): Promise<StatusRead> {
  try {
    // Read on each visit: a copy kept here and served stale after a quiet spell would make the page call a running
    // monitor paused. GitHub's own cache keeps the file up to 5 minutes.
    const response = await fetchImpl(STATUS_FILE_URL, { cache: "no-store", signal: AbortSignal.timeout(READ_DEADLINE_MS) });
    if (response.status === 404) return { state: "missing" };
    if (!response.ok) return { state: "unreadable" };
    const text = await response.text();
    if (text.length > FILE_MAX) return { state: "unreadable" };
    const file = parseStatusFile(JSON.parse(text));
    return file ? { state: "read", file } : { state: "unreadable" };
  } catch (error) {
    console.error("status: the status file could not be read", error instanceof Error ? error.name : "unknown error");
    return { state: "unreadable" };
  }
}
