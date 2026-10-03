import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { InboxEmailView } from "@/lib/email-inbox/list";

vi.mock("@/app/actions/email-inbox", () => ({
  addInboxEmailAction: vi.fn(), dismissInboxEmailAction: vi.fn(), turnOnInboxAction: vi.fn(), changeInboxAddressAction: vi.fn(), turnOffInboxAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import EmailInboxPanel from "@/components/EmailInboxPanel";
import InboxEmails from "@/components/InboxEmails";
import { TooltipProvider } from "@/components/ui/Tooltip";

const html = (node: ReactElement) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);

/**
 * Invoices by email on screen (email invoices design E2, E6, E7): on AP / AR, each email still to decide with what was
 * read, the sender's checks, and for an owner or admin the buttons that add it or dismiss it; in Settings, the address
 * for an owner or admin, who turns it on, changes it or turns it off.
 */

const READY: InboxEmailView = {
  id: "0b6c1c9e-4a4f-4a7e-9b1e-000000000e41",
  from: "Northwind Billing <billing@northwind.example>",
  subject: "Invoice INV-2207",
  receivedAt: "2026-10-03T16:00:00Z",
  status: "ready",
  reasons: [],
  read: {
    counterpartyName: "Northwind Hosting", vendorName: "Northwind Hosting", amount: "200.00", currency: "USDC", dueDate: "2026-10-31", poReference: "PO-1042",
    invoiceNumber: "INV-2207", memo: null, warnings: [], modelNote: null, reader: "deepseek", knownSender: true,
  },
  authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
};

describe("InboxEmails", () => {
  it("shows an email ready to add with what was read, the sender's checks, and the buttons for an owner or admin", () => {
    const markup = renderToStaticMarkup(<InboxEmails orgSlug="acme" emails={[READY]} canAdd />);
    expect(markup).toContain('id="email-inbox"');
    expect(markup).toContain("From email");
    expect(markup).toContain("Invoice INV-2207");
    expect(markup).toContain("billing@northwind.example");
    expect(markup).toContain("Northwind Hosting");
    expect(markup).toContain("200.00 USDC");
    expect(markup).toContain("SPF, DKIM and DMARC pass");
    expect(markup).toContain("the billing email Northwind Hosting has on file");
    for (const button of ["Add, goods received", "Add, not received yet", "Dismiss"]) expect(markup).toContain(button);
  });

  it("shows anyone else what came in, without the buttons", () => {
    const markup = renderToStaticMarkup(<InboxEmails orgSlug="acme" emails={[READY]} canAdd={false} />);
    expect(markup).toContain("Northwind Hosting");
    expect(markup).not.toContain("Add, goods received");
    expect(markup).toContain("An owner or admin adds it");
  });

  it("says why an email cannot be added as it was read, or could not be read, and offers to dismiss it", () => {
    const missing = { ...READY, id: "0b6c1c9e-4a4f-4a7e-9b1e-000000000e42", status: "needs_details" as const, reasons: ["no counterparty in this workspace matches “Quillfeather”"] };
    const unreadable = { ...READY, id: "0b6c1c9e-4a4f-4a7e-9b1e-000000000e43", status: "unreadable" as const, read: null, reasons: ["Its attachment is larger than 4 MB."] };
    const markup = renderToStaticMarkup(<InboxEmails orgSlug="acme" emails={[missing, unreadable]} canAdd />);
    expect(markup).toContain("Cannot be added as it was read");
    expect(markup).toContain("Quillfeather");
    expect(markup).toContain("Could not be read");
    expect(markup).toContain("larger than 4 MB");
    expect(markup).not.toContain("Add, goods received");
    expect(markup.match(/Dismiss/g)?.length).toBe(2);
  });

  it("warns when the sender did not pass its checks", () => {
    const unverified = { ...READY, authentication: { spf: "fail", dkim: "pass", dmarc: "fail" }, read: { ...READY.read!, knownSender: false } };
    const markup = renderToStaticMarkup(<InboxEmails orgSlug="acme" emails={[unverified]} canAdd />);
    expect(markup).toContain("did not pass SPF and DMARC");
    expect(markup).not.toContain("has on file");
  });

  it("shows nothing when nothing waits", () => {
    expect(renderToStaticMarkup(<InboxEmails orgSlug="acme" emails={[]} canAdd />)).toBe("");
  });
});

describe("EmailInboxPanel", () => {
  it("offers an owner or admin to turn it on, and tells anyone else who does", () => {
    expect(html(<EmailInboxPanel orgSlug="acme" view={{ on: false }} canManage />)).toContain("Turn on");
    const member = html(<EmailInboxPanel orgSlug="acme" view={{ on: false }} canManage={false} />);
    expect(member).not.toContain("Turn on");
    expect(member).toContain("An owner or admin turns on invoices by email.");
  });

  it("shows the address to an owner or admin, who can change it or turn it off, and to nobody else", () => {
    const manager = html(<EmailInboxPanel orgSlug="acme" view={{ on: true, address: "invoices-abcdefghij23@abc123.resend.app" }} canManage />);
    expect(manager).toContain("invoices-abcdefghij23@abc123.resend.app");
    expect(manager).toContain("New address");
    expect(manager).toContain("Turn off");
    const member = html(<EmailInboxPanel orgSlug="acme" view={{ on: true, address: null }} canManage={false} />);
    expect(member).not.toContain("@abc123.resend.app");
    expect(member).toContain("An owner or admin has the address");
  });
});
