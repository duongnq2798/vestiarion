import { describe, expect, it } from "vitest";
import {
  REASONING_RULE,
  explainMilestone,
  explainPayable,
  explainTreasury,
  isTechnical,
  noteSentence,
  plainAmount,
  plainFigures,
  presentReasoning,
} from "@/lib/reasoning-copy";

/**
 * The agent's reasoning as a person reads it (docs/superpowers/specs/2026-10-02-plain-reasoning-design.md):
 * never a field name, a raw null or boolean, or a six-decimal balance; the stored text and the signed
 * ledger are left as they are. The long texts here are real ones the model wrote on testnet-2.
 */

// Stored on the testnet-2 invoice in the report: the model's words, then the note code added.
const JIREN =
  "Invoice is 3 USDC on Arc testnet (direct route, no CCTP fee), due 2026-10-02 which is today, so it is paid now rather than scheduled. Counterparty Jiren is riskLevel 'clear' with a payment limit of 30 USDC, and the amount 3 USDC is well within it. Three-way match is complete: PO-125 is on file and goodsReceived is true. No early-pay discount is offered (earlyPayDiscount null, discountValue null), so there is no discount worth scheduling for, and floatValueToDue is 0 since the due date is today. No shortfall: timing.shortfall is false, earlierObligations total 0 across 0 items, and the operating balance of 49.443396 USDC covers the 3 USDC payment with 46.443396 USDC left. No duplicates (duplicateMatchesTotal 0, duplicateMatches empty) and no fraud signals: risk not high, riskTierChanges 0, heldByOurPolicy 1 with paidWithoutIntervention 4. Currency is USDC so no EURC balance or swap is involved; fundWithSwap is false. [guardrail override: paying 3 USDC would take the agent past its 5 USDC daily spending limit: 3.6 USDC already paid today, 1.4 USDC left — held for a person to approve]";

const JIREN_ENTRY = {
  ts: "2026-10-02T11:57:00Z",
  detail: {
    decision: { action: "pay", reasoning: "…" },
    observed: { riskLevel: "clear", paymentLimit: 30, poReference: "PO-125", goodsReceived: true, operatingBalance: 49.443396, duplicateCheck: { matchesTotal: 0 } },
  },
};

const TREASURY =
  "Idle operating cash above the required buffer is 43.578397 (operatingBalance 49.443396 minus requiredBuffer 5.864999). Sweeping is uneconomic: projectedYieldUsd 0.004119 over expectedHoldDays 1 is less than roundTripCostUsd 0.00638. It is also not executable now because usyc.subscriptionsOpen is false.";

/** What must never reach a person: the report's list. */
function expectPlain(text: string) {
  expect(isTechnical(text), text).toBe(false);
  expect(text, text).not.toMatch(/\b\d+\.\d{3,}\s?(?:USDC|EURC)\b/);
  expect(text).not.toMatch(/\[|\]/);
}

describe("presentReasoning", () => {
  it("explains a log-like decision from the facts it recorded, and says what code did in plain words", () => {
    const shown = presentReasoning(
      JIREN,
      explainPayable({ name: "Jiren", amount: 3, currency: "USDC", dueDate: "2026-10-02", poReference: "PO-125", goodsReceived: true, entry: JIREN_ENTRY })
    );
    expect(shown).toBe(
      "This invoice was due on the day the agent decided it. Jiren passed screening, and 3.00 USDC is within its 30.00 USDC limit. " +
        "The purchase order PO-125 is on file and the goods were received. The operating wallet holds enough USDC to pay it. " +
        "No duplicate or high-risk signals were found. The agent decided to pay it. " +
        "Held for a person to approve: paying 3.00 USDC would take the agent past its 5.00 USDC daily spending limit; 3.60 USDC already paid today, 1.40 USDC left."
    );
    expectPlain(shown);
  });

  it("keeps only the sentences that read plainly where no facts are at hand (an email, the scheduled list)", () => {
    const shown = presentReasoning(JIREN);
    expect(shown).toBe(
      "Invoice is 3.00 USDC on Arc testnet (direct route, no CCTP fee), due Oct 2, 2026 which is today, so it is paid now rather than scheduled. " +
        "Held for a person to approve: paying 3.00 USDC would take the agent past its 5.00 USDC daily spending limit; 3.60 USDC already paid today, 1.40 USDC left."
    );
    expectPlain(shown);
    expectPlain(presentReasoning(TREASURY));
  });

  it("shows plain reasoning as the model wrote it, figures tidied", () => {
    expect(presentReasoning("Pay Northstar Studio 12.5 USDC now: the purchase order PO-2207 is on file and the goods arrived on 2026-09-29.")).toBe(
      "Pay Northstar Studio 12.50 USDC now: the purchase order PO-2207 is on file and the goods arrived on Sep 29, 2026."
    );
  });

  it("is empty when there is nothing plain to say, for the caller's own line", () => {
    expect(presentReasoning(null)).toBe("");
    expect(presentReasoning("goodsReceived is true; riskLevel clear.")).toBe("");
  });
});

describe("the notes code adds", () => {
  it("says each one as a sentence", () => {
    expect(noteSentence("transfer failed: provider reported failure")).toBe("The transfer failed: Circle reported a failure.");
    expect(noteSentence("transfer submitted; awaiting provider confirmation")).toBe("The transfer was sent and is waiting for Circle to confirm it.");
    expect(noteSentence("execution failed: column milestones.escrow_state does not exist")).toBe("The payment could not be sent.");
    expect(noteSentence("approved and paid by a person")).toBe("A person approved and paid it.");
    expect(noteSentence("paid now by a person")).toBe("A person chose Pay now.");
    expect(noteSentence("closed without paying by a person: Paid in cash")).toBe("A person closed it without paying: Paid in cash.");
    expect(noteSentence("guardrail override: contractor is high risk — release refused")).toBe("Not released: the contractor is high risk.");
    expect(noteSentence("guardrail override: 3 exceeds the 0.25 USDC payment limit — pay refused before execution")).toBe("Not paid: the amount exceeds the 0.25 USDC payment limit.");
    expect(noteSentence("guardrail override: the counterparty's address changed on 2026-09-30 and no one has confirmed it — held for a person to approve")).toBe(
      "Held for a person to approve: the counterparty's address changed on Sep 30, 2026 and no one has confirmed it."
    );
    expect(noteSentence("guardrail override: the operating wallet holds 1.5 EURC, less than the 2 EURC this payment sends — held for a person; fund EURC from Circle's faucet first")).toBe(
      "Held for a person to approve: the operating wallet holds 1.50 EURC, less than the 2.00 EURC this payment sends. Fund EURC from Circle's faucet first."
    );
    expect(noteSentence("not paid: it is being locked in escrow; verify it again once the lock has finished")).toBe(
      "Not paid: it is being locked in escrow; verify it again once the lock has finished."
    );
  });
});

describe("figures", () => {
  it("shows amounts to two decimals, a fee below a cent to its first figures, and ISO days as dates", () => {
    expect(plainAmount(49.443396)).toBe("49.44");
    expect(plainAmount(1250)).toBe("1,250.00");
    expect(plainAmount(0.004119)).toBe("0.0041");
    expect(plainFigures("holds 49.443396 USDC, earns $0.004119, idle 43.578397, matched at 0.909, due 2026-10-15")).toBe(
      "holds 49.44 USDC, earns $0.0041, idle 43.58, matched at 0.909, due Oct 15, 2026"
    );
  });
});

describe("explaining what a decision recorded", () => {
  it("says a milestone held for its screening in plain words", () => {
    const lines = explainMilestone({
      name: "Quoc Duong",
      amount: 1,
      entry: {
        detail: {
          decision: { action: "hold" },
          observed: { riskLevel: "medium", paymentLimit: 0.25, performanceHistory: { status: "no_history_yet" }, verification: { verified: true, method: "manual" } },
        },
      },
    });
    expect(lines).toEqual([
      "A person verified the work by hand.",
      "Quoc Duong has a screening match to review, and 1.00 USDC is above its 0.25 USDC limit, so code does not let the agent release it.",
      "Quoc Duong has no payment history with this workspace yet.",
      "The agent held it for a person to review.",
    ]);
  });

  it("says a treasury hold from its balances and economics", () => {
    const lines = explainTreasury({
      decision: { action: "hold", amount: 0 },
      economics: { idleAboveBuffer: 43.578397, requiredBuffer: 5.864999, expectedHoldDays: 1, projectedYieldUsd: 0.004119, roundTripCostUsd: 0.00638 },
      usycSubscriptionsOpen: false,
    });
    expect(lines).toEqual([
      "The agent kept the cash in the operating wallet.",
      "43.58 USDC sat above the 5.86 USDC kept for what falls due in the next 7 days.",
      "Parking it in the reserve for 1 day would earn about $0.0041, less than the $0.0064 a move in and out costs.",
      "USYC could not be bought until its next daily price update.",
    ]);
    expectPlain(presentReasoning(TREASURY, lines));
  });

  it("says a payable's three-way match, funds and duplicates only as they decided it", () => {
    const lines = explainPayable({
      name: "Bluebird Logistics",
      amount: 8,
      currency: "USDC",
      dueDate: "2026-10-09",
      poReference: "PO-2213",
      goodsReceived: false,
      entry: { ts: "2026-09-30T12:04:00Z", detail: { decision: { action: "request_info" }, observed: { riskLevel: "clear", paymentLimit: 50, operatingBalance: 5, duplicateCheck: { matchesTotal: 2 } } } },
    });
    expect(lines).toEqual([
      "This invoice is due on Oct 9, 2026.",
      "Bluebird Logistics passed screening, and 8.00 USDC is within its 50.00 USDC limit.",
      "The purchase order PO-2213 is on file, but the goods are not marked received.",
      "The operating wallet held 5.00 USDC, less than this invoice.",
      "It resembles 2 earlier invoices from Bluebird Logistics.",
      "The agent asked for more information before paying it.",
    ]);
  });
});

describe("the prompt", () => {
  it("asks the model for plain English, not the input's field names", () => {
    expect(REASONING_RULE).toContain("never as a field name or path from the input");
    expect(REASONING_RULE).toContain("never write null, true or false");
  });
});
