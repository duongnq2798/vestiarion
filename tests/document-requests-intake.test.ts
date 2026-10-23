import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * The vendor's page behind a document request's link (docs/superpowers/specs/2026-10-23-document-requests-design.md ER5,
 * ER7): what it shows, for an open request only; an upload address for one PDF, PNG or JPEG of at most 10 MB; the file
 * checked by its first bytes and kept under its SHA-256 in the workspace's private storage; one answer; rate limits per
 * address and per link; the signed entry and the owners' email; and nothing written to the bill.
 */

const { bestEffortMock, sendMock, storage } = vi.hoisted(() => ({
  bestEffortMock: vi.fn(),
  sendMock: vi.fn(),
  storage: {
    uploadUrl: vi.fn(),
    download: vi.fn(),
    move: vi.fn(),
    remove: vi.fn(),
    openUrl: vi.fn(),
  },
}));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: bestEffortMock }));
vi.mock("@/lib/dal/scope", () => ({ withOrg: async (_orgId: string, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/usage/record", () => ({ recordUsageFor: vi.fn(async () => undefined), recordUsage: vi.fn(async () => undefined) }));
vi.mock("@/lib/email/send", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/email/send")>()), sendEmail: sendMock }));
vi.mock("@/lib/dal", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/dal")>()), platformStorage: () => storage }));

import { previewDocumentRequest, startDocumentUpload, submitDocument } from "@/lib/document-requests/intake";
import { generateDocumentToken } from "@/lib/document-requests/token";

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000e0e";
const REQUEST = "0b6c1c9e-4a4f-4a7e-9b1e-0000000003e3";
const INVOICE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001e1";
const VENDOR = "0b6c1c9e-4a4f-4a7e-9b1e-0000000002e2";
const NOW = Date.parse("2026-10-24T09:00:00Z");

const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj << >> endobj\n%%EOF");
const PDF_SHA = crypto.createHash("sha256").update(PDF).digest("hex");

const previewRow = {
  request_id: REQUEST,
  org_id: ORG,
  org_name: "Pinecrest Studio",
  counterparty_name: "Northstar Studio",
  invoice_reference: "INV-2215",
  amount: "1250.000000",
  currency: "USDC",
  due_date: "2026-10-30T12:00:00+00:00",
  missing: ["purchase_order"],
  expires_at: "2026-11-06T09:00:00+00:00",
};

interface World {
  preview?: FakeReply;
  answer?: FakeReply;
}

function world(w: World = {}) {
  return fakeSupabase((request: RecordedRequest): FakeReply => {
    if (request.path === "/rest/v1/rpc/document_request_preview") return w.preview ?? { body: [previewRow] };
    if (request.path === "/rest/v1/rpc/answer_document_request") {
      return (
        w.answer ?? {
          body: [{ outcome: "answered", request_id: REQUEST, org_id: ORG, org_name: "Pinecrest Studio", org_slug: "pinecrest", invoice_id: INVOICE, counterparty_id: VENDOR, counterparty_name: "Northstar Studio", invoice_reference: "INV-2215" }],
        }
      );
    }
    if (request.path === "/rest/v1/rpc/org_members") {
      return {
        body: [
          { user_id: "u1", email: "owner@pinecrest.example", role: "owner", joined_at: "2026-09-01T00:00:00Z" },
          { user_id: "u2", email: "approver@pinecrest.example", role: "approver", joined_at: "2026-09-01T00:00:00Z" },
        ],
      };
    }
    return { body: [] };
  });
}

const within = <T,>(client: ReturnType<typeof fakeSupabase>, fn: () => Promise<T>) => runWith({ config, db: client.client, fetch: client.fetch }, fn);
let ip = 0;
/** A fresh address and link each test, so the rate limits of one test never spend another's. */
const freshClient = () => `203.0.113.${(ip += 1)}`;
const token = () => generateDocumentToken().token;

beforeEach(() => {
  bestEffortMock.mockReset().mockResolvedValue(undefined);
  sendMock.mockReset().mockResolvedValue({ sent: true, id: "email-1" });
  storage.uploadUrl.mockReset().mockResolvedValue({ data: { signedUrl: "https://tests.supabase.invalid/storage/v1/object/upload/sign/documents/x?token=t", token: "t", path: "x" }, error: null });
  storage.download.mockReset().mockResolvedValue({ data: new Blob([PDF]), error: null });
  storage.move.mockReset().mockResolvedValue({ data: { message: "Successfully moved" }, error: null });
  storage.remove.mockReset().mockResolvedValue({ data: [], error: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the page (ER5)", () => {
  it("shows the workspace, the vendor's invoice, its amount and due date, and what is missing", async () => {
    const client = world();
    const link = token();
    expect(await within(client, () => previewDocumentRequest(link))).toEqual({
      orgName: "Pinecrest Studio",
      vendorName: "Northstar Studio",
      reference: "INV-2215",
      amount: 1250,
      currency: "USDC",
      dueDate: "2026-10-30T12:00:00+00:00",
      missing: ["purchase_order"],
      expiresAt: "2026-11-06T09:00:00+00:00",
    });
    expect((client.requests[0].body as { p_token_hash: string }).p_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(client.requests[0].body)).not.toContain(link);
  });

  it("shows nothing for a link that is not one, one that answers nothing, or before migration 0142", async () => {
    const client = world();
    expect(await within(client, () => previewDocumentRequest("vxu_short"))).toBeNull();
    expect(client.requests).toHaveLength(0);
    expect(await within(world({ preview: { body: [] } }), () => previewDocumentRequest(token()))).toBeNull();
    expect(await within(world({ preview: { status: 404, body: { code: "PGRST202", message: "Could not find the function" } } }), () => previewDocumentRequest(token()))).toBeNull();
  });
});

describe("starting the upload (ER5)", () => {
  it("gives the browser a one-time upload address under the request's own folder", async () => {
    const result = await within(world(), () => startDocumentUpload(token(), { size: 2048, type: "application/pdf" }, freshClient(), NOW));
    expect(result).toEqual({ ok: true, url: "https://tests.supabase.invalid/storage/v1/object/upload/sign/documents/x?token=t" });
    expect(storage.uploadUrl).toHaveBeenCalledWith(`${ORG}/document-requests/${REQUEST}/upload`);
  });

  it("refuses a file over 10 MB, an empty one, and a kind it does not take, before looking the link up", async () => {
    const client = world();
    expect(await within(client, () => startDocumentUpload(token(), { size: 10 * 1024 * 1024 + 1, type: "application/pdf" }, freshClient(), NOW))).toEqual({ ok: false, reason: "too_large" });
    expect(await within(client, () => startDocumentUpload(token(), { size: 0, type: "application/pdf" }, freshClient(), NOW))).toEqual({ ok: false, reason: "no_file" });
    expect(await within(client, () => startDocumentUpload(token(), { size: 100, type: "text/html" }, freshClient(), NOW))).toEqual({ ok: false, reason: "file_type" });
    expect(client.requests).toHaveLength(0);
    expect(storage.uploadUrl).not.toHaveBeenCalled();
  });

  it("refuses a link that answers nothing", async () => {
    expect(await within(world({ preview: { body: [] } }), () => startDocumentUpload(token(), { size: 100, type: "image/png" }, freshClient(), NOW))).toEqual({ ok: false, reason: "invalid_link" });
    expect(storage.uploadUrl).not.toHaveBeenCalled();
  });

  it("is rate-limited per link and per address", async () => {
    const link = token();
    const results = [];
    for (let i = 0; i < 7; i++) results.push(await within(world(), () => startDocumentUpload(link, { size: 100, type: "image/png" }, freshClient(), NOW)));
    expect(results.filter((result) => result.ok)).toHaveLength(5);
    expect(results.at(-1)).toEqual({ ok: false, reason: "busy" });

    const address = freshClient();
    const fromOne = [];
    for (let i = 0; i < 12; i++) fromOne.push(await within(world(), () => startDocumentUpload(token(), { size: 100, type: "image/png" }, address, NOW)));
    expect(fromOne.filter((result) => result.ok)).toHaveLength(10);
    expect(fromOne.at(-1)).toEqual({ ok: false, reason: "busy" });
  });
});

describe("sending it (ER5, ER6)", () => {
  it("checks the file by its first bytes, keeps it under its SHA-256, takes the answer once, signs it and tells the owners and admins", async () => {
    const client = world();
    const deferred: Array<() => Promise<unknown>> = [];
    const result = await within(client, () =>
      submitDocument(token(), { poReference: " PO-4410 ", note: "Signed copy." }, freshClient(), { now: NOW, defer: (work) => deferred.push(work) })
    );
    expect(result).toEqual({ ok: true, orgName: "Pinecrest Studio" });
    expect(storage.download).toHaveBeenCalledWith(`${ORG}/document-requests/${REQUEST}/upload`);
    const kept = `${ORG}/document-requests/${REQUEST}/${PDF_SHA}`;
    expect(storage.move).toHaveBeenCalledWith(`${ORG}/document-requests/${REQUEST}/upload`, kept);
    const answer = client.requests.find((r) => r.path === "/rest/v1/rpc/answer_document_request")!;
    expect(answer.body).toEqual({
      p_token_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      p_file_path: kept,
      p_file_sha256: PDF_SHA,
      p_file_type: "application/pdf",
      p_file_size: PDF.byteLength,
      p_po_reference: "PO-4410",
      p_note: "Signed copy.",
    });
    expect(bestEffortMock).toHaveBeenCalledWith(ORG, {
      actor: "human",
      domain: "ap",
      action: "document_received",
      summary: "Northstar Studio sent a document for invoice INV-2215, with purchase order PO-4410",
      detail: { by: null, via: "document_request", invoiceId: INVOICE, counterpartyId: VENDOR, requestId: REQUEST, poReference: "PO-4410", fileSha256: PDF_SHA, fileType: "application/pdf", fileSize: PDF.byteLength },
    });

    // The owners and admins hear of it after the vendor has its page.
    expect(sendMock).not.toHaveBeenCalled();
    expect(deferred).toHaveLength(1);
    await within(client, deferred[0]);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0]).toMatchObject({ to: "owner@pinecrest.example", subject: "Northstar Studio sent a document for invoice INV-2215" });
    expect(sendMock.mock.calls[0][0].text).toContain(`/o/pinecrest/approvals#payable-${INVOICE}`);
    // What the vendor typed stays on the card, behind sign-in: Vestiarion's own email only says there is one.
    expect(sendMock.mock.calls[0][0].text).toContain("with a purchase order number");
    expect(JSON.stringify(sendMock.mock.calls[0][0])).not.toContain("PO-4410");
  });

  it("keeps the file only once it reads back, from where it is kept, as the file it checked", async () => {
    const kept = `${ORG}/document-requests/${REQUEST}/${PDF_SHA}`;
    const client = world();
    await within(client, () => submitDocument(token(), { poReference: "", note: "" }, freshClient(), { now: NOW }));
    expect(storage.download).toHaveBeenNthCalledWith(1, `${ORG}/document-requests/${REQUEST}/upload`);
    expect(storage.download).toHaveBeenNthCalledWith(2, kept);

    // The upload address put another file in place between the check and the move: nothing is taken, and it is removed.
    storage.download.mockReset();
    storage.download
      .mockResolvedValueOnce({ data: new Blob([PDF]), error: null })
      .mockResolvedValueOnce({ data: new Blob([new TextEncoder().encode("<html><script>alert(1)</script>")]), error: null });
    storage.remove.mockClear();
    bestEffortMock.mockClear();
    const swapped = world();
    expect(await within(swapped, () => submitDocument(token(), { poReference: "", note: "" }, freshClient(), { now: NOW }))).toEqual({ ok: false, reason: "failed_check" });
    expect(storage.remove).toHaveBeenCalledWith([kept]);
    expect(swapped.requests.some((r) => r.path === "/rest/v1/rpc/answer_document_request")).toBe(false);
    expect(bestEffortMock).not.toHaveBeenCalled();
  });

  it("leaves the purchase order out of the entry when the vendor typed none", async () => {
    await within(world(), () => submitDocument(token(), { poReference: "", note: "" }, freshClient(), { now: NOW }));
    const detail = bestEffortMock.mock.calls[0][1].detail as Record<string, unknown>;
    expect("poReference" in detail).toBe(false);
  });

  it("refuses a file that is not a PDF, PNG or JPEG by its bytes, whatever its name, and removes it", async () => {
    storage.download.mockResolvedValueOnce({ data: new Blob([new TextEncoder().encode("<html><script>alert(1)</script>")]), error: null });
    const client = world();
    expect(await within(client, () => submitDocument(token(), { poReference: "", note: "" }, freshClient(), { now: NOW }))).toEqual({ ok: false, reason: "file_type" });
    expect(storage.remove).toHaveBeenCalledWith([`${ORG}/document-requests/${REQUEST}/upload`]);
    expect(client.requests.some((r) => r.path === "/rest/v1/rpc/answer_document_request")).toBe(false);
  });

  it("refuses a file over 10 MB, and says so when no file arrived", async () => {
    storage.download.mockResolvedValueOnce({ data: new Blob([PDF, new Uint8Array(10 * 1024 * 1024)]), error: null });
    expect(await within(world(), () => submitDocument(token(), { poReference: "", note: "" }, freshClient(), { now: NOW }))).toEqual({ ok: false, reason: "too_large" });
    storage.download.mockResolvedValueOnce({ data: null, error: { message: "Object not found" } });
    expect(await within(world(), () => submitDocument(token(), { poReference: "", note: "" }, freshClient(), { now: NOW }))).toEqual({ ok: false, reason: "no_file" });
  });

  it("checks the fields before anything else", async () => {
    const client = world();
    expect(await within(client, () => submitDocument(token(), { poReference: "P".repeat(101), note: "" }, freshClient(), { now: NOW }))).toMatchObject({ ok: false, reason: "invalid", field: "poReference" });
    expect(client.requests).toHaveLength(0);
    expect(storage.download).not.toHaveBeenCalled();
  });

  it("takes one answer: a second finds the link used, and the file it would have kept is removed", async () => {
    const client = world({ answer: { body: [{ outcome: "not_valid", request_id: null, org_id: null, org_name: null, org_slug: null, invoice_id: null, counterparty_id: null, counterparty_name: null, invoice_reference: null }] } });
    expect(await within(client, () => submitDocument(token(), { poReference: "", note: "" }, freshClient(), { now: NOW }))).toEqual({ ok: false, reason: "invalid_link" });
    expect(storage.remove).toHaveBeenCalledWith([`${ORG}/document-requests/${REQUEST}/${PDF_SHA}`]);
    expect(bestEffortMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("answers nothing for an expired, answered or revoked link, reading no file", async () => {
    expect(await within(world({ preview: { body: [] } }), () => submitDocument(token(), { poReference: "", note: "" }, freshClient(), { now: NOW }))).toEqual({ ok: false, reason: "invalid_link" });
    expect(storage.download).not.toHaveBeenCalled();
  });

  it("is rate-limited per link", async () => {
    const link = token();
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await within(world({ preview: { body: [] } }), () => submitDocument(link, { poReference: "", note: "" }, freshClient(), { now: NOW })));
    // A link that answers nothing gets no bucket of its own: each try is refused as a dead link.
    expect(results.every((result) => !result.ok && result.reason === "invalid_link")).toBe(true);
    const live = token();
    const tries = [];
    for (let i = 0; i < 7; i++) tries.push(await within(world(), () => submitDocument(live, { poReference: "", note: "" }, freshClient(), { now: NOW })));
    expect(tries.at(-1)).toEqual({ ok: false, reason: "busy" });
  });

  it("never writes to a bill, a counterparty or a payment (ER7)", async () => {
    const client = world();
    await within(client, () => submitDocument(token(), { poReference: "PO-1", note: "" }, freshClient(), { now: NOW }));
    expect(client.requests.filter((r) => !r.path.startsWith("/rest/v1/rpc/"))).toEqual([]);
    const called = client.requests.map((r) => r.path.slice("/rest/v1/rpc/".length));
    // The lookup, the answer, and the members to tell: nothing else.
    expect(called).toEqual(["document_request_preview", "answer_document_request", "org_members"]);
  });
});
