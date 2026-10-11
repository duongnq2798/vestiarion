import { describe, expect, it } from "vitest";
import { cashOutlook } from "@/lib/cash-outlook";
import { paymentPlanInput, type PlanRows } from "@/lib/payment-plan-input";

/**
 * The rows the page and the command each read, turned into the planner's input the same way (payment plan P3, P11,
 * P12): so the plan a person sees and the plan the server checks their approval against are built alike.
 */

const NOW = Date.UTC(2026, 9, 11, 9, 0);
const SYNCED = new Date(NOW - 120_000).toISOString();

const rows = (fields: Partial<PlanRows> = {}): PlanRows => ({
  now: NOW,
  invoices: [
    {
      id: "i-1",
      direction: "payable",
      counterparty_id: "c-1",
      counterparty_name: "Northwind Supply",
      amount: 120,
      currency: "USDC",
      due_date: "2026-10-14T12:00:00.000Z",
      status: "scheduled",
      scheduled_for: "2026-10-14T00:00:00+00:00",
      early_pay_discount_pct: "2.00",
      discount_due_date: "2026-10-12T12:00:00+00:00",
      created_by: "u-maker",
    },
    {
      id: "i-2",
      direction: "receivable",
      counterparty_id: "c-2",
      counterparty_name: "Client",
      amount: 500,
      currency: "USDC",
      due_date: "2026-10-13T12:00:00.000Z",
      status: "pending",
      scheduled_for: null,
    },
  ],
  counterparties: [
    { id: "c-1", address: "0xabc", payment_limit: 1000, risk_level: "clear" },
    { id: "c-3", address: "0xada", payment_limit: 30, risk_level: "high" },
  ],
  milestones: [{ id: "m-1", contractor_id: "c-3", contractor_name: "Ada Lovelace", title: "Design review", amount: 40, status: "verified", escrow_state: null }],
  accounts: [
    { kind: "operating", balance: 300, circle_wallet_id: "w-1", address: "0xop", balance_synced_at: SYNCED },
    { kind: "reserve", balance: "200", apy: "0.045", circle_wallet_id: null, address: null, balance_synced_at: null },
  ],
  chainMode: "live",
  walletHost: "hosted",
  budget: { budget: { dailyUsdc: 100, weeklyUsdc: 400 }, spent: { today: 10, week: 50 }, room: null },
  twoApprovalsAbove: 250,
  ...fields,
});

describe("paymentPlanInput", () => {
  it("reads cash as Safe to spend does: the operating wallet and the reserve, with Safe to spend's own cushion", () => {
    const input = paymentPlanInput(rows());
    expect(input.operatingUsdc).toBe(300);
    expect(input.reserveUsdc).toBe(200);
    // The reserve's yield, as the agent reads it, to weigh a discount against holding the cash (P4).
    expect(input.reserveApy).toBe(0.045);
    expect(paymentPlanInput(rows({ accounts: [{ kind: "operating", balance: 300 }] })).reserveApy).toBe(0);
    const outlook = cashOutlook({
      now: NOW,
      operatingUsdc: 300,
      reserveUsdc: 200,
      payables: [{ id: "i-1", counterparty: "Northwind Supply", amount: 120, currency: "USDC", due_date: "2026-10-14T12:00:00.000Z", status: "scheduled", scheduled_for: "2026-10-14T00:00:00+00:00" }],
      milestones: [{ id: "m-1", title: "Design review", contractor: "Ada Lovelace", amount: 40, status: "verified", escrow_state: null }],
      receivables: [],
    });
    expect(input.cushion).toBe(outlook.cushion);
    expect(input.cushion).toBeCloseTo((120 + 40) * 0.15, 6);
  });

  it("takes payables only, with the payee's address, payment limit and screening, the discount and who entered it, and milestones with their contractor's", () => {
    const input = paymentPlanInput(rows());
    expect(input.bills).toEqual([
      {
        id: "i-1",
        counterpartyId: "c-1",
        payee: "Northwind Supply",
        payeeAddress: "0xabc",
        amount: 120,
        currency: "USDC",
        dueDate: "2026-10-14T12:00:00.000Z",
        status: "scheduled",
        scheduledFor: "2026-10-14T00:00:00+00:00",
        discount: { pct: 2, deadline: "2026-10-12T12:00:00+00:00" },
        paymentLimit: 1000,
        riskLevel: "clear",
        createdBy: "u-maker",
      },
    ]);
    // The contractor's payment limit and screening, which the agent checks before it releases a milestone (P7).
    expect(input.milestones).toEqual([
      { id: "m-1", counterpartyId: "c-3", payee: "Ada Lovelace", title: "Design review", amount: 40, status: "verified", escrowState: null, paymentLimit: 30, riskLevel: "high" },
    ]);
  });

  it("reads the limits: the agent's figures and what it paid, and the figure for two approvals", () => {
    expect(paymentPlanInput(rows()).limits).toEqual({ budget: { dailyUsdc: 100, weeklyUsdc: 400, spentToday: 10, spentThisWeek: 50 }, twoApprovalsAbove: 250 });
    expect(paymentPlanInput(rows({ budget: null, twoApprovalsAbove: null })).limits).toEqual({ budget: null, twoApprovalsAbove: null });
    expect(paymentPlanInput(rows({ budget: { budget: { dailyUsdc: null, weeklyUsdc: null }, spent: { today: 0, week: 0 }, room: null } })).limits.budget).toBeNull();
  });

  it("reads the balance from the chain when payments are live and the operating account holds a wallet, a sandbox's own otherwise", () => {
    expect(paymentPlanInput(rows()).balance).toEqual({ kind: "chain", syncedAt: SYNCED });
    expect(paymentPlanInput(rows({ chainMode: "simulate" })).balance).toEqual({ kind: "simulated" });
    const noWallet = rows({ accounts: [{ kind: "operating", balance: 300, circle_wallet_id: null, address: null, balance_synced_at: null }] });
    expect(paymentPlanInput(noWallet).balance).toEqual({ kind: "simulated" });
    // A workspace paying from its owner's own wallet: the operating account has the wallet's address and no Circle wallet.
    const external = rows({ walletHost: "external", accounts: [{ kind: "operating", balance: 300, circle_wallet_id: null, address: "0xown", balance_synced_at: null }] });
    expect(paymentPlanInput(external).balance).toEqual({ kind: "chain", syncedAt: null });
  });

  it("names what could not be read, and plans without it", () => {
    const input = paymentPlanInput(rows({ budget: "unread", twoApprovalsAbove: "unread", milestones: null }));
    expect(input.unread).toEqual(["the agent's spending limit", "the figure for two approvals", "the open milestones"]);
    expect(input.limits).toEqual({ budget: null, twoApprovalsAbove: null });
    expect(input.milestones).toEqual([]);
  });
});
