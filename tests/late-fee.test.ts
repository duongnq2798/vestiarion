import { describe, expect, it } from "vitest";
import {
  invoiceLateFee,
  lastDayWithoutFee,
  lateFeeOf,
  lateFeeRateWords,
  lateFeeStarted,
  lateFeeTerms,
  lateFeeWords,
  readWithLateFee,
  LATE_FEE_SELECT,
  type LateFee,
} from "@/lib/agent/late-fee";

/**
 * A payable's late fee (docs/superpowers/specs/2026-10-23-late-fees-design.md LF1, LF4): the term as a row carries it,
 * and what a month of waiting costs. Information only: nothing here changes what is paid.
 */

const percent: LateFee = { kind: "percent_month", value: 1.5, startsOn: "2026-10-30" };
const fixed: LateFee = { kind: "fixed", value: 25, startsOn: "2026-10-30" };

describe("invoiceLateFee", () => {
  it("reads the three columns of migration 0141", () => {
    expect(invoiceLateFee({ late_fee_kind: "percent_month", late_fee_value: "1.500000", late_fee_starts_on: "2026-10-30" })).toEqual(percent);
    expect(invoiceLateFee({ late_fee_kind: "fixed", late_fee_value: 25, late_fee_starts_on: "2026-10-30T00:00:00.000Z" })).toEqual(fixed);
  });

  it("is none for a row without the columns, as before migration 0141, or without a term", () => {
    expect(invoiceLateFee({})).toBeNull();
    expect(invoiceLateFee({ late_fee_kind: null, late_fee_value: null, late_fee_starts_on: null })).toBeNull();
  });

  it("is none for a term the database would refuse: a row that cannot be read never weighs a fee", () => {
    expect(invoiceLateFee({ late_fee_kind: "percent_year", late_fee_value: 12, late_fee_starts_on: "2026-10-30" })).toBeNull();
    expect(invoiceLateFee({ late_fee_kind: "percent_month", late_fee_value: 11, late_fee_starts_on: "2026-10-30" })).toBeNull();
    expect(invoiceLateFee({ late_fee_kind: "fixed", late_fee_value: 0, late_fee_starts_on: "2026-10-30" })).toBeNull();
    expect(invoiceLateFee({ late_fee_kind: "fixed", late_fee_value: "abc", late_fee_starts_on: "2026-10-30" })).toBeNull();
    expect(invoiceLateFee({ late_fee_kind: "fixed", late_fee_value: 25, late_fee_starts_on: "not a day" })).toBeNull();
    expect(invoiceLateFee({ late_fee_kind: "fixed", late_fee_value: 25, late_fee_starts_on: null })).toBeNull();
  });
});

describe("lateFeeOf (LF4)", () => {
  it("is the percent of the amount still to pay, for a month past its start", () => {
    expect(lateFeeOf({ amount: 100, lateFee: percent }, "2026-10-22")).toBe(1.5);
    expect(lateFeeOf({ amount: "1234.56", lateFee: percent }, "2026-10-22")).toBe(18.5184);
  });

  it("keeps costing a month's percent once it has started: the balance goes on growing", () => {
    expect(lateFeeOf({ amount: 100, lateFee: percent }, "2026-11-15")).toBe(1.5);
  });

  it("is the fixed amount while it is still ahead, and nothing more once it has started: it is owed then, whatever comes next", () => {
    expect(lateFeeOf({ amount: 100, lateFee: fixed }, "2026-10-29")).toBe(25);
    expect(lateFeeOf({ amount: 100, lateFee: fixed }, "2026-10-30")).toBe(0);
  });

  it("is nothing for a fee that starts after the coming month, the 30 days from the day: none of it can be charged in them (LF6)", () => {
    expect(lateFeeOf({ amount: 100, lateFee: percent }, "2026-09-30")).toBe(0);
    expect(lateFeeOf({ amount: 100, lateFee: percent }, "2026-10-01")).toBe(1.5);
    expect(lateFeeOf({ amount: 100, lateFee: fixed }, "2026-09-30")).toBe(0);
    expect(lateFeeOf({ amount: 100, lateFee: fixed }, "2026-10-01")).toBe(25);
  });

  it("is 0 with no fee, and never negative", () => {
    expect(lateFeeOf({ amount: 100, lateFee: null }, "2026-10-22")).toBe(0);
    expect(lateFeeOf({ amount: -100, lateFee: percent }, "2026-10-22")).toBe(0);
    expect(lateFeeOf({ amount: "abc", lateFee: percent }, "2026-10-22")).toBe(0);
  });
});

describe("the fee's days", () => {
  it("has started on its first day, and not the day before", () => {
    expect(lateFeeStarted(percent, "2026-10-29")).toBe(false);
    expect(lateFeeStarted(percent, "2026-10-30")).toBe(true);
  });

  it("has a last day without it, the day before it starts", () => {
    expect(lastDayWithoutFee(percent)).toBe("2026-10-29");
    expect(lastDayWithoutFee({ ...percent, startsOn: "2026-11-01" })).toBe("2026-10-31");
  });
});

describe("the fee in words", () => {
  it("says the rate alone", () => {
    expect(lateFeeRateWords(percent)).toBe("1.5% a month");
    expect(lateFeeRateWords(fixed, "EURC")).toBe("25.00 EURC");
  });

  it("says a percent with what a month costs, and a fixed amount as it is", () => {
    expect(lateFeeWords(percent, 100)).toBe("1.5% a month (1.50 USDC)");
    expect(lateFeeWords(fixed, 100)).toBe("25.00 USDC");
    expect(lateFeeWords({ ...fixed, value: 12.345678 }, 100, "EURC")).toBe("12.345678 EURC");
  });
});

describe("lateFeeTerms", () => {
  it("is the term as an entry signs it and the model reads it: kind, value, start, and a month's fee", () => {
    expect(lateFeeTerms(percent, 100)).toEqual({ kind: "percent_month", value: 1.5, startsOn: "2026-10-30", aMonth: 1.5 });
    expect(lateFeeTerms(fixed, 100)).toEqual({ kind: "fixed", value: 25, startsOn: "2026-10-30", aMonth: 25 });
  });
});

describe("readWithLateFee", () => {
  it("names the columns in the read", async () => {
    const asked: string[] = [];
    const result = await readWithLateFee(async (columns) => {
      asked.push(columns);
      return { data: [{ id: "a" }], error: null };
    });
    expect(asked).toEqual([`, ${LATE_FEE_SELECT}`]);
    expect(result.data).toEqual([{ id: "a" }]);
  });

  it.each(["42703", "PGRST204"])("reads again without them when the database does not have them yet (%s, before migration 0141)", async (code) => {
    const asked: string[] = [];
    const result = await readWithLateFee(async (columns) => {
      asked.push(columns);
      return columns ? { data: null, error: { code, message: "column invoices.late_fee_kind does not exist" } } : { data: [{ id: "a" }], error: null };
    });
    expect(asked).toEqual([`, ${LATE_FEE_SELECT}`, ""]);
    expect(result).toEqual({ data: [{ id: "a" }], error: null });
  });

  it("leaves any other failure as it is", async () => {
    let calls = 0;
    const result = await readWithLateFee(async () => {
      calls += 1;
      return { data: null, error: { code: "57014", message: "timeout" } };
    });
    expect(calls).toBe(1);
    expect(result.error?.code).toBe("57014");
  });
});
