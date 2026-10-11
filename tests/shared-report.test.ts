import { describe, expect, it } from "vitest";
import type { ActualRecord } from "@/lib/actual-payment-fields";
import type { ActualsFacts } from "@/lib/actual-payments-compare";
import type { BaselineState } from "@/lib/report-value";
import { buildSharedReport, referenceWords, scrubReasoning, supplierLabel, type ShareOptions, type SharedReportInput } from "@/lib/shared-report";
import { agreementRate } from "@/lib/verdict-rate";
import { buildReport } from "@/lib/workspace-report";
import { bill, decision, facts, payment } from "./support/report-facts";

/**
 * The shared report, pure (docs/superpowers/specs/2026-10-10-shared-report-design.md S4, S6, S7): what a public link
 * shows of the workspace report, under the share's options. Supplier names become stable labels, in the agent's
 * reasoning too; amounts can be hidden everywhere; memos, people, invoice ids and addresses never leave.
 */

const LABELS: ShareOptions = { names: "labels", amounts: "shown", title: "workspace" };
const SHOWN: ShareOptions = { names: "shown", amounts: "shown", title: "workspace" };
const ANSWERED: BaselineState = {
  available: true,
  answer: { id: "b-1", minutesPerBill: 30, peoplePerBill: 2, answeredBy: "user-owner-0001", answeredAt: "2026-10-09T08:00:00.000Z" },
};
const NOW = "2026-10-11T12:00:00.000Z";
const TX = `0x${"b".repeat(64)}`;

/** Three suppliers: Northwind's first bill arrived first, then Atlas's, then Lumen's; Northwind sent a second later. */
const FACTS = facts({
  bills: [
    bill("inv-lumen", { createdAt: "2026-10-04T09:00:00.000Z", payee: { id: "cp-lumen", name: "Lumen Hosting", mirror: false, sample: false }, amount: 13.5 }),
    bill("inv-atlas", { createdAt: "2026-10-03T09:00:00.000Z", payee: { id: "cp-atlas", name: "Atlas Compute", mirror: false, sample: false }, amount: 61.87, status: "held" }),
    bill("inv-north-1", { createdAt: "2026-10-02T09:00:00.000Z", payee: { id: "cp-north", name: "Northwind Cloud", mirror: false, sample: false }, amount: 46.41, status: "paid" }),
    bill("inv-north-2", { createdAt: "2026-10-05T09:00:00.000Z", payee: { id: "cp-north", name: "Northwind Cloud", mirror: false, sample: false }, amount: 46.41, status: "flagged" }),
  ],
  decisions: [
    decision(1, "inv-north-1", { ts: "2026-10-02T09:01:00.000Z", reasoning: "Northwind Cloud's bill matches the plan at 46.41 USDC. Pay it." }),
    decision(2, "inv-atlas", {
      ts: "2026-10-03T09:01:00.000Z",
      action: "ap_hold",
      guardrailBlocked: true,
      guardrailRule: "invoice.match_incomplete",
      resultingStatus: "held",
      reasoning: "Atlas Compute sent it to billing@atlas.example from 0x221b000000000000000000000000000000001bc3.",
    }),
    decision(3, "inv-lumen", { ts: "2026-10-04T09:01:00.000Z", resultingStatus: "paid", reasoning: "LUMEN hosting is on time. Pay." }),
    decision(4, "inv-north-2", {
      ts: "2026-10-05T09:01:00.000Z",
      action: "ap_flag_fraud",
      resultingStatus: "flagged",
      reasoning: "It repeats Northwind Cloud's bill from two days ago, to the cent, unlike Lumen Hosting's.",
    }),
  ],
  verdicts: [
    { entrySeq: 1, verdict: "agree" },
    { entrySeq: 4, verdict: "disagree" },
    { entrySeq: 3, verdict: "agree" },
  ],
  payments: [payment("inv-north-1", { amount: 46.41, txHash: TX, at: "2026-10-02T09:02:00.000Z" }), payment("inv-lumen", { amount: 13.5, at: "2026-10-04T09:02:00.000Z" })],
});

function input(over: Partial<SharedReportInput> = {}): SharedReportInput {
  return {
    facts: FACTS,
    actuals: { available: false },
    baseline: ANSWERED,
    options: LABELS,
    name: "Harbor Books",
    sharedAt: "2026-10-10T08:00:00.000Z",
    knownNames: ["Northwind Cloud", "Atlas Compute", "Lumen Hosting", "Orbit Payroll"],
    billTexts: [],
    now: NOW,
    ...over,
  };
}

describe("supplier labels", () => {
  it("count A to Z, then AA, AB", () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(supplierLabel)).toEqual([
      "Supplier A",
      "Supplier B",
      "Supplier Z",
      "Supplier AA",
      "Supplier AB",
      "Supplier AZ",
      "Supplier BA",
      "Supplier ZZ",
      "Supplier AAA",
    ]);
  });

  it("follow the order each supplier's first bill arrived, and do not move when a new bill arrives", () => {
    const view = buildSharedReport(input());
    const bySeq = Object.fromEntries(view.decisions.map((row) => [row.seq, row.supplier]));
    expect(bySeq).toEqual({ 1: "Supplier A", 2: "Supplier B", 3: "Supplier C", 4: "Supplier A" });

    const later = facts({
      ...FACTS,
      bills: [...FACTS.bills, bill("inv-zeta", { createdAt: "2026-10-06T09:00:00.000Z", payee: { id: "cp-zeta", name: "Zeta Mail", mirror: false, sample: false } })],
    });
    const again = buildSharedReport(input({ facts: later }));
    expect(Object.fromEntries(again.decisions.map((row) => [row.seq, row.supplier]))).toEqual(bySeq);
  });

  it("break a tie between first bills by the supplier's id", () => {
    const tied = facts({
      bills: [
        bill("x", { createdAt: "2026-10-02T09:00:00.000Z", payee: { id: "cp-b", name: "Beta", mirror: false, sample: false } }),
        bill("y", { createdAt: "2026-10-02T09:00:00.000Z", payee: { id: "cp-a", name: "Alpha", mirror: false, sample: false } }),
      ],
      decisions: [decision(1, "x"), decision(2, "y")],
    });
    const view = buildSharedReport(input({ facts: tied }));
    expect(Object.fromEntries(view.decisions.map((row) => [row.seq, row.supplier]))).toEqual({ 1: "Supplier B", 2: "Supplier A" });
  });
});

describe("the agent's reasoning on a shared report", () => {
  it("is its first sentence, with every name the workspace knows replaced, longest first and ignoring case", () => {
    const view = buildSharedReport(input());
    const reasoning = Object.fromEntries(view.decisions.map((row) => [row.seq, row.reasoning]));
    expect(reasoning[1]).toBe("Supplier A's bill matches the plan at 46.41 USDC.");
    expect(reasoning[3]).toBe("Supplier C is on time.");
    expect(reasoning[4]).toBe("It repeats Supplier A's bill from two days ago, to the cent, unlike Supplier C's.");
  });

  it("never keeps an email or an address, names shown or not", () => {
    for (const options of [LABELS, SHOWN]) {
      const row = buildSharedReport(input({ options })).decisions.find((item) => item.seq === 2)!;
      expect(row.reasoning).not.toMatch(/@|0x/);
      expect(row.reasoning).toContain("[hidden]");
    }
    expect(buildSharedReport(input({ options: SHOWN })).decisions.find((item) => item.seq === 2)!.reasoning).toBe(
      "Atlas Compute sent it to [hidden] from [hidden]."
    );
  });

  it("never keeps an id, names shown or not", () => {
    const id = "5d0f3a2e-8c1b-4f7a-9e6d-00000000a5a5";
    for (const names of [null, new Map([["northwind cloud", "Supplier A"]])]) {
      expect(scrubReasoning(`Invoice ${id.toUpperCase()} from Northwind Cloud matches ${id}.`, { names, others: [], references: [], hideAmounts: true })).toBe(
        `Invoice [hidden] from ${names ? "Supplier A" : "Northwind Cloud"} matches [hidden].`
      );
    }
  });

  it("hides a supplier the report does not count, and a name that is part of a longer one goes with it", () => {
    expect(scrubReasoning("Orbit Payroll and Northwind were paid; Northwind Cloud too.", { names: new Map([["northwind cloud", "Supplier A"], ["northwind", "Supplier D"]]), others: ["Orbit Payroll"], references: [], hideAmounts: false })).toBe(
      "[hidden] and Supplier D were paid; Supplier A too."
    );
  });

  it("does not touch a word that only contains a name", () => {
    expect(scrubReasoning("Alpha's order is also final.", { names: new Map([["al", "Supplier A"], ["alpha", "Supplier B"]]), others: [], references: [], hideAmounts: false })).toBe("Supplier B's order is also final.");
  });

  it("replaces a name with a full stop in it whole, before it cuts the first sentence", () => {
    const names = new Map([
      ["smith bros. plumbing", "Supplier A"],
      ["acme co. ltd", "Supplier B"],
    ]);
    const rules = { names, others: [], references: [], hideAmounts: false };
    expect(scrubReasoning("Smith Bros. Plumbing invoice matches its PO and is due today, so pay now. It is the usual.", rules)).toBe(
      "Supplier A invoice matches its PO and is due today, so pay now."
    );
    expect(scrubReasoning("Pay Acme Co. Ltd now, ahead of the deadline. Nothing else is due.", rules)).toBe("Pay Supplier B now, ahead of the deadline.");
    // Shown, a name is not cut in half either.
    expect(scrubReasoning("Smith Bros. Plumbing invoice matches. Pay.", { ...rules, names: null, others: ["Smith Bros. Plumbing"] })).toBe("Smith Bros. Plumbing invoice matches.");
  });

  it("gives such a supplier its label on a shared report, in its reasoning too", () => {
    const smith = facts({
      bills: [bill("inv-smith", { payee: { id: "cp-smith", name: "Smith Bros. Plumbing", mirror: false, sample: false } })],
      decisions: [decision(1, "inv-smith", { reasoning: "Smith Bros. Plumbing invoice matches its PO and is due today, so pay now." })],
    });
    const row = buildSharedReport(input({ facts: smith, knownNames: ["Smith Bros. Plumbing"] })).decisions[0];
    expect(row).toMatchObject({ supplier: "Supplier A", reasoning: "Supplier A invoice matches its PO and is due today, so pay now." });
    expect(JSON.stringify(row)).not.toMatch(/Smith|Bros/);
  });

  it("hides each bill's purchase order reference and memo, and each code in a memo, names shown or not", () => {
    const references = referenceWords([
      { poReference: "PO-FALCON-7781", memo: "Lisbon office retainer, INV-2291." },
      { poReference: null, memo: "Q3" },
      { poReference: "  ", memo: null },
    ]);
    expect(references).toEqual(expect.arrayContaining(["PO-FALCON-7781", "Lisbon office retainer, INV-2291", "INV-2291"]));
    // Too short to hide without hiding ordinary words.
    expect(references).not.toContain("Q3");
    for (const names of [null, new Map([["atlas compute", "Supplier B"]])]) {
      const rules = { names, others: ["Atlas Compute"], references, hideAmounts: false };
      expect(scrubReasoning("Hold: PO-FALCON-7781 for the Lisbon office retainer, INV-2291 does not match. Ask.", rules)).toBe("Hold: [hidden] for the [hidden] does not match.");
      expect(scrubReasoning("Atlas Compute quotes inv-2291 for October.", rules)).toBe(`${names ? "Supplier B" : "Atlas Compute"} quotes [hidden] for October.`);
    }
  });

  it("hides on a shared report the references the workspace's bills carry", () => {
    const quoted = facts({ ...FACTS, decisions: FACTS.decisions.map((item) => (item.seq === 2 ? { ...item, reasoning: "Hold: PO-FALCON-7781 does not match the goods received." } : item)) });
    for (const options of [LABELS, SHOWN]) {
      const view = buildSharedReport(input({ facts: quoted, options, billTexts: [{ poReference: "PO-FALCON-7781", memo: "Lisbon office retainer" }] }));
      expect(view.decisions.find((row) => row.seq === 2)!.reasoning).toBe("Hold: [hidden] does not match the goods received.");
      expect(JSON.stringify(view)).not.toMatch(/FALCON|Lisbon/);
    }
  });

  it("keeps a shown name whole when amounts are hidden, and turns every other number into #", () => {
    expect(scrubReasoning("Route 66 Diner is due 120.50 USDC by Oct 20.", { names: null, others: ["Route 66 Diner"], references: [], hideAmounts: true })).toBe(
      "Route 66 Diner is due # USDC by Oct #."
    );
  });

  it("turns every number into # when amounts are hidden", () => {
    const view = buildSharedReport(input({ options: { ...LABELS, amounts: "hidden" } }));
    expect(view.decisions.find((row) => row.seq === 1)!.reasoning).toBe("Supplier A's bill matches the plan at # USDC.");
  });

  it("is at most 200 characters", () => {
    const long = facts({ ...FACTS, decisions: [decision(1, "inv-north-1", { reasoning: `${"word ".repeat(80)}end.` })] });
    const row = buildSharedReport(input({ facts: long })).decisions[0];
    expect(row.reasoning!.length).toBeLessThanOrEqual(200);
    expect(row.reasoning!.endsWith("…")).toBe(true);
  });

  it("says why code held a bill in its own fixed words, never the agent's", () => {
    const row = buildSharedReport(input()).decisions.find((item) => item.seq === 2)!;
    expect(row.stance).toBe("held");
    expect(row.rule).toBe("Code refused it: its three-way match is incomplete.");
    const flagged = buildSharedReport(input()).decisions.find((item) => item.seq === 4)!;
    expect(flagged.rule).toBeNull();
  });
});

describe("what a shared report shows", () => {
  it("names the workspace only when the share says so", () => {
    expect(buildSharedReport(input())).toMatchObject({ title: "Harbor Books", named: true });
    expect(buildSharedReport(input({ options: { ...LABELS, title: "neutral" }, name: null }))).toMatchObject({ title: "A business on Vestiarion", named: false });
    // A name passed with a neutral share is still not shown.
    expect(buildSharedReport(input({ options: { ...LABELS, title: "neutral" } }))).toMatchObject({ title: "A business on Vestiarion", named: false });
  });

  it("shows supplier names when the share says so", () => {
    const view = buildSharedReport(input({ options: SHOWN }));
    expect(view.decisions.find((row) => row.seq === 4)!.supplier).toBe("Northwind Cloud");
    expect(view.decisions.find((row) => row.seq === 4)!.reasoning).toBe("It repeats Northwind Cloud's bill from two days ago, to the cent, unlike Lumen Hosting's.");
  });

  it("hides every amount when the share says so, and keeps the counts", () => {
    const view = buildSharedReport(input({ options: { ...LABELS, amounts: "hidden" } }));
    expect(view.figures.paid).toEqual({ count: 2, onTime: 2, byCurrency: null });
    expect(view.decisions.every((row) => row.amount === null)).toBe(true);
    expect(view.payments.every((row) => row.amount === null && row.bill === null)).toBe(true);
    expect(view.value.measured.discountsTaken.byCurrency).toBeNull();
    expect(view.value.notCounted.discountsNotTaken.byCurrency).toBeNull();
    expect(view.value.notCounted.discountsOpen.byCurrency).toBeNull();
    expect(JSON.stringify(view)).not.toMatch(/46\.41|61\.87|13\.5/);
  });

  it("gives no transaction when amounts are hidden, since the public explorer shows each one's amount", () => {
    const view = buildSharedReport(input({ options: { ...LABELS, amounts: "hidden" } }));
    expect(view.decisions.find((row) => row.seq === 1)!.payment).toEqual({ simulated: false, txHash: null });
    expect(view.payments.every((row) => row.txHash === null)).toBe(true);
    expect(JSON.stringify(view)).not.toContain(TX);
    // Shown with the amounts.
    expect(buildSharedReport(input()).payments.some((row) => row.txHash === TX)).toBe(true);
  });

  it("never carries an invoice id, a supplier's id, a person's id or the workspace's", () => {
    const json = JSON.stringify(buildSharedReport(input({ options: SHOWN })));
    for (const secret of ["inv-", "cp-", "user-owner-0001"]) expect(json).not.toContain(secret);
    expect(buildSharedReport(input()).value.estimate).toMatchObject({ kind: "answered", answeredBy: null, saved: { bills: 2, hours: 1 }, wouldHaveSaved: null });
  });

  it("gives each decided bill's newest decision, newest first, with its verdict and its payment", () => {
    const view = buildSharedReport(input());
    expect(view.decisions.map((row) => row.seq)).toEqual([4, 3, 2, 1]);
    expect(view.decisionCount).toBe(4);
    expect(view.decisions.find((row) => row.seq === 1)).toMatchObject({ stance: "paid", verdict: "agree", payment: { simulated: false, txHash: TX }, amount: { amount: 46.41, currency: "USDC" } });
    expect(view.decisions.find((row) => row.seq === 4)).toMatchObject({ stance: "held", verdict: "disagree", payment: null });
  });

  it("lists at most 50 decisions", () => {
    const many = facts({
      bills: Array.from({ length: 60 }, (_, index) => bill(`b-${index}`, { createdAt: `2026-10-02T09:${String(index).padStart(2, "0")}:00.000Z` })),
      decisions: Array.from({ length: 60 }, (_, index) => decision(index + 1, `b-${index}`, { ts: `2026-10-02T10:${String(index).padStart(2, "0")}:00.000Z` })),
    });
    const view = buildSharedReport(input({ facts: many }));
    expect(view.decisions).toHaveLength(50);
    expect(view.decisionCount).toBe(60);
    expect(view.decisions[0].seq).toBe(60);
  });

  it("says the agreement rate as the console does", () => {
    const view = buildSharedReport(input());
    const report = buildReport(FACTS);
    expect(view.figures.verdicts).toEqual({ agreed: 2, disagreed: 1, rate: agreementRate(report.verdicts!) });
    expect(view.figures.verdicts!.rate).toBe(67);
  });

  it("says a sandbox's payments are simulated, with no transaction", () => {
    const sandbox = facts({ ...FACTS, sandbox: true, payments: FACTS.payments.map((item) => ({ ...item, simulated: true })) });
    const view = buildSharedReport(input({ facts: sandbox }));
    expect(view.simulated).toBe(true);
    expect(view.payments.every((row) => row.simulated && row.txHash === null)).toBe(true);
    expect(view.decisions.find((row) => row.seq === 1)!.payment).toEqual({ simulated: true });
  });

  it("counts the sample data while the workspace has no real bill", () => {
    const sample = facts({ ...FACTS, bills: FACTS.bills.map((item) => ({ ...item, payee: { ...item.payee, sample: true } })) });
    expect(buildSharedReport(input({ facts: sample })).source).toBe("sample");
  });

  it("states the period from the workspace's first entry to the view, live", () => {
    expect(buildSharedReport(input())).toMatchObject({ openedAt: FACTS.openedAt, computedAt: NOW, sharedAt: "2026-10-10T08:00:00.000Z", network: "arc-testnet" });
  });
});

describe("agent vs what really happened, on a shared report", () => {
  const record = (id: string, invoiceId: string, over: Partial<ActualRecord> = {}): ActualRecord => ({
    id,
    invoiceId,
    outcome: "paid",
    paidOn: "2026-10-04",
    amount: 46.41,
    currency: "USDC",
    method: "bank_transfer",
    reference: "SEPA-1",
    note: "Paid from the main account",
    reason: null,
    replaces: null,
    source: "form",
    recordedBy: "user-owner-0001",
    recordedAt: "2026-10-06T08:00:00.000Z",
    ...over,
  });
  const actuals = (records: ActualRecord[]): { available: true; facts: ActualsFacts } => ({
    available: true,
    facts: { records, entries: new Map(), verdictEntries: new Map() },
  });

  it("says so before the records are set up", () => {
    expect(buildSharedReport(input()).comparison).toEqual({ kind: "not_ready" });
  });

  it("says so when no bill is recorded yet, with how many wait", () => {
    expect(buildSharedReport(input({ actuals: actuals([]) })).comparison).toEqual({ kind: "none", notRecorded: 4 });
  });

  it("gives totals over recorded bills only; a bill nobody recorded is only in not recorded", () => {
    const view = buildSharedReport(
      input({ actuals: actuals([record("r-1", "inv-north-1"), record("r-2", "inv-atlas", { paidOn: "2026-10-05", amount: 61.87 })]) })
    );
    // Atlas's bill was held, so it has no day the agent would have paid it on: only Northwind's is counted in days.
    expect(view.comparison).toEqual({ kind: "totals", compared: 2, notRecorded: 2, same: 1, different: 1, medianDays: 2, daysCompared: 1 });
    const json = JSON.stringify(view);
    for (const secret of ["SEPA-1", "Paid from the main account", "r-1"]) expect(json).not.toContain(secret);
  });
});
