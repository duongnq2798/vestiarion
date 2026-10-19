import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import CapturedDrafts from "@/components/CapturedDrafts";
import { capturedCountLabel, capturedTitle } from "@/lib/invoice-drafts/model";
import ChromeExtensionPanel from "@/components/ChromeExtensionPanel";
import { EXTENSION_CAN, EXTENSION_CANNOT, ExtensionConsentForm } from "@/components/extension/ExtensionConsentForm";
import type { CapturedDraftView } from "@/lib/invoice-drafts/store";

/**
 * The console's side of invoice capture, rendered (docs/superpowers/specs/2026-10-15-invoice-capture-design.md C5,
 * C7, C13, C17): a captured draft's card with what it may repeat and its text, Review and add as bill for an owner or
 * admin only, the consent form's promises, and Settings' connections with Disconnect.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/app/actions/invoice-drafts", () => ({ confirmInvoiceDraftAction: vi.fn(), discardInvoiceDraftAction: vi.fn(), readCapturedTextAction: vi.fn() }));
vi.mock("@/app/actions/extension", () => ({ allowExtensionAction: vi.fn(), disconnectExtensionAction: vi.fn() }));
vi.mock("@/app/actions/intake", () => ({ createInvoiceAction: vi.fn(), createCounterpartyAction: vi.fn() }));

const COUNTERPARTY = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de";
const DRAFT: CapturedDraftView = {
  id: "7c1d6a52-2f5b-4bb0-9c62-1f1f0d4b9a10",
  source: "selection",
  documentKind: "text",
  fields: { supplierName: "Northwind Hosting", invoiceNumber: "INV-2207", amount: "200.00", currency: "USDC", invoiceDate: "2026-10-01", dueDate: "2026-10-31", poReference: "PO-1042", memo: null },
  capturedAt: "2026-10-15T09:00:00Z",
  sentAt: "2026-10-15T09:02:00Z",
  capturedBy: "user-1",
  counterpartyId: COUNTERPARTY,
  counterpartyName: "Northwind Hosting",
  warnings: ["The total line reads 210.00, but the model read 200.00. Check the amount against the invoice."],
  modelNote: null,
  extracted: null,
  reader: "heuristic",
  duplicates: ["Bills the same purchase order for the same 200 USDC as invoice due 2026-10-31 (already paid). Paying both would pay one obligation twice."],
};
const COUNTERPARTIES = [{ id: COUNTERPARTY, name: "Northwind Hosting", role: "vendor" }];

describe("an invoice a payee sent through its payee link (payee invoice link P5)", () => {
  const FROM_PAYEE: CapturedDraftView = {
    ...DRAFT,
    source: "payee_link",
    documentKind: "pdf",
    fields: { ...DRAFT.fields, supplierName: "Linh Tran", invoiceNumber: "INV-7", invoiceDate: null, poReference: null },
    capturedBy: null,
    counterpartyName: "Linh Tran",
    warnings: [],
    reader: null,
    duplicates: [],
    note: "Logo work, October",
  };
  const COUNTERPARTY_LINH = [{ id: COUNTERPARTY, name: "Linh Tran", role: "contractor" }];

  it("names the payee and its payee link, its note, and that no model read it", () => {
    const markup = renderToStaticMarkup(<CapturedDrafts orgSlug="northstar" drafts={[FROM_PAYEE]} canAdd counterparties={COUNTERPARTY_LINH} members={{}} />);
    expect(markup).toContain("Invoices from payees");
    expect(markup).toContain("1 to review · sent through payee links");
    expect(markup).toContain("Linh Tran sent it through their payee link, with a PDF");
    expect(markup).not.toContain("Chrome extension");
    expect(markup).toContain("Their note");
    expect(markup).toContain("Logo work, October");
    expect(markup).toContain("The payee typed this in, and no model read it.");
    expect(markup).toContain("The text of the file they sent");
    expect(markup).toContain("Review and add as bill");
  });

  it("offers no text to read for an invoice sent without a file", () => {
    const markup = renderToStaticMarkup(
      <CapturedDrafts orgSlug="northstar" drafts={[{ ...FROM_PAYEE, documentKind: null }]} canAdd counterparties={COUNTERPARTY_LINH} members={{}} />
    );
    expect(markup).not.toContain("The text of the file they sent");
    expect(markup).not.toContain(", with ");
  });

  it("lists both kinds under one title when both wait", () => {
    const markup = renderToStaticMarkup(<CapturedDrafts orgSlug="northstar" drafts={[DRAFT, { ...FROM_PAYEE, id: "8c1d6a52-2f5b-4bb0-9c62-1f1f0d4b9a11" }]} canAdd counterparties={COUNTERPARTIES} members={{ "user-1": "linh@example.com" }} />);
    expect(markup).toContain("Captured drafts and payee invoices");
    expect(markup).toContain("captured with the Chrome extension or sent through payee links");
  });
});

describe("Captured drafts", () => {
  it("shows what was read, who captured it and what it may repeat, and leaves the captured text to be read when opened", () => {
    const markup = renderToStaticMarkup(<CapturedDrafts orgSlug="northstar" drafts={[DRAFT]} canAdd counterparties={COUNTERPARTIES} members={{ "user-1": "linh@example.com" }} />);
    expect(markup).toContain("Captured drafts");
    expect(markup).toContain("Northwind Hosting · INV-2207");
    expect(markup).toContain("by linh@example.com");
    expect(markup).toContain("This may be a duplicate");
    expect(markup).toContain("Paying both would pay one obligation twice.");
    expect(markup).toContain("What was captured");
    // The text is loaded when its disclosure is opened, never sent with every draft on every refresh.
    expect(markup).not.toContain("Total due");
    expect(markup).toContain("Review and add as bill");
    expect(markup).toContain("Discard");
  });

  it("leaves adding and discarding to an owner or admin", () => {
    const markup = renderToStaticMarkup(<CapturedDrafts orgSlug="northstar" drafts={[DRAFT]} canAdd={false} counterparties={COUNTERPARTIES} members={{}} />);
    expect(markup).not.toContain("Review and add as bill");
    expect(markup).toContain("An owner or admin adds it as a bill, or discards it.");
  });

  it("offers to add a supplier that is not a counterparty, with its name", () => {
    const markup = renderToStaticMarkup(
      <CapturedDrafts orgSlug="northstar" drafts={[{ ...DRAFT, counterpartyId: null, counterpartyName: null, duplicates: [] }]} canAdd counterparties={COUNTERPARTIES} members={{}} />
    );
    expect(markup).toContain("not in Counterparties");
    // The supplier's name, often a person's, never goes into an address: the page reads it from the draft.
    expect(markup).toContain("/o/northstar/counterparties?add=1&amp;draft=7c1d6a52-2f5b-4bb0-9c62-1f1f0d4b9a10");
    expect(markup).not.toMatch(/name=Northwind/);
  });

  it("shows the same warning twice without two children of one key", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const markup = renderToStaticMarkup(
      <CapturedDrafts orgSlug="northstar" drafts={[{ ...DRAFT, warnings: ["Check it.", "Check it."] }]} canAdd counterparties={COUNTERPARTIES} members={{}} />
    );
    expect(markup.match(/Check it\./g)).toHaveLength(2);
    expect(errors.mock.calls.flat().join(" ")).not.toMatch(/same key/);
    errors.mockRestore();
  });

  it("counts at most 50, then says 50+", () => {
    expect(capturedCountLabel(3, false)).toBe("3 captured");
    expect(capturedCountLabel(50, true)).toBe("50+ captured");
    // A payee's invoice is named by its payee (payee invoice link P5).
    expect(capturedCountLabel(1, false, ["Linh Tran"])).toBe("Invoice from Linh Tran");
    expect(capturedCountLabel(2, false, ["Linh Tran", "Minh Le"])).toBe("2 from payees");
    expect(capturedCountLabel(3, false, ["Linh Tran"])).toBe("2 captured, invoice from Linh Tran");
    expect(capturedCountLabel(50, true, ["Linh Tran"])).toBe("50+ to review");
    expect(capturedTitle(["selection", "file"])).toBe("Captured drafts");
    expect(capturedTitle(["payee_link"])).toBe("Invoices from payees");
    expect(capturedTitle(["file", "payee_link"])).toBe("Captured drafts and payee invoices");
  });

  it("renders nothing when nothing waits", () => {
    expect(renderToStaticMarkup(<CapturedDrafts orgSlug="northstar" drafts={[]} canAdd counterparties={COUNTERPARTIES} members={{}} />)).toBe("");
  });
});

describe("the consent form", () => {
  it("says what the extension can and cannot do, and posts the request with the workspace", () => {
    const markup = renderToStaticMarkup(
      <ExtensionConsentForm
        workspaces={[{ slug: "northstar", name: "Northstar", role: "owner" }, { slug: "acme", name: "Acme", role: "admin" }]}
        clientId="abcdefghijklmnopabcdefghijklmnop"
        redirectUri="https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/"
        codeChallenge="E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        state="s-1"
        scope="invoice_draft:create invoice_draft:read"
        cancelHref="https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/?error=access_denied&state=s-1"
      />
    );
    for (const line of [...EXTENSION_CAN, ...EXTENSION_CANNOT]) expect(markup).toContain(line.replace(/'/g, "&#x27;"));
    expect(markup).toContain("Workspace to send drafts to");
    expect(markup).toContain('name="codeChallenge" value="E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"');
    expect(markup).toContain(">Allow<");
    expect(markup).toContain("error=access_denied");
  });
});

describe("Settings' Chrome extension section", () => {
  it("lists each connection with Disconnect, naming its member for an owner or admin", () => {
    const markup = renderToStaticMarkup(
      <ChromeExtensionPanel
        orgSlug="northstar"
        available
        seesEveryone
        connections={[{ id: "c1", member: "linh@example.com", mine: false, client: "abcdefghijklmnopabcdefghijklmnop", connectedAt: "2026-10-15T09:00:00Z", lastUsedAt: null }]}
      />
    );
    expect(markup).toContain("Chrome extension <code");
    expect(markup).toContain("abcdefgh…");
    expect(markup).toContain("linh@example.com");
    expect(markup).toContain("Disconnect");
  });

  it("says when it is not set up yet, and when nothing is connected", () => {
    expect(renderToStaticMarkup(<ChromeExtensionPanel orgSlug="northstar" available={false} seesEveryone connections={[]} />)).toContain("not set up on this deployment yet");
    expect(renderToStaticMarkup(<ChromeExtensionPanel orgSlug="northstar" available seesEveryone={false} connections={[]} />)).toContain(
      "You have not connected a Chrome extension to this workspace."
    );
  });
});
