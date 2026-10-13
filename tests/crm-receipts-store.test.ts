import { describe, expect, it, vi } from "vitest";
import type { DealRecord } from "@/lib/deals/read";

vi.mock("server-only", () => ({}));

const { dealFields } = await import("@/lib/connectors/crm-receipts-store");

/**
 * What a deal collected, from the rows as the store reads them (docs/superpowers/specs/2026-10-13-crm-receipts-design.md
 * R1): the deal's receivables, the allocations on them (a reversal undoes its row), the payments that brought them, and
 * the whole matches. Only money that arrived on Arc and was applied counts.
 */

const HASH = `0x${"ab".repeat(32)}`;

const deal = (lines: Array<{ id: string; status: "planned" | "released"; amountMinor: number; receivable?: string }>): DealRecord => ({
  facts: {
    id: "deal-1",
    status: "active",
    version: 1,
    totalMinor: lines.reduce((sum, line) => sum + line.amountMinor, 0),
    currency: "USDC",
    startsOn: "2026-10-01",
    termsDays: 14,
    autoRelease: false,
    lines: lines.map((line, index) => ({
      id: line.id,
      position: index + 1,
      kind: "charge",
      label: `Line ${index + 1}`,
      invoiceOn: "2026-10-01",
      dueOn: "2026-10-15",
      amountMinor: line.amountMinor,
      roundingMinor: 0,
      status: line.status,
      addedIn: 1,
      endedIn: null,
      replaces: null,
      releasedAt: line.status === "released" ? "2026-10-01T00:00:00Z" : null,
      releasedVia: line.status === "released" ? "person" : null,
      receivable: line.receivable ? { id: line.receivable, status: "pending", dueDate: "2026-10-15" } : null,
    })),
  },
  title: "Website rebuild",
  customer: { id: "cp-1", name: "Northwind" },
  digits: 2,
  externalRef: "9001",
  template: "custom",
  createdBy: null,
  createdAt: "2026-10-01T00:00:00Z",
  autoReleaseBy: null,
  autoReleaseAt: null,
  versions: [],
});

const receivable = (id: string, amount: number, status = "pending") => ({
  id,
  deal_id: "deal-1",
  amount: amount.toFixed(6),
  currency: "USDC",
  status,
  due_date: "2026-10-15T12:00:00+00:00",
  original_currency: null,
  original_amount: null,
});

const transfer = (id: string, amount: number, invoiceId: string | null, receivedAt: string) => ({ id, invoice_id: invoiceId, amount: amount.toFixed(6), received_at: receivedAt, tx_hash: HASH, chain: "ARC-TESTNET" });

describe("dealFields", () => {
  it("counts live allocations and whole matches, undoes a reversed one, and leaves the planned line uninvoiced", () => {
    const fields = dealFields({
      deal: deal([
        { id: "l1", status: "released", amountMinor: 300000, receivable: "r1" },
        { id: "l2", status: "released", amountMinor: 200000, receivable: "r2" },
        { id: "l3", status: "planned", amountMinor: 500000 },
      ]),
      receivables: [receivable("r1", 3000, "received"), receivable("r2", 2000)],
      allocations: [
        { id: "a1", kind: "payment", invoice_id: "r2", transfer_id: "t2", amount: "800.000000", reverses: null },
        { id: "a2", kind: "payment", invoice_id: "r2", transfer_id: "t3", amount: "500.000000", reverses: null },
        { id: "a3", kind: "reversal", invoice_id: "r2", transfer_id: "t3", amount: "500.000000", reverses: "a2" },
      ],
      transfers: new Map([
        ["t2", transfer("t2", 800, null, "2026-10-12T09:00:00Z")],
        ["t3", transfer("t3", 500, null, "2026-10-12T12:00:00Z")],
      ]),
      wholeMatches: [transfer("t1", 3000, "r1", "2026-10-10T09:00:00Z")],
      today: "2026-10-13",
      evidence: "https://www.vestiarion.xyz/o/northstar/invoices/deals/deal-1",
    });
    expect(fields).toMatchObject({
      vestiarion_collected: "3800.00",
      vestiarion_still_owed: "1200.00",
      vestiarion_collection_status: "partly_paid",
      vestiarion_last_receipt_date: "2026-10-12",
      vestiarion_last_receipt_amount: "800.00",
      vestiarion_reconciliation: "reconciled",
    });
  });

  it("never counts an invoice marked received with no payment on Arc", () => {
    const fields = dealFields({
      deal: deal([{ id: "l1", status: "released", amountMinor: 300000, receivable: "r1" }]),
      receivables: [receivable("r1", 3000, "received")],
      allocations: [],
      transfers: new Map(),
      wholeMatches: [],
      today: "2026-10-13",
      evidence: "https://example.test/d",
    });
    expect(fields).toMatchObject({ vestiarion_collected: "0.00", vestiarion_still_owed: "0.00", vestiarion_reconciliation: "needs_review", vestiarion_last_receipt_date: "" });
  });
});
