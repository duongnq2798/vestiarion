import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/intake", () => ({ createInvoiceAction: vi.fn() }));

import InvoiceIntake from "@/components/intake/InvoiceIntake";

/** The invoice form as the server renders it (EURC invoices design E1). */
describe("InvoiceIntake", () => {
  const markup = renderToStaticMarkup(
    <InvoiceIntake orgSlug="acme" counterparties={[{ id: "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de", name: "Northstar Studio", role: "vendor" }]} />
  );

  it("asks for the amount, and its currency in a field of its own", () => {
    expect(markup).toContain(">Amount<");
    expect(markup).not.toContain("Amount (USDC)");
    expect(markup).toContain(">Currency<");
    // Radix renders its options only on the client; the hidden native select carries the field's name.
    expect(markup).toMatch(/<select[^>]*name="currency"/);
  });
});

describe("the CSV import's preview (review M2)", () => {
  it("shows each row's currency before anything is imported, USDC where the row leaves it blank", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/components/intake/InvoiceCsvImport.tsx", "utf8");
    expect(source).toContain('"Amount", "Currency"');
    expect(source).toContain('{row.currency ? row.currency.toUpperCase() : "USDC"}');
  });
});

describe("the counterparty form's chain (CCTP payouts X1)", () => {
  it("offers the chains Vestiarion pays on, Arc testnet first", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/components/intake/CounterpartyIntake.tsx", "utf8");
    expect(source).toContain('<Select name="chain" defaultValue="ARC-TESTNET">');
    expect(source).toContain("PAYEE_CHAINS.map");
  });
});
