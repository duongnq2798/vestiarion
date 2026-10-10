import { describe, expect, it } from "vitest";
import { dateOrderOf, readDate } from "@/lib/bill-import/dates";

const iso = (cell: string, order: "dmy" | "mdy" | null = null) => {
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
    expect(iso("next week")).toBe("is not a date");
    expect(iso("1200")).toBe("is not a date");
    expect(iso("")).toBe("is blank");
  });
});

describe("dateOrderOf", () => {
  it("decides day first from a first part above 12 anywhere", () => {
    expect(dateOrderOf(["03/04/2026", "15/04/2026"])).toEqual({ order: "dmy", ask: false, mixed: false });
  });

  it("decides month first from a second part above 12 anywhere", () => {
    expect(dateOrderOf(["03/04/2026", "04/15/2026"])).toEqual({ order: "mdy", ask: false, mixed: false });
  });

  it("asks when no date settles it and one could be read both ways", () => {
    expect(dateOrderOf(["03/04/2026", "2026-10-15", "05/06/2026"])).toEqual({ order: null, ask: true, mixed: false });
  });

  it("asks when the list holds dates written both ways", () => {
    expect(dateOrderOf(["15/04/2026", "04/15/2026"])).toEqual({ order: null, ask: true, mixed: true });
  });

  it("asks nothing when every date reads one way", () => {
    expect(dateOrderOf(["2026-10-15", "03/03/2026", "15 Oct 2026", "", "46310"])).toEqual({ order: null, ask: false, mixed: false });
  });
});
