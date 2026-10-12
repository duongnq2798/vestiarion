import { describe, expect, it } from "vitest";
import { addDays, buildSchedule, carryRounding, checkLines, monthlyDates, type ScheduleInput } from "@/lib/deals/schedule";

/**
 * A deal's schedule from a template (docs/superpowers/specs/2026-10-12-deal-schedule-design.md D4-D6): the lines add up
 * to the total exactly in minor units, each line takes the floor of its share and the last takes the remainder, which
 * it says it carries; each line is due its payment terms after its invoice day.
 */

const base = (over: Partial<ScheduleInput> = {}): ScheduleInput => ({
  totalMinor: 1_000_000,
  currency: "USDC",
  startsOn: "2026-10-12",
  termsDays: 14,
  template: { kind: "deposit", depositPct: "30", deliveryOn: "2026-12-01" },
  ...over,
});

function lines(input: ScheduleInput) {
  const result = buildSchedule(input);
  if (!result.ok) throw new Error(`refused: ${result.message}`);
  return result.lines;
}

describe("a deposit and the balance on delivery", () => {
  it("bills 30% on the start date and 70% on delivery, each due 14 days later", () => {
    expect(lines(base())).toEqual([
      { position: 1, kind: "charge", label: "Deposit (30%)", invoiceOn: "2026-10-12", dueOn: "2026-10-26", amountMinor: 300_000, roundingMinor: 0 },
      { position: 2, kind: "charge", label: "Balance on delivery", invoiceOn: "2026-12-01", dueOn: "2026-12-15", amountMinor: 700_000, roundingMinor: 0 },
    ]);
  });

  it("puts the rounding remainder on the balance, and says how much it is", () => {
    const [deposit, balance] = lines(base({ totalMinor: 100_001 }));
    expect(deposit.amountMinor).toBe(30_000);
    expect(balance.amountMinor).toBe(70_001);
    expect(balance.roundingMinor).toBe(1);
    expect(deposit.amountMinor + balance.amountMinor).toBe(100_001);
  });

  it("takes a percent with two decimals", () => {
    const [deposit, balance] = lines(base({ template: { kind: "deposit", depositPct: "33.33", deliveryOn: "2026-12-01" } }));
    expect(deposit.label).toBe("Deposit (33.33%)");
    expect(deposit.amountMinor).toBe(333_300);
    expect(balance.amountMinor).toBe(666_700);
  });

  it("refuses a percent outside 0 to 100, a delivery before the start, and a total too small to split", () => {
    expect(buildSchedule(base({ template: { kind: "deposit", depositPct: "100", deliveryOn: "2026-12-01" } }))).toMatchObject({ ok: false, code: "deposit_pct" });
    expect(buildSchedule(base({ template: { kind: "deposit", depositPct: "0", deliveryOn: "2026-12-01" } }))).toMatchObject({ ok: false, code: "deposit_pct" });
    expect(buildSchedule(base({ template: { kind: "deposit", depositPct: "30.555", deliveryOn: "2026-12-01" } }))).toMatchObject({ ok: false, code: "deposit_pct" });
    expect(buildSchedule(base({ template: { kind: "deposit", depositPct: "30", deliveryOn: "2026-10-01" } }))).toMatchObject({ ok: false, code: "delivery_on" });
    expect(buildSchedule(base({ totalMinor: 1 }))).toMatchObject({ ok: false, code: "too_small" });
  });
});

describe("equal milestones", () => {
  const three = { kind: "milestones" as const, milestones: [{ invoiceOn: "2026-10-12" }, { invoiceOn: "2026-11-12", label: "Design approved" }, { invoiceOn: "2026-12-12" }] };

  it("splits the total in three, the remainder on the last", () => {
    const schedule = lines(base({ totalMinor: 100_000, template: three }));
    expect(schedule.map((line) => [line.label, line.invoiceOn, line.amountMinor, line.roundingMinor])).toEqual([
      ["Milestone 1 of 3", "2026-10-12", 33_333, 0],
      ["Design approved", "2026-11-12", 33_333, 0],
      ["Milestone 3 of 3", "2026-12-12", 33_334, 1],
    ]);
    expect(schedule.reduce((sum, line) => sum + line.amountMinor, 0)).toBe(100_000);
  });

  it("refuses fewer than two, more than 24, and a date before the start", () => {
    expect(buildSchedule(base({ template: { kind: "milestones", milestones: [{ invoiceOn: "2026-10-12" }] } }))).toMatchObject({ ok: false, code: "milestone_count" });
    expect(
      buildSchedule(base({ template: { kind: "milestones", milestones: Array.from({ length: 25 }, () => ({ invoiceOn: "2026-10-12" })) } }))
    ).toMatchObject({ ok: false, code: "milestone_count" });
    expect(buildSchedule(base({ template: { kind: "milestones", milestones: [{ invoiceOn: "2026-10-12" }, { invoiceOn: "2026-09-01" }] } }))).toMatchObject({
      ok: false,
      code: "line_date",
    });
  });
});

describe("a monthly retainer", () => {
  it("bills 12 months on day 31, each on the month's last day when it is shorter", () => {
    expect(monthlyDates("2026-01-15", 12, 31)).toEqual([
      "2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31", "2026-06-30",
      "2026-07-31", "2026-08-31", "2026-09-30", "2026-10-31", "2026-11-30", "2026-12-31",
    ]);
  });

  it("takes February 29 in a leap year, and starts next month when the day has passed", () => {
    expect(monthlyDates("2028-02-01", 2, 31)).toEqual(["2028-02-29", "2028-03-31"]);
    expect(monthlyDates("2028-01-31", 2, 30)).toEqual(["2028-02-29", "2028-03-30"]);
    expect(monthlyDates("2026-10-20", 3, 5)).toEqual(["2026-11-05", "2026-12-05", "2027-01-05"]);
    expect(monthlyDates("2026-10-05", 1, 5)).toEqual(["2026-10-05"]);
  });

  it("splits the total into equal months, the remainder on the last", () => {
    const schedule = lines(base({ startsOn: "2026-01-15", template: { kind: "retainer", months: 12, dayOfMonth: 31 } }));
    expect(schedule).toHaveLength(12);
    expect(schedule.slice(0, 11).every((line) => line.amountMinor === 83_333)).toBe(true);
    expect(schedule[11]).toMatchObject({ amountMinor: 83_337, roundingMinor: 4, invoiceOn: "2026-12-31", dueOn: "2027-01-14", label: "December 2026" });
    expect(schedule[1]).toMatchObject({ invoiceOn: "2026-02-28", label: "February 2026" });
  });

  it("refuses 0 or more than 60 months and a day outside 1 to 31", () => {
    expect(buildSchedule(base({ template: { kind: "retainer", months: 0, dayOfMonth: 1 } }))).toMatchObject({ ok: false, code: "months" });
    expect(buildSchedule(base({ template: { kind: "retainer", months: 61, dayOfMonth: 1 } }))).toMatchObject({ ok: false, code: "months" });
    expect(buildSchedule(base({ template: { kind: "retainer", months: 12, dayOfMonth: 32 } }))).toMatchObject({ ok: false, code: "day_of_month" });
  });
});

describe("custom lines", () => {
  const custom = (amounts: number[]) =>
    base({ template: { kind: "custom", lines: amounts.map((amountMinor, index) => ({ label: `Part ${index + 1}`, invoiceOn: addDays("2026-10-12", index * 30), amountMinor })) } });

  it("keeps lines that add up to the total, with no rounding", () => {
    const schedule = lines(custom([200_000, 300_000, 500_000]));
    expect(schedule.map((line) => line.amountMinor)).toEqual([200_000, 300_000, 500_000]);
    expect(schedule.every((line) => line.roundingMinor === 0)).toBe(true);
  });

  it("refuses lines that do not add up, saying by how much", () => {
    const short = buildSchedule(custom([200_000, 300_000, 400_000]));
    expect(short).toMatchObject({ ok: false, code: "sum" });
    if (!short.ok) expect(short.message).toBe("The lines add up to 9,000.00 USDC; the deal is 10,000.00 USDC: 1,000.00 USDC short.");
    const over = buildSchedule(custom([200_000, 300_000, 600_000]));
    if (!over.ok) expect(over.message).toBe("The lines add up to 11,000.00 USDC; the deal is 10,000.00 USDC: 1,000.00 USDC over.");
    expect(over.ok).toBe(false);
  });

  it("refuses a blank name, a line of nothing, too many lines and a date past ten years", () => {
    expect(buildSchedule(base({ template: { kind: "custom", lines: [{ label: " ", invoiceOn: "2026-10-12", amountMinor: 1_000_000 }] } }))).toMatchObject({ ok: false, code: "line_label" });
    expect(buildSchedule(custom([1_000_000, 0]))).toMatchObject({ ok: false, code: "line_amount" });
    expect(buildSchedule(custom(Array.from({ length: 61 }, () => 1)))).toMatchObject({ ok: false, code: "line_count" });
    expect(buildSchedule(base({ template: { kind: "custom", lines: [{ label: "Later", invoiceOn: "2037-01-01", amountMinor: 1_000_000 }] } }))).toMatchObject({ ok: false, code: "line_date" });
  });
});

describe("currencies without minor units", () => {
  it("splits a yen total in whole yen", () => {
    const schedule = lines(base({ currency: "JPY", totalMinor: 1_000_000, template: { kind: "milestones", milestones: [{ invoiceOn: "2026-10-12" }, { invoiceOn: "2026-11-12" }, { invoiceOn: "2026-12-12" }] } }));
    expect(schedule.map((line) => line.amountMinor)).toEqual([333_333, 333_333, 333_334]);
    expect(schedule[2].roundingMinor).toBe(1);
  });

  it("takes a won deposit in whole won", () => {
    const [deposit, balance] = lines(base({ currency: "KRW", totalMinor: 1_000_001 }));
    expect(deposit.amountMinor).toBe(300_000);
    expect(balance).toMatchObject({ amountMinor: 700_001, roundingMinor: 1 });
  });

  it("says a won gap in whole won", () => {
    const short = buildSchedule(base({ currency: "KRW", totalMinor: 1_000_000, template: { kind: "custom", lines: [{ label: "All", invoiceOn: "2026-10-12", amountMinor: 999_999 }] } }));
    if (!short.ok) expect(short.message).toBe("The lines add up to 999,999 KRW; the deal is 1,000,000 KRW: 1 KRW short.");
    expect(short.ok).toBe(false);
  });
});

describe("the deal itself", () => {
  it("refuses a total of nothing, a start date that is not a day, and terms past a year", () => {
    expect(buildSchedule(base({ totalMinor: 0 }))).toMatchObject({ ok: false, code: "total" });
    expect(buildSchedule(base({ startsOn: "2026-02-30" }))).toMatchObject({ ok: false, code: "starts_on" });
    expect(buildSchedule(base({ termsDays: 366 }))).toMatchObject({ ok: false, code: "terms" });
    expect(buildSchedule(base({ termsDays: 0 }))).toMatchObject({ ok: true });
  });
});

describe("checkLines", () => {
  it("accepts lines with a credit when they still add up", () => {
    expect(
      checkLines(
        [
          { label: "Deposit", invoiceOn: "2026-10-12", amountMinor: 300_000, kind: "charge" },
          { label: "Credit", invoiceOn: "2026-10-12", amountMinor: -50_000, kind: "credit" },
        ],
        { totalMinor: 250_000, currency: "USDC", startsOn: "2026-10-12" }
      )
    ).toBeNull();
  });
});

describe("carryRounding", () => {
  it("keeps a line's rounding only where the posted line is the one the template built", () => {
    const built = lines(base({ totalMinor: 100_001 }));
    const posted = built.map(({ label, invoiceOn, amountMinor }) => ({ label, invoiceOn, amountMinor }));
    expect(carryRounding(posted, built)).toEqual([0, 1]);
    expect(carryRounding([posted[0], { ...posted[1], invoiceOn: "2026-12-02" }], built)).toEqual([0, 0]);
  });
});
