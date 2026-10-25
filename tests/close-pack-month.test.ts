import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { handoffPeriod } from "@/lib/accountant/handoff";
import { closePackMonth, closePackMonthFrom, monthEnded, monthsBeside } from "@/lib/close-pack/month";

/**
 * The close pack's month (docs/superpowers/specs/2026-10-25-monthly-close-pack-design.md CP1): a calendar month in UTC,
 * asked as YYYY-MM, the last full month when none is given, this month allowed and read "so far", anything else refused.
 * The hand-off reads its month through the same parser, so the two never disagree.
 */

const NOW = new Date("2026-10-25T09:30:00Z");

describe("closePackMonth (close pack CP1)", () => {
  it("reads 2026-10 as from 2026-10-01 up to 2026-11-01, October 2026", () => {
    expect(closePackMonth("2026-10", NOW)).toEqual({ from: "2026-10-01", to: "2026-11-01", label: "October 2026", key: "2026-10" });
  });

  it("runs December up to January of the next year", () => {
    expect(closePackMonth("2025-12", NOW)).toEqual({ from: "2025-12-01", to: "2026-01-01", label: "December 2025", key: "2025-12" });
  });

  it("opens on the last full month when none is given", () => {
    expect(closePackMonth(null, NOW)).toEqual({ from: "2026-09-01", to: "2026-10-01", label: "September 2026", key: "2026-09" });
    expect(closePackMonth("", NOW)?.key).toBe("2026-09");
    expect(closePackMonth(null, new Date("2026-01-03T00:00:00Z"))).toEqual({ from: "2025-12-01", to: "2026-01-01", label: "December 2025", key: "2025-12" });
  });

  it("takes this month so far, which has not ended, while September has", () => {
    const october = closePackMonth("2026-10", NOW)!;
    const september = closePackMonth("2026-09", NOW)!;
    expect(monthEnded(october, NOW)).toBe(false);
    expect(monthEnded(september, NOW)).toBe(true);
    expect(monthEnded(october, new Date("2026-11-01T00:00:00Z"))).toBe(true);
    expect(monthEnded(october, new Date("2026-10-31T23:59:59.999Z"))).toBe(false);
  });

  it("refuses a month to come, one before 2020, and anything that is not YYYY-MM", () => {
    for (const month of ["2026-11", "2027-01", "2019-12", "1999-01", "2026-13", "2026-00", "2026-1", "202610", "2026-10-01", " 2026-10", "2026-10 ", "26-10", "october"]) {
      expect(closePackMonth(month, NOW), month).toBeNull();
    }
    expect(closePackMonth("2020-01", NOW)?.key).toBe("2020-01");
  });
});

describe("monthsBeside (close pack CP1)", () => {
  it("names the months either side", () => {
    const { previous, next } = monthsBeside(closePackMonth("2026-09", NOW)!, NOW);
    expect(previous?.label).toBe("August 2026");
    expect(next?.label).toBe("October 2026");
  });

  it("has no next month past this one, and no previous month before 2020", () => {
    expect(monthsBeside(closePackMonth("2026-10", NOW)!, NOW).next).toBeNull();
    expect(monthsBeside(closePackMonth("2026-10", NOW)!, NOW).previous?.key).toBe("2026-09");
    expect(monthsBeside(closePackMonth("2020-01", NOW)!, NOW).previous).toBeNull();
    expect(monthsBeside(closePackMonth("2020-01", NOW)!, NOW).next?.key).toBe("2020-02");
    const january = monthsBeside(closePackMonth("2026-01", NOW)!, NOW);
    expect(january.previous?.key).toBe("2025-12");
    expect(monthsBeside(closePackMonth("2025-12", NOW)!, NOW).next?.key).toBe("2026-01");
  });
});

describe("closePackMonthFrom (close pack CP1, CP11)", () => {
  it("reads ?month= once", () => {
    expect(closePackMonthFrom({ month: "2026-08" }, NOW)).toEqual({ month: closePackMonth("2026-08", NOW), unreadable: false });
  });

  it("opens on last month with none, and says nothing", () => {
    expect(closePackMonthFrom({}, NOW)).toEqual({ month: closePackMonth(null, NOW), unreadable: false });
    expect(closePackMonthFrom({ month: "" }, NOW)).toEqual({ month: closePackMonth(null, NOW), unreadable: false });
  });

  it("falls back to last month, saying so, for a value given twice or one that does not read", () => {
    for (const month of [["2026-08", "2026-07"], "2026-13", "2027-01", "soon", "2026-10-01"]) {
      expect(closePackMonthFrom({ month }, NOW), String(month)).toEqual({ month: closePackMonth(null, NOW), unreadable: true });
    }
  });
});

describe("the hand-off's month is the close pack's (close pack CP1)", () => {
  it("keeps handoffPeriod equal to closePackMonth for every input", () => {
    const inputs = [null, "", "2026-10", "2026-09", "2025-12", "2020-01", "2026-11", "2019-12", "2026-13", "2026-1", "202610", "2026-10-01", " 2026-10"];
    for (const now of [NOW, new Date("2026-01-03T00:00:00Z")]) {
      for (const month of inputs) expect(handoffPeriod(month, now), String(month)).toEqual(closePackMonth(month, now));
    }
  });
});
