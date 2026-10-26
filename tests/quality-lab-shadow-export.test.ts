import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AGENT_DECISION_ACTIONS } from "@/lib/agent/shadow-hold";
import {
  assertShareable,
  exportShadowDecisions,
  SHADOW_DECISIONS_PATH,
  SHADOW_DECISIONS_SOURCE,
  type ShadowDecisionsFile,
  type ShadowLedgerRow,
  type ShadowVerdictRow,
} from "@/lib/quality-lab/shadow-export";
import { runShadowExport, SHADOW_ENTRIES_SQL, SHADOW_VERDICTS_SQL, type ShadowExportClient } from "../scripts/lib/quality-lab-shadow";
import { applyMigrations, createDatabase, createUser, FOUNDING_ORG_ID } from "./support/pglite";

/**
 * The export half of replaying the shadow-mode decisions (docs/superpowers/specs/2026-10-26-quality-lab-shadow-replay-
 * design.md SX1-SX8): only the team's own workspaces, only fields the code names, no text, names or identifiers, and the
 * whole output refused when anything in it looks private.
 */

const FOUNDING = "00000000-0000-4000-8000-000000000001";
const TEAM = "7a6c1d2e-3f40-4b5a-9c8d-1e2f3a4b5c6d";
const BILL_A = "3c1f9a2b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const BILL_B = "8e2d4c6b-0a1f-4e3d-9c5b-7a6f8e0d2c4b";
const BILL_C = "1b3d5f7a-9c2e-4a6b-8d0f-2e4c6a8b0d1f";
const ACME = "5f4e3d2c-1b0a-4c9d-8e7f-6a5b4c3d2e1f";
const NORTHWIND = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";
const PROJECT = "2d4f6a8c-0e1b-4d3f-8a5c-7e9b1d3f5a7c";
const MILESTONE = "6c8e0a2d-4f6b-4a8c-9e0d-2f4a6c8e0b1d";
const MEMBER = "4a2c6e8b-1d3f-4b5a-8c7e-9f0a2b4c6d8e";
const OTHER_MEMBER = "0e9d8c7b-6a5f-4e3d-8c1b-0a9f8e7d6c5b";
const DOCUMENT_REQUEST = "7d5b3f1a-9e8c-4a6b-8d4f-2c0e8a6b4d2f";

const ADDRESS_ON_FILE = "0x4b1d5e7a9c3f2e6d8a0b1c2d3e4f5a6b7c8d9e0f";
const DOCUMENT_PAY_TO = "0x9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a291807";
const CONTRACT = "0x9da3c47f0e1d2c3b4a5f6e7d8c9b0a1f2e3d4c5b";
const AGENT_WALLET = "0x1f2e3d4c5b6a79880a9b8c7d6e5f4a3b2c1d0e9f";
const TX_HASH = `0x${"ab".repeat(32)}`;
const LIMIT_REF = `0x${"cd".repeat(32)}`;
const FILE_SHA = "e3".repeat(32);
const FINGERPRINT = "7f".repeat(32);

const REASONING = "Acme Hosting Ltd invoice INV-2207 matches PO-7781 and the goods were received, so pay it today.";
const POLICY_REASONING = "Policy: INV-2207 from Acme Hosting Ltd is under the limit and matched; pay.";
const PO_REFERENCE = "PO-7781 / Northwind order for INV-2207";
const TIMING_REASON = "Paying on 2026-10-20 keeps 400 USDC earning until it is due for Acme Hosting Ltd.";
const DUPLICATE_FINDING = "Same amount and memo as INV-2206 from Acme Hosting Ltd, still scheduled.";
const SAME_WORK_FINDING = "The milestone Support plan setup names the same purchase order PO-7781.";
const PROJECT_NAME = "Northwind office fit-out";
const HISTORY_ABOUT = "Payments to this address across Vestiarion workspaces, ops@acme-hosting.example";
const PRIORITY_REASON = "Acme first: the hosting keeps the shop online";
const FUTURE_VALUE = "a field the ledger gains later, with a name in it: Acme";

/** An AP decision's ledger detail, shaped as `decideApPayable` writes it (src/lib/agent/orchestrator.ts). */
function apDetail(input: { invoiceId: string; counterpartyId: string; action: string; payOn?: string | null }): Record<string, unknown> {
  return {
    invoiceId: input.invoiceId,
    counterpartyId: input.counterpartyId,
    decision: { action: input.action, payOn: input.payOn ?? null, reasoning: REASONING, confidence: 0.82 },
    decisionMode: "deepseek",
    referenceDecision: { action: "pay", reasoning: POLICY_REASONING, confidence: 1 },
    agreedWithReference: input.action === "pay",
    guardrailBlocked: false,
    guardrailRule: null,
    currency: "USDC",
    vendorDocument: { requestId: DOCUMENT_REQUEST, source: "vendor", fileSha256: FILE_SHA },
    outflowBudget: { dailyUsdc: 500, weeklyUsdc: null, spentToday: 40, spentThisWeek: 40, remaining: 460, binding: "day" },
    onChainLimit: { contract: CONTRACT, agent: AGENT_WALLET, ref: LIMIT_REF, covered: true, verdict: { state: "refused", error: "OverDailyLimit", spent: 480, amount: 400, limit: 500 } },
    timing: {
      today: "2026-10-12",
      dueOn: "2026-10-20",
      discountValue: 8,
      discountAvailableUntil: "2026-10-15",
      floatValueToDue: 0.12,
      targetOn: "2026-10-20",
      recommendation: { action: "schedule", payOn: "2026-10-20" },
      reason: TIMING_REASON,
      shortfall: false,
      amountDueAtTarget: 400,
      earlierObligations: { total: 120, count: 2 },
    },
    timingRule: null,
    terms: { earlyPayDiscount: { percent: 2, deadline: "2026-10-15T00:00:00.000Z" }, lateFee: { kind: "percent", value: 1.5, startsOn: "2026-10-21", aMonth: 6 } },
    shadow: true,
    cashPriority: { waits: false, reason: PRIORITY_REASON, fingerprint: FINGERPRINT },
    reevaluation: { reopenedSeq: 5120, trigger: "fx_quote", previousDecisionSeq: 5100, previousAction: "hold" },
    amountPaid: null,
    discountTaken: null,
    futureField: FUTURE_VALUE,
    observed: {
      amount: 400,
      paymentLimit: 1000,
      riskLevel: "clear",
      performanceHistory: {
        score: 0.92,
        status: "measured_from_ledger",
        inputs: { paidWithoutIntervention: 4, informationRequested: 1, heldOrFlagged: 0, duplicateSubmissions: 0, riskTierChanges: 0, heldByOurPolicy: 1 },
        note: "Historical evidence for closer review, not a verdict or payment guardrail.",
      },
      poReference: PO_REFERENCE,
      goodsReceived: true,
      purchaseOrderRequired: true,
      twoApprovalsAbove: 2500,
      newPayee: { addressBy: MEMBER, confirmedBy: OTHER_MEMBER, twoParties: true },
      addressHistory: {
        about: HISTORY_ABOUT,
        workspacesPaid: 3,
        paymentsConfirmed: 7,
        firstPaidAt: "2026-08-01T10:00:00.000Z",
        lastPaidAt: "2026-10-01T10:00:00.000Z",
        boughtAt: "2026-10-12T09:30:00.000Z",
        priceUsdc: 0.01,
      },
      operatingBalance: 1500.25,
      addressUnconfirmed: false,
      documentPayTo: DOCUMENT_PAY_TO,
      projectId: PROJECT,
      project: {
        id: PROJECT,
        name: PROJECT_NAME,
        state: "reserved",
        already: false,
        neededMinor: 40000,
        budgetMinor: 500000,
        bufferMinor: 0,
        reservedMinor: 40000,
        paidMinor: 0,
        availableMinor: 460000,
      },
      sameWork: [{ otherKind: "milestone", otherId: MILESTONE, otherStatus: "verified", signal: "purchase_order", reference: PO_REFERENCE, finding: SAME_WORK_FINDING }],
      duplicateCheck: {
        candidatesConsidered: 6,
        matchesTotal: 1,
        matchesShown: 1,
        matches: [{ otherInvoiceId: BILL_B, otherInvoiceStatus: "scheduled", confidence: 0.85, signals: ["same_amount", "same_memo"], finding: DUPLICATE_FINDING }],
      },
      futureObserved: FUTURE_VALUE,
    },
    execution: {
      txRef: TX_HASH,
      chainMode: "live",
      resultingStatus: "held",
      settlementRequired: true,
      feeUsd: null,
      feeSource: null,
      settledInMs: null,
      executedAt: null,
      reconciled: false,
      heldBecause: "shadow_verdict",
      futureExecution: FUTURE_VALUE,
    },
  };
}

/** The founding workspace's hold on a payee whose address changed, decided first. */
function foundingHold(): ShadowLedgerRow {
  const detail = apDetail({ invoiceId: BILL_C, counterpartyId: NORTHWIND, action: "hold" });
  detail.guardrailBlocked = true;
  detail.guardrailRule = "counterparty.address_unconfirmed";
  const observed = detail.observed as Record<string, unknown>;
  observed.addressUnconfirmed = true;
  observed.poReference = null;
  delete observed.documentPayTo;
  delete observed.projectId;
  delete observed.project;
  delete observed.sameWork;
  (observed.duplicateCheck as Record<string, unknown>).matches = [];
  (observed.duplicateCheck as Record<string, unknown>).matchesTotal = 0;
  (observed.duplicateCheck as Record<string, unknown>).matchesShown = 0;
  (detail.execution as Record<string, unknown>).heldBecause = undefined;
  return { seq: "5188", ts: new Date("2026-10-11T15:02:09.000Z"), org_id: FOUNDING, action: "ap_hold", side: "ours", detail, address_on_file: null };
}

/** The team workspace's payment of bill A, held for a verdict, with a duplicate match against bill B. */
function teamPay(): ShadowLedgerRow {
  return { seq: "5201", ts: new Date("2026-10-12T09:41:27.512Z"), org_id: TEAM, action: "ap_pay", side: "ours", detail: apDetail({ invoiceId: BILL_A, counterpartyId: ACME, action: "pay" }), address_on_file: ADDRESS_ON_FILE };
}

/** Bill A decided a second time: scheduled for five days on. */
function teamScheduleAgain(): ShadowLedgerRow {
  const detail = apDetail({ invoiceId: BILL_A, counterpartyId: ACME, action: "schedule", payOn: "2026-10-19" });
  detail.timingRule = "payon.after_due";
  detail.requestedPayOn = "2026-10-25";
  detail.scheduledFor = "2026-10-16T00:00:00.000Z";
  const observed = detail.observed as Record<string, unknown>;
  // The document asked for the address on file, in another case: it does not differ.
  observed.documentPayTo = ADDRESS_ON_FILE.toUpperCase().replace("0X", "0x");
  observed.newPayee = { addressBy: "payee", linkCreatedBy: MEMBER, confirmedBy: null, unanswered: true, twoParties: false };
  (detail.execution as Record<string, unknown>).resultingStatus = "scheduled";
  delete (detail.execution as Record<string, unknown>).heldBecause;
  return { seq: 5230, ts: "2026-10-14T08:00:59.000Z", org_id: TEAM, action: "ap_schedule", side: "ours", detail, address_on_file: ADDRESS_ON_FILE };
}

/** Bill B, the duplicate match's other bill, decided at the same minute as the schedule and after it in the ledger. */
function teamHoldOther(): ShadowLedgerRow {
  const detail = apDetail({ invoiceId: BILL_B, counterpartyId: ACME, action: "hold" });
  delete (detail.observed as Record<string, unknown>).duplicateCheck;
  return { seq: 5231n, ts: "2026-10-14T08:00:59.000Z", org_id: TEAM, action: "ap_hold", side: "ours", detail, address_on_file: ADDRESS_ON_FILE };
}

/** Planted by the guardrail fixture: never exported (SX1). */
function fixture(): ShadowLedgerRow {
  const detail = { ...apDetail({ invoiceId: BILL_A, counterpartyId: ACME, action: "pay" }), guardrailFixture: true };
  return { seq: "5300", ts: "2026-10-15T08:00:00.000Z", org_id: TEAM, action: "ap_pay", side: "ours", detail, address_on_file: ADDRESS_ON_FILE };
}

/** Decided while the workspace was live: never exported (SX1). */
function live(): ShadowLedgerRow {
  const detail = apDetail({ invoiceId: BILL_A, counterpartyId: ACME, action: "pay" });
  delete detail.shadow;
  return { seq: "5301", ts: "2026-10-15T09:00:00.000Z", org_id: TEAM, action: "ap_pay", side: "ours", detail, address_on_file: ADDRESS_ON_FILE };
}

const VERDICTS: ShadowVerdictRow[] = [
  { org_id: TEAM, entry_seq: "5201", verdict: "agree" },
  { org_id: TEAM, entry_seq: 5230, verdict: "disagree" },
  // A verdict on a decision the export left out, and one in another workspace under the same number: neither attaches.
  { org_id: TEAM, entry_seq: "5300", verdict: "agree" },
  { org_id: FOUNDING, entry_seq: "5231", verdict: "agree" },
];

const READ_AT = new Date("2026-10-26T12:00:00.000Z");

function exported(): ShadowDecisionsFile {
  // Out of order on purpose: the export sorts by time, then by the ledger's order.
  return exportShadowDecisions([teamHoldOther(), live(), teamPay(), fixture(), teamScheduleAgain(), foundingHold()], VERDICTS, READ_AT);
}

describe("exportShadowDecisions (shadow replay SX1-SX5, SX8)", () => {
  it("keeps the team's shadow decisions in time order, the ledger's order breaking a tie, with ids and minutes", () => {
    const file = exported();
    expect(file.source).toBe(SHADOW_DECISIONS_SOURCE);
    expect(file.readAt).toBe("2026-10-26T12:00:00.000Z");
    expect(file.decisions.map((decision) => [decision.id, decision.decidedAt, decision.decision.action])).toEqual([
      ["shadow-01", "2026-10-11T15:02:00.000Z", "hold"],
      ["shadow-02", "2026-10-12T09:41:00.000Z", "pay"],
      ["shadow-03", "2026-10-14T08:00:00.000Z", "schedule"],
      ["shadow-04", "2026-10-14T08:00:00.000Z", "hold"],
    ]);
  });

  it("leaves out the guardrail fixture's entries and decisions not made in shadow mode (SX1)", () => {
    const file = exportShadowDecisions([fixture(), live()], VERDICTS, READ_AT);
    expect(file.decisions).toEqual([]);
  });

  it("refuses the whole export when a row is a customer's (SX2)", () => {
    const customer = { ...teamPay(), side: "customers" };
    expect(() => exportShadowDecisions([foundingHold(), customer], VERDICTS, READ_AT)).toThrow(/customer/);
  });

  it("maps each verdict to its own decision, and none to a decision without one, never its reason (SX1)", () => {
    expect(exported().decisions.map((decision) => decision.verdict)).toEqual([null, "agree", "disagree", null]);
  });

  it("names workspaces, bills and payees by pseudonyms in decision order, the same one for the same thing (SX4)", () => {
    const [hold, pay, schedule, other] = exported().decisions;
    expect([hold.workspace, hold.bill, hold.payee]).toEqual(["w1", "b1", "p1"]);
    expect([pay.workspace, pay.bill, pay.payee]).toEqual(["w2", "b2", "p2"]);
    // The same bill decided twice, and the same payee.
    expect([schedule.workspace, schedule.bill, schedule.payee]).toEqual(["w2", "b2", "p2"]);
    // The duplicate match's other bill is the bill decided in shadow-04.
    expect(pay.observed.duplicateCheck?.matches).toEqual([{ otherBill: "b3", otherInvoiceStatus: "scheduled", confidence: 0.85, signals: ["same_amount", "same_memo"] }]);
    expect([other.workspace, other.bill, other.payee]).toEqual(["w2", "b3", "p2"]);
    expect(pay.observed.projectId).toBe("pj1");
    expect(pay.observed.sameWork).toEqual([{ otherKind: "milestone", other: "m1", otherStatus: "verified", signal: "purchase_order" }]);
    expect(other.observed.projectId).toBe("pj1");
  });

  it("copies only the fields it names: an unknown field never passes (SX3)", () => {
    const pay = exported().decisions[1];
    expect(Object.keys(pay).sort()).toEqual(
      [
        "agreedWithReference", "amountPaid", "bill", "cashAhead", "cashPriority", "currency", "decidedAt", "decision", "decisionMode",
        "discountTaken", "eurc", "execution", "guardrailBlocked", "guardrailRule", "id", "observed", "onChainLimit", "outflowBudget",
        "paidToBank", "payee", "payout", "reevaluation", "referenceAction", "requestedPayOnInDays", "scheduledForInDays", "terms",
        "timing", "timingRule", "vendorDocument", "verdict", "workspace",
      ].sort()
    );
    expect(Object.keys(pay.observed).sort()).toEqual(
      [
        "addressHistory", "addressMissing", "addressUnconfirmed", "amount", "documentPayTo", "duplicateCheck", "goodsReceived", "newPayee",
        "operatingBalance", "paymentLimit", "performanceHistory", "poPresent", "project", "projectId", "purchaseOrderRequired", "riskLevel",
        "sameWork", "twoApprovalsAbove",
      ].sort()
    );
    expect(pay.execution).toEqual({ resultingStatus: "held", heldBecause: "shadow_verdict" });
    const json = JSON.stringify(exported());
    for (const unknown of ["futureField", "futureObserved", "futureExecution", FUTURE_VALUE]) expect(json).not.toContain(unknown);
  });

  it("keeps the decision's facts as numbers, booleans, tokens and days from the decision (SX3, SX5)", () => {
    const [hold, pay, schedule] = exported().decisions;
    expect(pay.decision).toEqual({ action: "pay", payOnInDays: null, fundWithSwap: null, confidence: 0.82 });
    expect(pay).toMatchObject({
      decisionMode: "deepseek",
      referenceAction: "pay",
      agreedWithReference: true,
      guardrailBlocked: false,
      guardrailRule: null,
      currency: "USDC",
      vendorDocument: "vendor",
      paidToBank: false,
      payout: null,
      eurc: null,
      cashAhead: null,
      cashPriority: { waits: false, byPerson: false },
      reevaluation: { trigger: "fx_quote", previousAction: "hold" },
      outflowBudget: { dailyUsdc: 500, weeklyUsdc: null, spentToday: 40, spentThisWeek: 40, remaining: 460, binding: "day" },
      onChainLimit: { covered: true, uncoveredBecause: null, verdict: { state: "refused", error: "OverDailyLimit", spent: 480, amount: 400, limit: 500 } },
    });
    // Decided on 2026-10-12: due on the 20th, the discount until the 15th, the late fee from the 21st.
    expect(pay.timing).toEqual({
      dueInDays: 8,
      targetInDays: 8,
      recommendation: { action: "schedule", payOnInDays: 8 },
      discountValue: 8,
      discountAvailableUntilInDays: 3,
      floatValueToDue: 0.12,
      shortfall: false,
      amountDueAtTarget: 400,
      earlierObligations: { total: 120, count: 2 },
    });
    expect(pay.terms).toEqual({ earlyPayDiscount: { percent: 2, deadlineInDays: 3 }, lateFee: { kind: "percent", value: 1.5, startsOnInDays: 9, aMonth: 6 } });
    expect(pay.observed).toMatchObject({
      amount: 400,
      paymentLimit: 1000,
      riskLevel: "clear",
      performanceHistory: {
        score: 0.92,
        status: "measured_from_ledger",
        inputs: { paidWithoutIntervention: 4, informationRequested: 1, heldOrFlagged: 0, duplicateSubmissions: 0, riskTierChanges: 0, heldByOurPolicy: 1 },
      },
      poPresent: true,
      goodsReceived: true,
      purchaseOrderRequired: true,
      twoApprovalsAbove: 2500,
      newPayee: { addressBy: "member", askedVia: null, confirmed: true, unanswered: false, twoParties: true },
      addressHistory: { workspacesPaid: 3, paymentsConfirmed: 7, priceUsdc: 0.01 },
      operatingBalance: 1500.25,
      addressUnconfirmed: false,
      addressMissing: false,
      documentPayTo: { present: true, differs: true },
      project: { state: "reserved", already: false, neededMinor: 40000, budgetMinor: 500000, bufferMinor: 0, reservedMinor: 40000, paidMinor: 0, availableMinor: 460000 },
      duplicateCheck: { candidatesConsidered: 6, matchesTotal: 1, matchesShown: 1 },
    });
    // Decided on 2026-10-14: scheduled for the 19th, the model asked for the 25th, set earlier for the 16th.
    expect(schedule.decision.payOnInDays).toBe(5);
    expect([schedule.timingRule, schedule.requestedPayOnInDays, schedule.scheduledForInDays]).toEqual(["payon.after_due", 11, 2]);
    expect(schedule.observed.documentPayTo).toEqual({ present: true, differs: false });
    expect(schedule.observed.newPayee).toEqual({ addressBy: "payee", askedVia: "payee_link", confirmed: false, unanswered: true, twoParties: false });
    expect(schedule.execution).toEqual({ resultingStatus: "scheduled", heldBecause: null });
    expect(hold).toMatchObject({ guardrailBlocked: true, guardrailRule: "counterparty.address_unconfirmed", verdict: null });
    expect(hold.observed).toMatchObject({ poPresent: false, addressUnconfirmed: true, documentPayTo: { present: false, differs: false }, projectId: null, project: null, sameWork: [] });
  });

  it("turns a named field that is not what it should be into null (SX3)", () => {
    const row = teamPay();
    const detail = row.detail as Record<string, unknown>;
    detail.guardrailRule = "Held because Acme Hosting Ltd asked for it";
    detail.decisionMode = { model: "secret" };
    (detail.observed as Record<string, unknown>).riskLevel = "high: on a list since 2026";
    (detail.observed as Record<string, unknown>).amount = "four hundred";
    const [decision] = exportShadowDecisions([row], [], READ_AT).decisions;
    expect([decision.guardrailRule, decision.decisionMode, decision.observed.riskLevel, decision.observed.amount]).toEqual([null, null, null, null]);
  });

  it("writes no text, name, reference, address, email, id, hash or ledger number anywhere (SX4)", () => {
    const json = JSON.stringify(exported());
    const secrets = [
      REASONING, POLICY_REASONING, PO_REFERENCE, "PO-7781", "INV-2207", "INV-2206", "Acme", "Northwind", TIMING_REASON, DUPLICATE_FINDING,
      SAME_WORK_FINDING, PROJECT_NAME, HISTORY_ABOUT, PRIORITY_REASON, "Historical evidence",
      ADDRESS_ON_FILE, ADDRESS_ON_FILE.toUpperCase().slice(2), DOCUMENT_PAY_TO, CONTRACT, AGENT_WALLET, TX_HASH, LIMIT_REF, FILE_SHA, FINGERPRINT,
      FOUNDING, TEAM, BILL_A, BILL_B, BILL_C, ACME, NORTHWIND, PROJECT, MILESTONE, MEMBER, OTHER_MEMBER, DOCUMENT_REQUEST,
      "5188", "5201", "5230", "5231", "5120", "5100", "2026-08-01", "2026-10-01",
    ];
    for (const secret of secrets) expect(json, secret).not.toContain(secret);
    expect(json).not.toMatch(/0x|@/);
    expect(() => assertShareable(exported())).not.toThrow();
  });
});

describe("assertShareable (shadow replay SX6)", () => {
  const broken = (change: (file: ShadowDecisionsFile) => void) => {
    const file = exported();
    change(file);
    return () => assertShareable(file);
  };

  it("refuses an address or hash, naming its path and never the value", () => {
    const check = broken((file) => {
      (file.decisions[1] as unknown as Record<string, unknown>).guardrailRule = DOCUMENT_PAY_TO;
    });
    expect(check).toThrow(/decisions\[1\]\.guardrailRule/);
    expect(check).not.toThrow(new RegExp(DOCUMENT_PAY_TO));
    expect(broken((file) => {
      file.decisions[0].execution.heldBecause = TX_HASH;
    })).toThrow(/decisions\[0\]\.execution\.heldBecause/);
  });

  it("refuses an email address, a UUID and a string longer than 40 characters", () => {
    expect(broken((file) => {
      file.decisions[2].observed.riskLevel = "ops@acme.example";
    })).toThrow(/decisions\[2\]\.observed\.riskLevel/);
    expect(broken((file) => {
      file.decisions[3].bill = BILL_B;
    })).toThrow(/decisions\[3\]\.bill/);
    expect(broken((file) => {
      file.decisions[1].observed.duplicateCheck!.matches[0].signals = ["x".repeat(41)];
    })).toThrow(/decisions\[1\]\.observed\.duplicateCheck\.matches\[0\]\.signals\[0\]/);
  });

  it("refuses a private key as well as a value, and a source that is not the export's own", () => {
    const keyed = broken((file) => {
      (file.decisions[0].observed as unknown as Record<string, unknown>)[ACME] = 1;
    });
    expect(keyed).toThrow(/decisions\[0\]\.observed/);
    expect(keyed).not.toThrow(new RegExp(ACME));
    expect(broken((file) => {
      file.source = `${SHADOW_DECISIONS_SOURCE} Acme Hosting Ltd`;
    })).toThrow(/source/);
  });
});

/** A pg client that answers the two reads from fixtures and records every query. */
class FakeClient implements ShadowExportClient {
  readonly queries: Array<{ text: string; params: unknown[] | undefined }> = [];

  constructor(
    private readonly entries: ShadowLedgerRow[],
    private readonly verdicts: ShadowVerdictRow[]
  ) {}

  async query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
    this.queries.push({ text, params });
    if (text.includes("from public.ledger_entries")) return { rows: this.entries };
    if (text.includes("from public.decision_verdicts")) return { rows: this.verdicts };
    return { rows: [] };
  }
}

const squash = (sql: string) => sql.replace(/\s+/g, " ").trim();

describe("runShadowExport (shadow replay SX2, SX7)", () => {
  it("reads in one read-only transaction, two reads, and writes nothing to the database", async () => {
    const client = new FakeClient([teamPay(), foundingHold()], VERDICTS);
    await runShadowExport({ client, write: () => {}, now: READ_AT });
    expect(client.queries.map((query) => squash(query.text).slice(0, 40))).toEqual([
      "begin transaction read only",
      squash(SHADOW_ENTRIES_SQL).slice(0, 40),
      squash(SHADOW_VERDICTS_SQL).slice(0, 40),
      "commit",
    ]);
    for (const { text } of client.queries) expect(text).not.toMatch(/\b(insert|update|delete|truncate|alter|drop|create|grant|revoke)\b/i);
  });

  it("filters to the team's own workspaces on Arc testnet, in shadow mode, with no fixture and no sample payee", async () => {
    const client = new FakeClient([], []);
    await runShadowExport({ client, write: () => {}, now: READ_AT });
    const entries = squash(client.queries[1].text);
    expect(entries).toContain("from public.ledger_entries e");
    expect(entries).toContain("join public.orgs o on o.id = e.org_id");
    expect(entries).toContain("(o.created_by is null or exists (select 1 from public.platform_team t where t.user_id = o.created_by))");
    expect(entries).toContain("e.detail->>'shadow' = 'true'");
    expect(entries).toContain("not (e.detail ? 'guardrailFixture')");
    expect(entries).toContain("join public.counterparties c on c.org_id = e.org_id and c.id::text = e.detail->>'counterpartyId'");
    expect(entries).toContain("not c.sample");
    expect(entries).toContain("o.network = 'arc-testnet'");
    expect(entries).toContain("e.actor = 'agent'");
    expect(entries).toContain("e.domain = 'ap'");
    expect(entries).toContain("e.action = any($1::text[])");
    expect(client.queries[1].params).toEqual([[...AGENT_DECISION_ACTIONS]]);
  });

  it("reads each kept decision's verdict, never its reason", async () => {
    const client = new FakeClient([teamPay(), foundingHold()], VERDICTS);
    await runShadowExport({ client, write: () => {}, now: READ_AT });
    const verdicts = squash(client.queries[2].text);
    expect(verdicts).toContain("select v.org_id, v.entry_seq, v.verdict from public.decision_verdicts v");
    expect(verdicts).toContain("v.entry_seq = any($1::bigint[])");
    expect(verdicts).not.toMatch(/reason|decided_by|\*/);
    expect(client.queries[2].params).toEqual([["5201", "5188"]]);
  });

  it("writes the file as 2-space JSON with LF and a trailing newline, and prints one line", async () => {
    const writes: Array<{ path: string; text: string }> = [];
    const client = new FakeClient([teamHoldOther(), teamPay(), teamScheduleAgain(), foundingHold(), fixture()], VERDICTS);
    const line = await runShadowExport({ client, write: (path, text) => void writes.push({ path, text }), now: READ_AT });
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe(SHADOW_DECISIONS_PATH);
    expect(SHADOW_DECISIONS_PATH).toBe("src/lib/quality-lab/shadow-decisions.json");
    expect(writes[0].text).toBe(`${JSON.stringify(exported(), null, 2)}\n`);
    expect(writes[0].text).not.toContain("\r");
    expect(line).toBe("4 shadow decisions from 2 workspaces: 1 agreed, 1 disagreed, 2 with no verdict. Wrote src/lib/quality-lab/shadow-decisions.json");
  });

  it("writes nothing when a customer's row comes back or the output looks private", async () => {
    const writes: string[] = [];
    const customer = new FakeClient([foundingHold(), { ...teamPay(), side: "customers" }], VERDICTS);
    await expect(runShadowExport({ client: customer, write: (path) => void writes.push(path), now: READ_AT })).rejects.toThrow(/customer/);
    // A UUID is shaped like a token, so it passes the allowlist's check of a token field; the refusal still stops it.
    const row = teamPay();
    (row.detail as Record<string, unknown>).decisionMode = "d5f3a2b1-4c6e-4f80-9a1b-2c3d4e5f6a7b";
    const tokenLike = new FakeClient([row], []);
    await expect(runShadowExport({ client: tokenLike, write: (path) => void writes.push(path), now: READ_AT })).rejects.toThrow(/decisions\[0\]\.decisionMode/);
    expect(writes).toEqual([]);
  });
});

/** The real query on the real schema (PGlite with every migration): what it keeps, and what it never reads (SX1, SX2). */
describe("the export's read on the migrated schema (SX1, SX2)", () => {
  let db: PGlite;
  let file: ShadowDecisionsFile;
  let line: string;

  async function org(slug: string, createdBy: string | null, network = "arc-testnet"): Promise<string> {
    const result = await db.query<{ id: string }>(
      "insert into public.orgs (slug, name, mode, created_by, created_at, network) values ($1, $1, 'live', $2, '2026-09-20T00:00:00Z', $3) returning id",
      [slug, createdBy, network]
    );
    return result.rows[0].id;
  }

  async function payee(orgId: string, name: string, sample = false): Promise<string> {
    const result = await db.query<{ id: string }>(
      "insert into public.counterparties (org_id, name, role, sample, address) values ($1, $2, 'vendor', $3, $4) returning id",
      [orgId, name, sample, ADDRESS_ON_FILE]
    );
    return result.rows[0].id;
  }

  async function entry(orgId: string, at: string, action: string, detail: object, domain = "ap"): Promise<number> {
    const result = await db.query<{ seq: number | string }>(
      `insert into public.ledger_entries (org_id, ts, actor, domain, action, summary, detail, body_hash, signature, prev_hash, hash)
       values ($1, $2, 'agent', $3, $4, $4, $5, 'b', 's', 'p', gen_random_uuid()::text) returning seq`,
      [orgId, at, domain, action, JSON.stringify(detail)]
    );
    return Number(result.rows[0].seq);
  }

  async function verdict(orgId: string, seq: number, given: "agree" | "disagree"): Promise<void> {
    await db.query(
      "insert into public.decision_verdicts (org_id, entry_seq, subject, subject_id, agent_action, verdict, reason) values ($1, $2, 'invoice', gen_random_uuid(), 'ap_pay', $3, 'A reason the person wrote about Acme')",
      [orgId, seq, given]
    );
  }

  const decisionOn = (counterpartyId: string, amount: number, extra: Record<string, unknown> = {}) => ({
    invoiceId: crypto.randomUUID(),
    counterpartyId,
    decision: { action: "pay", payOn: null, reasoning: REASONING, confidence: 0.9 },
    shadow: true,
    observed: { amount },
    execution: { resultingStatus: "held", heldBecause: "shadow_verdict" },
    ...extra,
  });

  beforeAll(async () => {
    db = await createDatabase();
    await applyMigrations(db);
    const team = await createUser(db, "team@vestiarion.test");
    await db.query("select public.set_platform_team_member('team@vestiarion.test', true)");
    const owner = await createUser(db, "owner@customer.test");

    const ours = await org("team-shop", team);
    const customer = await org("customer-shop", owner);
    const ourMainnet = await org("team-mainnet", team, "arc-mainnet");

    const foundingVendor = await payee(FOUNDING_ORG_ID, "Founding vendor");
    const ourVendor = await payee(ours, "Our vendor");
    const ourSample = await payee(ours, "Sample vendor", true);
    const customerVendor = await payee(customer, "Customer vendor");
    const mainnetVendor = await payee(ourMainnet, "Mainnet vendor");

    // Kept: the founding workspace's and the team's own shadow decisions.
    await entry(FOUNDING_ORG_ID, "2026-10-11T10:00:00Z", "ap_hold", { ...decisionOn(foundingVendor, 101), decision: { action: "hold", reasoning: REASONING, confidence: 0.7 } });
    const kept = await entry(ours, "2026-10-12T10:00:00Z", "ap_pay", decisionOn(ourVendor, 102));
    await verdict(ours, kept, "agree");
    // Left out: a sample payee, a live decision, the guardrail fixture, a treasury entry, a customer's, and Arc mainnet.
    await entry(ours, "2026-10-12T11:00:00Z", "ap_pay", decisionOn(ourSample, 103));
    await entry(ours, "2026-10-12T12:00:00Z", "ap_pay", { ...decisionOn(ourVendor, 104), shadow: undefined });
    await entry(ours, "2026-10-12T13:00:00Z", "ap_pay", decisionOn(ourVendor, 105, { guardrailFixture: true }));
    await entry(ours, "2026-10-12T14:00:00Z", "treasury_sweep", decisionOn(ourVendor, 106), "treasury");
    const customers = await entry(customer, "2026-10-12T15:00:00Z", "ap_pay", decisionOn(customerVendor, 777));
    await verdict(customer, customers, "disagree");
    await entry(ourMainnet, "2026-10-12T16:00:00Z", "ap_pay", decisionOn(mainnetVendor, 108));

    const writes: string[] = [];
    line = await runShadowExport({ client: { query: (text, params) => db.query(text, params) }, write: (_path, text) => void writes.push(text), now: READ_AT });
    file = JSON.parse(writes[0]) as ShadowDecisionsFile;
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it("keeps only the founding workspace's and the team's shadow decisions on Arc testnet", () => {
    expect(file.decisions.map((decision) => [decision.id, decision.workspace, decision.decision.action, decision.observed.amount, decision.verdict])).toEqual([
      ["shadow-01", "w1", "hold", 101, null],
      ["shadow-02", "w2", "pay", 102, "agree"],
    ]);
    expect(line).toBe("2 shadow decisions from 2 workspaces: 1 agreed, 0 disagreed, 1 with no verdict. Wrote src/lib/quality-lab/shadow-decisions.json");
  });

  it("never carries a customer's decision, its verdict, or any verdict's reason", () => {
    const json = JSON.stringify(file);
    expect(json).not.toContain("777");
    expect(json).not.toContain("disagree");
    expect(json).not.toContain("A reason the person wrote");
  });
});
