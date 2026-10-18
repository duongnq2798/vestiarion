import { describe, expect, it } from "vitest";
import { boundOrder, competingBills, personOrder, needsPlan, planFingerprint, planFrom, planOf, referenceOrder, sameSplit, type PriorityRow } from "@/lib/agent/cash-priority";
import { supplierRequestsOf } from "@/lib/agent/cash-priority-plan";

/**
 * Which bill first when the cash cannot cover them all (docs/superpowers/specs/2026-10-18-cash-priority-design.md P1-P3,
 * P5). The book is our test workspace's on Oct 17: 147.03 USDC, a 140 USDC render farm bill set for Oct 22, a 150 USDC
 * GPU cluster bill held for cash, due Oct 23, and two 45 USDC bills, GPU hosting and storage, due Oct 24 and Oct 25.
 */

const TODAY = "2026-10-17";
const row = (over: Partial<PriorityRow>): PriorityRow => ({ id: "x", status: "pending", amount: 10, currency: "USDC", dueDate: "2026-10-20T12:00:00Z", heldForCash: false, paidToBank: false, ...over });
const BOOK: PriorityRow[] = [
  row({ id: "render-140", status: "scheduled", amount: 140, dueDate: "2026-10-22T12:00:00Z" }),
  row({ id: "cluster-150", status: "held", heldForCash: true, amount: 150, dueDate: "2026-10-23T12:00:00Z" }),
  row({ id: "hosting-45", status: "held", heldForCash: true, amount: 45, dueDate: "2026-10-24T12:00:00Z" }),
  row({ id: "storage-45", status: "held", heldForCash: true, amount: 45, dueDate: "2026-10-25T12:00:00Z" }),
];

describe("the bills competing for the same cash (P1)", () => {
  it("takes open USDC bills, pending, scheduled or held for want of cash, due within 14 days or overdue", () => {
    const rows = [
      ...BOOK,
      row({ id: "overdue", amount: 5, dueDate: "2026-10-10T12:00:00Z" }),
      row({ id: "later", amount: 5, dueDate: "2026-11-30T12:00:00Z" }),
      row({ id: "guardrail", status: "held", heldForCash: false }),
      row({ id: "flagged", status: "flagged" }),
      row({ id: "eurc", currency: "EURC" }),
      row({ id: "bank", paidToBank: true }),
      row({ id: "in-flight", status: "matched" }),
    ];
    expect(competingBills(rows, TODAY).map((bill) => bill.id)).toEqual(["render-140", "cluster-150", "hosting-45", "storage-45", "overdue"]);
  });

  it("asks for a plan only when they add up to more than the cash", () => {
    const competing = competingBills(BOOK, TODAY);
    expect(needsPlan(competing, 147.03)).toBe(true);
    expect(needsPlan(competing, 380)).toBe(false);
  });
});

describe("the order (P2, P3)", () => {
  it("is the written policy's by default: overdue first, then by due day, the smaller first on the same day", () => {
    const competing = competingBills([...BOOK, row({ id: "same-day-small", amount: 4, dueDate: "2026-10-22T08:00:00Z" })], TODAY);
    expect(referenceOrder(competing)).toEqual(["same-day-small", "render-140", "cluster-150", "hosting-45", "storage-45"]);
  });

  it("keeps the model's order, drops what it does not know or names twice, and appends what it left out", () => {
    const reference = ["render-140", "cluster-150", "hosting-45", "storage-45"];
    expect(boundOrder(["hosting-45", "storage-45", "render-140", "cluster-150"], reference)).toEqual({ order: ["hosting-45", "storage-45", "render-140", "cluster-150"], corrected: false });
    expect(boundOrder(["hosting-45", "ghost", "hosting-45", "storage-45"], reference)).toEqual({ order: ["hosting-45", "storage-45", "render-140", "cluster-150"], corrected: true });
  });

  it("keeps each bill in that order while the kept total fits the cash, and a smaller one after one that does not", () => {
    const competing = competingBills([...BOOK, row({ id: "lumen-4", status: "scheduled", amount: 4, dueDate: "2026-10-18T12:00:00Z" })], TODAY);
    expect(planFrom(["hosting-45", "storage-45", "render-140", "cluster-150", "lumen-4"], competing, 147.03)).toEqual({
      keep: ["hosting-45", "storage-45", "lumen-4"],
      wait: ["render-140", "cluster-150"],
    });
    expect(planFrom(["render-140", "cluster-150", "hosting-45", "storage-45"], competing, 147.03)).toEqual({
      keep: ["render-140"],
      wait: ["cluster-150", "hosting-45", "storage-45"],
    });
  });
});

describe("the plan, signed and read back (P5)", () => {
  it("has a fingerprint of the bills, not of their statuses", () => {
    const competing = competingBills(BOOK, TODAY);
    const moved = competingBills(BOOK.map((bill) => (bill.id === "hosting-45" ? { ...bill, status: "pending" } : bill)), TODAY);
    expect(planFingerprint(moved)).toBe(planFingerprint(competing));
    expect(planFingerprint(competing.filter((bill) => bill.id !== "storage-45"))).not.toBe(planFingerprint(competing));
  });

  it("stands while its order splits the bills the same way against the cash there is now (review of the plan)", () => {
    const competing = competingBills(BOOK, TODAY);
    const plan = { fingerprint: planFingerprint(competing), order: ["hosting-45", "storage-45", "render-140", "cluster-150"], keep: ["hosting-45", "storage-45"], wait: ["render-140", "cluster-150"], reasons: {}, byPerson: null };
    expect(sameSplit(plan, competing, 147.03)).toBe(true);
    expect(sameSplit(plan, competing, 147.1)).toBe(true);
    expect(sameSplit(plan, competing, 230)).toBe(false);
  });

  it("reads back from the ledger entry's order, or not at all", () => {
    const detail = {
      fingerprint: "f1",
      order: [
        { invoiceId: "hosting-45", keep: true, reason: "Hosting stops the business." },
        { invoiceId: "render-140", keep: false, reason: "A one-off render can wait." },
      ],
    };
    expect(planOf(detail)).toEqual({
      fingerprint: "f1",
      order: ["hosting-45", "render-140"],
      keep: ["hosting-45"],
      wait: ["render-140"],
      reasons: { "hosting-45": "Hosting stops the business.", "render-140": "A one-off render can wait." },
      byPerson: null,
    });
    // A person's order says who set it (order design O3).
    expect(planOf({ ...detail, decisionMode: "person", by: "member-1" })?.byPerson).toBe("member-1");
    expect(planOf({ ...detail, decisionMode: "deepseek", by: "member-1" })?.byPerson).toBeNull();
    expect(planOf({ fingerprint: "f1" })).toBeNull();
    expect(planOf(null)).toBeNull();
  });
});


describe("what a supplier did with earlier requests for more time (live test, Oct 17)", () => {
  it("names every outcome, so a request the agent withdrew or whose counter it declined is not read as the supplier's", () => {
    // Cobalt Cloud on Oct 17: it proposed 3 days and the agent declined them; the agent withdrew the next request when cash came in.
    expect(supplierRequestsOf([{ status: "declined", counter_days: 3 }, { status: "withdrawn", counter_days: null }])).toEqual({
      made: 2,
      agreed: 0,
      declinedBySupplier: 0,
      supplierProposedFewerDaysWhichTheAgentDeclined: 1,
      withdrawnByTheAgentBeforeAnAnswer: 1,
      stillOpen: 0,
    });
    expect(supplierRequestsOf([{ status: "accepted", counter_days: null }, { status: "declined", counter_days: null }, { status: "open", counter_days: null }])).toMatchObject({
      agreed: 1,
      declinedBySupplier: 1,
      stillOpen: 1,
    });
  });
});

describe("a person's order (order design O3)", () => {
  it("names every competing bill once, or is refused", () => {
    const competing = competingBills(BOOK, TODAY);
    const ids = competing.map((bill) => bill.id);
    expect(personOrder([...ids].reverse(), competing)).toEqual([...ids].reverse());
    expect(personOrder(ids.slice(1), competing)).toBeNull();
    expect(personOrder([...ids, ids[0]], competing)).toBeNull();
    expect(personOrder([...ids.slice(1), "not-competing"], competing)).toBeNull();
  });
});
