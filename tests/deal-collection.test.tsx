import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DealFigures } from "@/components/deals/DealFigures";
import { DealsSection } from "@/components/deals/DealsSection";
import { collectionOfRows, type CollectionRows } from "@/lib/deals/collection";
import { dealSummary } from "@/lib/deals/lines";
import { minorToDecimal } from "@/lib/deals/money";
import type { DealRecord } from "@/lib/deals/read";

vi.mock("server-only", () => ({}));

const { dealFields } = await import("@/lib/connectors/crm-receipts-store");

/**
 * One figure for the money a deal collected (docs/superpowers/specs/2026-10-13-crm-receipts-design.md R1): the deal's
 * page (Paid, Outstanding), the Deals list and the Collected and Still owed written to the CRM all read
 * `collectionOfRows`. A part payment counts as what arrived; a fee a person marked settles its invoice and is never paid.
 */

const HASH = `0x${"ab".repeat(32)}`;
const TODAY = "2026-10-13";

const line = (id: string, amountMinor: number, receivable: { id: string; status: string } | null) => ({
  id,
  position: Number(id.slice(1)),
  kind: "charge" as const,
  label: `Line ${id}`,
  invoiceOn: "2026-10-01",
  dueOn: "2026-10-20",
  amountMinor,
  roundingMinor: 0,
  status: receivable ? ("released" as const) : ("planned" as const),
  addedIn: 1,
  endedIn: null,
  replaces: null,
  releasedAt: receivable ? "2026-10-01T00:00:00Z" : null,
  releasedVia: receivable ? ("person" as const) : null,
  receivable: receivable ? { ...receivable, dueDate: "2026-10-20" } : null,
});

// Three lines: one part paid (2,000 of 3,000), one settled by 1,990 paid and a 10.00 fee a person marked, one planned.
const DEAL: DealRecord = {
  facts: {
    id: "deal-1",
    status: "active",
    version: 1,
    totalMinor: 1_000_000,
    currency: "USDC",
    startsOn: "2026-10-01",
    termsDays: 19,
    autoRelease: false,
    lines: [line("l1", 300_000, { id: "r1", status: "pending" }), line("l2", 200_000, { id: "r2", status: "received" }), line("l3", 500_000, null)],
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
};

const receivable = (id: string, amount: number, status: string) => ({
  id,
  deal_id: "deal-1",
  amount: amount.toFixed(6),
  currency: "USDC",
  status,
  due_date: "2026-10-20T12:00:00+00:00",
  original_currency: null,
  original_amount: null,
});
const transfer = (id: string, amount: number, receivedAt: string) => ({ id, invoice_id: null, amount: amount.toFixed(6), received_at: receivedAt, tx_hash: HASH, chain: "ARC-TESTNET" });

const ROWS: CollectionRows = {
  receivables: [receivable("r1", 3000, "pending"), receivable("r2", 2000, "received")],
  allocations: [
    { id: "a1", kind: "payment", invoice_id: "r1", transfer_id: "t1", amount: "2000.000000", reverses: null },
    { id: "a2", kind: "payment", invoice_id: "r2", transfer_id: "t2", amount: "1990.000000", reverses: null },
    { id: "a3", kind: "fee", invoice_id: "r2", transfer_id: null, amount: "10.000000", reverses: null },
  ],
  transfers: new Map([
    ["t1", transfer("t1", 2000, "2026-10-11T09:00:00Z")],
    ["t2", transfer("t2", 1990, "2026-10-12T09:00:00Z")],
  ]),
  wholeMatches: [],
};

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

/** The figure a tile shows, by its label. */
function tile(markup: string, label: string): string {
  const read = text(markup);
  const at = read.indexOf(` ${label} `);
  expect(at, label).toBeGreaterThanOrEqual(0);
  return /([\d,]+\.\d{2})/.exec(read.slice(at + label.length + 2))?.[1] ?? "";
}

describe("what a deal collected, one figure wherever it is shown", () => {
  const collection = collectionOfRows(DEAL, ROWS, TODAY);

  it("counts a part payment as what arrived, and never a fee", () => {
    expect(collection).toMatchObject({ collectedMinor: 399_000, feesMinor: 1_000, stillOwedMinor: 100_000, invoicedMinor: 500_000, status: "partly_paid" });
    // The lines alone count only the invoice settled whole, fee and all: 2,000.00, never what arrived.
    expect(dealSummary(DEAL.facts, TODAY).paidMinor).toBe(200_000);
  });

  it("shows on the deal's page the Paid and Outstanding written to the CRM as Collected and Still owed", () => {
    const markup = renderToStaticMarkup(<DealFigures deal={DEAL} today={TODAY} collected={collection} />);
    const fields = dealFields({ deal: DEAL, ...ROWS, today: TODAY, evidence: "https://example.test/o/acme/invoices/deals/deal-1" });
    expect(fields.vestiarion_collected).toBe("3990.00");
    expect(fields.vestiarion_still_owed).toBe("1000.00");
    expect(tile(markup, "Paid")).toBe("3,990.00");
    expect(tile(markup, "Outstanding")).toBe("1,000.00");
    expect(tile(markup, "Paid").replace(/,/g, "")).toBe(fields.vestiarion_collected);
    expect(minorToDecimal(collection.collectedMinor, 2)).toBe(fields.vestiarion_collected);
    // The fee is said, never counted.
    expect(text(markup)).toMatch(/fees of 10\.00 USDC settled the rest/);
  });

  it("shows the same figures on the Deals list", () => {
    const markup = renderToStaticMarkup(<DealsSection deals={[DEAL]} orgSlug="acme" today={TODAY} collected={new Map([[DEAL.facts.id, collection]])} />);
    expect(text(markup)).toContain("Paid 3,990.00 USDC");
    expect(text(markup)).toContain("Outstanding 1,000.00 USDC");
  });

  it("never counts an invoice marked received with no payment on Arc, and says so on the tile", () => {
    const unverified = collectionOfRows(DEAL, { receivables: [receivable("r2", 2000, "received")], allocations: [], transfers: new Map(), wholeMatches: [] }, TODAY);
    const markup = renderToStaticMarkup(<DealFigures deal={DEAL} today={TODAY} collected={unverified} />);
    expect(tile(markup, "Paid")).toBe("0.00");
    expect(text(markup)).toMatch(/2,000\.00 USDC marked received without a payment on Arc is not counted/);
  });

  it("says a collection it could not read was not read, rather than show another figure", () => {
    const markup = text(renderToStaticMarkup(<DealFigures deal={DEAL} today={TODAY} collected={null} />));
    expect(markup).toContain("Paid — Not read: reload the page in a moment");
    expect(markup).toContain("Outstanding — Not read");
    const list = text(renderToStaticMarkup(<DealsSection deals={[DEAL]} orgSlug="acme" today={TODAY} />));
    expect(list).not.toContain("Paid ");
    expect(list).toContain("Released 5,000.00 USDC");
  });
});
