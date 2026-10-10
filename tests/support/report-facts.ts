import type { ReportBill, ReportDecision, ReportFacts, ReportPayment } from "@/lib/workspace-report";

/** Hand-made report facts for the value groups and the shared report's tests: one bill, decision or payment at a time. */

export const OPENED = "2026-10-01T00:00:00.000Z";

export function bill(id: string, over: Partial<ReportBill> = {}): ReportBill {
  return {
    id,
    createdAt: "2026-10-02T10:00:00.000Z",
    dueDate: "2026-10-10T00:00:00.000Z",
    amount: 100,
    currency: "USDC",
    status: "pending",
    reviewedBy: null,
    paidAmount: null,
    discount: null,
    bill: null,
    payee: { id: `payee-${id}`, name: `Payee ${id}`, mirror: false, sample: false },
    ...over,
  };
}

export function decision(seq: number, invoiceId: string, over: Partial<ReportDecision> = {}): ReportDecision {
  return {
    seq,
    ts: "2026-10-02T10:01:00.000Z",
    action: "ap_pay",
    invoiceId,
    guardrailBlocked: false,
    guardrailRule: null,
    heldBecause: null,
    resultingStatus: "paid",
    shadow: false,
    reasoning: "Pay it. The bill matches the order.",
    ...over,
  };
}

export function payment(invoiceId: string, over: Partial<ReportPayment> = {}): ReportPayment {
  return { invoiceId, amount: 100, token: "USDC", txHash: `0x${"a".repeat(64)}`, at: "2026-10-02T10:02:00.000Z", simulated: false, ...over };
}

export function facts(over: Partial<ReportFacts> = {}): ReportFacts {
  return { network: "arc-testnet", sandbox: false, openedAt: OPENED, shadow: null, bills: [], decisions: [], personActions: [], verdicts: [], payments: [], ...over };
}
