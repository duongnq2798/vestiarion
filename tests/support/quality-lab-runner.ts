import type { Mock } from "vitest";
import { onChainLimitGate, type OnChainLimitGate } from "@/lib/agent/onchain-limit";
import type { NewPayeeFacts } from "@/lib/new-payee-facts";
import { judgeScenario, type QualityLabOutcome, type QualityLabRun, type QualityLabVerdict } from "@/lib/quality-lab/judge";
import { LAB_ADDRESS_ON_FILE, QUALITY_LAB_TODAY, type QualityLabScenario } from "@/lib/quality-lab/scenarios";
import { invoiceWrites, LabChain, ledgerEntries, scriptModel, today, type apHarness } from "./ap-harness";

/**
 * Runs one Quality Lab scenario through the real AP stage (docs/superpowers/specs/2026-10-26-quality-lab-design.md QL1,
 * QL4): its workspace, payee and bill built from the scenario's data, every cycle it asks for, and what the provider
 * took. Shared by tests/quality-lab.test.ts, which judges every scenario and writes the results, and
 * tests/quality-lab-earned.test.ts, which runs each scenario again as a shadow-mode workspace whose owner lets the agent
 * pay earned vendors on their own (docs/superpowers/specs/2026-10-28-earned-vendors-design.md AL23, AL30).
 *
 * The test file calls `apHarness()` at its top, so the signing hooks register there, and hands in its `world` and the
 * model it mocked.
 */

const BILL_ID = "018f8ce0-1557-7b54-a931-4d777f6bc001";
const TWIN_ID = "018f8ce0-1557-7b54-a931-4d777f6bc002";
export const LAB_PAYEE_ID = "018f8ce0-1557-7b54-a931-4d777f6bc003";
const MILESTONE_ID = "018f8ce0-1557-7b54-a931-4d777f6bc004";
/** Where a payee whose address changed was paid before. */
const EARLIER_ADDRESS = "0x2c4e6a8b0d1f3e5a7c9b1d3f5e7a9c0b2d4f6e81";
const LIMIT = { contract: "0x11a1700000000000000000000000000000001111", agentWalletId: "wallet-agent", agentAddress: "0xA9e7000000000000000000000000000000000A9e" };

const NOW = Date.parse(QUALITY_LAB_TODAY);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (offset: number) => new Date(NOW + offset).toISOString();
const dayIn = (days: number) => at(days * DAY).slice(0, 10);

/** The scenario's payee, as the stage's load nests it in a bill. */
function payeeRow(scenario: QualityLabScenario) {
  const payee = scenario.payee ?? {};
  const changed = payee.addressChanged;
  return {
    id: LAB_PAYEE_ID, name: "Harbor Supply", role: payee.role ?? "vendor", risk_level: payee.riskLevel ?? "low",
    payment_limit: String(payee.paymentLimit ?? 1000), performance_score: null, performance_inputs: null,
    address: payee.address === undefined ? LAB_ADDRESS_ON_FILE : payee.address,
    address_changed_at: changed ? at(-changed.hoursAgo * HOUR) : null,
    address_confirmed_at: changed && changed.confirmedHoursAgo !== null ? at(-changed.confirmedHoursAgo * HOUR) : null,
    chain: null, purchase_order_required: payee.purchaseOrderRequired ?? true,
  };
}

/** The scenario's bill: 400 USDC due today with its purchase order and goods received, unless it says otherwise. */
function billRow(scenario: QualityLabScenario) {
  const bill = scenario.bill ?? {};
  const scheduled = bill.scheduledForToday === true;
  return {
    id: BILL_ID, direction: "payable", status: scheduled ? "scheduled" : "pending", amount: String(bill.amount ?? 400), currency: "USDC",
    memo: bill.memo ?? "Annual support plan", po_reference: bill.poReference === undefined ? "PO-1044" : bill.poReference,
    goods_received: bill.goodsReceived ?? true, due_date: `${dayIn(bill.dueInDays ?? 0)}T12:00:00+00:00`, counterparty_id: LAB_PAYEE_ID,
    agent_reasoning: scheduled ? "Scheduled for today, as agreed with the vendor." : null, tx_ref: null,
    decided_at: scheduled ? at(-5 * DAY) : null, scheduled_for: scheduled ? `${dayIn(0)}T00:00:00+00:00` : null, paid_amount: null,
    early_pay_discount_pct: bill.discount ? bill.discount.percent.toFixed(2) : null,
    discount_due_date: bill.discount ? `${dayIn(bill.discount.inDays)}T12:00:00+00:00` : null,
    document_pay_to: bill.documentPayTo ?? null, project_id: null, created_at: at(-DAY), recurring_payables: null,
    counterparties: payeeRow(scenario),
  };
}

/** The same bill, paid a month ago: same vendor, purchase order and amount. */
function paidTwin(scenario: QualityLabScenario) {
  return {
    ...billRow(scenario), id: TWIN_ID, status: "paid", memo: "Annual support plan", po_reference: "PO-1044",
    due_date: `${dayIn(-30)}T12:00:00+00:00`, decided_at: at(-30 * DAY), created_at: at(-31 * DAY), tx_ref: "0xpaid", paid_amount: "400",
  };
}

/** Who stands behind the payee's address, and where it was paid before (new payee check N1, N2). */
function newPayeeFacts(scenario: QualityLabScenario, address: string | null): NewPayeeFacts {
  const payee = scenario.payee ?? {};
  const entries: Array<{ action: string; detail: Record<string, unknown> }> = [];
  const paidTo = new Set<string>();
  const confirmed = { action: "counterparty_address_confirmed", detail: { by: "member-bao", counterpartyId: LAB_PAYEE_ID, address } };
  if (payee.addressChanged) {
    paidTo.add(EARLIER_ADDRESS);
    if (payee.addressChanged.confirmedHoursAgo !== null) entries.push(confirmed);
    entries.push({ action: "counterparty_address_changed", detail: { by: "member-anna", counterpartyId: LAB_PAYEE_ID, from: EARLIER_ADDRESS, to: address } });
  } else {
    if (payee.firstPayment === "two_members") entries.push(confirmed);
    if (!payee.firstPayment && address) paidTo.add(address.toLowerCase());
  }
  entries.push({ action: "create_counterparty", detail: { by: "member-anna", counterpartyId: LAB_PAYEE_ID, address: payee.addressChanged ? EARLIER_ADDRESS : address } });
  return { paidTo: new Map([[LAB_PAYEE_ID, paidTo]]), entries: new Map([[LAB_PAYEE_ID, entries]]) };
}

function spendingLimitOnArc(scenario: QualityLabScenario): OnChainLimitGate | undefined {
  const answer = scenario.workspace?.spendingLimitOnArc;
  if (!answer) return undefined;
  const verdict = answer === "allows" ? { state: "allowed" as const } : { state: "refused" as const, error: "OverDailyLimit", spent: 4.9, amount: 400, limit: 5 };
  return onChainLimitGate({ read: async () => LIMIT, verdict: async () => verdict });
}

/** A vendor that earned the owner's rule in every run with the switch on, never the scenario's payee. */
const OTHER_EARNED_VENDOR = "018f8ce0-1557-7b54-a931-4d777f6be0a1";

/**
 * The vendors the stage's gate grants (earned vendors AL22): with the owner's switch on, another vendor, and the payee
 * too when it earned it under the rule, so a payee that has not earned it is weighed with the switch on and some vendor
 * earned; with the switch off, none is handed in, and the stage builds its gate from the workspace, whose fake has no
 * rule.
 */
function earnedOf(scenario: QualityLabScenario): string[] | undefined {
  if (!scenario.workspace?.earnedVendorPayments) return undefined;
  return scenario.payee?.earned ? [OTHER_EARNED_VENDOR, LAB_PAYEE_ID] : [OTHER_EARNED_VENDOR];
}

export function expectedOf(scenario: QualityLabScenario): QualityLabOutcome {
  const { money, status, rule, heldBecause, transfers } = scenario.expected;
  return { money, status, rule, heldBecause: heldBecause ?? null, transfers };
}

export interface ScenarioRun {
  verdict: QualityLabVerdict;
  /** What the run did, as the judge was handed it. */
  run: QualityLabRun;
  /** How often it asked the provider to send, and the model to decide. */
  reached: { asked: number; decided: number };
}

/** A runner for the test file's world and mocked model. */
export function qualityLabRunner(world: ReturnType<typeof apHarness>["world"], decideMock: Mock) {
  /** Runs one scenario through the AP stage, every cycle it asks for, and judges what it did (QL4). */
  return async function runScenario(scenario: QualityLabScenario): Promise<ScenarioRun> {
    const workspace = scenario.workspace ?? {};
    const bill = billRow(scenario);
    const book: Array<Record<string, unknown>> = [...(scenario.history?.paidTwin ? [paidTwin(scenario)] : []), bill];
    const milestones = scenario.history?.milestoneSamePurchaseOrder
      ? [{ id: MILESTONE_ID, contractor_id: LAB_PAYEE_ID, title: "Support plan setup", status: "verified", verified: true, amount: "400", created_at: at(-10 * DAY), verification_source: null, po_reference: "PO-1044" }]
      : [];
    const chain = new LabChain(scenario.run?.lostAnswer ?? null);
    const earned = earnedOf(scenario);
    const { fake, stage } = world({
      book,
      chain,
      milestones,
      paused: workspace.paused,
      shadow: workspace.shadowMode ? "USD" : undefined,
      twoApprovals: workspace.twoApprovalsAbove,
      payeeLock: workspace.payeeLockHours ? { on: true, hours: workspace.payeeLockHours } : undefined,
      budget: workspace.dailySpendingLimit ? { daily_usdc: String(workspace.dailySpendingLimit), weekly_usdc: null } : undefined,
      onChainLimit: spendingLimitOnArc(scenario),
      newPayee: newPayeeFacts(scenario, bill.counterparties.address),
      vendorDocuments: scenario.bill?.poFromVendorDocument ? [BILL_ID] : [],
      ...(earned ? { earned } : {}),
    });
    const { action, payOnInDays, reasoning } = scenario.model;
    scriptModel(decideMock, () => ({ action, payOn: payOnInDays === undefined ? null : dayIn(payOnInDays), reasoning, confidence: 0.9 }));

    today(QUALITY_LAB_TODAY);
    if (scenario.run?.overlapping) {
      await Promise.all([stage(), stage()]);
      today(at(5 * 60_000));
      await stage();
    } else {
      await stage();
    }
    for (const minutes of scenario.run?.laterCycles ?? []) {
      today(at(minutes * 60_000));
      await stage();
    }

    const writes = invoiceWrites(fake.requests, BILL_ID);
    const decisions = ledgerEntries(fake.requests).filter((entry) => entry.detail.invoiceId === BILL_ID);
    const last = decisions.at(-1)?.detail as { guardrailRule?: string | null; execution?: { heldBecause?: string } } | undefined;
    const run: QualityLabRun = {
      status: String(bill.status),
      rule: last?.guardrailRule ?? null,
      heldBecause: last?.execution?.heldBecause ?? null,
      transfers: chain.sent.map((transfer) => ({ to: transfer.toAddress, amount: transfer.amount })),
      scheduled: writes.some((write) => write.status === "scheduled"),
    };
    const verdict = judgeScenario(expectedOf(scenario), run, { amount: Number(bill.amount), addressOnFile: bill.counterparties.address });
    return { verdict, run, reached: { asked: chain.asked.length, decided: decideMock.mock.calls.length } };
  };
}
