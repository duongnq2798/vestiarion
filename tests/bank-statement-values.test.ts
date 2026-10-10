import { describe, expect, it } from "vitest";
import { decideDateOrder, decideDecimalMark, looksLikeDate, readAmount, readDate } from "@/lib/bank-statement/values";

/**
 * A statement's dates and amounts (docs/superpowers/specs/2026-10-10-bank-statement-design.md B4): the order of a date and
 * the decimal mark are decided from every value, and asked when the values allow two readings, never guessed. Amounts
 * come back in the currency's minor units.
 */

describe("readDate", () => {
  it("reads a day in each order, with month names, two-digit years and a time after it", () => {
    expect(readDate("2026-10-03", "ymd")).toBe("2026-10-03");
    expect(readDate("2026/10/03 14:22:05", "ymd")).toBe("2026-10-03");
    expect(readDate("2026-10-03T14:22:05Z", "ymd")).toBe("2026-10-03");
    expect(readDate("20261003", "ymd")).toBe("2026-10-03");
    expect(readDate("03/10/2026", "dmy")).toBe("2026-10-03");
    expect(readDate("03.10.26", "dmy")).toBe("2026-10-03");
    expect(readDate("10/03/2026", "mdy")).toBe("2026-10-03");
    expect(readDate("3 Oct 2026", "mdy")).toBe("2026-10-03");
    expect(readDate("03-OCT-2026", "dmy")).toBe("2026-10-03");
    expect(readDate("October 3, 2026", "ymd")).toBe("2026-10-03");
  });

  it("refuses a day that is not real, or a value in another order", () => {
    expect(readDate("31/02/2026", "dmy")).toBeNull();
    expect(readDate("13/10/2026", "mdy")).toBeNull();
    expect(readDate("2026-10-03", "dmy")).toBeNull();
    // A date written with dots is day first wherever dots are used.
    expect(readDate("03.10.2026", "mdy")).toBeNull();
    expect(readDate("Opening balance", "dmy")).toBeNull();
  });

  it("says whether a cell looks like a date in any order", () => {
    expect(looksLikeDate("13/10/2026")).toBe(true);
    expect(looksLikeDate("Date")).toBe(false);
    expect(looksLikeDate("-120.00")).toBe(false);
  });
});

describe("decideDateOrder", () => {
  it("decides when only one order reads every value", () => {
    expect(decideDateOrder(["03/10/2026", "13/10/2026"])).toEqual({ order: "dmy" });
    expect(decideDateOrder(["10/03/2026", "10/13/2026"])).toEqual({ order: "mdy" });
    expect(decideDateOrder(["2026-10-03", "2026-10-13"])).toEqual({ order: "ymd" });
  });

  it("asks when day first and month first both read every value, with the first value read two ways", () => {
    expect(decideDateOrder(["03/04/2026", "05/04/2026"])).toEqual({ ask: ["dmy", "mdy"], example: "03/04/2026" });
  });

  it("reads dates written with dots as day first, without asking", () => {
    expect(decideDateOrder(["03.10.2026", "04.10.2026"])).toEqual({ order: "dmy" });
  });

  it("needs no answer when every reading is the same day", () => {
    expect(decideDateOrder(["3 Oct 2026", "4 Oct 2026"])).toEqual({ order: "ymd" });
    expect(decideDateOrder(["04/04/2026"])).toEqual({ order: "dmy" });
  });

  it("names the first value no order reads, and leaves out values with no digit", () => {
    expect(decideDateOrder(["03/10/2026", "Closing balance", "32/10/2026"])).toEqual({ unreadable: "32/10/2026" });
    expect(decideDateOrder(["Closing balance"])).toEqual({ none: true });
  });
});

describe("decideDecimalMark", () => {
  it("decides from a value with both marks, a mark repeated, or one or two digits after a mark", () => {
    expect(decideDecimalMark(["1,234.56", "-12"])).toEqual({ mark: "." });
    expect(decideDecimalMark(["1.234,56"])).toEqual({ mark: "," });
    expect(decideDecimalMark(["1.250.000"])).toEqual({ mark: "," });
    expect(decideDecimalMark(["1,250,000"])).toEqual({ mark: "." });
    expect(decideDecimalMark(["-12,5", "1.500"])).toEqual({ mark: "," });
    expect(decideDecimalMark(["1 234.56"])).toEqual({ mark: "." });
  });

  it("asks when no value decides and one has three digits after its only mark", () => {
    expect(decideDecimalMark(["1,500", "250", "-3,000"])).toEqual({ ask: true, example: "1,500" });
  });

  it("needs no answer for whole numbers", () => {
    expect(decideDecimalMark(["1500", "-250", ""])).toEqual({ mark: "." });
  });

  it("refuses values that decide two ways, showing both", () => {
    expect(decideDecimalMark(["12.50", "-3,25"])).toEqual({ conflict: ["12.50", "-3,25"] });
  });
});

describe("readAmount", () => {
  it("reads to minor units, two decimals or none", () => {
    expect(readAmount("1,234.56", ".", 2)).toEqual({ minor: 123456, marked: null });
    expect(readAmount("1.234,5", ",", 2)).toEqual({ minor: 123450, marked: null });
    expect(readAmount("-12", ".", 2)).toEqual({ minor: -1200, marked: null });
    expect(readAmount("¥12,500", ".", 0)).toEqual({ minor: 12500, marked: null });
    expect(readAmount("12500.00", ".", 0)).toEqual({ minor: 12500, marked: null });
    expect(readAmount("₩1,250,000", ".", 0)).toEqual({ minor: 1250000, marked: null });
    expect(readAmount("1'234.50", ".", 2)).toEqual({ minor: 123450, marked: null });
  });

  it("reads parentheses, a trailing minus, a currency beside it and DR or CR as signs", () => {
    expect(readAmount("(45.00)", ".", 2)).toEqual({ minor: -4500, marked: null });
    expect(readAmount("45.00-", ".", 2)).toEqual({ minor: -4500, marked: null });
    expect(readAmount("-S$ 1,250.00", ".", 2)).toEqual({ minor: -125000, marked: null });
    expect(readAmount("SGD -1,250.00", ".", 2)).toEqual({ minor: -125000, marked: null });
    expect(readAmount("1,250.00 EUR", ".", 2)).toEqual({ minor: 125000, marked: null });
    expect(readAmount("45.00 DR", ".", 2)).toEqual({ minor: 4500, marked: "out" });
    expect(readAmount("45.00CR", ".", 2)).toEqual({ minor: 4500, marked: "in" });
  });

  it("refuses decimals a currency does not have, and what is not an amount", () => {
    expect(readAmount("12.5", ".", 0)).toBeNull();
    expect(readAmount("12.345", ".", 2)).toBeNull();
    expect(readAmount("12.340", ".", 2)).toEqual({ minor: 1234, marked: null });
    expect(readAmount("abc", ".", 2)).toBeNull();
    expect(readAmount("1,2,3", ".", 2)).toBeNull();
  });
});
