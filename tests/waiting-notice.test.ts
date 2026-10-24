import { describe, expect, it } from "vitest";
import { buildWaitingNotice, NOTICE_MAX_BILLS, type WaitingBill } from "@/lib/notifications/waiting-notice";

/**
 * The bills a chat is told wait for approval, as structured entries (docs/superpowers/specs/2026-10-22-discord-design.md
 * DC3): Discord formats them, and so does Telegram's decisions message. How much, to whom, why in one plain sentence,
 * what it needs, and the Approvals path that opens it.
 */

const ID = (n: number) => `2b6c1c9e-4a4f-4a7e-9b1e-${String(n).padStart(12, "0")}`;
const bill = (n: number, fields: Partial<WaitingBill> = {}): WaitingBill => ({
  id: ID(n), payee: `Vendor ${n}`, amount: 1250, currency: "USDC", status: "held", reasoning: null, stopRule: null, ...fields,
});

describe("buildWaitingNotice", () => {
  it("gives each bill its amount, payee, status and the Approvals anchor of its card", () => {
    const notice = buildWaitingNotice([bill(1), bill(2, { currency: "EURC", amount: 80.5, status: "flagged" })]);
    expect(notice).toEqual({
      total: 2,
      more: 0,
      entries: [
        { invoiceId: ID(1), payee: "Vendor 1", amountText: "1,250.00 USDC", status: "held", reason: null, twoApprovals: false, cosign: false, reviewPath: `/approvals#payable-${ID(1)}` },
        { invoiceId: ID(2), payee: "Vendor 2", amountText: "80.50 EURC", status: "flagged", reason: null, twoApprovals: false, cosign: false, reviewPath: `/approvals#payable-${ID(2)}` },
      ],
    });
  });

  it("says the agent's reason in its first plain sentence, as the approval card does", () => {
    const [entry] = buildWaitingNotice([bill(1, { reasoning: "The invoice has no purchase order. The goods were received on Oct 2, 2026." })]).entries;
    expect(entry.reason).toBe("The invoice has no purchase order.");
    const [none] = buildWaitingNotice([bill(1, { reasoning: "   " })]).entries;
    expect(none.reason).toBeNull();
  });

  it("says why code stopped a bill in place of the model's sentence, as its row on Bills does (chat code stop reason CS3)", () => {
    const reasoning = "The invoice is due today, so I am paying now.";
    const [rule, cash, model, nameless] = buildWaitingNotice([
      bill(1, { reasoning, stopRule: "counterparty.cooling_off" }),
      bill(2, { reasoning, stopRule: "treasury.cash_shortfall" }),
      bill(3, { reasoning }),
      // A rule with no words of its own: the model's sentence says more than its name.
      bill(4, { reasoning, stopRule: "some.new_rule" }),
    ]).entries;
    expect(rule.reason).toBe("Code stopped it: the payment address changed recently, and the payee lock makes it wait.");
    expect(cash.reason).toBe("Code stopped it: the operating wallet did not hold the cash it needs.");
    expect(model.reason).toBe(reasoning);
    expect(nameless.reason).toBe(reasoning);
  });

  it("lists at most ten bills, in the order given, and counts the rest", () => {
    const notice = buildWaitingNotice(Array.from({ length: 14 }, (_, i) => bill(i + 1)));
    expect(NOTICE_MAX_BILLS).toBe(10);
    expect(notice.entries.map((entry) => entry.payee)).toEqual(Array.from({ length: 10 }, (_, i) => `Vendor ${i + 1}`));
    expect(notice.more).toBe(4);
    expect(notice.total).toBe(14);
  });

  it("marks a bill above the figure as needing two approvals, strictly above it", () => {
    const policy = { twoApprovalsAbove: 500, accountantCosigns: false };
    const [above, at, below] = buildWaitingNotice([bill(1, { amount: 500.01 }), bill(2, { amount: 500 }), bill(3, { amount: 20 })], policy).entries;
    expect([above.twoApprovals, at.twoApprovals, below.twoApprovals]).toEqual([true, false, false]);
    expect(above.cosign).toBe(false);
  });

  it("says an accountant can co-sign only a bill that needs two approvals, while co-signing is on", () => {
    const policy = { twoApprovalsAbove: 500, accountantCosigns: true };
    const [above, below] = buildWaitingNotice([bill(1, { amount: 900 }), bill(2, { amount: 20 })], policy).entries;
    expect(above).toMatchObject({ twoApprovals: true, cosign: true });
    expect(below).toMatchObject({ twoApprovals: false, cosign: false });
  });

  it("weighs a EURC bill by its USDC value, and needs two approvals when that is not known", () => {
    const policy = { twoApprovalsAbove: 100, accountantCosigns: false };
    const [known, unknown] = buildWaitingNotice([bill(1, { currency: "EURC", amount: 90, usdcValue: 98 }), bill(2, { currency: "EURC", amount: 90 })], policy).entries;
    expect(known.twoApprovals).toBe(false);
    expect(unknown.twoApprovals).toBe(true);
  });

  it("needs nothing more when no figure is set", () => {
    const [entry] = buildWaitingNotice([bill(1, { amount: 1_000_000 })], { twoApprovalsAbove: null, accountantCosigns: true }).entries;
    expect(entry).toMatchObject({ twoApprovals: false, cosign: false });
  });
});
