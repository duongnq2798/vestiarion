import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { payeeInvoiceEmail } from "@/lib/email/payee-invoice";
import { notifyPayeeInvoice } from "@/lib/notifications/payee-invoice";
import { PAYEE_INVOICE_MESSAGES, readPayeeInvoice, yearAfter } from "@/lib/payee-invoice";
import { submitPayeeInvoice } from "@/lib/platform/payee-invoices";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * A payee's invoice, sent through its payee link (docs/superpowers/specs/2026-10-19-payee-invoice-link-design.md P4-P7):
 * the fields checked in the payee's words, the file read for its text with no model and never kept, 0133's function
 * called with what was read, then the signed entry and the members' email, both best effort.
 */

const { withOrgMock, ledgerMock, notifyMock, takeMock, sendMock, recipientsMock, usageMock } = vi.hoisted(() => ({
  withOrgMock: vi.fn(),
  ledgerMock: vi.fn(),
  notifyMock: vi.fn(),
  takeMock: vi.fn(),
  sendMock: vi.fn(),
  recipientsMock: vi.fn(),
  usageMock: vi.fn(),
}));
vi.mock("@/lib/dal/scope", () => ({ withOrg: withOrgMock }));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: ledgerMock }));
vi.mock("@/lib/notifications/payee-invoice", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notifications/payee-invoice")>();
  // The notification's own tests below call the real one; the submission's are told only that it was asked.
  return { notifyPayeeInvoice: (input: Parameters<typeof actual.notifyPayeeInvoice>[0]) => (notifyMock.getMockImplementation() ? notifyMock(input) : actual.notifyPayeeInvoice(input)) };
});
vi.mock("@/lib/rate-limit", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/rate-limit")>()), takePayeeInvoiceToken: takeMock }));
vi.mock("@/lib/email/send", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/email/send")>()), sendEmail: sendMock }));
vi.mock("@/lib/platform/members", () => ({ listMembers: recipientsMock }));
vi.mock("@/lib/usage/record", () => ({ recordUsageFor: usageMock }));

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const PAYEE = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de";
const LINK = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001e1";
const DRAFT = "7c1d6a52-2f5b-4bb0-9c62-1f1f0d4b9a10";
const TOKEN = `vxp_${"A".repeat(43)}`;
const HASH = createHash("sha256").update("A".repeat(43), "utf8").digest("hex");
const NOW = Date.parse("2026-10-19T12:00:00Z");
const TODAY = "2026-10-19";

const FIELDS = { invoiceNumber: " INV-7 ", amount: "1250.50", dueDate: "2026-11-02", note: "Design work for October" };
const ANSWER = { draftId: DRAFT, linkId: LINK, orgId: ORG, counterpartyId: PAYEE, orgName: "Acme", payeeName: "Linh Tran" };

const rpc = (request: RecordedRequest, name: string) => request.path === `/rest/v1/rpc/${name}`;
const submitted = (fake: ReturnType<typeof fakeSupabase>) => fake.requests.find((request) => rpc(request, "submit_payee_invoice"))?.body as Record<string, unknown> | undefined;

const LIVE = { asksInvoice: true, invoiceSent: false };
/** A live link that asks for an invoice, and 0133's function answering `submit`. */
const live =
  (submit: FakeReply = { body: ANSWER }, status: FakeReply = { body: LIVE }) =>
  (request: RecordedRequest): FakeReply =>
    rpc(request, "payee_link_status") ? status : rpc(request, "submit_payee_invoice") ? submit : { body: [] };

function platform<T>(fn: () => Promise<T>, respond: (request: RecordedRequest) => FakeReply = live()) {
  const fake = fakeSupabase(respond);
  return { fake, result: runWith({ config, db: fake.client }, fn) };
}

function textFile(text: string, name = "invoice.txt", type = "text/plain") {
  const bytes = new TextEncoder().encode(text);
  return { size: bytes.length, name, type, arrayBuffer: vi.fn(async () => bytes.slice().buffer) };
}

beforeEach(() => {
  withOrgMock.mockReset().mockImplementation(async (_orgId: string, fn: () => Promise<unknown>) => fn());
  ledgerMock.mockReset().mockResolvedValue(undefined);
  notifyMock.mockReset().mockImplementation(async () => 1);
  takeMock.mockReset().mockReturnValue(true);
  sendMock.mockReset().mockResolvedValue({ sent: true, id: "e1" });
  recipientsMock.mockReset().mockResolvedValue([
    { userId: "u1", email: "owner@acme.test", role: "owner" },
    { userId: "u2", email: "approver@acme.test", role: "approver" },
    { userId: "u3", email: "admin@acme.test", role: "admin" },
    { userId: "u4", email: "books@acme.test", role: "accountant" },
  ]);
  usageMock.mockReset().mockResolvedValue(undefined);
  process.env.SITE_URL = "https://www.vestiarion.xyz";
});

describe("readPayeeInvoice (P4)", () => {
  it("takes an invoice number, an amount above 0 with at most 6 decimals, a due date from today to a year ahead, and a note", () => {
    expect(readPayeeInvoice(FIELDS, TODAY)).toEqual({ ok: true, invoice: { invoiceNumber: "INV-7", amount: "1250.50", dueDate: "2026-11-02", note: "Design work for October" } });
    expect(readPayeeInvoice({ ...FIELDS, note: "   ", dueDate: TODAY }, TODAY)).toMatchObject({ ok: true, invoice: { note: null, dueDate: TODAY } });
    expect(readPayeeInvoice({ ...FIELDS, dueDate: "2027-10-19", amount: "0.000001" }, TODAY)).toMatchObject({ ok: true });
  });

  it.each([
    [{ invoiceNumber: "  " }, "invoiceNumber"],
    [{ invoiceNumber: "x".repeat(101) }, "invoiceNumber"],
    [{ amount: "0" }, "amount"],
    [{ amount: "-1" }, "amount"],
    [{ amount: "1.1234567" }, "amount"],
    [{ amount: "1,250.00" }, "amount"],
    [{ dueDate: "2026-10-18" }, "dueDate"],
    [{ dueDate: "2027-10-20" }, "dueDate"],
    [{ dueDate: "2026-02-30" }, "dueDate"],
    [{ note: "n".repeat(501) }, "note"],
    // Plain text only: an invoice number on one line with no link, a note with nothing unseen but line breaks.
    [{ invoiceNumber: "INV\u00007" }, "invoiceNumber"],
    [{ invoiceNumber: "INV\t7" }, "invoiceNumber"],
    [{ invoiceNumber: "INV\n7" }, "invoiceNumber"],
    [{ invoiceNumber: "https://pay.example/inv7" }, "invoiceNumber"],
    [{ invoiceNumber: "see www.example.com" }, "invoiceNumber"],
    [{ note: "tab\there" }, "note"],
    [{ note: "bell\u0007" }, "note"],
    [{ note: "nul\u0000" }, "note"],
  ] as const)("%# refuses %j with a fixed sentence", (over, field) => {
    expect(readPayeeInvoice({ ...FIELDS, ...over }, TODAY)).toEqual({ ok: false, field, message: PAYEE_INVOICE_MESSAGES[field] });
  });

  it("keeps a note's line breaks, however the browser sent them", () => {
    expect(readPayeeInvoice({ ...FIELDS, note: "Line one\r\nline two\rline three" }, TODAY)).toMatchObject({ ok: true, invoice: { note: "Line one\nline two\nline three" } });
  });

  it("adds a year as the database does, the 29th of February becoming the 28th", () => {
    expect(yearAfter("2026-10-19")).toBe("2027-10-19");
    expect(yearAfter("2028-02-29")).toBe("2029-02-28");
  });
});

describe("submitPayeeInvoice", () => {
  it("sends the fields to 0133's function by the link's hash, with no file", async () => {
    const { fake, result } = platform(() => submitPayeeInvoice(TOKEN, { ...FIELDS, file: null }, NOW));
    expect(await result).toEqual({ ok: true, orgName: "Acme" });
    expect(submitted(fake)).toEqual({
      p_token_hash: HASH,
      p_invoice_number: "INV-7",
      p_amount: "1250.50",
      p_due_date: "2026-11-02",
      p_note: "Design work for October",
      p_document_kind: null,
      p_document_sha256: null,
      p_raw_text: null,
      p_request_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(JSON.stringify(fake.requests)).not.toContain("A".repeat(43));
    expect(takeMock).toHaveBeenCalledWith(HASH, NOW);
  });

  it("reads a file for its text and hash only, with no model, and keeps neither the file nor its name", async () => {
    const file = textFile("Invoice INV-7\n  Total due 1250.50 USDC  \n");
    const { fake, result } = platform(() => submitPayeeInvoice(TOKEN, { ...FIELDS, file }, NOW));
    expect(await result).toEqual({ ok: true, orgName: "Acme" });
    const body = submitted(fake);
    expect(body).toMatchObject({ p_document_kind: "text", p_raw_text: "Invoice INV-7\nTotal due 1250.50 USDC" });
    expect(body?.p_document_sha256).toBe(createHash("sha256").update(new TextEncoder().encode("Invoice INV-7\n  Total due 1250.50 USDC  \n")).digest("hex"));
    expect(JSON.stringify(fake.requests)).not.toContain("invoice.txt");
    // Nothing but the database was asked: no model, no other service.
    expect(fake.requests.map((request) => request.path)).toEqual(["/rest/v1/rpc/payee_link_status", "/rest/v1/rpc/submit_payee_invoice"]);
    expect(fake.requests[0].body).toEqual({ p_token_hash: HASH });
  });

  it("signs payee_invoice_submitted in the workspace, by no member, and tells the members who decide payments", async () => {
    const { result } = platform(() => submitPayeeInvoice(TOKEN, { ...FIELDS, file: textFile("Invoice INV-7 total 1250.50") }, NOW));
    await result;
    expect(withOrgMock).toHaveBeenCalledWith(ORG, expect.any(Function));
    expect(ledgerMock).toHaveBeenCalledWith(ORG, {
      actor: "human",
      domain: "compliance",
      action: "payee_invoice_submitted",
      summary: "Linh Tran sent invoice INV-7 for 1250.50 USDC through their payee link; it waits for a member to add it",
      detail: {
        by: null,
        via: "payee_link",
        linkId: LINK,
        draftId: DRAFT,
        counterpartyId: PAYEE,
        amount: "1250.50",
        currency: "USDC",
        invoiceNumber: "INV-7",
        documentSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    expect(notifyMock).toHaveBeenCalledWith({ orgId: ORG, orgName: "Acme", payeeName: "Linh Tran", invoiceNumber: "INV-7", amount: "1250.50", dueDate: "2026-11-02" });
  });

  it("records documentSha256 as null with no file", async () => {
    await platform(() => submitPayeeInvoice(TOKEN, { ...FIELDS, file: null }, NOW)).result;
    expect(ledgerMock.mock.calls[0][1].detail.documentSha256).toBeNull();
  });

  it("refuses a field before anything is read, sent or counted", async () => {
    const file = textFile("Invoice");
    const { fake, result } = platform(() => submitPayeeInvoice(TOKEN, { ...FIELDS, amount: "0", file }, NOW));
    expect(await result).toEqual({ ok: false, reason: "invalid", field: "amount" });
    expect(fake.requests).toEqual([]);
    expect(file.arrayBuffer).not.toHaveBeenCalled();
    expect(takeMock).not.toHaveBeenCalled();
  });

  it("refuses a file over 4 MB before reading it, and one the reader cannot read, in the payee's words", async () => {
    const large = { size: 4_000_001, name: "big.pdf", type: "application/pdf", arrayBuffer: vi.fn() };
    const big = platform(() => submitPayeeInvoice(TOKEN, { ...FIELDS, file: large }, NOW));
    expect(await big.result).toEqual({ ok: false, reason: "file", code: "too_large" });
    expect(large.arrayBuffer).not.toHaveBeenCalled();
    expect(big.fake.requests).toEqual([]);

    const picture = platform(() => submitPayeeInvoice(TOKEN, { ...FIELDS, file: textFile("\u0089PNG\u0000\u0000", "scan.png", "image/png") }, NOW));
    expect(await picture.result).toEqual({ ok: false, reason: "file", code: "unsupported" });
    expect(picture.fake.requests.some((request) => rpc(request, "submit_payee_invoice"))).toBe(false);
  });

  it.each([
    ["no live link", { body: null }, "invalid_link"],
    ["a link that does not ask for an invoice", { body: { asksInvoice: false, invoiceSent: false } }, "invalid_link"],
    ["a link that sent its invoice", { body: { asksInvoice: true, invoiceSent: true } }, "already_sent"],
  ] as const)("reads no file for %s", async (_label, status, reason) => {
    const file = textFile("Invoice INV-7");
    const { fake, result } = platform(() => submitPayeeInvoice(TOKEN, { ...FIELDS, file }, NOW), live({ body: ANSWER }, status));
    expect(await result).toEqual({ ok: false, reason });
    expect(file.arrayBuffer).not.toHaveBeenCalled();
    expect(fake.requests.some((request) => rpc(request, "submit_payee_invoice"))).toBe(false);
  });

  it("stops a page that sends too often, once the link is known to be live and before the reader runs", async () => {
    takeMock.mockReturnValueOnce(false);
    const file = textFile("Invoice");
    const { fake, result } = platform(() => submitPayeeInvoice(TOKEN, { ...FIELDS, file }, NOW));
    expect(await result).toEqual({ ok: false, reason: "busy" });
    expect(file.arrayBuffer).not.toHaveBeenCalled();
    expect(fake.requests.map((request) => request.path)).toEqual(["/rest/v1/rpc/payee_link_status"]);
  });

  it("takes no try for a link that is not live, so a made-up token adds nothing to the limit", async () => {
    const { result } = platform(() => submitPayeeInvoice(TOKEN, { ...FIELDS, file: null }, NOW), live({ body: ANSWER }, { body: null }));
    expect(await result).toEqual({ ok: false, reason: "invalid_link" });
    expect(takeMock).not.toHaveBeenCalled();
  });

  it.each([
    ["payee_invoice_link_dead: this link no longer takes an invoice", "invalid_link"],
    ["payee_invoice_not_asked: this link does not ask for an invoice", "invalid_link"],
    ["payee_invoice_sent: this link already sent its invoice", "already_sent"],
    ["payee_invoice_invalid: the due date", "failed_check"],
  ] as const)("answers %s as %s, signing and sending nothing", async (message, reason) => {
    const { result } = platform(() => submitPayeeInvoice(TOKEN, { ...FIELDS, file: null }, NOW), live({ status: 400, body: { code: "P0001", message } }));
    expect(await result).toEqual({ ok: false, reason });
    expect(ledgerMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("throws any other failure, and asks nothing for a malformed token", async () => {
    await expect(platform(() => submitPayeeInvoice(TOKEN, { ...FIELDS, file: null }, NOW), () => ({ status: 500, body: { message: "connection reset" } })).result).rejects.toThrow(
      /connection reset/
    );
    const malformed = platform(() => submitPayeeInvoice("vxp_nope", { ...FIELDS, file: null }, NOW));
    expect(await malformed.result).toEqual({ ok: false, reason: "invalid_link" });
    expect(malformed.fake.requests).toEqual([]);
  });

  it("answers sent when the entry could not be signed: the draft is written already", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    withOrgMock.mockRejectedValueOnce(new Error("org unreadable"));
    expect(await platform(() => submitPayeeInvoice(TOKEN, { ...FIELDS, file: null }, NOW)).result).toEqual({ ok: true, orgName: "Acme" });
    expect(logged).toHaveBeenCalledWith("ledger entry not recorded", "payee_invoice_submitted", ORG);
    expect(notifyMock).toHaveBeenCalled();
  });
});

describe("the members' email (P7)", () => {
  it("says who sent which invoice, that it waits on Bills, and carries no counterparty link", () => {
    const email = payeeInvoiceEmail({
      orgName: "Acme",
      payeeName: "Linh Tran",
      invoiceNumber: "INV-7",
      amount: "1250.50",
      dueDate: "2026-11-02",
      link: "https://www.vestiarion.xyz/o/acme/invoices?review=captured",
      origin: "https://www.vestiarion.xyz",
    });
    expect(email.subject).toBe("Linh Tran sent an invoice through their payee link");
    expect(email.text).toContain("Linh Tran sent invoice INV-7 for 1250.50 USDC, due 2026-11-02, through the payee link Acme sent them.");
    expect(email.text).toContain("Nothing is paid because it arrived");
    expect(email.html).toContain("https://www.vestiarion.xyz/o/acme/invoices?review=captured");
    expect(email.html).not.toContain("utm_campaign=counterparty_loop");
  });

  it("goes to each owner and admin, who add or discard it, never an approver, opening Bills' review list, metered as payee_invoice", async () => {
    notifyMock.mockReset();
    const { result } = platform(
      () => notifyPayeeInvoice({ orgId: ORG, orgName: "Acme", payeeName: "Linh Tran", invoiceNumber: "INV-7", amount: "1250.50", dueDate: "2026-11-02" }),
      (request) => (request.path === "/rest/v1/orgs" ? { body: { slug: "acme" } } : { body: [] })
    );
    expect(await result).toBe(2);
    expect(recipientsMock).toHaveBeenCalledWith(ORG);
    expect(sendMock.mock.calls.map(([message]) => message.to)).toEqual(["owner@acme.test", "admin@acme.test"]);
    expect(sendMock.mock.calls[0][0].html).toContain("Sent to the owners and admins of Acme, who add bills.");
    expect(sendMock.mock.calls[0][0].text).toContain("https://www.vestiarion.xyz/o/acme/invoices?review=captured");
    expect(usageMock).toHaveBeenCalledWith(ORG, { kind: "email", action: "payee_invoice", provider: "resend", quantity: 2 });
  });

  it("never throws, and counts only what went out", async () => {
    notifyMock.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
    sendMock.mockResolvedValueOnce({ sent: false, reason: "status 500" });
    const notify = () => notifyPayeeInvoice({ orgId: ORG, orgName: "Acme", payeeName: "Linh Tran", invoiceNumber: "INV-7", amount: "1", dueDate: "2026-11-02" });
    expect(await platform(notify, (request) => (request.path === "/rest/v1/orgs" ? { body: { slug: "acme" } } : { body: [] })).result).toBe(1);
    recipientsMock.mockRejectedValueOnce(new Error("members unreadable"));
    expect(await platform(notify, (request) => (request.path === "/rest/v1/orgs" ? { body: { slug: "acme" } } : { body: [] })).result).toBe(0);
  });
});
