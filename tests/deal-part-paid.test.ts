import { describe, expect, it } from "vitest";
import { stillOwed } from "@/lib/allocations/book";
import { toMicros, type AllocationRow } from "@/lib/allocations/model";
import { cashOutlook, type OutlookInput } from "@/lib/cash-outlook";
import { scenarioBasis } from "@/lib/cash-scenario-basis";
import { cashScenario } from "@/lib/cash-scenarios";
import { plannedLinesOf, type DealRecord } from "@/lib/deals/read";
import { planPayments } from "@/lib/payment-plan";
import { paymentPlanInput, type PlanRows } from "@/lib/payment-plan-input";
import { deal, line, released } from "./support/deal-facts";

/**
 * A deal's released line is a receivable (docs/superpowers/specs/2026-10-12-deal-schedule-design.md D14), and a payment
 * applied to part of it leaves it expected for what is still owed (docs/superpowers/specs/2026-10-12-allocations-design.md
 * L11): what arrived is in the wallet already. Treasury's cash outlook, its cash scenarios and the payment plan each
 * count that line once, for what it still owes, and list the deal's lines not released yet apart, in no balance.
 */

const NOW = Date.parse("2026-10-12T09:00:00Z");

// Acme Studio's website rebuild, 10,000.00 USDC: the deposit released and part paid, the balance not invoiced yet.
const WEBSITE: DealRecord = {
  facts: deal([
    released({
      id: "line-deposit",
      invoiceOn: "2026-10-06",
      dueOn: "2026-10-20",
      amountMinor: 300_000,
      receivable: { id: "inv-deposit", status: "pending", dueDate: "2026-10-20T12:00:00Z" },
    }),
    line({ id: "line-balance", position: 2, label: "Balance on delivery", invoiceOn: "2026-10-14", dueOn: "2026-10-24", amountMinor: 700_000 }),
  ]),
  title: "Website rebuild",
  customer: { id: "c-acme", name: "Acme Studio" },
  digits: 2,
  externalRef: null,
  template: "deposit",
  createdBy: "u-owner",
  createdAt: "2026-10-06T09:00:00Z",
  autoReleaseBy: null,
  autoReleaseAt: null,
  versions: [],
};

// The receivable the deposit line became, as the invoices list reads it.
const DEPOSIT = {
  id: "inv-deposit",
  direction: "receivable",
  counterparty_id: "c-acme",
  counterparty_name: "Acme Studio",
  amount: 3000,
  currency: "USDC",
  due_date: "2026-10-20T12:00:00.000Z",
  status: "pending",
  scheduled_for: null,
  created_at: "2026-10-06T09:00:00Z",
  memo: "Website rebuild: Deposit (30%)",
  po_reference: null,
};

const allocation = (over: Partial<AllocationRow>): AllocationRow => ({
  id: "alloc-1",
  kind: "payment",
  invoiceId: "inv-deposit",
  transferId: "transfer-1",
  amount: toMicros(1200),
  currency: "USDC",
  reverses: null,
  reason: null,
  basis: "person",
  paymentSeq: 1,
  createdBy: "u-owner",
  createdAt: "2026-10-10T09:00:00Z",
  ...over,
});

// 1,200.00 arrived and was applied, a 0.50 fee recorded, and a 500.00 payment applied by mistake then reversed.
const APPLIED: AllocationRow[] = [
  allocation({}),
  allocation({ id: "fee-1", kind: "fee", transferId: null, amount: toMicros(0.5), reason: "Transfer fee", basis: null, paymentSeq: null, createdAt: "2026-10-10T09:01:00Z" }),
  allocation({ id: "alloc-2", transferId: "transfer-2", amount: toMicros(500), paymentSeq: 2, createdAt: "2026-10-11T09:00:00Z" }),
  allocation({ id: "rev-2", kind: "reversal", transferId: "transfer-2", amount: toMicros(500), reverses: "alloc-2", reason: "Wrong invoice", basis: null, paymentSeq: 3, createdAt: "2026-10-11T10:00:00Z" }),
];
const OWED = 1799.5;

// The rows the console reads and how it hands them over: each receivable for what is still owed, the planned lines apart.
const outlookInput = (rows: readonly AllocationRow[]): OutlookInput => ({
  now: NOW,
  operatingUsdc: 500,
  payables: [],
  milestones: [],
  receivables: [{ ...DEPOSIT, amount: stillOwed(DEPOSIT, rows), counterparty: DEPOSIT.counterparty_name }],
  planned: plannedLinesOf([WEBSITE]),
});

const planRows = (rows: readonly AllocationRow[]): PlanRows => ({
  now: NOW,
  invoices: [DEPOSIT],
  planned: plannedLinesOf([WEBSITE]),
  owed: new Map([[DEPOSIT.id, stillOwed(DEPOSIT, rows)]]),
  counterparties: [],
  milestones: [],
  accounts: [{ kind: "operating", balance: 500, circle_wallet_id: "w-1", address: "0xop", balance_synced_at: new Date(NOW - 60_000).toISOString() }],
  chainMode: "live",
  walletHost: "hosted",
  budget: null,
  twoApprovalsAbove: null,
});

describe("a deal's released line, part paid", () => {
  it("is still owed what the payments and fees applied in force leave", () => {
    expect(stillOwed(DEPOSIT, APPLIED)).toBe(OWED);
    // No row names it: the whole line is owed. A row about another receivable changes nothing.
    expect(stillOwed(DEPOSIT, [])).toBe(3000);
    expect(stillOwed(DEPOSIT, [allocation({ invoiceId: "inv-other" })])).toBe(3000);
  });

  it("is never a planned line: only the balance not invoiced yet is", () => {
    expect(plannedLinesOf([WEBSITE]).map((planned) => [planned.id, planned.amount])).toEqual([["line-balance", 7000]]);
  });

  it("counts once on the cash outlook, for what it still owes, and the planned balance apart", () => {
    const outlook = cashOutlook(outlookInput(APPLIED));
    expect(outlook.expectedIn30d).toBe(OWED);
    expect(outlook.plannedIn30d).toBe(7000);
    expect(outlook.plannedCount).toBe(1);
    // The balance moves with the deposit's rest only: never its whole, never the planned balance.
    expect(outlook.days.at(-1)?.balanceWithExpected).toBe(500 + OWED);
    const items = outlook.days.flatMap((d) => d.items);
    expect(items.filter((item) => item.kind === "in").map((item) => item.amount)).toEqual([OWED]);
    expect(items.some((item) => item.label.includes("Balance on delivery"))).toBe(false);
  });

  it("counts once in the cash scenarios, for what it still owes, and names the planned balance apart", () => {
    const basis = scenarioBasis({ ...outlookInput(APPLIED), recurring: [] });
    expect(basis.receivables.map((receivable) => [receivable.id, receivable.amount])).toEqual([["inv-deposit", OWED]]);
    expect(basis.planned?.map((planned) => [planned.id, planned.amount])).toEqual([["line-balance", 7000]]);
    const onTime = cashScenario(basis, { horizon: 30, lateDays: 0, choices: { "inv-deposit": "on_time" }, costPct: 0, costScope: "all" });
    expect(onTime.receivables).toEqual({ base: OWED, scenario: OWED });
    expect(onTime.coverage.planned).toMatchObject({ count: 1, amount: 7000 });
  });

  it("counts once in the payment plan's money expected in, for what it still owes, and the planned balance apart", () => {
    const input = paymentPlanInput(planRows(APPLIED));
    expect(input.incoming?.receivables.map((receivable) => [receivable.id, receivable.amount])).toEqual([["inv-deposit", OWED]]);
    expect(input.incoming?.planned?.map((planned) => [planned.id, planned.amount])).toEqual([["line-balance", 7000]]);
    const plan = planPayments(input);
    expect(plan.incoming.expectedUsdc).toBe(OWED);
    expect(plan.incoming.plannedUsdc).toBe(7000);
    expect(plan.incoming.expected.map((expected) => expected.id)).toEqual(["inv-deposit"]);
  });

  it("counts in full everywhere once the payment applied is reversed", () => {
    const reversed = [...APPLIED.slice(2), allocation({}), allocation({ id: "rev-1", kind: "reversal", amount: toMicros(1200), reverses: "alloc-1", reason: "Wrong client", basis: null, paymentSeq: 4, createdAt: "2026-10-11T11:00:00Z" })];
    expect(cashOutlook(outlookInput(reversed)).expectedIn30d).toBe(3000);
    expect(planPayments(paymentPlanInput(planRows(reversed))).incoming.expectedUsdc).toBe(3000);
  });
});
