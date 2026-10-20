import { describe, expect, it } from "vitest";
import { payableDecisionFacts } from "@/lib/agent/orchestrator";
import { planFollowUp, type FollowUpConfig, type FrozenInvoice } from "@/lib/agent/follow-up";

/**
 * A payment the reconcile did not send again (`ap_reconcile` with `notResubmittedBecause`), through the facts the
 * follow-up stage reads for it (`payableDecisionFacts`) and its plan (`planFollowUp`). The reconcile records no
 * `observed`, so the facts used to be the decision's from before the send, which nothing held: a payable held for the
 * payee lock's wait, or for an address no one had confirmed, was never decided again once that ended. The reconcile
 * itself is tested in tests/control-cycle.test.ts, and the payment the AP stage then makes in tests/ap-stage.test.ts.
 */

const INVOICE = "018f8ce0-1557-7b54-a931-4d777f6bd001";
const NOW = Date.parse("2026-10-21T15:30:00.000Z");
const config: FollowUpConfig = { staleAfterDays: 7, reEscalateAfterDays: 3 };

type Entry = { seq: number; action: string; detail: Record<string, unknown> };

/** The agent's decision to pay it, on Oct 20, before the address changed. */
const paid: Entry = {
  seq: 10,
  action: "ap_pay",
  detail: {
    invoiceId: INVOICE,
    observed: { amount: 150, paymentLimit: 500, riskLevel: "low", poReference: "PO-7", goodsReceived: true, purchaseOrderRequired: true, addressUnconfirmed: false },
    execution: { resultingStatus: "matched" },
  },
};

/** The next cycle's reconcile: the send never reached Circle, and it was not sent again, for `reason`. */
function notResent(reason: string, seq = 12): Entry {
  return {
    seq,
    action: "ap_reconcile",
    detail: { invoiceId: INVOICE, reconciled: true, previousStatus: "matched", notResubmittedBecause: reason, execution: { resultingStatus: "held" } },
  };
}

/** The payable as the follow-up stage reads it, held since the reconcile. */
function held(over: Partial<FrozenInvoice> = {}): FrozenInvoice {
  return {
    id: INVOICE,
    status: "held",
    amount: 150,
    dueDate: "2026-10-31T12:00:00.000Z",
    decidedAt: "2026-10-20T09:00:00.000Z",
    escalatedAt: null,
    poReference: "PO-7",
    goodsReceived: true,
    riskLevel: "low",
    paymentLimit: 500,
    addressUnconfirmed: false,
    addressMissing: false,
    purchaseOrderRequired: true,
    ...over,
  };
}

function factsOf(entries: Entry[]) {
  return payableDecisionFacts(entries).get(INVOICE) ?? null;
}

describe("the follow-up and a payment not sent again for the payee lock's wait (payee lock PL5)", () => {
  const facts = () => factsOf([notResent("counterparty.cooling_off"), paid]);

  it("knows it is held for the wait", () => {
    expect(facts()).toMatchObject({ coolingOffHeld: true, addressUnconfirmed: false });
  });

  it("leaves it held while the wait runs, and decides it again once it has ended", () => {
    expect(planFollowUp(held({ coolingOff: true }), facts(), NOW, config).action).toBe("wait");
    const ended = planFollowUp(held({ coolingOff: false }), facts(), NOW, config);
    expect(ended).toMatchObject({ action: "reopen", changes: ["the payee lock's wait for the new address has ended"] });
  });
});

describe("the follow-up and a payment not sent again to an address no one has confirmed", () => {
  const facts = () => factsOf([notResent("counterparty.address_unconfirmed"), paid]);

  it("knows it is held for the address", () => {
    expect(facts()).toMatchObject({ addressUnconfirmed: true, coolingOffHeld: false });
  });

  it("leaves it held while the address waits, and decides it again once someone confirms it", () => {
    expect(planFollowUp(held({ addressUnconfirmed: true }), facts(), NOW, config).action).toBe("wait");
    const confirmed = planFollowUp(held({ addressUnconfirmed: false }), facts(), NOW, config);
    expect(confirmed).toMatchObject({ action: "reopen", changes: ["the counterparty's new address has since been confirmed"] });
  });
});

describe("the follow-up and a payment not sent again as the first payment to its address (new payee check N7)", () => {
  it("decides it again once a second person stands behind the address", () => {
    const facts = factsOf([notResent("counterparty.new_payee"), paid]);
    expect(facts).toMatchObject({ newPayeeHeld: true });
    expect(planFollowUp(held({ newPayee: { addressPaid: false, twoParties: false } }), facts, NOW, config).action).toBe("wait");
    expect(planFollowUp(held({ newPayee: { addressPaid: false, twoParties: true } }), facts, NOW, config)).toMatchObject({
      action: "reopen",
      changes: ["a second person now stands behind the payee's address"],
    });
  });
});

describe("payableDecisionFacts — what a payment not sent again rests on", () => {
  it("keeps the facts its decision rested on, so a change in them reopens it as before", () => {
    expect(factsOf([notResent("counterparty.cooling_off"), paid])).toMatchObject({ poReference: "PO-7", goodsReceived: true, riskLevel: "low", paymentLimit: 500, purchaseOrderRequired: true });
    const raised = planFollowUp(held({ coolingOff: true, paymentLimit: 800 }), factsOf([notResent("counterparty.cooling_off"), paid]), NOW, config);
    expect(raised).toMatchObject({ action: "reopen", changes: ["payment limit moved 500 USDC → 800 USDC"] });
  });

  it("drops a hold the decision itself had: a person paid it since, so only the reason it was not sent again holds it", () => {
    // Held for want of cash on Oct 19, then approved and paid by a person, whose approval records no facts.
    const heldForCash: Entry = {
      seq: 8,
      action: "ap_hold",
      detail: { ...paid.detail, execution: { resultingStatus: "held", heldBecause: "cash_shortfall", cashNeededUsdc: 150, cashSeen: { operating: 20, reserve: 0 } } },
    };
    const approved: Entry = { seq: 10, action: "invoice_approved", detail: { invoiceId: INVOICE } };
    const facts = factsOf([notResent("counterparty.cooling_off"), approved, heldForCash]);
    expect(facts).toMatchObject({ coolingOffHeld: true, heldForCash: null });
    // Cash that came in since is no reason to decide it again inside the wait.
    expect(planFollowUp(held({ coolingOff: true, cash: { operating: 900, reserve: 0 } }), facts, NOW, config).action).toBe("wait");
  });

  it("is passed over by an entry that records no facts, such as an escalation", () => {
    const escalated: Entry = { seq: 13, action: "invoice_escalated", detail: { invoiceId: INVOICE, followUp: { action: "escalate" } } };
    expect(factsOf([escalated, notResent("counterparty.cooling_off"), paid])).toMatchObject({ coolingOffHeld: true });
  });

  it("gives way to a decision taken after it", () => {
    const reopened: Entry = { seq: 13, action: "invoice_reopened", detail: { invoiceId: INVOICE, followUp: { action: "reopen" } } };
    const paidAgain: Entry = { ...paid, seq: 14 };
    expect(factsOf([paidAgain, reopened, notResent("counterparty.cooling_off"), paid])).toMatchObject({ coolingOffHeld: false, addressUnconfirmed: false });
    const heldAgain: Entry = { seq: 14, action: "ap_hold", detail: { ...paid.detail, guardrailRule: "counterparty.address_unconfirmed", observed: { ...(paid.detail.observed as object), addressUnconfirmed: true } } };
    expect(factsOf([heldAgain, reopened, notResent("counterparty.cooling_off"), paid])).toMatchObject({ coolingOffHeld: false, addressUnconfirmed: true });
  });

  it("decides again, as before, a payment not sent again to a payee now screened high risk, whose risk moved since the decision", () => {
    const facts = factsOf([notResent("counterparty.high_risk"), paid]);
    expect(facts).toMatchObject({ riskLevel: "low", coolingOffHeld: false, addressUnconfirmed: false, newPayeeHeld: false });
    expect(planFollowUp(held({ riskLevel: "high" }), facts, NOW, config)).toMatchObject({ action: "reopen", changes: ["counterparty risk moved low → high"] });
  });

  it("changes nothing for a reconcile that held it for another cause, such as a transfer Circle reported failed", () => {
    const failed: Entry = { seq: 12, action: "ap_reconcile", detail: { invoiceId: INVOICE, reconciled: true, previousStatus: "matched", execution: { resultingStatus: "held" } } };
    expect(factsOf([failed, paid])).toEqual(factsOf([paid]));
  });

  it("leaves a payable with no decision on record to be decided again, as before", () => {
    expect(factsOf([notResent("counterparty.cooling_off")])).toBeNull();
  });
});
