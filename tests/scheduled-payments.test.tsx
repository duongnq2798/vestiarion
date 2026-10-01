import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ScheduledPayments, scheduledPaymentRows } from "@/components/vx/ScheduledPayments";
import type { InvoiceRow } from "@/lib/queries";

/**
 * The console's "Scheduled payments" section (payment timing, 2026-09-30):
 * up to 5 scheduled payables, soonest first, derived from the invoices the
 * console already loads — no extra query.
 */

const html = (node: ReactElement) => renderToStaticMarkup(node);

function invoice(overrides: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: "inv-1",
    direction: "payable",
    counterparty_id: "cp-1",
    counterparty_name: "Northwind Supply",
    amount: 400,
    memo: null,
    po_reference: null,
    goods_received: true,
    due_date: "2026-11-09T12:00:00.000Z",
    status: "scheduled",
    agent_reasoning: "Paying on the discount deadline. The due date is later.",
    tx_ref: null,
    scheduled_for: "2026-10-10T00:00:00.000Z",
    early_pay_discount_pct: "2.00",
    discount_due_date: "2026-10-10T12:00:00.000Z",
    paid_amount: null,
    ...overrides,
  };
}

describe("scheduledPaymentRows", () => {
  it("keeps only scheduled invoices, soonest first", () => {
    const rows = scheduledPaymentRows([
      invoice({ id: "a", scheduled_for: "2026-10-20T00:00:00.000Z", early_pay_discount_pct: null, discount_due_date: null }),
      invoice({ id: "b", status: "paid", scheduled_for: null }),
      invoice({ id: "c", scheduled_for: "2026-10-10T00:00:00.000Z", early_pay_discount_pct: null, discount_due_date: null }),
      invoice({ id: "d", status: "pending", scheduled_for: null }),
    ]);
    expect(rows.map((row) => row.id)).toEqual(["c", "a"]);
  });

  it("caps the list at 5", () => {
    const invoices = Array.from({ length: 8 }, (_, i) =>
      invoice({ id: `inv-${i}`, scheduled_for: `2026-10-${String(10 + i).padStart(2, "0")}T00:00:00.000Z`, early_pay_discount_pct: null, discount_due_date: null })
    );
    expect(scheduledPaymentRows(invoices)).toHaveLength(5);
  });

  it("uses the discounted amount when the discount will still apply on the scheduled day", () => {
    const [row] = scheduledPaymentRows([invoice({ amount: 400, early_pay_discount_pct: "2.00", discount_due_date: "2026-10-10T12:00:00.000Z", scheduled_for: "2026-10-10T00:00:00.000Z" })]);
    expect(row.amount).toBe(392);
  });

  it("uses the full amount once the discount deadline has passed", () => {
    const [row] = scheduledPaymentRows([invoice({ amount: 400, early_pay_discount_pct: "2.00", discount_due_date: "2026-10-05T12:00:00.000Z", scheduled_for: "2026-10-30T00:00:00.000Z" })]);
    expect(row.amount).toBe(400);
  });

  it("takes only the first sentence of the reasoning", () => {
    const [row] = scheduledPaymentRows([invoice({ agent_reasoning: "Paying on the discount deadline. The due date is later." })]);
    expect(row.reasoning).toBe("Paying on the discount deadline.");
  });

  it("copes with no reasoning yet", () => {
    const [row] = scheduledPaymentRows([invoice({ agent_reasoning: null })]);
    expect(row.reasoning).toBe("");
  });
});

describe("ScheduledPayments", () => {
  it("titles the section Scheduled payments, and shows the date, counterparty, amount and reasoning", () => {
    const markup = html(
      <ScheduledPayments
        payments={[{ id: "inv-1", counterparty: "Northwind Supply", date: "2026-10-10T00:00:00.000Z", amount: 392, currency: "USDC", reasoning: "Paying on the discount deadline." }]}
      />
    );
    expect(markup).toContain("Scheduled payments");
    expect(markup).toContain("Northwind Supply");
    expect(markup).toContain("Oct 10, 2026");
    expect(markup).toContain("392.00");
    expect(markup).toContain("Paying on the discount deadline.");
  });

  it("renders nothing when there is nothing scheduled", () => {
    expect(html(<ScheduledPayments payments={[]} />)).toBe("");
  });
});

describe("a scheduled EURC payable", () => {
  it("keeps its currency, and is shown in it", () => {
    const rows = scheduledPaymentRows([invoice({ currency: "EURC", early_pay_discount_pct: null, discount_due_date: null })]);
    expect(rows[0]).toMatchObject({ amount: 400, currency: "EURC" });
    expect(html(<ScheduledPayments payments={rows} />)).toMatch(/400\.00<\/span><span[^>]*>EURC<\/span>/);
  });
});
