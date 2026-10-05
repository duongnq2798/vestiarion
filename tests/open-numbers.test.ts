import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import {
  dailySeries,
  listTeam,
  parsePeriod,
  readOpenNumbers,
  setTeamMember,
  type DailyPayments,
  type Period,
} from "@/lib/platform/open-numbers";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const NOW = new Date("2026-09-30T12:00:00Z");

function platform<T>(fn: () => Promise<T>, respond?: (request: RecordedRequest) => FakeReply) {
  const fake = fakeSupabase(respond);
  return { fake, result: runWith({ config, db: fake.client }, fn) };
}

const SIDE = {
  workspacesOpened: 1, liveWorkspaces: 1, people: 1, payments: 2, usdcPaid: 8, payees: 1, invoicesDecided: 1,
  milestonesReleased: 1, cycles: 1, modelDecisions: 3, policyDepartures: 1, refusedByCode: 1, usdcInWallets: 40,
};

/** What PostgREST returns for open_numbers: numerics can arrive as strings. */
const DOCUMENT = {
  generatedAt: "2026-09-30T12:00:00+00:00",
  sides: { customers: SIDE, ours: { ...SIDE, usdcPaid: "3.000000" }, total: SIDE },
  daily: [{ day: "2026-09-28", customers: 1, ours: 2, oursUsdc: "5.000000" }],
  ourPayments: [{ at: "2026-09-27T10:00:00+00:00", amount: "2.000000", txHash: "0xh1", chain: "ARC-TESTNET" }],
};

/** What PostgREST returns for open_first_payments (0042): the median is a float, or null with no first payment. */
const FIRSTS = {
  sides: {
    customers: { firstPayments: 2, medianMinutesToFirstPayment: 780.5 },
    ours: { firstPayments: 0, medianMinutesToFirstPayment: null },
    total: { firstPayments: "2", medianMinutesToFirstPayment: 780.5 },
  },
};

/** What PostgREST returns for open_outcomes (0049): counts, which can arrive as strings. */
const OUTCOME_SIDE = {
  decisionsCarriedOut: 5, decisionsEscalated: 10, escalationsResolved: 5, flagsResolved: 3, flagsUpheld: 1,
  invoicesPaidOnArc: 4, invoicesPaidOnTime: 3, invoicesPaidOnTimeUntouched: 1, duplicatesCaught: 2,
};
const OUTCOMES = { sides: { customers: OUTCOME_SIDE, ours: { ...OUTCOME_SIDE, decisionsCarriedOut: "7" }, total: OUTCOME_SIDE } };

/** Each function's document, by the path it is called at. */
const reply = (request: RecordedRequest): FakeReply =>
  request.path === "/rest/v1/rpc/open_first_payments"
    ? { body: FIRSTS }
    : request.path === "/rest/v1/rpc/open_outcomes"
      ? { body: OUTCOMES }
      : { body: DOCUMENT };

describe("parsePeriod", () => {
  it("is all time with no parameters", () => {
    expect(parsePeriod({}, NOW)).toEqual({ key: "all", since: null, label: "All time", query: "", fallback: false });
  });

  it("reads the rolling periods", () => {
    expect(parsePeriod({ period: "7d" }, NOW)).toEqual({
      key: "7d",
      since: new Date("2026-09-23T12:00:00Z"),
      label: "Last 7 days",
      query: "?period=7d",
      fallback: false,
    });
    expect(parsePeriod({ period: "30d" }, NOW)).toMatchObject({ key: "30d", since: new Date("2026-08-31T12:00:00Z"), label: "Last 30 days" });
  });

  it("reads a calendar date as the start of that UTC day", () => {
    expect(parsePeriod({ since: "2026-09-27" }, NOW)).toEqual({
      key: "since",
      since: new Date("2026-09-27T00:00:00Z"),
      label: "Since Sep 27, 2026",
      query: "?since=2026-09-27",
      fallback: false,
    });
    expect(parsePeriod({ since: "2026-09-30" }, NOW).key).toBe("since");
  });

  it.each([
    ["a future day", { since: "2026-10-01" }],
    ["a day before 2026", { since: "2025-12-31" }],
    ["a day that does not exist", { since: "2026-02-30" }],
    ["not a date", { since: "yesterday" }],
    ["two dates", { since: ["2026-09-27", "2026-09-28"] }],
    ["an unknown period", { period: "1y" }],
  ])("falls back to all time, and says so, for %s", (_name, params) => {
    expect(parsePeriod(params, NOW)).toEqual({ key: "all", since: null, label: "All time", query: "", fallback: true });
  });
});

describe("dailySeries", () => {
  const day = (d: string, customers = 0, ours = 0): DailyPayments => ({ day: d, customers, ours, oursUsdc: ours });
  const all: Period = { key: "all", since: null, label: "All time", query: "", fallback: false };

  it("fills every day from the first payment to today with zeros between", () => {
    expect(dailySeries([day("2026-09-27", 0, 1), day("2026-09-29", 2, 0)], all, NOW)).toEqual([
      day("2026-09-27", 0, 1),
      day("2026-09-28"),
      day("2026-09-29", 2, 0),
      day("2026-09-30"),
    ]);
  });

  it("starts a dated period on its first day", () => {
    const since: Period = { key: "since", since: new Date("2026-09-26T00:00:00Z"), label: "", query: "", fallback: false };
    expect(dailySeries([day("2026-09-29", 1)], since, NOW).map((row) => row.day)).toEqual([
      "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30",
    ]);
  });

  it("keeps the latest 90 days at most", () => {
    const series = dailySeries([day("2026-01-02", 1)], all, NOW);
    expect(series).toHaveLength(90);
    expect(series.at(-1)?.day).toBe("2026-09-30");
    expect(series[0].day).toBe("2026-07-03");
  });

  it("is empty when nothing was paid", () => {
    expect(dailySeries([], all, NOW)).toEqual([]);
  });
});

describe("readOpenNumbers", () => {
  const since = (date: string) => parsePeriod({ since: date }, NOW);

  it("asks open_numbers, open_first_payments and open_outcomes for the period's start and reads figures sent as strings", async () => {
    const { fake, result } = platform(() => readOpenNumbers(since("2026-09-20"), "arc-testnet", NOW.getTime()), reply);
    const numbers = await result;
    expect(fake.requests.map((request) => [request.path, request.body]).sort()).toEqual([
      ["/rest/v1/rpc/open_first_payments", { p_since: "2026-09-20T00:00:00.000Z", p_network: "arc-testnet" }],
      ["/rest/v1/rpc/open_numbers", { p_since: "2026-09-20T00:00:00.000Z", p_network: "arc-testnet" }],
      ["/rest/v1/rpc/open_outcomes", { p_since: "2026-09-20T00:00:00.000Z", p_network: "arc-testnet" }],
    ]);
    expect(numbers.sides.ours.usdcPaid).toBe(3);
    expect(numbers.daily[0]).toEqual({ day: "2026-09-28", customers: 1, ours: 2, oursUsdc: 5 });
    expect(numbers.ourPayments[0]).toEqual({ at: "2026-09-27T10:00:00+00:00", amount: 2, txHash: "0xh1", chain: "ARC-TESTNET" });
  });

  it("merges the first payments into each side, keeping a missing median missing", async () => {
    const { result } = platform(() => readOpenNumbers(since("2026-09-19"), "arc-testnet", NOW.getTime()), reply);
    const numbers = await result;
    expect(numbers.sides.customers).toMatchObject({ payments: 2, firstPayments: 2, medianMinutesToFirstPayment: 780.5 });
    expect(numbers.sides.ours).toMatchObject({ firstPayments: 0, medianMinutesToFirstPayment: null });
    expect(numbers.sides.total.firstPayments).toBe(2);
  });

  it("still reads every other figure when open_first_payments cannot be read, with no first-payment figures", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = platform(
      () => readOpenNumbers(since("2026-09-24"), "arc-testnet", 1_000),
      (request) =>
        request.path === "/rest/v1/rpc/open_first_payments"
          ? { status: 404, body: { message: "function open_first_payments does not exist" } }
          : { body: DOCUMENT }
    );
    const numbers = await result;
    expect(numbers.sides.ours.usdcPaid).toBe(3);
    for (const side of [numbers.sides.customers, numbers.sides.ours, numbers.sides.total]) {
      expect(side).toMatchObject({ firstPayments: null, medianMinutesToFirstPayment: null });
    }
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("open_first_payments"), expect.anything());
    logged.mockRestore();
  });

  it("merges the outcomes into each side", async () => {
    const { result } = platform(() => readOpenNumbers(since("2026-09-18"), "arc-testnet", NOW.getTime()), reply);
    const numbers = await result;
    expect(numbers.sides.customers).toMatchObject({ payments: 2, ...OUTCOME_SIDE });
    expect(numbers.sides.ours.decisionsCarriedOut).toBe(7);
  });

  it("still reads every other figure when open_outcomes cannot be read, with no outcome figures", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = platform(
      () => readOpenNumbers(since("2026-09-17"), "arc-testnet", 1_000),
      (request) =>
        request.path === "/rest/v1/rpc/open_outcomes"
          ? { status: 404, body: { message: "function open_outcomes does not exist" } }
          : reply(request)
    );
    const numbers = await result;
    expect(numbers.sides.customers).toMatchObject({ payments: 2, firstPayments: 2 });
    for (const side of [numbers.sides.customers, numbers.sides.ours, numbers.sides.total]) {
      for (const key of Object.keys(OUTCOME_SIDE)) expect(side).toHaveProperty(key, null);
    }
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("open_outcomes"), expect.anything());
    logged.mockRestore();
  });

  it("sends a null start for all time", async () => {
    const all = parsePeriod({}, NOW);
    const { fake, result } = platform(() => readOpenNumbers(all, "arc-testnet", NOW.getTime() + 10 * 60_000), reply);
    await result;
    expect(fake.requests.map((request) => request.body)).toEqual([{ p_since: null, p_network: "arc-testnet" }, { p_since: null, p_network: "arc-testnet" }, { p_since: null, p_network: "arc-testnet" }]);
  });

  it("answers the same period from memory for 60 seconds, then reads again", async () => {
    const period = since("2026-09-21");
    const first = platform(() => readOpenNumbers(period, "arc-testnet", 1_000), reply);
    await first.result;
    const second = platform(() => readOpenNumbers(period, "arc-testnet", 60_000), reply);
    await second.result;
    expect(second.fake.requests).toEqual([]);
    const third = platform(() => readOpenNumbers(period, "arc-testnet", 61_001), reply);
    await third.result;
    expect(third.fake.requests).toHaveLength(3);
  });

  it("forgets a failed read, so the next request tries again", async () => {
    const period = since("2026-09-22");
    const failing = platform(() => readOpenNumbers(period, "arc-testnet", 1_000), () => ({ status: 404, body: { message: "function open_numbers does not exist" } }));
    await expect(failing.result).rejects.toThrow(/open_numbers/);
    const retry = platform(() => readOpenNumbers(period, "arc-testnet", 2_000), reply);
    await retry.result;
    expect(retry.fake.requests).toHaveLength(3);
  });

  it("asks for the network it is given, and keeps each network's figures apart in memory (network foundation N7)", async () => {
    const period = since("2026-09-25");
    const mainnet = platform(() => readOpenNumbers(period, "arc-mainnet", 1_000), reply);
    await mainnet.result;
    expect(mainnet.fake.requests.map((request) => request.body)).toEqual([
      { p_since: "2026-09-25T00:00:00.000Z", p_network: "arc-mainnet" },
      { p_since: "2026-09-25T00:00:00.000Z", p_network: "arc-mainnet" },
      { p_since: "2026-09-25T00:00:00.000Z", p_network: "arc-mainnet" },
    ]);
    const testnet = platform(() => readOpenNumbers(period, "arc-testnet", 2_000), reply);
    await testnet.result;
    expect(testnet.fake.requests).toHaveLength(3);
  });

  it("refuses a document of the wrong shape", async () => {
    const { result } = platform(() => readOpenNumbers(since("2026-09-23"), "arc-testnet", 1_000), () => ({ body: { sides: {} } }));
    await expect(result).rejects.toThrow();
  });
});

describe("the team list", () => {
  it("adds and removes a person by email", async () => {
    const { fake, result } = platform(() => setTeamMember("team@vestiarion.test", true), () => ({ body: true }));
    expect(await result).toBe(true);
    expect(fake.requests.map((request) => [request.path, request.body])).toEqual([
      ["/rest/v1/rpc/set_platform_team_member", { p_email: "team@vestiarion.test", p_member: true }],
    ]);
  });

  it("lists the team", async () => {
    const { result } = platform(listTeam, () => ({ body: [{ email: "team@vestiarion.test", added_at: "2026-09-30T12:00:00+00:00" }] }));
    expect(await result).toEqual([{ email: "team@vestiarion.test", addedAt: "2026-09-30T12:00:00+00:00" }]);
  });
});
