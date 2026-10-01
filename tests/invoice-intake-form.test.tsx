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
