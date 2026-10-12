import { describe, expect, it } from "vitest";
import { dealSummary, dueForRelease, inForce, lineState, releaseRefusal } from "@/lib/deals/lines";
import { deal, line, released } from "./support/deal-facts";

/**
 * A deal's lines as they stand (docs/superpowers/specs/2026-10-12-deal-schedule-design.md D9, D10, D14): what each
 * line is now, which lines may be released and which the agent releases on their day, and the deal's figures.
 */

const TODAY = "2026-11-01";

describe("lineState", () => {
  it("names each line as it is now", () => {
    expect(lineState(line(), TODAY)).toBe("planned");
    expect(lineState(released({ dueOn: "2026-11-15", receivable: { id: "inv-1", status: "pending", dueDate: "2026-11-15T12:00:00Z" } }), TODAY)).toBe("released");
    expect(lineState(released(), TODAY)).toBe("overdue");
    expect(lineState(released({ receivable: { id: "inv-1", status: "received", dueDate: "2026-10-26T12:00:00Z" } }), TODAY)).toBe("paid");
    expect(lineState(released({ receivable: null }), TODAY)).toBe("not_made");
    expect(lineState(line({ kind: "credit", amountMinor: -10_000 }), TODAY)).toBe("credit");
    expect(lineState(line({ status: "superseded", endedIn: 2 }), TODAY)).toBe("superseded");
    expect(lineState(line({ status: "cancelled", endedIn: 2 }), TODAY)).toBe("cancelled");
  });
});

describe("releaseRefusal", () => {
  it("lets a planned charge of an active deal be released, before its day too", () => {
    expect(releaseRefusal(deal([line({ invoiceOn: "2026-12-01" })]), line({ invoiceOn: "2026-12-01" }))).toBeNull();
  });

  it("lets a line released without its receivable be released again, to make it", () => {
    const orphan = released({ receivable: null });
    expect(releaseRefusal(deal([orphan]), orphan)).toBeNull();
  });

  it("refuses a released line, an ended line, a credit and a cancelled deal", () => {
    expect(releaseRefusal(deal([released()]), released())).toBe("released");
    expect(releaseRefusal(deal([line({ status: "cancelled", endedIn: 2 })]), line({ status: "cancelled", endedIn: 2 }))).toBe("ended");
    expect(releaseRefusal(deal([line({ kind: "credit", amountMinor: -1 })]), line({ kind: "credit", amountMinor: -1 }))).toBe("credit");
    expect(releaseRefusal(deal([line()], { status: "cancelled" }), line())).toBe("deal_cancelled");
  });
});

describe("dueForRelease", () => {
  const lines = [
    line({ id: "a", invoiceOn: "2026-10-12" }),
    line({ id: "b", position: 2, invoiceOn: "2026-11-01" }),
    line({ id: "c", position: 3, invoiceOn: "2026-11-02" }),
    line({ id: "d", position: 4, kind: "credit", amountMinor: -5, invoiceOn: "2026-10-12" }),
    released({ id: "e", position: 5, receivable: null }),
    released({ id: "f", position: 6 }),
  ];

  it("releases nothing unless the deal says so", () => {
    expect(dueForRelease(deal(lines), TODAY)).toEqual([]);
  });

  it("releases the planned charges whose day has come, and makes a lost receivable, when the switch is on", () => {
    expect(dueForRelease(deal(lines, { autoRelease: true }), TODAY).map((each) => each.id)).toEqual(["a", "e", "b"]);
  });

  it("releases nothing from a cancelled deal", () => {
    expect(dueForRelease(deal(lines, { autoRelease: true, status: "cancelled" }), TODAY)).toEqual([]);
  });
});

describe("dealSummary", () => {
  it("adds up what was released, paid, is outstanding, is planned and is owed back, and names the next line", () => {
    const summary = dealSummary(
      deal([
        released({ id: "paid", amountMinor: 300_000, receivable: { id: "inv-1", status: "received", dueDate: "2026-10-26T12:00:00Z" } }),
        released({ id: "late", position: 2, amountMinor: 100_000, dueOn: "2026-10-30" }),
        line({ id: "next", position: 3, amountMinor: 400_000, invoiceOn: "2026-12-01" }),
        line({ id: "after", position: 4, amountMinor: 200_000, invoiceOn: "2027-01-01" }),
        line({ id: "credit", position: 5, kind: "credit", amountMinor: -50_000 }),
        line({ id: "old", position: 6, amountMinor: 999, status: "superseded", endedIn: 2 }),
      ]),
      TODAY
    );
    expect(summary).toMatchObject({
      totalMinor: 950_000,
      releasedMinor: 400_000,
      paidMinor: 300_000,
      outstandingMinor: 100_000,
      overdueMinor: 100_000,
      plannedMinor: 600_000,
      creditMinor: -50_000,
    });
    expect(summary.next?.id).toBe("next");
  });

  it("keeps only the lines in force", () => {
    expect(inForce([line(), line({ id: "x", status: "superseded", endedIn: 2 }), released({ id: "y" })]).map((each) => each.id)).toEqual(["line-1", "y"]);
  });
});
