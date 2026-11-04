import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connection } from "next/server";
import StatusPage, { metadata } from "@/app/status/page";
import { parseStatusFile, readStatusFile, STATUS_BRANCH_URL, STATUS_FILE_URL, type StatusFile } from "@/lib/status/file";
import { checkName, INCIDENT_FAILS, PAUSED_AFTER_MINUTES, summarize } from "@/lib/status/summary";
import { ISSUES_URL } from "@/lib/site-links";
import { CHECKS, STATUS_REASON_MAX, TIMEOUT_MS, statusFile, statusRound } from "../scripts/synthetic-check.mjs";

// Outside a request, Next's connection() has none to wait for.
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: vi.fn(async () => undefined) }));

vi.mock("@/lib/status/file", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/status/file")>();
  return { ...actual, readStatusFile: vi.fn(actual.readStatusFile) };
});

/**
 * The status page (docs/superpowers/specs/2026-11-04-status-page-design.md SP6, SP7): the file the production check
 * publishes, parsed strictly; what the page says from it, worked out apart from the page; and the page for each state.
 * Every file here is written with the check's own functions, so the script and the page cannot drift.
 */

const MINUTE = 60_000;
const NOW = new Date("2026-11-04T12:05:00.000Z");
const PATHS = CHECKS.map((check) => check.path);

type Result = { path: string; ok: boolean; reason: string | null; status: number | null; ms: number };
type Failing = Partial<Record<string, string>>;
const results = (failing: Failing = {}, ms = 120): Result[] =>
  PATHS.map((path) => {
    const reason = failing[path];
    return reason === undefined ? { path, ok: true, reason: null, status: 200, ms } : { path, ok: false, reason, status: 500, ms };
  });

/** Rounds every 10 minutes from `from` to `to` (inclusive), each with `failing(at)` failing. */
function rounds(from: Date, to: Date, failing: (at: Date) => Failing = () => ({})) {
  const kept = [];
  for (let time = from.getTime(); time <= to.getTime(); time += 10 * MINUTE) kept.push(statusRound(results(failing(new Date(time))), new Date(time)));
  return kept;
}

function file(kept: ReturnType<typeof rounds>): StatusFile {
  const parsed = parseStatusFile(JSON.parse(JSON.stringify(statusFile({ origin: "https://www.vestiarion.xyz", everyMinutes: 10, checks: CHECKS, rounds: kept }))));
  if (!parsed) throw new Error("the script's file did not parse");
  return parsed;
}

const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * MINUTE);

const text = (markup: string) =>
  markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").replace(/ ([.,])/g, "$1").trim();

describe("the status file (SP7)", () => {
  it("reads the file the production check writes", () => {
    const kept = rounds(minutesAgo(20), minutesAgo(0), () => ({ "/open": "answered 500, expected 200" }));
    const parsed = file(kept);
    expect(parsed.checks.map((check) => check.path)).toEqual(PATHS);
    expect(parsed.rounds).toHaveLength(3);
    expect(parsed.rounds[2].results["/open"]).toEqual([0, 120, "answered 500, expected 200"]);
  });

  it("refuses the whole file when any part of it is not what the check writes", () => {
    const good = JSON.parse(JSON.stringify(statusFile({ origin: "https://www.vestiarion.xyz", everyMinutes: 10, checks: CHECKS, rounds: rounds(minutesAgo(10), NOW) })));
    const variants: Array<[string, (value: Record<string, unknown>) => void]> = [
      ["another version", (value) => void (value.version = 2)],
      ["no checks", (value) => void (value.checks = [])],
      ["a check without a path", (value) => void ((value.checks as Array<Record<string, unknown>>)[0].path = "open")],
      ["an origin that is not one", (value) => void (value.origin = "javascript:alert(1)")],
      ["a round's time that is not ISO", (value) => void ((value.rounds as Array<Record<string, unknown>>)[0].at = "yesterday")],
      ["a pass with a reason", (value) => void (((value.rounds as Array<{ results: Record<string, unknown> }>)[0].results)["/"] = [1, 5, "why"])],
      ["a failure without one", (value) => void (((value.rounds as Array<{ results: Record<string, unknown> }>)[0].results)["/"] = [0, 5])],
      ["a reason too long", (value) => void (((value.rounds as Array<{ results: Record<string, unknown> }>)[0].results)["/"] = [0, 5, "x".repeat(STATUS_REASON_MAX + 1)])],
      ["a negative time", (value) => void (((value.rounds as Array<{ results: Record<string, unknown> }>)[0].results)["/"] = [1, -1])],
      ["every minute a week", (value) => void (value.everyMinutes = 0)],
    ];
    expect(parseStatusFile(good)).not.toBeNull();
    for (const [what, change] of variants) {
      const copy = JSON.parse(JSON.stringify(good));
      change(copy);
      expect(parseStatusFile(copy), what).toBeNull();
    }
    expect(parseStatusFile(null)).toBeNull();
    expect(parseStatusFile([])).toBeNull();
  });

  it("is read from GitHub's raw host, kept 60 seconds: missing before the first round, unreadable for anything else", async () => {
    const good = JSON.stringify(statusFile({ origin: "https://www.vestiarion.xyz", everyMinutes: 10, checks: CHECKS, rounds: rounds(minutesAgo(10), NOW) }));
    const calls: Array<[string, RequestInit | undefined]> = [];
    const answering = (response: () => Response): typeof fetch => async (input, init) => {
      calls.push([String(input), init]);
      return response();
    };
    expect((await readStatusFile(answering(() => new Response(good)))).state).toBe("read");
    expect(calls[0][0]).toBe(STATUS_FILE_URL);
    expect(STATUS_FILE_URL).toBe("https://raw.githubusercontent.com/duongnq2798/vestiarion/refs/heads/status/status.json");
    // Read on each visit, never a copy kept here that a quiet spell would leave old.
    expect((calls[0][1] as RequestInit).cache).toBe("no-store");
    expect(await readStatusFile(answering(() => new Response("404: Not Found", { status: 404 })))).toEqual({ state: "missing" });
    expect(await readStatusFile(answering(() => new Response("", { status: 503 })))).toEqual({ state: "unreadable" });
    expect(await readStatusFile(answering(() => new Response("{not json")))).toEqual({ state: "unreadable" });
    expect(await readStatusFile(answering(() => new Response(JSON.stringify({ version: 2 }))))).toEqual({ state: "unreadable" });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(
      await readStatusFile(async () => {
        throw new TypeError("fetch failed");
      })
    ).toEqual({ state: "unreadable" });
    error.mockRestore();
  });

  it("stays under the read's limit for a week of every page failing with the longest reason", () => {
    const reason = "x".repeat(STATUS_REASON_MAX);
    const kept = rounds(new Date(NOW.getTime() - 7 * 24 * 60 * MINUTE + MINUTE), NOW, () => Object.fromEntries(PATHS.map((path) => [path, reason])));
    const size = JSON.stringify(statusFile({ origin: "https://www.vestiarion.xyz", everyMinutes: 10, checks: CHECKS, rounds: kept })).length;
    expect(kept).toHaveLength(1008);
    expect(size).toBeLessThan(2_000_000);
  });
});

describe("what the page says (SP6)", () => {
  it("names each check: the landing page, the open numbers, the docs, each free tool by its title, robots.txt and the sitemap", () => {
    expect(PATHS.map(checkName)).toEqual([
      "Landing page",
      "Open numbers",
      "Docs",
      "Address checker",
      "Payment terms calculator",
      "OFAC vendor check",
      "Bill list check",
      "Payout batch check",
      "robots.txt",
      "Sitemap",
    ]);
    expect(checkName("/elsewhere")).toBe("/elsewhere");
  });

  it("says every check passes when each one passed in a recent last round", () => {
    const summary = summarize(file(rounds(minutesAgo(65), minutesAgo(5))), NOW);
    expect(summary.headline).toEqual({ kind: "passing", checks: 10 });
    expect(summary.updatedAt).toBe(minutesAgo(5).toISOString());
    expect(summary.checks[0].last).toEqual({ at: minutesAgo(5).toISOString(), ok: true, ms: 120, reason: null });
  });

  it("names the checks that failed in the last round", () => {
    const failing = (at: Date): Record<string, string> => (at >= minutesAgo(10) ? { "/open": "answered 500, expected 200", "/docs": "missing \"Vestiarion docs\"" } : {});
    const summary = summarize(file(rounds(minutesAgo(30), minutesAgo(0), failing)), NOW);
    expect(summary.headline).toEqual({ kind: "failing", checks: 10, failing: ["Open numbers", "Docs"] });
    expect(summary.checks[1].last).toEqual({ at: NOW.toISOString(), ok: false, ms: 120, reason: "answered 500, expected 200" });
  });

  it(`says the checks are paused when the last round is more than ${PAUSED_AFTER_MINUTES} minutes old, with what failed in it`, () => {
    const last = minutesAgo(PAUSED_AFTER_MINUTES + 1);
    const summary = summarize(file(rounds(minutesAgo(120), last, () => ({ "/sitemap.xml": "took 10.0 s, over its 4 s budget" }))), NOW);
    expect(summary.headline).toEqual({ kind: "paused", since: summary.updatedAt, failing: ["Sitemap"] });
    expect(summarize(file(rounds(minutesAgo(65), minutesAgo(PAUSED_AFTER_MINUTES))), NOW).headline.kind).toBe("passing");
  });

  it("says no round has run when the file holds none", () => {
    const summary = summarize(file([]), NOW);
    expect(summary.headline).toEqual({ kind: "none" });
    expect(summary.checks.every((check) => check.last === null && check.day.rounds === 0)).toBe(true);
  });

  it("counts the rounds that ran against the ones a round every 10 minutes makes, so a pause shows", () => {
    // Rounds for the last 7 days but a 3-hour pause yesterday.
    const kept = rounds(new Date(NOW.getTime() - 7 * 24 * 60 * MINUTE + MINUTE), NOW).filter((round) => {
      const time = Date.parse(round.at);
      return !(time > NOW.getTime() - 20 * 60 * MINUTE && time <= NOW.getTime() - 17 * 60 * MINUTE);
    });
    const summary = summarize(file(kept), NOW);
    expect(summary.coverage).toEqual({ day: 144 - 18, week: 1008 - 18, dayExpected: 144, weekExpected: 1008 });
    expect(summary.checks[0].day).toEqual({ rounds: 126, passed: 126, slots: 126 });
  });

  it("counts the monitor's 10-minute slots, so a run starting just after the last never counts more than it should", () => {
    // Two rounds a few minutes apart in each of the last 3 slots, as when a run ends and the next starts at once.
    const kept = [0, 10, 20].flatMap((ago) => [statusRound(results(), minutesAgo(ago + 1)), statusRound(results(), minutesAgo(ago + 3))]);
    const summary = summarize(file(kept.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))), NOW);
    expect(summary.coverage.day).toBe(3);
    expect(summary.checks[0].day).toEqual({ rounds: 6, passed: 6, slots: 3 });
  });

  it("says an incident already failing in the oldest result kept may have started earlier", () => {
    const summary = summarize(file(rounds(minutesAgo(60), NOW, (at) => (at <= minutesAgo(40) ? { "/docs": "answered 500, expected 200" } : {}))), NOW);
    expect(summary.incidents).toEqual([
      { path: "/docs", name: "Docs", since: minutesAgo(60).toISOString(), until: minutesAgo(30).toISOString(), startedEarlier: true, failedRounds: 3, reason: "answered 500, expected 200" },
    ]);
  });

  it("shows the last 24 hours an hour a cell: passed, failed in a round, or not checked", () => {
    const kept = rounds(minutesAgo(5 * 60), minutesAgo(0), (at) => (at.getTime() === Date.parse("2026-11-04T10:35:00.000Z") ? { "/": "answered 502, expected 200" } : {}));
    const hours = summarize(file(kept), NOW).checks[0].hours;
    expect(hours).toHaveLength(24);
    expect(hours[0].start).toBe("2026-11-03T13:00:00.000Z");
    expect(hours[23].start).toBe("2026-11-04T12:00:00.000Z");
    expect(hours.slice(0, 18).every((cell) => cell.state === "none")).toBe(true);
    expect(hours.slice(18).map((cell) => cell.state)).toEqual(["passed", "passed", "passed", "failed", "passed", "passed"]);
    expect(hours[21]).toEqual({ start: "2026-11-04T10:00:00.000Z", state: "failed", rounds: 6, failed: 1 });
  });

  it(`makes an incident of ${INCIDENT_FAILS} failures running, ended or ongoing, and none of one`, () => {
    const failing = (at: Date): Record<string, string> => {
      const time = at.toISOString();
      const fails: Record<string, string> = {};
      // The docs fail 3 rounds running, then pass.
      if (time >= "2026-11-04T09:05:00.000Z" && time <= "2026-11-04T09:25:00.000Z") fails["/docs"] = "answered 500, expected 200";
      // The sitemap fails once.
      if (time === "2026-11-04T10:05:00.000Z") fails["/sitemap.xml"] = "took 10.0 s, over its 4 s budget";
      // The open numbers fail from 11:50 and still fail.
      if (time >= "2026-11-04T11:50:00.000Z") fails["/open"] = "answered 503, expected 200";
      return fails;
    };
    const summary = summarize(file(rounds(minutesAgo(5 * 60), NOW, failing)), NOW);
    expect(summary.incidents).toEqual([
      { path: "/open", name: "Open numbers", since: "2026-11-04T11:55:00.000Z", until: null, startedEarlier: false, failedRounds: 2, reason: "answered 503, expected 200" },
      { path: "/docs", name: "Docs", since: "2026-11-04T09:05:00.000Z", until: "2026-11-04T09:35:00.000Z", startedEarlier: false, failedRounds: 3, reason: "answered 500, expected 200" },
    ]);
  });
});

describe("the page (SP6)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(readStatusFile).mockReset();
  });

  const render = async (status: StatusFile | "missing" | "unreadable") => {
    vi.mocked(readStatusFile).mockResolvedValue(typeof status === "string" ? { state: status } : { state: "read", file: status });
    return renderToStaticMarkup(await StatusPage());
  };

  it("gives the check's own wait and budgets", () => {
    expect(TIMEOUT_MS).toBe(15_000);
    expect(CHECKS.filter((check) => check.budgetMs === 8000).map((check) => check.path)).toEqual(["/", "/open"]);
    expect(CHECKS.filter((check) => check.budgetMs !== 8000).every((check) => check.budgetMs === 4000)).toBe(true);
  });

  it("is public, at /status, and rendered for each visit", async () => {
    expect(metadata.alternates?.canonical).toBe("/status");
    expect(metadata.title).toBe("Status");
    await render("missing");
    expect(connection).toHaveBeenCalled();
  });

  it("says every page is up, with each page's last result, its times checked and missed, its hours, and no incident", async () => {
    const markup = await render(file(rounds(minutesAgo(65), minutesAgo(5))));
    const words = text(markup);
    expect(words).toContain("All 10 pages up");
    expect(words).toContain("All 10 pages were up at the last check. Last checked Nov 4, 2026, 12:00 UTC.");
    expect(words).toContain("In the last 24 hours the monitor ran 7 of the 144 times it should have, and 7 of 1,008 in the last 7 days.");
    expect(words).toContain("This page read the results Nov 4, 2026, 12:05 UTC.");
    expect(words).toContain("Landing page / Up 120 ms at 12:00 UTC");
    expect(words).toContain("Last 24 hours: up 7 of 7 times checked, 137 missed. Last 7 days: up 7 of 7 times checked, 1,001 missed.");
    expect(words).toContain("Last 24 hours, by the hour: 2 hours up every check, none with a failure, 22 hours not checked.");
    expect(words).toContain("Last 24 hours, by the hour: Up every check A failure Not checked");
    expect(words).toContain("No incident in the last 7 days.");
    expect(words).toContain("the same results are on GitHub at github.com/duongnq2798/vestiarion/tree/status.");
    expect(markup).toContain(`href="${STATUS_BRANCH_URL}"`);
    expect(markup).toContain(`href="${STATUS_FILE_URL}"`);
    expect(markup).toContain(`href="${ISSUES_URL}"`);
    expect((markup.match(/title="[^"]*: not checked"/g) ?? []).length).toBe(22 * 10);
    // Never "checks" on their own, which on a bills product reads as payments.
    expect(words).not.toMatch(/\b\d+ (of \d+ )?checks\b/);
  });

  it("names a failing page first, with its reason, the incident and where to report a problem", async () => {
    const markup = await render(file(rounds(minutesAgo(60), NOW, (at) => (at >= minutesAgo(10) ? { "/open": "answered 500, expected 200" } : {}))));
    const words = text(markup);
    expect(words).toContain("1 of 10 pages failing");
    expect(words).toContain("1 of 10 pages failed at the last check: Open numbers.");
    expect(words).toContain("The team gets an alert when a page fails twice in a row. Something wrong that this page does not show? Tell us on GitHub Issues.");
    expect(words).toContain("Each page Last 24 hours, by the hour: Up every check A failure Not checked Open numbers /open Failing at 12:05 UTC answered 500, expected 200");
    expect(words).toContain("Last 24 hours, by the hour: 0 hours up every check, 2 hours with a failure (11:00 to 12:00 UTC, 12:00 to 13:00 UTC), 22 hours not checked.");
    expect(words).toContain("Open numbers /open Still failing");
    expect(words).toContain("From Nov 4, 2026, 11:55 UTC, failed 2 times in a row so far. First reason: answered 500, expected 200.");
  });

  it("says when monitoring paused, shows the last results as they were then, and an ongoing incident as failing when it paused", async () => {
    const markup = await render(file(rounds(minutesAgo(180), minutesAgo(40), (at) => (at >= minutesAgo(50) ? { "/docs": "answered 500, expected 200" } : {}))));
    const words = text(markup);
    expect(words).toContain("Monitoring paused since Nov 4, 2026, 11:25 UTC");
    expect(words).toContain("Monitoring paused: nothing checked since Nov 4, 2026, 11:25 UTC.");
    expect(words).toContain("That does not mean Vestiarion is down. Below are the results of the last check, when 1 page failed: Docs.");
    expect(words).toContain("Landing page / Up at 11:25 UTC");
    expect(words).toContain("Docs /docs Failed at 11:25 UTC answered 500, expected 200");
    expect(words).not.toContain("Still failing");
    expect(words).toContain("Docs /docs Failing when monitoring paused");
    expect(words).toContain("Those hours show as not checked, never as up.");
  });

  it("says there are no results yet before the first round is published, and hides the pages", async () => {
    for (const status of ["missing", file([])] as const) {
      const words = text(await render(status));
      expect(words).toContain("No results yet.");
      expect(words).toContain("The monitor has not published any results yet.");
      expect(words).not.toContain("Each page");
    }
  });

  it("still answers when the file cannot be read, and links the branch", async () => {
    const markup = await render("unreadable");
    const words = text(markup);
    expect(words).toContain("The results could not be read right now.");
    expect(words).toContain("That does not mean Vestiarion is down.");
    expect(markup).toContain(`href="${STATUS_BRANCH_URL}"`);
    expect(words).toContain("It does not check the API, which needs a key");
  });
});
