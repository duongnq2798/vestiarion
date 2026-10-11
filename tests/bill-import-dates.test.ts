import { describe, expect, it } from "vitest";
import { dateOrderOf, readDate, type DateOrder } from "@/lib/bill-import/dates";

const iso = (cell: string, order: DateOrder | null = null) => {
  const read = readDate(cell, order);
  return read.ok ? read.iso : read.reason;
};

describe("readDate", () => {
  it.each([
    ["2026-10-15", "2026-10-15"],
    ["2026-10-15T00:00:00Z", "2026-10-15"],
    ["2026-10-15 13:45:00", "2026-10-15"],
    ["2026/10/15", "2026-10-15"],
    ["2026/1/5", "2026-01-05"],
    ["2026.10.15", "2026-10-15"],
    ["2026. 10. 15.", "2026-10-15"],
    ["2026年10月15日", "2026-10-15"],
    ["2026년 10월 15일", "2026-10-15"],
    ["10 Oct 2026", "2026-10-10"],
    ["15-Oct-2026", "2026-10-15"],
    ["15-Oct-26", "2026-10-15"],
    ["15 October 2026", "2026-10-15"],
    ["Oct 15, 2026", "2026-10-15"],
    ["October 15 2026", "2026-10-15"],
    ["Sept 1, 2026", "2026-09-01"],
    ["46310", "2026-10-15"],
    ["46310.0", "2026-10-15"],
  ])("reads %s whatever the list's order", (cell, expected) => {
    expect(iso(cell)).toBe(expected);
  });

  it("reads a day-first or month-first date in the list's order", () => {
    expect(iso("03/04/2026", "dmy")).toBe("2026-04-03");
    expect(iso("03/04/2026", "mdy")).toBe("2026-03-04");
    expect(iso("15.10.2026", "dmy")).toBe("2026-10-15");
    expect(iso("15-10-26", "dmy")).toBe("2026-10-15");
    expect(iso("10/15/2026", "mdy")).toBe("2026-10-15");
  });

  it("reads a date that is the same either way without an order", () => {
    expect(iso("03/03/2026")).toBe("2026-03-03");
    expect(iso("25/12/2026")).toBe("2026-12-25");
    expect(iso("12/25/2026")).toBe("2026-12-25");
  });

  it("refuses a date it cannot read without the list's order", () => {
    expect(iso("03/04/2026")).toBe("could be read two ways: say whether the list's dates are day first or month first");
  });

  it("refuses a date that does not fit the list's order", () => {
    expect(iso("10/15/2026", "dmy")).toBe("does not fit the list's day-first dates");
    expect(iso("15/10/2026", "mdy")).toBe("does not fit the list's month-first dates");
  });

  it("refuses a day that does not exist, and text that is no date", () => {
    expect(iso("2026-02-30")).toBe("is not a real day");
    expect(iso("31/02/2026", "dmy")).toBe("is not a real day");
    expect(iso("31 Feb 2026")).toBe("is not a real day");
    expect(iso("13/13/2026", "dmy")).toBe("is not a real day");
    expect(iso("next week")).toBe("is not a date");
    expect(iso("1200")).toBe("is not a date");
    expect(iso("")).toBe("is blank");
  });

  it("reads a two-digit year first only when the list says its dates are year first", () => {
    expect(iso("26.10.15", "ymd")).toBe("2026-10-15");
    expect(iso("26/11/30", "ymd")).toBe("2026-11-30");
    expect(iso("26-01-05", "ymd")).toBe("2026-01-05");
    expect(iso("26.10.15", "dmy")).toBe("2015-10-26");
    expect(iso("15/10/2026", "ymd")).toBe("does not fit the list's year-first dates");
    expect(iso("6/10/15", "ymd")).toBe("does not fit the list's year-first dates");
  });

  it("never reads a date with a two-digit year as day first by itself, when it could be year first", () => {
    expect(iso("26.10.15")).toBe("could be read two ways: say whether the list's dates are day first or year first");
    expect(iso("15-10-26")).toBe("could be read two ways: say whether the list's dates are day first or year first");
    expect(iso("05/06/07")).toBe("could be read three ways: say whether the list's dates are day first, month first or year first");
    // A month above 12 rules year first out, as it rules day first out.
    expect(iso("10/15/26")).toBe("2026-10-15");
    // A first part above 31 can only be the year.
    expect(iso("32/10/15")).toBe("2032-10-15");
  });
});

describe("dateOrderOf", () => {
  it("decides day first from a first part above 12 anywhere", () => {
    expect(dateOrderOf(["03/04/2026", "15/04/2026"])).toEqual({ order: "dmy", ask: false, mixed: false, orders: [] });
  });

  it("decides month first from a second part above 12 anywhere", () => {
    expect(dateOrderOf(["03/04/2026", "04/15/2026"])).toEqual({ order: "mdy", ask: false, mixed: false, orders: [] });
  });

  it("asks when no date settles it and one could be read both ways", () => {
    expect(dateOrderOf(["03/04/2026", "2026-10-15", "05/06/2026"])).toEqual({ order: null, ask: true, mixed: false, orders: ["dmy", "mdy"] });
  });

  it("asks when the list holds dates written both ways", () => {
    expect(dateOrderOf(["15/04/2026", "04/15/2026"])).toEqual({ order: null, ask: true, mixed: true, orders: ["dmy", "mdy"] });
  });

  it("asks nothing when every date reads one way, and reads them in an order they all fit", () => {
    expect(dateOrderOf(["2026-10-15", "03/03/2026", "15 Oct 2026", "", "46310"])).toEqual({ order: "dmy", ask: false, mixed: false, orders: [] });
    expect(dateOrderOf(["2026-10-15", "15 Oct 2026", ""])).toEqual({ order: null, ask: false, mixed: false, orders: [] });
  });

  it("asks day first or year first of a list whose years have two digits, such as YY.MM.DD", () => {
    expect(dateOrderOf(["26.10.15", "26/11/30"])).toEqual({ order: null, ask: true, mixed: false, orders: ["dmy", "ymd"] });
    expect(dateOrderOf(["15-10-26", "20-11-26"])).toEqual({ order: null, ask: true, mixed: false, orders: ["dmy", "ymd"] });
  });

  it("settles a two-digit year's place from a date that only one order fits", () => {
    // A four-digit year last rules year first out for the whole list.
    expect(dateOrderOf(["15/10/2026", "03/04/26"])).toEqual({ order: "dmy", ask: false, mixed: false, orders: [] });
    // A first part above 31 can only be a year.
    expect(dateOrderOf(["32/10/15", "26/11/30"])).toEqual({ order: "ymd", ask: false, mixed: false, orders: [] });
    expect(dateOrderOf(["10/15/26", "11/20/26"])).toEqual({ order: "mdy", ask: false, mixed: false, orders: [] });
  });

  it("offers every order the list's dates were written in when they disagree", () => {
    expect(dateOrderOf(["26.10.15", "10/15/26"])).toEqual({ order: null, ask: true, mixed: true, orders: ["dmy", "mdy", "ymd"] });
  });
});
