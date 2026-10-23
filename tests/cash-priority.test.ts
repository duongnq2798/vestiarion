import { describe, expect, it } from "vitest";
import { boundOrder, carriedOrder, competingBills, namedRefs, personOrder, needsPlan, planFingerprint, planFrom, planOf, referenceOrder, sameSplit, type PriorityRow } from "@/lib/agent/cash-priority";
import { PRIORITY_SYSTEM_PROMPT, supplierRequestsOf } from "@/lib/agent/cash-priority-plan";

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
    expect(referenceOrder(competing, TODAY)).toEqual(["same-day-small", "render-140", "cluster-150", "hosting-45", "storage-45"]);
  });

  it("puts first, among bills due or overdue, the one whose late fee costs most in USDC in the coming month, then keeps that order (late fees LF6)", () => {
    const competing = competingBills(
      [
        row({ id: "overdue-plain", amount: 5, dueDate: "2026-10-10T12:00:00Z" }),
        row({ id: "overdue-1.5pct", amount: 100, dueDate: "2026-10-15T12:00:00Z", lateFee: { kind: "percent_month", value: 1.5, startsOn: "2026-10-25" } }),
        row({ id: "due-fixed-3", amount: 50, dueDate: "2026-10-17T12:00:00Z", lateFee: { kind: "fixed", value: 3, startsOn: "2026-10-18" } }),
        row({ id: "overdue-fixed-started", amount: 40, dueDate: "2026-10-12T12:00:00Z", lateFee: { kind: "fixed", value: 20, startsOn: "2026-10-13" } }),
        // Not due yet: its fee does not move it ahead of what is due now.
        row({ id: "later-5pct", amount: 200, dueDate: "2026-10-20T12:00:00Z", lateFee: { kind: "percent_month", value: 5, startsOn: "2026-10-21" } }),
        row({ id: "later-plain", amount: 1, dueDate: "2026-10-19T12:00:00Z" }),
      ],
      TODAY
    );
    expect(competing.map((bill) => [bill.id, bill.lateFee])).toEqual([
      ["overdue-plain", 0],
      ["overdue-1.5pct", 1.5],
      ["due-fixed-3", 3],
      // A fixed fee that has started is owed already: paying first saves none of it.
      ["overdue-fixed-started", 0],
      ["later-5pct", 10],
      ["later-plain", 0],
    ]);
    expect(referenceOrder(competing, TODAY)).toEqual(["due-fixed-3", "overdue-1.5pct", "overdue-plain", "overdue-fixed-started", "later-plain", "later-5pct"]);
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

  it("keeps a plan's fingerprint for bills without a late fee, and takes a new one when a fee is added or changes", () => {
    const competing = competingBills(BOOK, TODAY);
    const withFee = competingBills(BOOK.map((bill) => (bill.id === "hosting-45" ? { ...bill, lateFee: { kind: "fixed" as const, value: 5, startsOn: "2026-10-25" } } : bill)), TODAY);
    expect(planFingerprint(competingBills(BOOK.map((bill) => ({ ...bill, lateFee: null })), TODAY))).toBe(planFingerprint(competing));
    expect(planFingerprint(withFee)).not.toBe(planFingerprint(competing));
    // A person's order is set again once a bill's fee changed (order design O4).
    const plan = { ...planOf({ fingerprint: "f1", decisionMode: "person", by: "member-1", order: competing.map((bill) => ({ invoiceId: bill.id, keep: true, amount: bill.amount, dueOn: bill.dueOn })) })! };
    expect(carriedOrder(plan, competing)).toEqual(competing.map((bill) => bill.id));
    expect(carriedOrder(plan, withFee)).toBeNull();
    const signedWithFee = planOf({ fingerprint: "f2", decisionMode: "person", by: "member-1", order: withFee.map((bill) => ({ invoiceId: bill.id, keep: true, amount: bill.amount, dueOn: bill.dueOn, ...(bill.lateFee > 0 ? { lateFee: bill.lateFee } : {}) })) })!;
    expect(signedWithFee.bills["hosting-45"]).toEqual({ amount: 45, dueOn: "2026-10-24", lateFee: 5 });
    expect(carriedOrder(signedWithFee, withFee)).toEqual(withFee.map((bill) => bill.id));
  });

  it("stands while its order splits the bills the same way against the cash there is now (review of the plan)", () => {
    const competing = competingBills(BOOK, TODAY);
    const plan = { fingerprint: planFingerprint(competing), order: ["hosting-45", "storage-45", "render-140", "cluster-150"], keep: ["hosting-45", "storage-45"], wait: ["render-140", "cluster-150"], reasons: {}, byPerson: null, bills: {} };
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
      bills: { "hosting-45": { amount: null, dueOn: null }, "render-140": { amount: null, dueOn: null } },
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
      // The requests the agent sent: named `made`, the count was read as the supplier offering more time (Oct 18).
      requestsTheAgentSent: 2,
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

describe("the reasons people read (live test, Oct 18)", () => {
  const names = new Map([
    ["B1", "Cobalt Cloud 140.00 USDC"],
    ["B3", "Cobalt Cloud 45.00 USDC"],
  ]);

  it("names a bill by payee and amount where the model wrote its ref, and writes dollar amounts in USDC", () => {
    expect(namedRefs("GPU hosting pairs with B3; paid after B3 and B1.", names)).toBe("GPU hosting pairs with Cobalt Cloud 45.00 USDC; paid after Cobalt Cloud 45.00 USDC and Cobalt Cloud 140.00 USDC.");
    expect(namedRefs("Paying $45 now saves $1,200.50 USDC later.", names)).toBe("Paying 45 USDC now saves 1,200.50 USDC later.");
    // A ref it was not given, and words that only look like one, stay as they are.
    expect(namedRefs("B9 is unknown; a B2B supplier.", names)).toBe("B9 is unknown; a B2B supplier.");
  });

  it("are asked of the model by payee and in USDC, with the supplier history named for what the agent sent", () => {
    expect(PRIORITY_SYSTEM_PROMPT).toContain("never name a bill by its ref there");
    expect(PRIORITY_SYSTEM_PROMPT).toContain("never with a currency sign");
    expect(PRIORITY_SYSTEM_PROMPT).toContain("requestsTheAgentSent");
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

describe("a person's order carried on (order design O4)", () => {
  const competing = competingBills(BOOK, TODAY);
  const facts = Object.fromEntries(competing.map((bill) => [bill.id, { amount: bill.amount, dueOn: bill.dueOn }]));
  const personal = (order: string[], bills = facts) => ({ fingerprint: "old", order, keep: [], wait: [], reasons: {}, byPerson: "member-1", bills });

  it("goes on for the bills still due once some left it, in the person's order", () => {
    const order = [...competing.map((bill) => bill.id)].reverse();
    expect(carriedOrder(personal(order), competing)).toEqual(order);
    // A bill paid since is no longer competing: the order goes on without it.
    expect(carriedOrder(personal(["paid-already", ...order]), competing)).toEqual(order);
  });

  it("stops for a new bill, a changed amount or day, and never carries an agent's order", () => {
    const order = competing.map((bill) => bill.id);
    const [first, ...rest] = competing;
    expect(carriedOrder(personal(order.slice(1), Object.fromEntries(rest.map((bill) => [bill.id, facts[bill.id]]))), competing)).toBeNull();
    expect(carriedOrder(personal(order, { ...facts, [first.id]: { amount: first.amount + 1, dueOn: first.dueOn } }), competing)).toBeNull();
    expect(carriedOrder(personal(order, { ...facts, [first.id]: { amount: first.amount, dueOn: "2026-12-31" } }), competing)).toBeNull();
    expect(carriedOrder({ ...personal(order), byPerson: null }, competing)).toBeNull();
  });
});


describe("the cash step's question weighs late fees (late fees LF6)", () => {
  it("tells the model to weigh a late fee and its start, and that the written policy puts the heaviest first among bills due", () => {
    expect(PRIORITY_SYSTEM_PROMPT).toContain("a late fee (lateFee) is charged from its first day (startsOn)");
    expect(PRIORITY_SYSTEM_PROMPT).toContain("puts first, among the bills due or overdue, the one whose late fee costs most in the coming month");
  });
});
