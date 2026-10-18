import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SupplierStatusView } from "@/components/supplier/SupplierStatusView";
import { buildSupplierStatus } from "@/lib/supplier-status/model";

/**
 * A supplier's payment status page (docs/superpowers/specs/2026-10-18-supplier-status-design.md V2, V5, V7): it names
 * only the business, the supplier and its own bills, says where each stands without saying why a bill is held, links
 * each payment's transaction, and says once who pays through Vestiarion. The members' list of links is held to the same
 * words by the link test; here, the page a supplier reads.
 */

vi.mock("server-only", () => ({}));

const NOW = Date.parse("2026-10-18T09:00:00Z");

const view = buildSupplierStatus({
  orgName: "Pinecrest Studio",
  supplierName: "Cobalt Cloud",
  expiresAt: "2026-11-17T09:00:00Z",
  now: NOW,
  explorerTx: "https://explorer.testnet.arc.io/tx/",
  bills: [
    {
      id: "held",
      amount: 140,
      currency: "USDC",
      dueDate: "2026-10-22",
      memo: "CC-2026-1020 render farm",
      poReference: "PO-CC-1020",
      status: "held",
      scheduledFor: null,
      settledAt: null,
      txHash: null,
      inFlight: false,
    },
    {
      id: "paid",
      amount: 50,
      currency: "USDC",
      dueDate: "2026-10-17",
      memo: "CC-2026-1024 production database backups",
      poReference: null,
      status: "paid",
      scheduledFor: null,
      settledAt: "2026-10-17T21:44:13Z",
      txHash: "0x1adfad848f00fdadf7021ba1f1ac30505146c40c220eac8cbca36cfc479e3a7b",
      inFlight: false,
    },
  ],
});

describe("SupplierStatusView", () => {
  const html = renderToStaticMarkup(<SupplierStatusView view={view} />);
  const text = html.replace(/<[^>]+>/g, " ").replace(/&rsquo;/g, "’").replace(/\s+/g, " ");

  it("names the business and the supplier, and what is still to be paid", () => {
    expect(text).toContain("Pinecrest Studio’s payments to Cobalt Cloud");
    expect(text).toContain("As of Oct 18, 2026. This link works until Nov 17, 2026.");
    expect(text).toContain("Still to be paid 140.00 USDC");
  });

  it("says a held bill is being reviewed, and never why", () => {
    expect(text).toContain("CC-2026-1020 render farm Being reviewed");
    expect(text).toContain("140.00 USDC · due Oct 22, 2026 · purchase order PO-CC-1020");
    expect(text).not.toMatch(/cash|short|guardrail|flag|limit|agent chose|priority/i);
  });

  it("links a paid bill's transaction on the explorer", () => {
    expect(text).toContain("Paid recently");
    expect(text).toContain("Paid on Oct 17, 2026");
    expect(html).toContain('href="https://explorer.testnet.arc.io/tx/0x1adfad848f00fdadf7021ba1f1ac30505146c40c220eac8cbca36cfc479e3a7b"');
  });

  it("says once who pays through Vestiarion, linking to what it is", () => {
    expect(text).toContain("Pinecrest Studio pays its bills through Vestiarion , an AI agent for bills and payments.");
    expect(html).toContain('href="/?from=supplier-status"');
  });
});
