import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { InboxEmailView } from "@/lib/email-inbox/list";

vi.mock("@/app/actions/email-inbox", () => ({
  addInboxEmailAction: vi.fn(), finishInboxEmailAction: vi.fn(), dismissInboxEmailAction: vi.fn(),
  turnOnInboxAction: vi.fn(), changeInboxAddressAction: vi.fn(), turnOffInboxAction: vi.fn(),
}));
vi.mock("@/app/actions/intake", () => ({ createInvoiceAction: vi.fn() }));
vi.mock("@/app/actions/googledrive", () => ({ checkGoogleDriveNowAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import EmailInboxPanel from "@/components/EmailInboxPanel";
import InboxEmails from "@/components/InboxEmails";
import { reviewCountLabel, reviewListTitle } from "@/lib/email-inbox/words";
import { TooltipProvider } from "@/components/ui/Tooltip";

const html = (node: ReactElement) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);

/**
 * Invoices by email on screen (email invoices design E2, E6, E7): on Bills & receivables, each email still to decide
 * with what was read, the sender's checks, and for an owner or admin the buttons that add it or dismiss it; in
 * Settings, the address for an owner or admin, who turns it on, changes it or turns it off.
 */

const READY: InboxEmailView = {
  id: "0b6c1c9e-4a4f-4a7e-9b1e-000000000e41",
  source: "email",
  fileName: null,
  lastModifiedBy: null,
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

const COUNTERPARTIES = [{ id: "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de", name: "Northwind Hosting", role: "vendor" }];
const MISSING: InboxEmailView = { ...READY, id: "0b6c1c9e-4a4f-4a7e-9b1e-000000000e42", status: "needs_details", reasons: ["no counterparty in this workspace matches “Quillfeather”"] };
const UNREADABLE: InboxEmailView = { ...READY, id: "0b6c1c9e-4a4f-4a7e-9b1e-000000000e43", status: "unreadable", read: null, reasons: ["Its attachment is larger than 4 MB."] };

describe("InboxEmails", () => {
  it("shows an email ready to add with what was read, the sender's checks, and the buttons for an owner or admin", () => {
    const markup = html(<InboxEmails orgSlug="acme" emails={[READY]} canAdd counterparties={COUNTERPARTIES} />);
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

  it("shows anyone else what came in, without the buttons or the form", () => {
    const markup = html(<InboxEmails orgSlug="acme" emails={[READY, MISSING]} canAdd={false} counterparties={COUNTERPARTIES} />);
    expect(markup).toContain("Northwind Hosting");
    expect(markup).not.toContain("Add, goods received");
    expect(markup).not.toContain("<summary");
    expect(markup).not.toContain('name="inboxEmailId"');
    expect(markup).toContain("An owner or admin adds it");
  });

  it("says why an email cannot be added as it was read, or could not be read, and offers to dismiss it", () => {
    const markup = html(<InboxEmails orgSlug="acme" emails={[MISSING, UNREADABLE]} canAdd counterparties={COUNTERPARTIES} />);
    expect(markup).toContain("Cannot be added as it was read");
    expect(markup).toContain("Quillfeather");
    expect(markup).toContain("Could not be read");
    expect(markup).toContain("larger than 4 MB");
    expect(markup).not.toContain("Add, goods received");
    expect(markup.match(/Dismiss/g)?.length).toBe(2);
  });

  it("lets an owner or admin edit a ready email before adding it, and finish one that cannot be added as read (reader follow-up F5)", () => {
    const markup = html(<InboxEmails orgSlug="acme" emails={[READY, MISSING, UNREADABLE]} canAdd counterparties={COUNTERPARTIES} />);
    const summaries = [...markup.matchAll(/<summary[^>]*>([\s\S]*?)<\/summary>/g)].map(([, inner]) => inner.replace(/<[^>]+>/g, ""));
    expect(summaries).toEqual(["Edit and add", "Finish and add", "Finish and add"]);
    // Each form posts its own email, starts from what was read, and is a payable.
    for (const email of [READY, MISSING, UNREADABLE]) expect(markup).toContain(`name="inboxEmailId" value="${email.id}"`);
    expect(markup).toMatch(/<input[^>]*name="amount"[^>]*value="200.00"/);
    expect(markup).toContain("Fix what is missing with Finish and add.");
  });

  it("names a vendor no counterparty matches as not in Counterparties, never as the counterparty", () => {
    const unmatched: InboxEmailView = { ...MISSING, read: { ...READY.read!, counterpartyName: null, vendorName: "Quillfeather Studio", knownSender: false } };
    const markup = html(<InboxEmails orgSlug="acme" emails={[unmatched, READY]} canAdd counterparties={COUNTERPARTIES} />);
    expect(markup).toMatch(/Quillfeather Studio[\s\S]{0,80}not in Counterparties/);
    expect(markup.match(/not in Counterparties/g)?.length).toBe(1);
  });

  it("warns when the sender did not pass its checks", () => {
    const unverified = { ...READY, authentication: { spf: "fail", dkim: "pass", dmarc: "fail" }, read: { ...READY.read!, knownSender: false } };
    const markup = html(<InboxEmails orgSlug="acme" emails={[unverified]} canAdd counterparties={COUNTERPARTIES} />);
    expect(markup).toContain("did not pass SPF and DMARC");
    expect(markup).not.toContain("has on file");
  });

  it("shows nothing when nothing waits", () => {
    expect(html(<InboxEmails orgSlug="acme" emails={[]} canAdd counterparties={COUNTERPARTIES} />)).toBe("");
  });
});

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replaceAll("&amp;", "&").replace(/\s+/g, " ");

/** A PDF found in the workspace's Google Drive folder, read and ready to add (Google Drive intake GD6, GD8). */
const FROM_DRIVE: InboxEmailView = {
  ...READY,
  id: "0b6c1c9e-4a4f-4a7e-9b1e-000000000d41",
  source: "google_drive",
  from: null,
  subject: null,
  authentication: null,
  fileName: "Northwind - INV-2208.pdf",
  lastModifiedBy: "bo***@pinecrest.test",
  receivedAt: "2026-11-01T10:24:00Z",
  read: { ...READY.read!, invoiceNumber: "INV-2208", knownSender: false },
};

describe("InboxEmails with files from Google Drive (Google Drive intake GD7, GD8, GD16)", () => {
  it("names a Drive row by its file, from Google Drive, when it was found and who last changed it, masked, as information", () => {
    const markup = html(<InboxEmails orgSlug="acme" emails={[FROM_DRIVE]} canAdd counterparties={COUNTERPARTIES} />);
    const words = text(markup);
    expect(words).toContain("From Google Drive");
    expect(words).toContain("Northwind - INV-2208.pdf");
    expect(words).toContain("From Google Drive · found Nov 1, 10:24 UTC");
    expect(words).toContain(
      "Last changed in Google Drive by bo***@pinecrest.test. Anyone who can add files to the folder can put one here: check it is the vendor's invoice."
    );
    // A file has no sender: no sender's checks, and no billing email on file.
    expect(words).not.toMatch(/SPF|DKIM|DMARC|has on file|unknown sender|no subject/);
    expect(words).toContain("200.00 USDC");
  });

  it("says so when Google Drive did not say who last changed the file", () => {
    const words = text(html(<InboxEmails orgSlug="acme" emails={[{ ...FROM_DRIVE, lastModifiedBy: null }]} canAdd counterparties={COUNTERPARTIES} />));
    expect(words).toContain("Google Drive did not say who last changed it.");
  });

  it("decides a Drive row as an email: Add, Dismiss and Edit and add, each posting its row, for an owner or admin only (GD8)", () => {
    const markup = html(<InboxEmails orgSlug="acme" emails={[FROM_DRIVE]} canAdd counterparties={COUNTERPARTIES} />);
    for (const button of ["Add, goods received", "Add, not received yet", "Dismiss", "Edit and add"]) expect(markup).toContain(button);
    expect(markup).toContain(`name="inboxEmailId" value="${FROM_DRIVE.id}"`);
    const member = html(<InboxEmails orgSlug="acme" emails={[FROM_DRIVE]} canAdd={false} counterparties={COUNTERPARTIES} />);
    expect(member).not.toContain("Add, goods received");
    expect(member).toContain("An owner or admin adds it");
  });

  it("says why a file could not be read, in the file's words", () => {
    const unreadable: InboxEmailView = { ...FROM_DRIVE, status: "unreadable", read: null, reasons: ["It is a Google Docs file, which has no PDF to read."] };
    const words = text(html(<InboxEmails orgSlug="acme" emails={[unreadable]} canAdd counterparties={COUNTERPARTIES} />));
    expect(words).toContain("Could not be read: It is a Google Docs file, which has no PDF to read.");
    expect(words).toContain("Finish and add");
    expect(text(html(<InboxEmails orgSlug="acme" emails={[{ ...unreadable, reasons: [] }]} canAdd counterparties={COUNTERPARTIES} />))).toContain(
      "Could not be read: the file could not be read."
    );
  });

  it("names the list by what brought its rows, and counts them with where they came from", () => {
    const both = text(html(<InboxEmails orgSlug="acme" emails={[FROM_DRIVE, READY]} canAdd counterparties={COUNTERPARTIES} />));
    expect(both).toContain("From email and Google Drive");
    expect(both).toContain("2 to decide · sent to this workspace's invoice address or added to its Google Drive folder");
    const drive = text(html(<InboxEmails orgSlug="acme" emails={[FROM_DRIVE]} canAdd counterparties={COUNTERPARTIES} />));
    expect(drive).toContain("1 to decide · added to this workspace's Google Drive folder");
    expect(text(html(<InboxEmails orgSlug="acme" emails={[READY]} canAdd counterparties={COUNTERPARTIES} />))).toContain(
      "From email 1 to decide · sent to this workspace's invoice address"
    );
  });

  it("offers Check Google Drive now with the folder it reads, even when nothing waits (GD7, GD16)", () => {
    const empty = html(<InboxEmails orgSlug="acme" emails={[]} canAdd counterparties={COUNTERPARTIES} driveCheck={{ folderName: "Bills 2026" }} />);
    const words = text(empty);
    expect(words).toContain("From Google Drive");
    expect(words).toContain("Nothing to decide");
    expect(words).toContain("Vestiarion reads Bills 2026 in Google Drive every 15 minutes.");
    expect(empty).toMatch(/<button[^>]*type="submit"[^>]*>[^]*?Check Google Drive now<\/button>/);
    expect(empty).toContain('name="orgSlug" value="acme"');
    // With emails waiting, the list is named for the folder it reads too.
    const withEmail = text(html(<InboxEmails orgSlug="acme" emails={[READY]} canAdd counterparties={COUNTERPARTIES} driveCheck={{ folderName: "Bills 2026" }} />));
    expect(withEmail).toContain("From email and Google Drive");
    expect(withEmail).toContain("Check Google Drive now");
    expect(text(html(<InboxEmails orgSlug="acme" emails={[READY]} canAdd counterparties={COUNTERPARTIES} />))).not.toContain("Check Google Drive now");
  });

  it("says the folder is gone as the card does, never that it reads it every 15 minutes (GD13)", () => {
    const gone = "Google Drive no longer has this folder for the connected account: it was deleted, moved to the trash, or is no longer shared with it.";
    const markup = html(<InboxEmails orgSlug="acme" emails={[]} canAdd counterparties={COUNTERPARTIES} driveCheck={{ folderName: "Bills 2026", problem: gone }} />);
    expect(text(markup)).toContain(gone);
    expect(text(markup)).not.toContain("every 15 minutes");
    expect(markup).toMatch(/<p class="[^"]*text-refused[^"]*">Google Drive no longer has this folder/);
    // Check Google Drive now stays: the folder is read again once the account can open it.
    expect(text(markup)).toContain("Check Google Drive now");
  });

  it("wraps a long folder name with no place to break, so the list never scrolls sideways at 375 px", () => {
    const long = "Pinecrest_Studio_Accounts_Payable_Invoices_2026";
    const markup = html(<InboxEmails orgSlug="acme" emails={[]} canAdd counterparties={COUNTERPARTIES} driveCheck={{ folderName: long }} />);
    expect(markup).toMatch(/<p class="[^"]*break-words[^"]*">Vestiarion reads <span[^>]*>Pinecrest_Studio_Accounts_Payable_Invoices_2026<\/span>/);
    // The answer of Check Google Drive now names the folder too.
    expect(markup).toMatch(/<p role="status" aria-live="polite" class="[^"]*\[overflow-wrap:anywhere\][^"]*"/);
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

describe("the review list's words on Bills & receivables (Google Drive intake GD8)", () => {
  it("counts what waits by where it came from, in Waiting for review, and titles the list the same way", () => {
    expect(reviewCountLabel(["email", "email"])).toBe("2 by email");
    expect(reviewCountLabel(["google_drive"])).toBe("1 from Google Drive");
    expect(reviewCountLabel(["google_drive", "email", "email"])).toBe("2 by email, 1 from Google Drive");
    expect(reviewListTitle(["email"])).toBe("From email");
    expect(reviewListTitle(["google_drive"])).toBe("From Google Drive");
    expect(reviewListTitle(["email", "google_drive"])).toBe("From email and Google Drive");
    // A list that offers to check a folder is named for it, whatever waits in it now.
    expect(reviewListTitle([], true)).toBe("From Google Drive");
    expect(reviewListTitle(["email"], true)).toBe("From email and Google Drive");
  });
});
