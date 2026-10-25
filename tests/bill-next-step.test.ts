import { describe, expect, it } from "vitest";
import { billBlockers, billNextStep, collectionState } from "@/components/vx/bill-next-step";
import type { Decision } from "@/components/vx/types";

/**
 * A bill's row says what stands in its way and what a person does next, before the row is opened (Bills & receivables
 * tabs B6): the detail holds the reasoning and the actions, never the only mention that something is needed.
 */

const decision = (over: Partial<Decision> = {}): Decision => ({
  id: "inv-1",
  network: "arc-testnet",
  domain: "ap",
  action: "Pay",
  subject: "Northwind Hosting",
  amount: 120,
  token: "USDC",
  outcome: "held",
  reasoning: "No purchase order on file.",
  evidence: [
    { label: "PO", value: "none", state: "missing" },
    { label: "Goods received", value: "no", state: "missing" },
    { label: "Risk", value: "clear", state: "neutral" },
    { label: "Limit", value: "500.00 USDC", state: "neutral" },
  ],
  at: "2026-10-10T09:00:00Z",
  ...over,
});

const waiting = (over: { poReference?: string | null; goodsReceived?: boolean } = {}) => ({
  onFile: { poReference: null, goodsReceived: false, purchaseOrderRequired: true, ...over },
  added: null,
});

const people = { canWrite: true, canDecide: true, counterparty: { id: "cp-1", name: "Northwind Hosting" } };

describe("billNextStep", () => {
  it("asks for what the three-way match lacks, from the detail where Add details is", () => {
    expect(billNextStep(decision(), { status: "held", waiting: waiting(), rule: null, ...people })).toEqual({ text: "Add the purchase order and goods receipt", tone: "held", opens: "detail" });
    expect(billNextStep(decision(), { status: "held", waiting: waiting({ goodsReceived: true }), rule: null, ...people })).toMatchObject({ text: "Add the purchase order" });
    expect(billNextStep(decision(), { status: "held", waiting: waiting({ poReference: "PO-9" }), rule: null, ...people })).toMatchObject({ text: "Confirm the goods were received" });
  });

  it("says details were added while the agent decides again", () => {
    expect(billNextStep(decision(), { status: "held", waiting: { ...waiting(), added: { poReference: "PO-9" } }, rule: null, ...people })).toEqual({
      text: "Details added · the agent decides it again",
      tone: "muted",
      opens: "detail",
    });
  });

  it("names the fix for a rule an owner can change, and Approvals otherwise", () => {
    expect(billNextStep(decision({ outcome: "refused" }), { status: "flagged", waiting: waiting({ poReference: "PO-1", goodsReceived: true }), rule: "counterparty.payment_limit", ...people })).toEqual({
      text: "Edit limit",
      tone: "held",
      href: "/counterparties#counterparty-cp-1",
    });
    expect(
      billNextStep(decision({ outcome: "refused" }), { status: "flagged", waiting: waiting({ poReference: "PO-1", goodsReceived: true }), rule: "counterparty.payment_limit", ...people, canWrite: false })
    ).toEqual({ text: "Decide in Approvals", tone: "held", href: "/approvals#payable-inv-1" });
    expect(billNextStep(decision(), { status: "held", waiting: waiting({ poReference: "PO-1", goodsReceived: true }), rule: null, ...people })).toMatchObject({ text: "Decide in Approvals" });
  });

  it("says a viewer can only wait", () => {
    expect(billNextStep(decision(), { status: "held", waiting: waiting({ poReference: "PO-1", goodsReceived: true }), rule: null, canWrite: false, canDecide: false, counterparty: people.counterparty })).toEqual({
      text: "Waits for an owner or approver",
      tone: "muted",
      opens: "detail",
    });
  });

  it("asks for a verdict in shadow mode, when this person can give it", () => {
    const verdict = { entrySeq: 7, agentAction: "ap_pay", given: null, open: true, heldForVerdict: true };
    expect(billNextStep(decision({ heldForVerdict: true, verdict }), { status: "held", waiting: waiting({ poReference: "PO-1", goodsReceived: true }), rule: null, ...people })).toEqual({
      text: "Give your verdict",
      tone: "agent",
      opens: "detail",
    });
  });

  it("asks nothing of a bill on its way: scheduled, being decided, in flight or paid", () => {
    expect(billNextStep(decision({ outcome: "scheduled" }), { status: "scheduled", waiting: undefined, rule: null, ...people })).toBeNull();
    expect(billNextStep(decision({ outcome: "deciding" }), { status: "pending", waiting: undefined, rule: null, ...people })).toBeNull();
    expect(billNextStep(decision({ outcome: "settled" }), { status: "paid", waiting: undefined, rule: null, ...people })).toBeNull();
  });

  it("sends a bill held for its vendor's document to Approvals, where a person approves it (document checks DK8)", () => {
    const facts = { status: "held", waiting: waiting({ poReference: "PO-PC-2026-1030", goodsReceived: true }), rule: "invoice.vendor_document", ...people };
    expect(billNextStep(decision({ outcome: "refused" }), facts)).toEqual({ text: "Decide in Approvals", tone: "held", href: "/approvals#payable-inv-1" });
    expect(billNextStep(decision({ outcome: "refused" }), { ...facts, canDecide: false, canWrite: false })).toMatchObject({ text: "Waits for an owner or approver" });
  });

  it("sends a bill code refused, and no longer waiting, to Approvals", () => {
    expect(billNextStep(decision({ outcome: "refused" }), { status: "pending", waiting: undefined, rule: "counterparty.high_risk", ...people, canWrite: false })).toMatchObject({
      text: "Decide in Approvals",
    });
  });
});

describe("billBlockers", () => {
  it("lists only what stands in the way, from the card's own checks", () => {
    expect(billBlockers(decision())).toEqual(["No PO", "Not received"]);
    expect(billBlockers(decision({ evidence: [{ label: "Limit", value: "50.00 USDC", state: "missing" }, { label: "Risk", value: "high", state: "missing" }] }))).toEqual(["High risk", "Over its limit"]);
    expect(billBlockers(decision({ outcome: "scheduled", evidence: [{ label: "PO", value: "PO-1", state: "ok" }] }))).toEqual([]);
  });

  it("leaves a shadow-mode hold, which no check stopped, to the row's why line", () => {
    expect(billBlockers(decision({ evidence: [], heldForVerdict: true }))).toEqual([]);
  });

  it("lists nothing for a receivable", () => {
    expect(billBlockers(decision({ domain: "ar" }))).toEqual([]);
  });
});

describe("collectionState", () => {
  it("says where the reminders stand, never that money arrived", () => {
    expect(collectionState({ url: "https://x", legacy: false, remindersOnAt: "2026-10-01T00:00:00Z", deferredUntil: null, sent: [{ number: 2, tone: "firm", sentAt: "2026-10-09T08:00:00Z" }] }, "2026-10-12")).toBe(
      "Reminder 2 sent Oct 9, 2026"
    );
    expect(collectionState({ url: "https://x", legacy: false, remindersOnAt: "2026-10-01T00:00:00Z", deferredUntil: null, sent: [] }, "2026-10-12")).toBe("Reminders on");
    expect(collectionState({ url: "https://x", legacy: false, remindersOnAt: "2026-10-01T00:00:00Z", deferredUntil: "2026-10-20T00:00:00Z", sent: [] }, "2026-10-12")).toBe("Reminders paused until Oct 20, 2026");
    expect(collectionState({ url: "https://x", legacy: false, remindersOnAt: "2026-10-01T00:00:00Z", deferredUntil: "2026-10-10T00:00:00Z", sent: [] }, "2026-10-12")).toBe("Reminders on");
    expect(collectionState({ url: "https://x", legacy: false, remindersOnAt: null, deferredUntil: null, sent: [] }, "2026-10-12")).toBe("Pay link ready · reminders off");
    expect(collectionState(null, "2026-10-12")).toBeNull();
  });
});
