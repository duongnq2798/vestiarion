import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StatusPage, { metadata, revalidate } from "@/app/status/page";
import { parseStatusFile, readStatusFile, STATUS_BRANCH_URL, STATUS_FILE_URL, type StatusFile } from "@/lib/status/file";
import { checkName, INCIDENT_FAILS, PAUSED_AFTER_MINUTES, share, summarize } from "@/lib/status/summary";
import { CHECKS, STATUS_REASON_MAX, TIMEOUT_MS, statusFile, statusRound } from "../scripts/synthetic-check.mjs";

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

  it("is read from GitHub's raw host, kept 60 seconds, and an answer that is not a file counts as unread", async () => {
    const good = JSON.stringify(statusFile({ origin: "https://www.vestiarion.xyz", everyMinutes: 10, checks: CHECKS, rounds: rounds(minutesAgo(10), NOW) }));
    const calls: Array<[string, RequestInit | undefined]> = [];
    const answering = (response: () => Response): typeof fetch => async (input, init) => {
      calls.push([String(input), init]);
      return response();
    };
    expect(await readStatusFile(answering(() => new Response(good)))).not.toBeNull();
    expect(calls[0][0]).toBe(STATUS_FILE_URL);
    expect(STATUS_FILE_URL).toBe("https://raw.githubusercontent.com/duongnq2798/vestiarion/status/status.json");
    expect((calls[0][1] as { next?: { revalidate?: number } }).next).toEqual({ revalidate: 60 });
    expect(await readStatusFile(answering(() => new Response("not found", { status: 404 })))).toBeNull();
    expect(await readStatusFile(answering(() => new Response("{not json")))).toBeNull();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(
      await readStatusFile(async () => {
        throw new TypeError("fetch failed");
      })
    ).toBeNull();
    error.mockRestore();
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
    expect(summary.checks[0].day).toEqual({ rounds: 126, passed: 126 });
  });

  it("gives each check's share of passed rounds, never rounded up to 100% while a round failed", () => {
    expect(share({ rounds: 0, passed: 0 })).toBeNull();
    expect(share({ rounds: 144, passed: 144 })).toBe("100%");
    expect(share({ rounds: 1008, passed: 1007 })).toBe("99.9%");
    expect(share({ rounds: 3, passed: 2 })).toBe("66.6%");
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
      { path: "/open", name: "Open numbers", since: "2026-11-04T11:55:00.000Z", until: null, failedRounds: 2, reason: "answered 503, expected 200" },
      { path: "/docs", name: "Docs", since: "2026-11-04T09:05:00.000Z", until: "2026-11-04T09:35:00.000Z", failedRounds: 3, reason: "answered 500, expected 200" },
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

  const render = async (status: StatusFile | null) => {
    vi.mocked(readStatusFile).mockResolvedValue(status);
    return renderToStaticMarkup(await StatusPage());
  };

  it("gives the check's own wait and budgets", () => {
    expect(TIMEOUT_MS).toBe(15_000);
    expect(CHECKS.filter((check) => check.budgetMs === 8000).map((check) => check.path)).toEqual(["/", "/open"]);
    expect(CHECKS.filter((check) => check.budgetMs !== 8000).every((check) => check.budgetMs === 4000)).toBe(true);
  });

  it("is public, at /status, and kept a minute", () => {
    expect(metadata.alternates?.canonical).toBe("/status");
    expect(metadata.title).toBe("Status");
    expect(revalidate).toBe(60);
  });

  it("says every check passes, with each check's last result, its share of rounds and its hours, and no incident", async () => {
    const markup = await render(file(rounds(minutesAgo(65), minutesAgo(5))));
    const words = text(markup);
    expect(words).toContain("All 10 checks passing");
    expect(words).toContain("All 10 checks passed in the last round.");
    expect(words).toContain("The last round ran at Nov 4, 2026, 12:00 UTC.");
    expect(words).toContain("Rounds that ran: 7 of the 144 in the last 24 hours, and 7 of the 1,008 in the last 7 days, at one every 10 minutes.");
    expect(words).toContain("Landing page / Passing 120 ms at 12:00 UTC");
    expect(words).toContain("Passed 100% of the last 24 hours' rounds (7), 100% of the last 7 days' (7).");
    expect(words).toContain("Last 24 hours, hour by hour: 2 passed every round, 0 had a failed round, 22 not checked.");
    expect(words).toContain("No incident in the last 7 days.");
    expect(markup).toContain(`href="${STATUS_BRANCH_URL}"`);
    expect(markup).toContain(`href="${STATUS_FILE_URL}"`);
    expect((markup.match(/title="[^"]*: not checked"/g) ?? []).length).toBe(22 * 10);
  });

  it("names a failing check, its reason, and the incident", async () => {
    const markup = await render(file(rounds(minutesAgo(60), NOW, (at) => (at >= minutesAgo(10) ? { "/open": "answered 500, expected 200" } : {}))));
    const words = text(markup);
    expect(words).toContain("1 of 10 checks failing");
    expect(words).toContain("1 check failed in the last round: Open numbers.");
    expect(words).toContain("Open numbers /open Failing at 12:05 UTC answered 500, expected 200");
    expect(words).toContain("Open numbers /open Still failing");
    expect(words).toContain("From Nov 4, 2026, 11:55 UTC, 2 failed rounds so far. First reason: answered 500, expected 200.");
  });

  it("says when the checks paused, and that hours with no round are not checked, never passing", async () => {
    const words = text(await render(file(rounds(minutesAgo(180), minutesAgo(40)))));
    expect(words).toContain("Checks paused since 11:25 UTC");
    expect(words).toContain("No round has run since Nov 4, 2026, 11:25 UTC.");
    expect(words).toContain("GitHub starts the check's runs once an hour and sometimes late");
    expect(words).toContain("An hour with no round shows as not checked, never as passing");
  });

  it("still answers when the file cannot be read, and links the branch", async () => {
    const markup = await render(null);
    const words = text(markup);
    expect(words).toContain("The status could not be read right now.");
    expect(words).toContain("That says nothing about the site itself.");
    expect(markup).toContain(`href="${STATUS_BRANCH_URL}"`);
    expect(words).toContain("It does not check the API, which needs a key");
  });
});
