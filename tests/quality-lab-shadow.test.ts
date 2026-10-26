import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ObligationGate } from "@/lib/agent/obligation-gate";
import { onChainLimitGate, type OnChainLimitGate } from "@/lib/agent/onchain-limit";
import type { NewPayeeFacts } from "@/lib/new-payee-facts";
import file from "@/lib/quality-lab/shadow-decisions.json";
import { ATTACKER_ADDRESS, LAB_ADDRESS_ON_FILE, OFAC_LISTED_ADDRESS } from "@/lib/quality-lab/scenarios";
import { exportShadowDecisions, type ShadowAction, type ShadowDecision, type ShadowDecisionsFile } from "@/lib/quality-lab/shadow-export";
import {
  amountDue,
  dayAfter,
  planReplay,
  renderReplay,
  replayResult,
  replayWorld,
  summarizeReplay,
  variantsOf,
  type ShadowOutcome,
  type ShadowReplayPlan,
  type ShadowReplayResult,
  type ShadowReplayRun,
  type ShadowReplayWorld,
  type ShadowVariant,
} from "@/lib/quality-lab/shadow-replay";
import { replayClassWords, replayOutcomeWords } from "@/lib/quality-lab/words";
import type { SpendingLimitVerdict } from "@/lib/spending-limit/onchain";
import { apHarness, invoiceWrites, LAB_ORG, LabChain, ledgerEntries, scriptModel, today } from "./support/ap-harness";

/**
 * The replay of the team's shadow-mode decisions (docs/superpowers/specs/2026-10-26-quality-lab-shadow-replay-design.md
 * SR1-SR9): every decision in src/lib/quality-lab/shadow-decisions.json, rebuilt from its record as a world of its own
 * and run once through the real AP stage over the lab's harness, live, with the model answering as recorded. A fact the
 * record does not carry is run both ways (SR4). Transfers are counted from the provider, never inferred from a status.
 *
 * - Any wrong payment fails its decision's test, naming it (SR7).
 * - Every run's own entry must record the facts it was rebuilt from (SR8), and a decision rebuilt for each rule the
 *   record carries must come back the same, with that rule.
 * - The committed results (src/lib/data/quality-lab-shadow.json) must equal this run; with QUALITY_LAB_WRITE=1 the run
 *   writes them instead (`npm run quality-lab`).
 */

const { decideMock } = vi.hoisted(() => ({ decideMock: vi.fn() }));
vi.mock("@/lib/agent/decide", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/decide")>()),
  decide: decideMock,
}));

const { world: labWorld } = apHarness();

// A hook that returned the mock would be called as its teardown.
beforeEach(() => {
  decideMock.mockReset();
});
afterEach(() => vi.useRealTimers());

const DECISIONS = (file as unknown as ShadowDecisionsFile).decisions;
const RESULTS_FILE = path.join(process.cwd(), "src", "lib", "data", "quality-lab-shadow.json");
const STALE = "run npm run quality-lab and commit src/lib/data/quality-lab-shadow.json";

const BILL_ID = "018f8ce0-1557-7b54-a931-4d777f6bd001";
const PAYEE_ID = "018f8ce0-1557-7b54-a931-4d777f6bd002";
const OTHER_PAYEE_ID = "018f8ce0-1557-7b54-a931-4d777f6bd003";
const TWIN_ID = "018f8ce0-1557-7b54-a931-4d777f6bd004";
const PROJECT_ID = "018f8ce0-1557-7b54-a931-4d777f6bd005";
const LIMIT = { contract: "0x11a1700000000000000000000000000000001111", agentWalletId: "wallet-agent", agentAddress: "0xA9e7000000000000000000000000000000000A9e" };
const HOUR = 3_600_000;

const round6 = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

/** The address the world's payee has on file, if any. */
function addressOf(world: ShadowReplayWorld): string | null {
  return world.payee.address === "lab" ? LAB_ADDRESS_ON_FILE : world.payee.address === "sanctioned" ? OFAC_LISTED_ADDRESS : null;
}

/** The world as rows: the bill with its payee nested, what else falls due by its day, and a paid bill it repeats. */
function rowsOf(world: ShadowReplayWorld) {
  const now = Date.parse(world.now);
  const day = world.now.slice(0, 10);
  const dayIn = (days: number) => dayAfter(day, days);
  const ago = (hours: number) => new Date(now - hours * HOUR).toISOString();
  const address = addressOf(world);
  const { payee, bill } = world;
  const payeeRow = {
    id: PAYEE_ID, name: "Replayed payee", role: payee.role, risk_level: payee.riskLevel,
    payment_limit: payee.paymentLimit === null ? null : String(payee.paymentLimit), performance_score: null, performance_inputs: null,
    address, address_changed_at: payee.addressChangedHoursAgo === null ? null : ago(payee.addressChangedHoursAgo),
    address_confirmed_at: payee.addressConfirmedHoursAgo === null ? null : ago(payee.addressConfirmedHoursAgo),
    chain: null, purchase_order_required: payee.purchaseOrderRequired,
  };
  const scheduled = bill.scheduledForInDays !== null;
  const billRow: Record<string, unknown> = {
    id: BILL_ID, direction: "payable", status: scheduled ? "scheduled" : "pending", amount: String(bill.amount), currency: "USDC",
    memo: "Replayed shadow decision", po_reference: bill.poPresent ? "PO-SHADOW" : null, goods_received: bill.goodsReceived,
    due_date: `${dayIn(bill.dueInDays)}T12:00:00+00:00`, counterparty_id: PAYEE_ID,
    agent_reasoning: scheduled ? "Scheduled by an earlier cycle." : null, tx_ref: null, decided_at: scheduled ? ago(24) : null,
    scheduled_for: scheduled ? `${dayIn(bill.scheduledForInDays!)}T00:00:00+00:00` : null, paid_amount: null,
    early_pay_discount_pct: bill.discount ? bill.discount.percent.toFixed(2) : null,
    discount_due_date: bill.discount ? `${dayIn(bill.discount.deadlineInDays)}T12:00:00+00:00` : null,
    late_fee_kind: bill.lateFee?.kind ?? null, late_fee_value: bill.lateFee ? String(bill.lateFee.value) : null,
    late_fee_starts_on: bill.lateFee ? dayIn(bill.lateFee.startsOnInDays) : null,
    document_pay_to: bill.documentPayTo === "other" ? ATTACKER_ADDRESS : bill.documentPayTo === "on_file" ? address : null,
    project_id: bill.inProject ? PROJECT_ID : null, created_at: ago(48), recurring_payables: null, counterparties: payeeRow,
  };
  // What else falls due by its day (SR2): held bills to another payee, which the stage counts and never decides.
  const otherPayee = { ...payeeRow, id: OTHER_PAYEE_ID, name: "Another payee", address: "0x7a0c3e5b9d1f2a4c6e8b0d2f4a6c8e0b2d4f6a8c", address_changed_at: null, address_confirmed_at: null };
  const { total, count } = world.earlierObligations;
  const bills = total > 0 ? Math.max(count, 1) : count;
  const share = bills > 0 ? round6(total / bills) : 0;
  const others = Array.from({ length: bills }, (_, index) => ({
    ...billRow, id: `018f8ce0-1557-7b54-a931-4d777f6be${String(index).padStart(3, "0")}`, status: "held",
    amount: String(index < bills - 1 ? share : round6(total - share * (bills - 1))), memo: `Another bill ${index + 1}`, po_reference: null,
    goods_received: true, due_date: `${dayIn(0)}T12:00:00+00:00`, counterparty_id: OTHER_PAYEE_ID, agent_reasoning: null, decided_at: ago(30),
    scheduled_for: null, early_pay_discount_pct: null, discount_due_date: null, late_fee_kind: null, late_fee_value: null, late_fee_starts_on: null,
    document_pay_to: null, project_id: null, created_at: ago(72 + index), counterparties: otherPayee,
  }));
  // A paid bill with its purchase order and amount, which the real duplicate check refuses it against.
  const twin = bill.repeatsPaidBill
    ? [{ ...billRow, id: TWIN_ID, status: "paid", due_date: `${dayIn(-40)}T12:00:00+00:00`, decided_at: ago(40 * 24), created_at: ago(41 * 24), tx_ref: "0xpaid", paid_amount: String(bill.amount), scheduled_for: null, document_pay_to: null }]
    : [];
  return { bill: billRow, book: [...twin, ...others, billRow], address };
}

/** The new payee check's facts that give the recorded answer (SR2): ledger entries newest first, and where it was paid. */
function newPayeeFacts(world: ShadowReplayWorld, address: string | null): NewPayeeFacts {
  if (!address) return { paidTo: new Map(), entries: new Map() };
  const first = world.payee.firstPayment;
  const giver = "member-anna";
  const other = "member-bao";
  if (!first) {
    const added = { action: "create_counterparty", detail: { by: giver, counterpartyId: PAYEE_ID, address } };
    return { paidTo: new Map([[PAYEE_ID, new Set([address.toLowerCase()])]]), entries: new Map([[PAYEE_ID, [added]]]) };
  }
  const entries: Array<{ action: string; detail: Record<string, unknown> }> = [];
  let set: { action: string; detail: Record<string, unknown> };
  let asked: { action: string; detail: Record<string, unknown> } | null = null;
  if (first.addressBy === "mirror") {
    set = { action: "create_counterparty", detail: { by: null, via: "mirror", counterpartyId: PAYEE_ID, address } };
  } else if (first.addressBy === "payee" && first.askedVia === "payee_link") {
    set = { action: "counterparty_address_changed", detail: { by: null, via: "payee_link", linkId: "link-1", counterpartyId: PAYEE_ID, to: address } };
    asked = { action: "payee_link_created", detail: { by: giver, linkId: "link-1", counterpartyId: PAYEE_ID } };
  } else if (first.addressBy === "payee" && first.askedVia === "github") {
    set = { action: "create_counterparty", detail: { by: giver, via: "github", counterpartyId: PAYEE_ID, address } };
  } else {
    const by = first.addressBy === "member" ? giver : null;
    set = first.unanswered
      ? { action: "counterparty_address_changed", detail: { by, counterpartyId: PAYEE_ID, to: address } }
      : { action: "create_counterparty", detail: { by, counterpartyId: PAYEE_ID, address } };
  }
  if (first.confirmed) {
    // A second party confirms it only when the record says two stood behind it; otherwise whoever gave it, or a member.
    const by = first.twoParties || first.addressBy === null || first.unanswered ? other : giver;
    entries.push({ action: "counterparty_address_confirmed", detail: { by, counterpartyId: PAYEE_ID, address } });
  }
  entries.push(set);
  if (asked) entries.push(asked);
  return { paidTo: new Map(), entries: new Map([[PAYEE_ID, entries]]) };
}

/** The spending limit contract's verdict on Arc, as recorded: none enforced, or one it answers as the record says. */
function contractOf(world: ShadowReplayWorld): OnChainLimitGate {
  const recorded = world.workspace.contract;
  if (!recorded) return onChainLimitGate({ read: async () => null });
  const verdict: SpendingLimitVerdict =
    recorded.state === "refused"
      ? ({ state: "refused", error: recorded.error, spent: recorded.spent ?? 0, amount: recorded.amount ?? 0, limit: recorded.limit ?? 0 } as SpendingLimitVerdict)
      : recorded.state === "allowed"
        ? { state: "allowed" }
        : { state: "unreadable", reason: "The contract could not be read." };
  return onChainLimitGate({ read: async () => LIMIT, verdict: async () => verdict });
}

/** The checks after the guardrails, as recorded: the same work, and the project's answer. */
function obligationsOf(world: ShadowReplayWorld): ObligationGate {
  return {
    sameWork: () =>
      world.sameWork.map((match, index) => ({
        otherKind: match.otherKind, otherId: `018f8ce0-1557-7b54-a931-4d777f6bf${String(index).padStart(3, "0")}`, otherLabel: "Earlier work",
        otherStatus: match.otherStatus, signal: match.signal, reference: "PO-SHADOW",
        explanation: match.signal === "purchase_order" ? "An earlier milestone names the same purchase order." : "An earlier milestone delivered the same work.",
      })),
    reserve: async (_subject, projectId) => {
      const project = world.project;
      if (!projectId || !project) return null;
      if (project.state === "unreadable") return { state: "unreadable", projectId };
      const figures = {
        projectId, projectName: "Replayed project", neededMinor: project.neededMinor, budgetMinor: project.budgetMinor, bufferMinor: project.bufferMinor,
        reservedMinor: project.reservedMinor, paidMinor: project.paidMinor, availableMinor: project.availableMinor,
      };
      return project.state === "reserved" ? { state: "reserved", figures, already: project.already } : { state: project.state, figures };
    },
  };
}

interface Replayed {
  run: ShadowReplayRun;
  world: ShadowReplayWorld;
  entry: { action: string; detail: Record<string, unknown> };
  address: string | null;
  sent: number;
}

/** One replay of a decision, its unknown facts as `variant` says (SR1, SR2, SR5). */
async function replayOnce(decision: ShadowDecision, variant: ShadowVariant): Promise<Replayed> {
  const world = replayWorld(decision, variant);
  const { bill, book, address } = rowsOf(world);
  const chain = new LabChain();
  const { fake, stage } = labWorld({
    book,
    chain,
    payeeLock: world.workspace.payeeLock,
    twoApprovals: world.workspace.twoApprovalsAbove ?? undefined,
    newPayee: newPayeeFacts(world, address),
    vendorDocuments: world.bill.vendorDocument ? [BILL_ID] : [],
    onChainLimit: contractOf(world),
    spendingLimitRoom: world.workspace.spendingLimit,
    obligations: obligationsOf(world),
    reserveApy: world.workspace.reserveApy,
  });
  const { action, payOnInDays, fundWithSwap, confidence } = world.answer;
  const day = world.now.slice(0, 10);
  scriptModel(decideMock, () => ({
    action,
    // A schedule's day the record could not read is sent as one the model wrote that code cannot read either.
    payOn: action === "schedule" ? (payOnInDays === null ? "on the usual day" : dayAfter(day, payOnInDays)) : null,
    fundWithSwap,
    reasoning: "Replayed as the shadow decision recorded it.",
    confidence,
  }));

  today(world.now);
  await stage(world.workspace.operatingBalance);

  const entry = ledgerEntries(fake.requests)
    .filter((one) => one.detail.invoiceId === BILL_ID && one.action.startsWith("ap_"))
    .at(-1);
  if (!entry) throw new Error(`the replay of ${decision.id} decided nothing`);
  const scheduled = invoiceWrites(fake.requests, BILL_ID).some((write) => write.status === "scheduled") || bill.status === "scheduled";
  const detail = entry.detail as { guardrailBlocked?: boolean; guardrailRule?: string | null };
  const outcome: ShadowOutcome = {
    action: entry.action.slice("ap_".length) as ShadowAction,
    rule: detail.guardrailBlocked === true ? (detail.guardrailRule ?? null) : null,
    money: chain.sent.length > 0 || scheduled ? "moves" : "stops",
  };
  const due = amountDue(world);
  const transfersRight =
    chain.sent.length <= 1 &&
    chain.sent.every((transfer) => address !== null && transfer.toAddress.toLowerCase() === address.toLowerCase() && Math.abs(transfer.amount - due) < 0.0000005);
  return { run: { variant, outcome, transfersRight }, world, entry, address, sent: chain.sent.length };
}

/** The replay's own entry, mapped as the export maps a recorded one. */
function asExported(replayed: Replayed): ShadowDecision {
  const { world, entry, address } = replayed;
  const [mapped] = exportShadowDecisions(
    [
      {
        seq: 1, ts: world.now, org_id: LAB_ORG, action: entry.action, side: "team", detail: { ...entry.detail, shadow: true },
        address_on_file: address, address_changed_since: false, address_changed_hours_before: null, payee_role: world.payee.role,
        payee_lock_on: world.workspace.payeeLock.on, payee_lock_cooling_hours: world.workspace.payeeLock.hours,
      },
    ],
    [],
    new Date(world.now)
  ).decisions;
  return mapped;
}

/** The facts the world was rebuilt from must come back as recorded (SR8); a fact the record lacks is not compared. */
function expectRebuilt(decision: ShadowDecision, plan: ShadowReplayPlan, replayed: Replayed) {
  const again = asExported(replayed);
  const facts: Array<[string, unknown, unknown]> = [
    ["the amount", decision.observed.amount, again.observed.amount],
    ["the payment limit", decision.observed.paymentLimit, again.observed.paymentLimit],
    ["the risk level", decision.observed.riskLevel, again.observed.riskLevel],
    ["the purchase order", decision.observed.poPresent, again.observed.poPresent],
    ["the goods received", decision.observed.goodsReceived, again.observed.goodsReceived],
    ["whether a purchase order is needed", decision.observed.purchaseOrderRequired, again.observed.purchaseOrderRequired],
    ["the two-approvals figure", decision.observed.twoApprovalsAbove, again.observed.twoApprovalsAbove],
    ["whether the address is missing", decision.observed.addressMissing, again.observed.addressMissing],
    ["whether the address is unconfirmed", decision.observed.addressUnconfirmed, again.observed.addressUnconfirmed],
    ["the document's pay-to", decision.observed.documentPayTo.present, again.observed.documentPayTo.present],
    ["the new payee check", decision.observed.newPayee, again.observed.newPayee],
    ["the due day", decision.timing?.dueInDays, again.timing?.dueInDays],
    ["the terms", decision.terms, again.terms],
    ["what fell due besides it", decision.timing?.earlierObligations, again.timing?.earlierObligations],
    ["the vendor's document", decision.vendorDocument !== null, again.vendorDocument !== null],
  ];
  if (replayed.world.bill.scheduledForInDays !== null) facts.push(["the day it was scheduled for", decision.scheduledForInDays, again.scheduledForInDays]);
  // What the operating wallet held, before anything moved.
  if (replayed.sent === 0) facts.push(["the operating balance", decision.observed.operatingBalance, again.observed.operatingBalance]);
  // The spending limits as recorded, when the replay read them where the decision did.
  if (!plan.unknowns.some((unknown) => unknown.fact === "spending_limits") && again.decision.action === decision.decision.action) {
    facts.push(["the spending limit", decision.outflowBudget, again.outflowBudget]);
    facts.push(["the contract's verdict", decision.onChainLimit?.verdict?.state ?? null, again.onChainLimit?.verdict?.state ?? null]);
  }
  for (const [name, recorded, rebuilt] of facts) {
    if (recorded === null || recorded === undefined) continue;
    expect(rebuilt, `the replay of ${decision.id} did not rebuild ${name}`).toEqual(recorded);
  }
}

/** Every replay of a decision, judged (SR4-SR7). */
async function replayDecision(decision: ShadowDecision): Promise<ShadowReplayResult> {
  const plan = planReplay(decision);
  const runs: ShadowReplayRun[] = [];
  if (plan.unsupported === null) {
    for (const variant of variantsOf(plan.unknowns)) {
      const replayed = await replayOnce(decision, variant);
      expectRebuilt(decision, plan, replayed);
      runs.push(replayed.run);
    }
  }
  return replayResult(decision, plan, runs);
}

const results = new Map<string, ShadowReplayResult>();

describe("the team's shadow decisions, replayed through today's decision code (shadow replay SR1-SR8)", () => {
  for (const decision of DECISIONS) {
    it(`${decision.id}: makes no wrong payment`, { timeout: 30_000 }, async () => {
      const result = await replayDecision(decision);
      results.set(decision.id, result);
      expect(result.wrongPayment, `wrong payment in ${decision.id}: now ${replayOutcomeWords(result.now)}; ${replayClassWords(result)}`).toBe(false);
    });
  }
});

/** Moves a copy to a day after the same-work check was added (SX10.7), so its entry records that check's answer. */
function sinceSameWork(copy: ShadowDecision) {
  copy.decidedAt = "2026-10-20T03:00:00.000Z";
  copy.decidedOn = "2026-10-20";
}

/**
 * A real decision, changed into one stopped then by `rule` (or let through), as a record of it would read: made after
 * the same-work check was added, so that rule's is the only outcome it can have.
 */
function rebuiltFor(rule: string | null, change: (copy: ShadowDecision) => void): ShadowDecision {
  const copy = structuredClone(DECISIONS.find((one) => one.id === "shadow-01")!);
  copy.id = `shadow-${rule ?? "let-through"}`;
  sinceSameWork(copy);
  copy.guardrailBlocked = rule !== null;
  copy.guardrailRule = rule;
  change(copy);
  return copy;
}

/**
 * The rebuild held to every rule the record carries (SR8): a pay built from a real one for each, which the replay must
 * bring back the same, with that rule. None of these is in the committed file.
 */
describe("the replay rebuilds each rule the record carries (SR2, SR8)", () => {
  const cases: Array<[string, (copy: ShadowDecision) => void]> = [
    ["counterparty.high_risk", (copy) => void (copy.observed.riskLevel = "high")],
    ["counterparty.unscreened", (copy) => void (copy.observed.riskLevel = "unscreened")],
    ["counterparty.client_payable", (copy) => void (copy.payeeOnFile.role = "client")],
    ["counterparty.no_address", (copy) => void (copy.observed.addressMissing = true)],
    [
      "counterparty.address_unconfirmed",
      (copy) => {
        copy.observed.addressUnconfirmed = true;
        copy.payeeOnFile = { role: "vendor", addressChangedHoursBefore: 2, addressChangedSinceDecision: false };
      },
    ],
    [
      "counterparty.cooling_off",
      (copy) => {
        copy.payeeLock = { on: true, coolingHours: 24 };
        copy.payeeOnFile = { role: "vendor", addressChangedHoursBefore: 3, addressChangedSinceDecision: false };
      },
    ],
    ["invoice.pay_to_differs", (copy) => void (copy.observed.documentPayTo = { present: true, differs: true })],
    ["invoice.match_incomplete", (copy) => void (copy.observed.poPresent = false)],
    [
      "counterparty.new_payee",
      (copy) => void (copy.observed.newPayee = { addressBy: "member", askedVia: null, confirmed: false, unanswered: false, twoParties: false }),
    ],
    ["counterparty.payment_limit", (copy) => void (copy.observed.paymentLimit = 2)],
    ["workspace.two_approvals", (copy) => void (copy.observed.twoApprovalsAbove = 1)],
    [
      "workspace.outflow_budget",
      (copy) => void (copy.outflowBudget = { dailyUsdc: 1, weeklyUsdc: null, spentToday: 0, spentThisWeek: 0, remaining: 1, binding: "day" }),
    ],
    [
      "workspace.onchain_limit",
      (copy) => void (copy.onChainLimit = { covered: true, uncoveredBecause: null, verdict: { state: "refused", error: "OverDailyLimit", spent: 1, amount: 4.5, limit: 2 } }),
    ],
    [
      "invoice.duplicate_of_settled",
      (copy) =>
        void (copy.observed.duplicateCheck = {
          candidatesConsidered: 1, matchesTotal: 1, matchesShown: 1,
          matches: [{ otherBill: "b99", otherInvoiceStatus: "paid", confidence: 0.95, signals: ["same_purchase_order", "same_amount"] }],
        }),
    ],
    ["invoice.vendor_document", (copy) => void (copy.vendorDocument = "vendor")],
    ["obligation.duplicate_reference", (copy) => void (copy.observed.sameWork = [{ otherKind: "milestone", other: "m1", otherStatus: "verified", signal: "purchase_order" }])],
    [
      "project.budget_exceeded",
      (copy) => {
        copy.observed.projectId = "pj1";
        copy.observed.project = { state: "over", already: null, neededMinor: 4_500_000, budgetMinor: 1_000_000, bufferMinor: 0, reservedMinor: 0, paidMinor: 0, availableMinor: 1_000_000 };
      },
    ],
  ];

  it.each(cases)("brings back a decision stopped by %s the same", { timeout: 30_000 }, async (rule, change) => {
    const result = await replayDecision(rebuiltFor(rule, change));
    expect(result).toMatchObject({ class: "same", wrongPayment: false, now: { rule, money: "stops" } });
  });

  it("brings back a payee held as high risk while screened clear: its address was on OFAC's list (SX10.1)", { timeout: 30_000 }, async () => {
    const listed = rebuiltFor("counterparty.high_risk", () => {});
    expect(replayWorld(listed).payee.address).toBe("sanctioned");
    expect(await replayDecision(listed)).toMatchObject({ class: "same", wrongPayment: false, now: { rule: "counterparty.high_risk", money: "stops" } });
  });

  it("brings back a clean pay let through, sending once, to the address on file, for the bill", { timeout: 30_000 }, async () => {
    const replayed = await replayOnce(rebuiltFor(null, () => {}), {});
    expect(replayed.run).toEqual({ variant: {}, outcome: { action: "pay", rule: null, money: "moves" }, transfersRight: true });
    expect(replayed.sent).toBe(1);
  });

  it("shows a rule that stops now what code let through then as now stopped, and no wrong payment", { timeout: 30_000 }, async () => {
    const stoppedNow = rebuiltFor(null, (copy) => {
      copy.observed.newPayee = { addressBy: "member", askedVia: null, confirmed: false, unanswered: false, twoParties: false };
    });
    expect(await replayDecision(stoppedNow)).toMatchObject({ class: "now_stopped", wrongPayment: false, now: { rule: "counterparty.new_payee", money: "stops" } });
  });

  it("fails as a wrong payment money that moves, one way the record does not rule out, where code stopped it then (shadow-43)", { timeout: 30_000 }, async () => {
    // shadow-43 was stopped then by the new payee check, and its payee's address changed again since, so the payee
    // lock's wait is run both ways. Code weighs the wait before the new payee check, so the way past the wait is the
    // record's own. Given facts the new payee check lets through, as a check broken since would, that way pays.
    const copy = structuredClone(DECISIONS.find((one) => one.id === "shadow-43")!);
    expect(copy.guardrailRule).toBe("counterparty.new_payee");
    copy.id = "shadow-43-new-payee-passes";
    copy.observed.newPayee = null;
    const result = await replayDecision(copy);
    expect(result).toMatchObject({ class: "cannot_rebuild", now: null, wrongPayment: true });
    expect(result.reason).toContain("Money moves one way and not the other.");
  });

  it("fails as a wrong payment money that moves now where code stopped it then", { timeout: 30_000 }, async () => {
    const letThrough = rebuiltFor("counterparty.payment_limit", () => {});
    expect(await replayDecision(letThrough)).toMatchObject({ class: "now_let_through", wrongPayment: true, now: { rule: null, money: "moves" } });
  });

  it("cannot rebuild a payment let through before the same-work check existed: an earlier milestone for the same work would hold it now (SX10.7)", { timeout: 30_000 }, async () => {
    const shadow01 = DECISIONS.find((one) => one.id === "shadow-01")!;
    expect(shadow01.decidedAt < "2026-10-13T07:31:00.000Z").toBe(true);
    const held = await replayOnce(shadow01, { same_work: "stops" });
    expect(held.run.outcome).toEqual({ action: "pay", rule: "obligation.duplicate_reference", money: "stops" });
    expect(held.sent).toBe(0);
    const result = await replayDecision(shadow01);
    expect(result).toMatchObject({ class: "cannot_rebuild", now: null, wrongPayment: false });
    expect(result.reason).toMatch(/^It was decided on or before Oct 13, 2026, the day the check for an earlier milestone .* Money moves one way and not the other\.$/);
  });

  it("cannot rebuild a schedule whose project's answer is not in the record, naming only that", { timeout: 30_000 }, async () => {
    const copy = structuredClone(DECISIONS.find((one) => one.id === "shadow-24")!);
    sinceSameWork(copy);
    copy.observed.projectId = "pj1";
    const result = await replayDecision(copy);
    expect(result).toMatchObject({
      class: "cannot_rebuild",
      now: null,
      reason: "The decision did not reach its project's budget, so what the project had left is not in the record. Money moves one way and not the other.",
    });
  });
});

describe("the replay's committed results (SR9)", () => {
  it("are this run's, decision for decision", () => {
    expect([...results.keys()], "every decision ran").toEqual(DECISIONS.map((one) => one.id));
    const run = DECISIONS.map((one) => results.get(one.id)!);
    const rendered = renderReplay(run);
    if (process.env.QUALITY_LAB_WRITE === "1") {
      // A wrong payment is a finding to fix, never a result to publish (SR7): the file is not written while there is one.
      expect(summarizeReplay(run).wrongPayments, "a wrong payment in the replay: src/lib/data/quality-lab-shadow.json is not written").toBe(0);
      writeFileSync(RESULTS_FILE, rendered);
      return;
    }
    expect(readFileSync(RESULTS_FILE, "utf8").replace(/\r\n/g, "\n"), STALE).toBe(rendered);
  });

  it("publish no wrong payment, and count each decision once", () => {
    const { summary } = JSON.parse(readFileSync(RESULTS_FILE, "utf8")) as { summary: ReturnType<typeof summarizeReplay> };
    expect(summary.wrongPayments).toBe(0);
    expect(summary.same + summary.nowStopped + summary.nowLetThrough + summary.cannotRebuild + summary.wrongPayments).toBe(summary.decisions);
  });
});
