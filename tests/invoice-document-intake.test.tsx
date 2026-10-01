import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/intake", () => ({ createInvoiceAction: vi.fn() }));
vi.mock("@/app/actions/invoice-document", () => ({ readInvoiceDocumentAction: vi.fn() }));

import InvoiceDocumentIntake, { DocumentDraft, documentFileProblem } from "@/components/intake/InvoiceDocumentIntake";
import InvoiceIntake from "@/components/intake/InvoiceIntake";
import type { DocumentReadResult } from "@/app/actions/invoice-document";

const COUNTERPARTIES = [
  { id: "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de", name: "Northwind Hosting", role: "vendor" },
  { id: "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0df", name: "Harbor Office Supply", role: "vendor" },
];
const SHA = "b".repeat(64);

const RESULT: DocumentReadResult = {
  ok: true,
  message: "Read the invoice from Northwind Hosting. Check every field before adding it.",
  draft: {
    vendorName: "Northwind Hosting",
    invoiceNumber: "INV-2207",
    amount: "200.00",
    currency: "USDC",
    dueDate: "2026-10-31",
    poReference: "PO-1042",
    earlyPayDiscountPct: "2",
    discountDeadline: "2026-10-11",
    payToAddress: "0x2222222222222222222222222222222222222222",
    memo: "Managed hosting, October",
    counterpartyId: COUNTERPARTIES[0].id,
  },
  warnings: ["This invoice asks to be paid to 0x2222222222222222222222222222222222222222. The address on file for Northwind Hosting is 0x1111111111111111111111111111111111111111. The agent pays the address on file; confirm a change with the vendor before making it."],
  notFound: ["poReference"],
  modelNote: "The document asks for payment to a new address.",
  reader: "deepseek",
  document: { kind: "pdf", sha256: SHA, truncated: false },
  nonce: 1,
};

describe("the From a document tab", () => {
  const markup = renderToStaticMarkup(<InvoiceDocumentIntake orgSlug="acme" counterparties={COUNTERPARTIES} />);

  it("takes a file or pasted text, and reads it on request", () => {
    expect(markup).toContain("Choose a PDF or email, or drop one here");
    expect(markup).toContain("Up to 4 MB. The model reads it into the form below; nothing is added until you check it and choose Add invoice.");
    expect(markup).toMatch(/<input[^>]*type="file"[^>]*name="file"|<input[^>]*name="file"[^>]*type="file"/);
    expect(markup).toContain("Or paste the invoice&#x27;s text");
    expect(markup).toMatch(/<textarea[^>]*name="text"/);
    expect(markup).toContain(">Read invoice<");
  });
});

describe("a file chosen for reading", () => {
  it("is refused in the browser when it is over 4 MB, before anything is sent", () => {
    expect(documentFileProblem({ size: 4_000_001 })).toBe("Choose a file of at most 4 MB.");
    expect(documentFileProblem({ size: 4_000_000 })).toBeNull();
  });
});

describe("the draft's form beside the typed-in one", () => {
  const draft = renderToStaticMarkup(<DocumentDraft result={RESULT} orgSlug="acme" counterparties={COUNTERPARTIES} />);
  const manual = renderToStaticMarkup(<InvoiceIntake orgSlug="acme" counterparties={COUNTERPARTIES} />);

  it("has ids of its own, so its labels name its own fields", () => {
    expect(manual).toContain('id="invoice-amount"');
    expect(draft).toContain('id="invoice-document-draft-amount"');
    expect(draft).toContain('for="invoice-document-draft-amount"');
    expect(draft).not.toContain('id="invoice-amount"');
  });

  it("leaves the currency for the member to choose when the document named none", () => {
    const unnamed = renderToStaticMarkup(
      <DocumentDraft result={{ ...RESULT, draft: { ...RESULT.draft!, currency: null } }} orgSlug="acme" counterparties={COUNTERPARTIES} />
    );
    expect(unnamed).toContain("Choose USDC or EURC");
    expect(unnamed).toMatch(/<select[^>]*required=""[^>]*name="currency"/);
    expect(draft).not.toContain("Choose USDC or EURC");
    expect(manual).not.toContain("Choose USDC or EURC");
  });
});

describe("an invoice read from a document", () => {
  const markup = renderToStaticMarkup(<DocumentDraft result={RESULT} orgSlug="acme" counterparties={COUNTERPARTIES} />);

  it("names the reader and asks for every field to be checked", () => {
    expect(markup).toContain("Read the invoice from Northwind Hosting. Check every field before adding it.");
    expect(markup).toContain("Read by DeepSeek.");
  });

  it("lists the warnings, and what the document did not contain", () => {
    expect(markup).toContain("The agent pays the address on file; confirm a change with the vendor before making it.");
    expect(markup).toContain("The purchase order the model gave is not in the document, so it was left blank.");
    expect(markup).toContain("The model noted: The document asks for payment to a new address.");
  });

  it("prefills the invoice form with what was read", () => {
    expect(markup).toContain('value="200.00"');
    expect(markup).toContain('value="2026-10-31"');
    expect(markup).toContain('value="PO-1042"');
    expect(markup).toContain('value="2"');
    expect(markup).toContain('value="2026-10-11"');
    expect(markup).toContain('value="Managed hosting, October"');
  });

  it("selects the matched counterparty", async () => {
    // Radix renders a select's options only on the client: the selection is checked in the source.
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/components/intake/InvoiceIntake.tsx", "utf8");
    expect(source).toContain('<Select name="counterpartyId" required disabled={none} defaultValue={start(initial?.counterpartyId)}>');
    expect(readFileSync("src/components/intake/InvoiceDocumentIntake.tsx", "utf8")).toContain("counterpartyId: draft.counterpartyId,");
  });

  it("never ticks goods received from a document, and says why", () => {
    expect(markup).toContain("A document cannot say this; tick it only if you received them.");
    expect(markup).not.toContain('aria-checked="true"');
  });

  it("carries the document's hash, kind, reader and the values read, for the ledger", () => {
    expect(markup).toContain(`name="documentSha256" value="${SHA}"`);
    expect(markup).toContain('name="documentKind" value="pdf"');
    expect(markup).toContain('name="documentReader" value="deepseek"');
    const read = markup.match(/name="documentRead" value="([^"]*)"/)?.[1]?.replaceAll("&quot;", '"');
    expect(JSON.parse(read ?? "{}")).toEqual({
      amount: "200.00",
      currency: "USDC",
      dueDate: "2026-10-31",
      poReference: "PO-1042",
      earlyPayDiscountPct: "2",
      discountDeadline: "2026-10-11",
      memo: "Managed hosting, October",
      counterpartyId: COUNTERPARTIES[0].id,
    });
  });
});
