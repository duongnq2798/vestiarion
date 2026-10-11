import { describe, expect, it } from "vitest";
import { planOutcomes } from "@/lib/payment-plan-outcomes";

/**
 * The payment plan's three measures over the last 30 days (payment plan design P14): bills paid by their due day,
 * discounts actually taken, and days a person moved. Measured from what happened, never from a plan.
 */

const NOW = Date.UTC(2026, 9, 11, 9, 0);

const paid = (fields: Record<string, unknown> = {}) => ({
  direction: "payable",
  status: "paid",
  amount: 100,
  currency: "USDC",
  due_date: "2026-10-05T12:00:00.000Z",
  settled_at: "2026-10-05T08:00:00.000Z",
  paid_amount: 100,
  early_pay_discount_pct: null,
  discount_due_date: null,
  ...fields,
});

describe("planOutcomes", () => {
  it("counts bills paid by their due day (UTC) over the last 30 days, and the ones still overdue", () => {
    const outcomes = planOutcomes({
      now: NOW,
      invoices: [
        paid(),
        paid({ settled_at: "2026-10-06T01:00:00.000Z" }),
        paid({ settled_at: "2026-08-01T00:00:00.000Z", due_date: "2026-08-02T12:00:00.000Z" }),
        paid({ direction: "receivable" }),
        paid({ status: "scheduled", settled_at: null, paid_amount: null, due_date: "2026-10-09T12:00:00.000Z" }),
        paid({ status: "held", settled_at: null, paid_amount: null, due_date: "2026-10-12T12:00:00.000Z" }),
      ],
      entries: [],
    });
    expect(outcomes).toMatchObject({ paid: 2, paidOnTime: 1, overdueNow: 1 });
  });

  it("measures a discount taken from what the transfer carried, and nothing from terms alone", () => {
    const outcomes = planOutcomes({
      now: NOW,
      invoices: [
        paid({ paid_amount: 98, early_pay_discount_pct: "2.00", discount_due_date: "2026-10-03T12:00:00.000Z" }),
        paid({ status: "scheduled", settled_at: null, paid_amount: null, early_pay_discount_pct: "5.00", discount_due_date: "2026-10-12T12:00:00.000Z", due_date: "2026-10-20T12:00:00.000Z" }),
        paid({ paid_amount: 90 }),
      ],
      entries: [],
    });
    expect(outcomes.discountsTaken).toBe(2);
  });

  it("counts the days people moved from the plan over the last 30 days", () => {
    const outcomes = planOutcomes({
      now: NOW,
      invoices: [],
      entries: [
        { ts: "2026-10-10T10:00:00.000Z", action: "payment_rescheduled" },
        { ts: "2026-10-01T10:00:00.000Z", action: "payment_rescheduled" },
        { ts: "2026-08-01T10:00:00.000Z", action: "payment_rescheduled" },
        { ts: "2026-10-10T10:00:00.000Z", action: "approval_paid" },
      ],
    });
    expect(outcomes.moves).toBe(2);
  });
});
