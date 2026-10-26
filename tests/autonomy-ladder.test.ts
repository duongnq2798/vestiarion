import { describe, expect, it } from "vitest";
import { autonomyLadder, decisionKindLabel, ladderVerdicts, type LadderVerdict } from "@/lib/autonomy-ladder";
import { agreementRate } from "@/lib/verdict-rate";
import { buildReport, VERDICTS_BEFORE_LIVE, type ReportBill, type ReportDecision, type ReportFacts, type ReportVerdict } from "@/lib/workspace-report";

/**
 * The autonomy ladder's first step (docs/superpowers/specs/2026-10-26-autonomy-ladder-design.md AL1-AL6): how often a
 * person agreed with the agent, by decision kind and by vendor, counted from shadow-mode verdicts only, on real bills,
 * with the number of verdicts behind each figure, and no figure below five verdicts. Pure, on hand-made rows.
 */

function bill(id: string, payee: Partial<ReportBill["payee"]> = {}): ReportBill {
  return {
    id,
    createdAt: "2026-10-02T10:00:00.000Z",
    dueDate: "2026-10-10T00:00:00.000Z",
    amount: 100,
    currency: "USDC",
    status: "pending",
    reviewedBy: null,
    paidAmount: null,
    discount: null,
    bill: null,
    payee: { id: `payee-${id}`, name: `Payee ${id}`, mirror: false, sample: false, ...payee },
  };
}

function decision(seq: number, invoiceId: string, action = "ap_pay"): ReportDecision {
  return {
    seq,
    ts: "2026-10-02T10:01:00.000Z",
    action,
    invoiceId,
    guardrailBlocked: false,
    guardrailRule: null,
    heldBecause: null,
    resultingStatus: "held",
    shadow: true,
    reasoning: "Pay it.",
  };
}

const agree = (entrySeq: number): ReportVerdict => ({ entrySeq, verdict: "agree" });
const disagree = (entrySeq: number): ReportVerdict => ({ entrySeq, verdict: "disagree" });

function facts(over: Partial<ReportFacts> = {}): ReportFacts {
  return {
    network: "arc-testnet",
    sandbox: false,
    now: "2026-10-11T12:00:00.000Z",
    openedAt: "2026-10-01T00:00:00.000Z",
    shadow: { currency: "USD", startedAt: "2026-10-01T00:00:00.000Z" },
    bills: [],
    decisions: [],
    personActions: [],
    verdicts: [],
    payments: [],
    ...over,
  };
}

const COBALT = { id: "cp-cobalt", name: "Cobalt Cloud", sample: false };
const LUMEN = { id: "cp-lumen", name: "Lumen Print Co.", sample: false };
const SAMPLE = { id: "cp-sample", name: "Northwind Cloud", sample: true };

/** `count` verdicts on one vendor's decisions of one kind, the first `agreed` of them agreeing. */
function verdicts(count: number, agreed: number, action: string, vendor: LadderVerdict["vendor"]): LadderVerdict[] {
  return Array.from({ length: count }, (_, index) => ({ action, verdict: index < agreed ? "agree" : "disagree", vendor }));
}

describe("autonomyLadder", () => {
  it("counts verdicts per decision kind and per vendor, with agreed, disagreed and n (AL2, AL3)", () => {
    const ladder = autonomyLadder([...verdicts(6, 5, "ap_pay", COBALT), ...verdicts(2, 1, "ap_hold", COBALT), ...verdicts(3, 3, "ap_pay", LUMEN)]);
    expect(ladder).toMatchObject({ given: 11, agreed: 9, disagreed: 2 });
    expect(ladder.byKind).toEqual([
      { key: "ap_pay", label: "Pay", given: 9, agreed: 8, disagreed: 1, rate: 89, enough: true },
      { key: "ap_hold", label: "Hold", given: 2, agreed: 1, disagreed: 1, rate: null, enough: false },
    ]);
    expect(ladder.byVendor).toEqual([
      { key: "cp-cobalt", label: "Cobalt Cloud", given: 8, agreed: 6, disagreed: 2, rate: 75, enough: true },
      { key: "cp-lumen", label: "Lumen Print Co.", given: 3, agreed: 3, disagreed: 0, rate: null, enough: false },
    ]);
  });

  it("gives a rate from five verdicts, with the shared agreementRate, and none below (AL1, AL4)", () => {
    expect(VERDICTS_BEFORE_LIVE).toBe(5);
    const four = autonomyLadder(verdicts(4, 4, "ap_pay", COBALT)).byKind[0];
    expect(four).toMatchObject({ given: 4, agreed: 4, rate: null, enough: false });
    const five = autonomyLadder(verdicts(5, 4, "ap_pay", COBALT)).byKind[0];
    expect(five).toMatchObject({ given: 5, agreed: 4, rate: 80, enough: true });
    const seven = autonomyLadder(verdicts(7, 4, "ap_schedule", COBALT)).byKind[0];
    expect(seven.rate).toBe(agreementRate({ agreed: 4, disagreed: 3 }));
    expect(seven.rate).toBe(57);
  });

  it("leaves sample vendors out of every row and total (AL3)", () => {
    const ladder = autonomyLadder([...verdicts(6, 6, "ap_pay", SAMPLE), ...verdicts(1, 0, "ap_pay", COBALT)]);
    expect(ladder).toMatchObject({ given: 1, agreed: 0, disagreed: 1 });
    expect(ladder.byVendor.map((row) => row.key)).toEqual(["cp-cobalt"]);
    expect(ladder.byKind).toEqual([{ key: "ap_pay", label: "Pay", given: 1, agreed: 0, disagreed: 1, rate: null, enough: false }]);
  });

  it("lists the decision kinds in the agent's own order, only those with a verdict, each in plain words (AL2, AL5)", () => {
    const ladder = autonomyLadder([
      ...verdicts(1, 1, "ap_request_info", COBALT),
      ...verdicts(1, 1, "ap_flag_fraud", COBALT),
      ...verdicts(1, 1, "ap_hold", COBALT),
      ...verdicts(1, 1, "ap_schedule", COBALT),
      ...verdicts(1, 1, "ap_pay", COBALT),
      ...verdicts(1, 1, "ap_something_new", COBALT),
    ]);
    expect(ladder.byKind.map((row) => [row.key, row.label])).toEqual([
      ["ap_pay", "Pay"],
      ["ap_schedule", "Schedule"],
      ["ap_hold", "Hold"],
      ["ap_flag_fraud", "Flag for review"],
      ["ap_request_info", "Ask for details"],
      ["ap_something_new", "Another decision"],
    ]);
    expect(autonomyLadder(verdicts(2, 2, "ap_hold", COBALT)).byKind.map((row) => row.key)).toEqual(["ap_hold"]);
    expect(decisionKindLabel("ap_flag_fraud")).toBe("Flag for review");
  });

  it("lists vendors most verdicts first, then by name, then by id, whatever order the verdicts came in (AL5)", () => {
    const twin = { id: "cp-atlas-2", name: "Atlas Compute", sample: false };
    const rows = [
      ...verdicts(2, 2, "ap_pay", { id: "cp-atlas-1", name: "Atlas Compute", sample: false }),
      ...verdicts(2, 1, "ap_pay", twin),
      ...verdicts(2, 2, "ap_pay", LUMEN),
      ...verdicts(4, 4, "ap_pay", COBALT),
    ];
    const order = (input: LadderVerdict[]) => autonomyLadder(input).byVendor.map((row) => row.key);
    expect(order(rows)).toEqual(["cp-cobalt", "cp-atlas-1", "cp-atlas-2", "cp-lumen"]);
    expect(order([...rows].reverse())).toEqual(["cp-cobalt", "cp-atlas-1", "cp-atlas-2", "cp-lumen"]);
  });

  it("has nothing to show before any verdict", () => {
    expect(autonomyLadder([])).toEqual({ given: 0, agreed: 0, disagreed: 0, byKind: [], byVendor: [] });
  });
});

describe("ladderVerdicts", () => {
  const cobalt = (id: string) => bill(id, COBALT);
  const lumen = (id: string) => bill(id, LUMEN);

  it("takes each verdict's kind from the decision it is about, and its vendor from the decision's payable (AL2)", () => {
    const read = ladderVerdicts(
      facts({
        bills: [cobalt("a"), lumen("b")],
        decisions: [decision(1, "a", "ap_hold"), decision(2, "a", "ap_pay"), decision(3, "b", "ap_request_info")],
        verdicts: [agree(1), disagree(2), agree(3)],
      })
    );
    expect(read).toEqual([
      { action: "ap_hold", verdict: "agree", vendor: COBALT },
      { action: "ap_pay", verdict: "disagree", vendor: COBALT },
      { action: "ap_request_info", verdict: "agree", vendor: LUMEN },
    ]);
  });

  it("counts a bill decided twice as two decisions, one verdict each (AL3)", () => {
    const ladder = autonomyLadder(
      ladderVerdicts(facts({ bills: [cobalt("a")], decisions: [decision(1, "a", "ap_hold"), decision(2, "a", "ap_pay")], verdicts: [agree(1), agree(2)] }))
    );
    expect(ladder.byVendor).toEqual([{ key: "cp-cobalt", label: "Cobalt Cloud", given: 2, agreed: 2, disagreed: 0, rate: null, enough: false }]);
  });

  it("drops a verdict whose decision or payable was not read (AL3)", () => {
    const read = ladderVerdicts(facts({ bills: [cobalt("a")], decisions: [decision(1, "a"), decision(2, "gone")], verdicts: [agree(1), agree(2), agree(99)] }));
    expect(read).toHaveLength(1);
  });

  it("adds up to the report's own verdict figures while the workspace has real bills (AL3)", () => {
    const input = facts({
      bills: [cobalt("a"), cobalt("b"), lumen("c"), bill("s", SAMPLE)],
      decisions: [decision(1, "a"), decision(2, "b", "ap_schedule"), decision(3, "c", "ap_hold"), decision(4, "s"), decision(5, "c", "ap_pay")],
      verdicts: [agree(1), disagree(2), agree(3), agree(4), agree(5)],
    });
    const ladder = autonomyLadder(ladderVerdicts(input));
    const report = buildReport(input);
    expect({ agreed: ladder.agreed, disagreed: ladder.disagreed }).toEqual({ agreed: report.verdicts!.agreed, disagreed: report.verdicts!.disagreed });
    expect(ladder.byKind.reduce((sum, row) => sum + row.given, 0)).toBe(ladder.given);
    expect(ladder.byVendor.reduce((sum, row) => sum + row.given, 0)).toBe(ladder.given);
  });

  it("counts no sample verdict even while the report counts the sample data, for want of a real bill (AL3)", () => {
    const input = facts({ bills: [bill("s", SAMPLE)], decisions: [decision(1, "s")], verdicts: [agree(1)] });
    expect(buildReport(input).source).toBe("sample");
    expect(autonomyLadder(ladderVerdicts(input)).given).toBe(0);
  });
});
