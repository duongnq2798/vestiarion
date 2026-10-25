import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * An owner or admin attaches the vendor's document to a bill (docs/superpowers/specs/2026-10-25-exception-resolution-part-2-design.md
 * DK11): one PDF of at most 4 MB, known by its first bytes, kept under the workspace's own folder by its SHA-256 with an
 * upload that never overwrites, then 0144's attach_document, which inserts the answered member row; a file it refuses is
 * removed; signed as `document_received { by, via: "attached" }`. Before 0144, and while vendor requests are off, nothing.
 */

const { bestEffortMock, calls, storage } = vi.hoisted(() => {
  const calls: string[] = [];
  return {
    bestEffortMock: vi.fn(),
    calls,
    storage: {
      upload: vi.fn(async () => {
        calls.push("upload");
        return { data: { path: "x" }, error: null as { message: string } | null };
      }),
      remove: vi.fn(async () => ({ data: [], error: null })),
    },
  };
});
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: bestEffortMock }));
vi.mock("@/lib/dal", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/dal")>()), platformStorage: () => storage }));

import { attachDocument, AttachDocumentError } from "@/lib/document-requests/attach";

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c0c";
const ACTOR = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c1";
const BILL = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001c1";
const VENDOR = "0b6c1c9e-4a4f-4a7e-9b1e-0000000002c2";

const PDF = new TextEncoder().encode("%PDF-1.7\nNorthstar Studio\nPurchase order PO-2215\nTotal due 8.00 USDC\n%%EOF");
const PDF_SHA = crypto.createHash("sha256").update(PDF).digest("hex");

interface World {
  setting?: "off" | "shadow" | "on";
  checks?: boolean;
  bill?: Record<string, unknown> | null;
  attach?: FakeReply;
}

const waitingBill = (over: Record<string, unknown> = {}) => ({
  id: BILL,
  direction: "payable",
  status: "awaiting_info",
  memo: "INV-2215",
  po_reference: null,
  goods_received: true,
  tx_ref: null,
  counterparty_id: VENDOR,
  counterparties: { name: "Northstar Studio", purchase_order_required: true },
  ...over,
});

function world(w: World = {}) {
  return fakeSupabase((request: RecordedRequest): FakeReply => {
    if (request.path === "/rest/v1/approval_policies") return { body: [{ document_requests: w.setting ?? "on" }] };
    if (request.path === "/rest/v1/document_requests") {
      return w.checks === false ? { status: 400, body: { code: "42703", message: "column document_requests.checked_at does not exist" } } : { body: [] };
    }
    if (request.path === "/rest/v1/invoices") return { body: w.bill === undefined ? waitingBill() : w.bill };
    if (request.path === "/rest/v1/rpc/attach_document") {
      calls.push("attach_document");
      return w.attach ?? { body: "attached" };
    }
    return { body: [] };
  });
}

const within = <T,>(client: ReturnType<typeof fakeSupabase>, fn: () => Promise<T>) => runWith(orgTestContext({ config, client: client.client, orgId: ORG }), fn);
const attach = (client: ReturnType<typeof fakeSupabase>, over: Partial<Parameters<typeof attachDocument>[0]> = {}) =>
  within(client, () => attachDocument({ actorId: ACTOR, role: "admin", invoiceId: BILL, bytes: PDF, ...over }));

beforeEach(() => {
  calls.length = 0;
  bestEffortMock.mockReset().mockResolvedValue(undefined);
  storage.upload.mockClear();
  storage.remove.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("attaching (DK11)", () => {
  it("keeps the PDF under the workspace's own folder by its SHA-256, uploads it before the function without overwriting, and signs who attached it", async () => {
    const client = world();
    const result = await attach(client);
    expect(result).toEqual({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/), mode: "on" });
    const path = `${ORG}/document-requests/${result.requestId}/${PDF_SHA}`;
    expect(storage.upload).toHaveBeenCalledWith(path, PDF, "application/pdf");
    expect(calls).toEqual(["upload", "attach_document"]);
    const rpc = client.requests.find((r) => r.path === "/rest/v1/rpc/attach_document")!;
    expect(rpc.body).toEqual({
      p_org_id: ORG,
      p_id: result.requestId,
      p_invoice_id: BILL,
      p_by: ACTOR,
      p_missing: ["purchase_order"],
      p_file_path: path,
      p_file_sha256: PDF_SHA,
      p_file_size: PDF.byteLength,
    });
    expect(storage.remove).not.toHaveBeenCalled();
    expect(bestEffortMock).toHaveBeenCalledWith(ORG, {
      actor: "human",
      domain: "ap",
      action: "document_received",
      summary: "A member attached Northstar Studio's document for invoice INV-2215",
      detail: { by: ACTOR, via: "attached", invoiceId: BILL, counterpartyId: VENDOR, requestId: result.requestId, fileSha256: PDF_SHA, fileType: "application/pdf", fileSize: PDF.byteLength },
    });
  });

  it("names what the bill lacks now, and says the mode it is checked in", async () => {
    const client = world({ setting: "shadow", bill: waitingBill({ po_reference: "PO-2215", goods_received: false }) });
    const result = await attach(client);
    expect(result.mode).toBe("shadow");
    expect((client.requests.find((r) => r.path === "/rest/v1/rpc/attach_document")!.body as { p_missing: string[] }).p_missing).toEqual(["goods_receipt"]);
    // A counterparty paid without purchase orders is never asked for one.
    const unasked = world({ bill: waitingBill({ goods_received: false, counterparties: { name: "Northstar Studio", purchase_order_required: false } }) });
    await attach(unasked);
    expect((unasked.requests.find((r) => r.path === "/rest/v1/rpc/attach_document")!.body as { p_missing: string[] }).p_missing).toEqual(["goods_receipt"]);
  });

  it("removes the file the function refused, and says why", async () => {
    for (const [answer, message] of [
      ["busy", "The last document attached to this bill is still waiting to be checked. Try again in a minute."],
      ["same_file", "This file is already on this bill."],
      ["not_waiting", "This bill no longer waits for a purchase order or goods receipt. Reload the page to see it."],
    ] as const) {
      storage.remove.mockClear();
      bestEffortMock.mockClear();
      const client = world({ attach: { body: answer } });
      const refused = await attach(client).catch((error: unknown) => error);
      expect(refused, answer).toBeInstanceOf(AttachDocumentError);
      expect((refused as Error).message).toBe(message);
      const path = (client.requests.find((r) => r.path === "/rest/v1/rpc/attach_document")!.body as { p_file_path: string }).p_file_path;
      expect(storage.remove).toHaveBeenCalledWith([path]);
      expect(bestEffortMock).not.toHaveBeenCalled();
    }
  });

  it("refuses a file that is not a PDF by its first bytes, an empty one and one over 4 MB, before anything is stored", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const large = new Uint8Array(4_000_001);
    large.set(PDF.slice(0, 5));
    for (const bytes of [png, new Uint8Array(0), large, new TextEncoder().encode("<html>%PDF-1.7</html>")]) {
      const client = world();
      await expect(attach(client, { bytes })).rejects.toThrow("Choose a PDF of up to 4 MB.");
      expect(client.requests.some((r) => r.path === "/rest/v1/rpc/attach_document")).toBe(false);
    }
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it("refuses while vendor requests are off, before migration 0144, and for a bill that no longer waits for a document", async () => {
    await expect(attach(world({ setting: "off" }))).rejects.toThrow("Turn on vendor requests in Settings, in shadow or on, to check documents.");
    await expect(attach(world({ checks: false }))).rejects.toThrow("Checking documents is not available in this workspace yet.");
    for (const bill of [null, waitingBill({ status: "held" }), waitingBill({ direction: "receivable" }), waitingBill({ po_reference: "PO-1" }), waitingBill({ tx_ref: "0xabc" })]) {
      await expect(attach(world({ bill }))).rejects.toThrow("This bill no longer waits for a purchase order or goods receipt. Reload the page to see it.");
    }
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it("is an owner's or admin's alone", async () => {
    for (const role of ["approver", "accountant", "viewer"] as const) {
      await expect(attach(world(), { role })).rejects.toThrow("Only an owner or admin can attach a document.");
    }
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it("removes the file and says it is not available when the function is not there yet", async () => {
    const client = world({ attach: { status: 404, body: { code: "PGRST202", message: "Could not find the function public.attach_document" } } });
    await expect(attach(client)).rejects.toThrow("Checking documents is not available in this workspace yet.");
    expect(storage.remove).toHaveBeenCalledTimes(1);
  });

  it("stops when the file cannot be stored, and calls nothing", async () => {
    storage.upload.mockResolvedValueOnce({ data: null as never, error: { message: "The resource already exists" } });
    const client = world();
    await expect(attach(client)).rejects.toThrow();
    expect(client.requests.some((r) => r.path === "/rest/v1/rpc/attach_document")).toBe(false);
  });
});
