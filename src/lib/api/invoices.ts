/**
 * The values `GET /api/v1/invoices` accepts for its `direction` and `status`
 * filters. Kept here rather than in the route so the OpenAPI document can
 * import the same lists the route validates against.
 */
export const INVOICE_DIRECTIONS = ["payable", "receivable"] as const;
export const INVOICE_STATUSES = [
  "pending", "matched", "scheduled", "paid", "held", "flagged", "awaiting_info", "received", "rejected",
] as const;

export interface InvoicePayload {
  id: string;
  direction: (typeof INVOICE_DIRECTIONS)[number];
  status: string;
  amount: number;
  currency: string;
  memo: string | null;
  poReference: string | null;
  goodsReceived: boolean;
  dueDate: string;
  /** ISO timestamp the agent has committed to pay this on, once scheduled; else null. */
  scheduledFor: string | null;
  /** The early-payment discount this invoice carries, if any: the percent off and the deadline's ISO timestamp. */
  earlyPayDiscount: { percent: number; deadline: string } | null;
  decidedAt: string | null;
  settledAt: string | null;
  escalatedAt: string | null;
  /** Why the agent ruled as it did, verbatim from the decision. */
  agentReasoning: string | null;
  /** An on-chain hash when the payment settled on Arc, else null. */
  txHash: string | null;
  /** What actually left once this invoice was paid; null otherwise, even while a submitted transfer already carries an amount. */
  paidAmount: number | null;
  counterparty: { id: string; name: string; riskLevel: string } | null;
  createdAt: string;
}

/** What `GET /api/v1/invoices` reads for each invoice, and what a write reads back to answer in the same shape. */
export const INVOICE_SELECT =
  "id, direction, status, amount, currency, memo, po_reference, goods_received, due_date, scheduled_for, early_pay_discount_pct, discount_due_date, decided_at, settled_at, escalated_at, agent_reasoning, tx_ref, paid_amount, created_at, counterparties(id, name, risk_level)";

/**
 * `early_pay_discount_pct` and `discount_due_date` (migration 0038), read the
 * way `invoiceDiscount` in `src/lib/agent/payment-timing.ts` reads them for
 * the AP stage: a percent outside (0, 100), or a deadline that is not a real
 * date, is reported as no discount at all, never a malformed one. A change to
 * one belongs in the other, so the API never reports terms the agent would
 * not pay by, or the reverse.
 */
function invoiceDiscountOf(rawPct: unknown, rawDeadline: unknown): { percent: number; deadline: string } | null {
  if (rawPct == null || rawDeadline == null) return null;
  const percent = Number(rawPct);
  if (!Number.isFinite(percent) || percent <= 0 || percent >= 100) return null;
  const deadline = String(rawDeadline);
  if (Number.isNaN(Date.parse(deadline))) return null;
  return { percent, deadline };
}

/** An invoice row, read with `INVOICE_SELECT`, as the API returns it. */
export function mapInvoice(row: Record<string, unknown>): InvoicePayload {
  const embedded = row.counterparties as
    | { id: string; name: string; risk_level: string }
    | null;
  const txRef = row.tx_ref == null ? null : String(row.tx_ref);
  const status = String(row.status);
  return {
    id: String(row.id),
    direction: row.direction as InvoicePayload["direction"],
    status,
    amount: Number(row.amount),
    currency: String(row.currency ?? "USDC"),
    memo: row.memo == null ? null : String(row.memo),
    poReference: row.po_reference == null ? null : String(row.po_reference),
    goodsReceived: row.goods_received === true,
    dueDate: String(row.due_date),
    scheduledFor: row.scheduled_for == null ? null : String(row.scheduled_for),
    earlyPayDiscount: invoiceDiscountOf(row.early_pay_discount_pct, row.discount_due_date),
    decidedAt: row.decided_at == null ? null : String(row.decided_at),
    settledAt: row.settled_at == null ? null : String(row.settled_at),
    escalatedAt: row.escalated_at == null ? null : String(row.escalated_at),
    agentReasoning: row.agent_reasoning == null ? null : String(row.agent_reasoning),
    // Only a real chain hash is reported as one. A simulated reference
    // is not a transaction anybody can look up.
    txHash: txRef?.startsWith("0x") ? txRef : null,
    // paid_amount can already be set while a discounted transfer is
    // merely submitted (status "matched"); only "paid" means it landed.
    paidAmount: status === "paid" && row.paid_amount != null ? Number(row.paid_amount) : null,
    counterparty: embedded
      ? { id: embedded.id, name: embedded.name, riskLevel: embedded.risk_level }
      : null,
    createdAt: String(row.created_at),
  };
}
