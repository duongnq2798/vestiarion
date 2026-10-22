import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StatementResults, VendorStatementCheck } from "@/components/VendorStatementCheck";
import type { VendorStatementResult } from "@/lib/vendor-statement/check";

/**
 * Check their statement on Counterparties (docs/superpowers/specs/2026-10-22-vendor-statement-design.md VS1, VS4): the
 * button, and what a check shows, each group only when it has something, Add this bill for whoever may add bills.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/actions/vendor-statement", () => ({ checkVendorStatementAction: vi.fn() }));
vi.mock("@/app/actions/intake", () => ({ createInvoiceAction: vi.fn() }));

const VENDOR = { id: "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de", name: "Northstar Studio" };
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

const result: VendorStatementResult = {
  vendorName: "Northstar Studio",
  period: { from: "2026-10-01", to: "2026-10-08" },
  currency: "USD",
  counts: { lines: 5, charges: 3, payments: 2, matchedCharges: 1, matchedPayments: 1 },
  missing: [{ line: 4, on: "2026-10-06", number: "INV-1003", description: "Revisions", amount: 25 }],
  twice: [],
  differs: [{ line: 3, number: "INV-1002", billId: "b", theirs: 60, ours: 65 }],
  paidNotListed: [{ billId: "c", number: "INV-0999", amount: 40, paidOn: "2026-10-05", txUrl: "https://explorer.arc.io/tx/0xabc" }],
  unknownPayments: [{ line: 6, on: "2026-10-08", description: "Payment received", amount: 999 }],
  notListed: [],
  balance: { theirs: 85, ours: 65 },
};

describe("Check their statement", () => {
  it("is a button on the vendor's row", () => {
    expect(text(renderToStaticMarkup(<VendorStatementCheck orgSlug="acme" vendor={VENDOR} canAddBills />))).toContain("Check their statement");
  });

  it("says how much matched, then each group with something in it, and the balances", () => {
    const shown = text(renderToStaticMarkup(<StatementResults orgSlug="acme" vendor={VENDOR} result={result} canAddBills />));
    expect(shown).toContain("1 of 3 charges and 1 of 2 payments on their statement match your books, 2026-10-01 to 2026-10-08.");
    expect(shown).toContain("Missing here (1)");
    expect(shown).toContain("Line 4, 2026-10-06: INV-1003, 25.00 USD, Revisions");
    expect(shown).toContain("Amount differs (1)");
    expect(shown).toContain("INV-1002: theirs 60.00 USD, yours 65.00 USD, a difference of -5.00 USD");
    expect(shown).toContain("Paid, not on their statement (1)");
    expect(shown).toContain("40.00 USD paid 2026-10-05 for INV-0999: the transaction , to send them");
    expect(shown).toContain("A payment you have no record of (1)");
    expect(shown).not.toContain("Listed twice");
    expect(shown).not.toContain("Not on their statement (");
    expect(shown).toContain("Their balance: 85.00 USD. What your open bills to Northstar Studio add up to: 65.00 USD.");
  });

  it("offers Add this bill to whoever may add bills, and says an owner or admin adds it to an accountant", () => {
    expect(text(renderToStaticMarkup(<StatementResults orgSlug="acme" vendor={VENDOR} result={result} canAddBills />))).toContain("Add this bill");
    const accountant = text(renderToStaticMarkup(<StatementResults orgSlug="acme" vendor={VENDOR} result={result} canAddBills={false} />));
    expect(accountant).not.toContain("Add this bill");
    expect(accountant).toContain("An owner or admin adds it.");
  });

  it("says when everything matches", () => {
    const clean = { ...result, missing: [], differs: [], paidNotListed: [], unknownPayments: [], counts: { ...result.counts, matchedCharges: 3, matchedPayments: 2 } };
    expect(text(renderToStaticMarkup(<StatementResults orgSlug="acme" vendor={VENDOR} result={clean} canAddBills />))).toContain(
      "Everything on their statement matches your books, and everything on your books for those days is on it."
    );
  });
});
