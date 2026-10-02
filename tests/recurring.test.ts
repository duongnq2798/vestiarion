import { describe, expect, it } from "vitest";
import { cadenceLabel, dueOn, leadDays, MAX_PERIODS_PER_CYCLE, parseRecurringForm, periodsDue, type RecurringSchedule } from "@/lib/recurring";

/** Recurring payments (docs/superpowers/specs/2026-10-02-recurring-payables-design.md R2, R3). */

const monthly = (over: Partial<RecurringSchedule> = {}): RecurringSchedule => ({ startsOn: "2026-10-31", endsOn: null, everyCount: 1, everyUnit: "month", nextPeriod: 0, ...over });

describe("dueOn (R2)", () => {
  it("counts every period from the first, so the 31st survives a short month", () => {
    expect([0, 1, 2, 3, 4].map((n) => dueOn(monthly(), n))).toEqual(["2026-10-31", "2026-11-30", "2026-12-31", "2027-01-31", "2027-02-28"]);
  });

  it("steps days and weeks exactly", () => {
    expect(dueOn({ startsOn: "2026-10-03", everyCount: 1, everyUnit: "day" }, 2)).toBe("2026-10-05");
    expect(dueOn({ startsOn: "2026-10-03", everyCount: 2, everyUnit: "week" }, 3)).toBe("2026-11-14");
    expect(dueOn({ startsOn: "2026-01-15", everyCount: 3, everyUnit: "month" }, 4)).toBe("2027-01-15");
  });
});

describe("leadDays (R3)", () => {
  it("is the period less a day, at most a week", () => {
    expect(leadDays({ everyCount: 1, everyUnit: "day" })).toBe(0);
    expect(leadDays({ everyCount: 3, everyUnit: "day" })).toBe(2);
    expect(leadDays({ everyCount: 1, everyUnit: "week" })).toBe(6);
    expect(leadDays({ everyCount: 1, everyUnit: "month" })).toBe(7);
  });
});

describe("periodsDue (R3)", () => {
  it("creates a monthly period a week before it falls due, not earlier", () => {
    expect(periodsDue(monthly(), new Date("2026-10-23T09:00:00Z")).periods).toEqual([]);
    expect(periodsDue(monthly(), new Date("2026-10-24T09:00:00Z")).periods).toEqual([{ index: 0, dueOn: "2026-10-31" }]);
  });

  it("creates a daily period on its day", () => {
    const daily = monthly({ startsOn: "2026-10-03", everyUnit: "day" });
    expect(periodsDue(daily, new Date("2026-10-02T23:00:00Z")).periods).toEqual([]);
    expect(periodsDue(daily, new Date("2026-10-03T00:30:00Z")).periods).toEqual([{ index: 0, dueOn: "2026-10-03" }]);
  });

  it("catches up a schedule that fell behind, at most three periods a cycle", () => {
    const daily = monthly({ startsOn: "2026-10-01", everyUnit: "day" });
    const due = periodsDue(daily, new Date("2026-10-09T09:00:00Z"));
    expect(due.periods.map((p) => p.dueOn)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(due.periods).toHaveLength(MAX_PERIODS_PER_CYCLE);
  });

  it("ends past its last due date", () => {
    const short = monthly({ startsOn: "2026-10-03", everyUnit: "day", endsOn: "2026-10-04", nextPeriod: 1 });
    expect(periodsDue(short, new Date("2026-10-04T09:00:00Z"))).toEqual({ periods: [{ index: 1, dueOn: "2026-10-04" }], ended: true });
    expect(periodsDue({ ...short, nextPeriod: 2 }, new Date("2026-10-05T09:00:00Z"))).toEqual({ periods: [], ended: true });
  });
});

describe("cadenceLabel", () => {
  it("reads as a person would say it", () => {
    expect(cadenceLabel(1, "month")).toBe("every month");
    expect(cadenceLabel(2, "week")).toBe("every 2 weeks");
    expect(cadenceLabel(1, "day")).toBe("every day");
  });
});

describe("parseRecurringForm", () => {
  const raw = {
    counterpartyId: "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de",
    amount: "25",
    currency: "USDC",
    memo: "Monthly hosting",
    poReference: "",
    everyCount: "1",
    everyUnit: "month",
    startsOn: "2026-10-31",
    endsOn: "",
    goodsReceived: true,
  };
  const TODAY = new Date("2026-10-02T09:00:00Z");

  it("reads a schedule, the reference and last date optional", () => {
    expect(parseRecurringForm(raw, TODAY)).toEqual({
      ok: true,
      value: { counterpartyId: raw.counterpartyId, amount: "25", currency: "USDC", memo: "Monthly hosting", poReference: null, everyCount: 1, everyUnit: "month", startsOn: "2026-10-31", endsOn: null, goodsReceived: true },
    });
  });

  it("refuses a first date in the past, a last date before the first, and a cadence out of range", () => {
    expect(parseRecurringForm({ ...raw, startsOn: "2026-10-01" }, TODAY)).toEqual({ ok: false, message: "The first due date cannot be in the past" });
    expect(parseRecurringForm({ ...raw, endsOn: "2026-10-30" }, TODAY)).toEqual({ ok: false, message: "The last due date cannot be before the first" });
    expect(parseRecurringForm({ ...raw, everyCount: "0" }, TODAY)).toEqual({ ok: false, message: "Every must be at least 1" });
    expect(parseRecurringForm({ ...raw, memo: " " }, TODAY)).toEqual({ ok: false, message: "Say what it is for" });
  });
});
