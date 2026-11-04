import { FREE_TOOLS } from "@/lib/free-tools";
import type { StatusFile } from "./file";

/**
 * What the status page says, worked out from the status file and the time it was read
 * (docs/superpowers/specs/2026-11-04-status-page-design.md SP6). Pure, so every state is tested apart from the page.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A last round older than this, two and a half rounds at 10 minutes, means the checks are paused (SP6). */
export const PAUSED_AFTER_MINUTES = 25;

/** Failed rounds in a row that make an incident: the rule the team is told by (production check PC5). */
export const INCIDENT_FAILS = 2;

/** Each check's name on the page, by its address. */
const NAMES: Readonly<Record<string, string>> = {
  "/": "Landing page",
  "/open": "Open numbers",
  "/docs": "Docs",
  ...Object.fromEntries(FREE_TOOLS.map((tool) => [tool.path, tool.title])),
  "/robots.txt": "robots.txt",
  "/sitemap.xml": "Sitemap",
};

export function checkName(path: string): string {
  return NAMES[path] ?? path;
}

export interface RoundCount {
  /** Rounds that ran this check in the window. */
  rounds: number;
  passed: number;
  /** The monitor's slots of `everyMinutes` in the window with at least one of those rounds, never more than it makes. */
  slots: number;
}

/** One hour of the last 24, oldest first: whether the check passed every round of it, failed one, or never ran. */
export interface HourCell {
  start: string;
  state: "passed" | "failed" | "none";
  rounds: number;
  failed: number;
}

export interface CheckSummary {
  path: string;
  name: string;
  /** The check's result in the newest round that ran it. */
  last: { at: string; ok: boolean; ms: number; reason: string | null } | null;
  day: RoundCount;
  week: RoundCount;
  hours: HourCell[];
}

export interface Incident {
  path: string;
  name: string;
  since: string;
  /** The round it passed again, or null while it still fails. */
  until: string | null;
  /** It was already failing in the oldest round the file keeps, so it may have started earlier. */
  startedEarlier: boolean;
  failedRounds: number;
  reason: string;
}

export type Headline =
  | { kind: "passing"; checks: number }
  | { kind: "failing"; checks: number; failing: string[] }
  | { kind: "paused"; since: string; failing: string[] }
  | { kind: "none" };

export interface StatusSummary {
  readAt: string;
  updatedAt: string | null;
  everyMinutes: number;
  headline: Headline;
  checks: CheckSummary[];
  /** Slots with a round in the last 24 hours and 7 days, against what a round every `everyMinutes` makes. */
  coverage: { day: number; week: number; dayExpected: number; weekExpected: number };
  /** Newest first, from the last 7 days. */
  incidents: Incident[];
}

/**
 * The slots of `everyMinutes` the rounds fall in. A run can start just after the last ended and make a round a few
 * minutes after its last, so rounds alone can count more than a round every `everyMinutes` makes.
 */
const slotsOf = (times: readonly number[], everyMinutes: number) => new Set(times.map((time) => Math.floor(time / (everyMinutes * MINUTE)))).size;

/** The status file's state at `now` (SP6). */
export function summarize(file: StatusFile, now: Date): StatusSummary {
  const at = now.getTime();
  const rounds = file.rounds.filter((round) => Date.parse(round.at) <= at);
  const newest = rounds[rounds.length - 1] ?? null;
  const dayFrom = at - DAY;
  const weekFrom = at - 7 * DAY;
  const firstHour = Math.floor(at / HOUR) * HOUR - 23 * HOUR;

  const checks: CheckSummary[] = file.checks.map(({ path }) => {
    const ran = rounds.filter((round) => round.results[path] !== undefined);
    const lastRound = ran[ran.length - 1];
    const lastResult = lastRound?.results[path];
    const within = (from: number): RoundCount => {
      const kept = ran.filter((round) => Date.parse(round.at) > from);
      return {
        rounds: kept.length,
        passed: kept.filter((round) => round.results[path][0] === 1).length,
        slots: slotsOf(kept.map((round) => Date.parse(round.at)), file.everyMinutes),
      };
    };
    const hours: HourCell[] = Array.from({ length: 24 }, (_, index) => {
      const start = firstHour + index * HOUR;
      const results = ran.filter((round) => {
        const time = Date.parse(round.at);
        return time >= start && time < start + HOUR;
      }).map((round) => round.results[path]);
      const failed = results.filter((result) => result[0] === 0).length;
      return { start: new Date(start).toISOString(), state: results.length === 0 ? "none" : failed > 0 ? "failed" : "passed", rounds: results.length, failed };
    });
    return {
      path,
      name: checkName(path),
      last: lastRound && lastResult ? { at: lastRound.at, ok: lastResult[0] === 1, ms: lastResult[1], reason: lastResult[0] === 0 ? lastResult[2] : null } : null,
      day: within(dayFrom),
      week: within(weekFrom),
      hours,
    };
  });

  const incidents: Incident[] = [];
  for (const { path } of file.checks) {
    // Widened by hand: TypeScript narrows a `let` set to null and changed only inside the loop to `never` there.
    let run = null as { since: string; failed: number; reason: string; startedEarlier: boolean } | null;
    let first = true;
    const close = (until: string | null) => {
      if (run && run.failed >= INCIDENT_FAILS) {
        incidents.push({ path, name: checkName(path), since: run.since, until, startedEarlier: run.startedEarlier, failedRounds: run.failed, reason: run.reason });
      }
      run = null;
    };
    for (const round of rounds) {
      const result = round.results[path];
      if (result === undefined) continue;
      if (result[0] === 0) {
        if (run) run.failed += 1;
        else run = { since: round.at, failed: 1, reason: result[2], startedEarlier: first };
      } else {
        close(round.at);
      }
      first = false;
    }
    close(null);
  }
  incidents.sort((a, b) => Date.parse(b.since) - Date.parse(a.since));

  const failing = checks.filter((check) => newest?.results[check.path]?.[0] === 0).map((check) => check.name);
  const headline: Headline =
    newest === null
      ? { kind: "none" }
      : at - Date.parse(newest.at) > PAUSED_AFTER_MINUTES * MINUTE
        ? { kind: "paused", since: newest.at, failing }
        : failing.length > 0
          ? { kind: "failing", checks: file.checks.length, failing }
          : { kind: "passing", checks: file.checks.length };

  const perDay = Math.round(DAY / (file.everyMinutes * MINUTE));
  return {
    readAt: now.toISOString(),
    updatedAt: newest?.at ?? null,
    everyMinutes: file.everyMinutes,
    headline,
    checks,
    coverage: {
      day: slotsOf(rounds.map((round) => Date.parse(round.at)).filter((time) => time > dayFrom), file.everyMinutes),
      week: slotsOf(rounds.map((round) => Date.parse(round.at)).filter((time) => time > weekFrom), file.everyMinutes),
      dayExpected: perDay,
      weekExpected: perDay * 7,
    },
    incidents,
  };
}
