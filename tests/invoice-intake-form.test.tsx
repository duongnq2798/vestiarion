import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IntakeActionResult } from "@/app/actions/intake";
import { INVOICE_FIELD_LABELS } from "@/lib/intake-validation";

vi.mock("@/app/actions/intake", () => ({ createInvoiceAction: vi.fn() }));

/** A refused submission's result, put in place of the form's initial one when a test sets it. */
const refused = vi.hoisted(() => ({ state: null as IntakeActionResult | null }));
vi.mock("@/components/ui/useActionForm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/useActionForm")>();
  return {
    ...actual,
    useActionForm: ((...args: Parameters<typeof actual.useActionForm>) => {
      const real = actual.useActionForm(...args);
      return refused.state ? { ...real, state: refused.state } : real;
    }) as typeof actual.useActionForm,
  };
});

import InvoiceIntake, { amountNote } from "@/components/intake/InvoiceIntake";

const COUNTERPARTIES = [{ id: "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de", name: "Northstar Studio", role: "vendor" }];
const DEADLINE_MISSING = "Enter the last day the discount applies, on or before the due date, or clear the discount.";

/** The `<input>` tag carrying this name. */
const input = (markup: string, name: string) => markup.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0] ?? "";

/** The invoice form as the server renders it (EURC invoices design E1). */
describe("InvoiceIntake", () => {
  const markup = renderToStaticMarkup(<InvoiceIntake orgSlug="acme" counterparties={COUNTERPARTIES} />);

  it("asks for the amount, and its currency in a field of its own", () => {
    expect(markup).toContain(">Amount<");
    expect(markup).not.toContain("Amount (USDC)");
    expect(markup).toContain(">Currency<");
    // Radix renders its options only on the client; the hidden native select carries the field's name.
    expect(markup).toMatch(/<select[^>]*name="currency"/);
  });

  it("labels each field the way a refusal from the server names it", () => {
    for (const label of Object.values(INVOICE_FIELD_LABELS)) expect(markup).toContain(`>${label}<`);
  });
});

describe("InvoiceIntake for an invoice that arrived by email (reader follow-up F5)", () => {
  const EMAIL = "0b6c1c9e-4a4f-4a7e-9b1e-000000000e42";
  const markup = renderToStaticMarkup(
    <InvoiceIntake orgSlug="acme" counterparties={COUNTERPARTIES} inboxEmailId={EMAIL} action={vi.fn()} initial={{ amount: "3.50", currency: "USDC", dueDate: "2026-10-15" }} />
  );

  it("posts the email, always as a payable, with no direction to choose", () => {
    expect(input(markup, "inboxEmailId")).toContain(`value="${EMAIL}"`);
    expect(input(markup, "direction")).toMatch(/type="hidden"[^>]*value="payable"|value="payable"[^>]*type="hidden"/);
    expect(markup).not.toContain(">Direction<");
    expect(input(markup, "amount")).toContain('value="3.50"');
  });

  it("says a document cannot tell whether the goods were received", () => {
    expect(markup).toContain("A document cannot say this; tick it only if you received them.");
  });
});

describe("an amount typed over the one read (reader follow-up F7)", () => {
  it("says what the invoice was read as, when the amount typed differs", () => {
    expect(amountNote("1.20", "1.5")).toBe("The invoice was read as 1.20: check this amount before you add it.");
  });

  it("says nothing when they agree, when nothing was read, or while the field is empty or not a number", () => {
    for (const typed of ["1.2", "1.20", "1.200000", " 1.20 "]) expect(amountNote("1.20", typed), typed).toBeUndefined();
    expect(amountNote(null, "1.5")).toBeUndefined();
    expect(amountNote(undefined, "1.5")).toBeUndefined();
    expect(amountNote("1.20", "")).toBeUndefined();
    expect(amountNote("1.20", "1,5")).toBeUndefined();
  });
});

describe("the invoice form's early-payment discount", () => {
  afterEach(() => {
    refused.state = null;
  });

  it("leaves both discount fields optional while neither is filled in, and says the deadline comes with a percent", () => {
    const markup = renderToStaticMarkup(<InvoiceIntake orgSlug="acme" counterparties={COUNTERPARTIES} />);
    expect(input(markup, "discountDeadline")).not.toContain("required");
    expect(input(markup, "earlyPayDiscountPct")).not.toContain("required");
    expect(markup).toContain("Needed with a discount: the last day it applies, on or before the due date.");
  });

  it("shows no example percent in the empty field, where it could pass for one entered", () => {
    // The guide's screenshot showed a grey "2" in an empty discount field, beside an optional deadline.
    const markup = renderToStaticMarkup(<InvoiceIntake orgSlug="acme" counterparties={COUNTERPARTIES} />);
    expect(input(markup, "earlyPayDiscountPct")).not.toContain("placeholder=");
  });

  it("requires the deadline, no later than the due date, once a percent is entered", () => {
    const markup = renderToStaticMarkup(
      <InvoiceIntake orgSlug="acme" counterparties={COUNTERPARTIES} initial={{ dueDate: "2026-10-05", earlyPayDiscountPct: "2" }} />
    );
    const deadline = input(markup, "discountDeadline");
    expect(deadline).toContain('required=""');
    expect(deadline).toContain('max="2026-10-05"');
    expect(markup).toMatch(/<label for="invoice-discount-deadline"[^>]*>Discount deadline<\/label>/);
  });

  it("requires the percent once a deadline is entered", () => {
    const markup = renderToStaticMarkup(<InvoiceIntake orgSlug="acme" counterparties={COUNTERPARTIES} initial={{ discountDeadline: "2026-10-01" }} />);
    expect(input(markup, "earlyPayDiscountPct")).toContain('required=""');
    expect(markup).toMatch(/<label for="invoice-discount-pct"[^>]*>Early-payment discount \(%\)<\/label>/);
  });

  it("shows a refusal's error under the field it is about, and marks only that field invalid", () => {
    refused.state = { ok: false, message: `Discount deadline: ${DEADLINE_MISSING}`, fieldErrors: { discountDeadline: DEADLINE_MISSING } };
    const markup = renderToStaticMarkup(<InvoiceIntake orgSlug="acme" counterparties={COUNTERPARTIES} />);
    expect(input(markup, "discountDeadline")).toContain('aria-invalid="true"');
    expect(input(markup, "discountDeadline")).toContain("invoice-discount-deadline-error");
    expect(markup).toMatch(new RegExp(`id="invoice-discount-deadline-error"[^>]*>.*${DEADLINE_MISSING.replace(/[.,]/g, "\\$&")}`));
    expect(input(markup, "earlyPayDiscountPct")).not.toContain('aria-invalid="true"');
    expect(input(markup, "amount")).not.toContain('aria-invalid="true"');
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
