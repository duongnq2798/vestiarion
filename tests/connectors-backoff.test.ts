import { describe, expect, it } from "vitest";
import { failureDelayMs, MAX_RETRY_AFTER_MS, parseRetryAfter, waitInRun } from "@/lib/connectors/backoff";

/**
 * Rate limits and backoff (docs/superpowers/specs/2026-10-12-xero-connector-design.md X8, I13): the wait a provider
 * asks for, in seconds or as a date, bounded; a short one waited in the run, a longer one left to a later run; and the
 * growing wait after failures in a row, at most an hour.
 */

const NOW = Date.parse("2026-10-12T08:00:00.000Z");

describe("parseRetryAfter", () => {
  it("reads seconds", () => {
    expect(parseRetryAfter("30", NOW)).toBe(30_000);
    expect(parseRetryAfter(" 2 ", NOW)).toBe(2_000);
    expect(parseRetryAfter("0", NOW)).toBe(0);
  });

  it("reads an HTTP date, never a time in the past", () => {
    expect(parseRetryAfter("Mon, 12 Oct 2026 08:01:00 GMT", NOW)).toBe(60_000);
    expect(parseRetryAfter("Mon, 12 Oct 2026 07:00:00 GMT", NOW)).toBe(0);
  });

  it("is null without a header or with one that does not read", () => {
    expect(parseRetryAfter(null, NOW)).toBeNull();
    expect(parseRetryAfter("", NOW)).toBeNull();
    expect(parseRetryAfter("soon", NOW)).toBeNull();
    expect(parseRetryAfter("-5", NOW)).toBeNull();
  });

  it("waits at most a day, whatever the provider says", () => {
    expect(parseRetryAfter(String(10 * 86_400), NOW)).toBe(MAX_RETRY_AFTER_MS);
    expect(MAX_RETRY_AFTER_MS).toBe(86_400_000);
  });
});

describe("waitInRun", () => {
  it("waits in the run for at most 5 seconds, and leaves anything longer to a later run", () => {
    expect(waitInRun(0)).toBe(true);
    expect(waitInRun(5_000)).toBe(true);
    expect(waitInRun(5_001)).toBe(false);
    expect(waitInRun(null)).toBe(false);
  });
});

describe("failureDelayMs", () => {
  it("doubles from a minute with each failure in a row, at most an hour", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 20].map(failureDelayMs)).toEqual([
      60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000, 3_600_000,
    ]);
  });

  it("treats no failure as one", () => {
    expect(failureDelayMs(0)).toBe(60_000);
  });
});
