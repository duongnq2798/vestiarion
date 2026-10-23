import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * What members see and do of document requests (docs/superpowers/specs/2026-10-23-document-requests-design.md ER3, ER4,
 * ER6): each bill's latest request as its card shows it, read as none before migration 0142; an owner's or admin's
 * Revoke, signed; and a short-lived address for a member to open the vendor's file.
 */

const { bestEffortMock, storage } = vi.hoisted(() => ({
  bestEffortMock: vi.fn(),
  storage: { uploadUrl: vi.fn(), download: vi.fn(), move: vi.fn(), remove: vi.fn(), openUrl: vi.fn() },
}));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: bestEffortMock }));
vi.mock("@/lib/dal", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/dal")>()), platformStorage: () => storage }));

import { documentOpenUrl, readDocumentRequests, revokeDocumentRequest, RevokeDocumentRequestError } from "@/lib/document-requests/read";

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000f1f";
const ACTOR = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000f1";
const BILL = (n: number) => `0b6c1c9e-4a4f-4a7e-9b1e-00000000010${n}`;
const NOW = Date.parse("2026-10-24T09:00:00Z");

const request = (over: Record<string, unknown>) => ({
  id: "r-1",
  invoice_id: BILL(1),
  status: "open",
  missing: ["purchase_order"],
  created_at: "2026-10-23T09:00:00Z",
  sent_at: "2026-10-23T09:00:00Z",
  expires_at: "2026-11-06T09:00:00Z",
  answered_at: null,
  po_reference: null,
  note: null,
  file_type: null,
  file_size: null,
  ...over,
});

function world(options: { setting?: string; requests?: Array<Record<string, unknown>> | FakeReply; revoke?: FakeReply; file?: Record<string, unknown> | null } = {}) {
  return fakeSupabase((r: RecordedRequest): FakeReply => {
    if (r.path === "/rest/v1/approval_policies") return { body: [{ document_requests: options.setting ?? "on" }] };
    if (r.path === "/rest/v1/document_requests") {
      if (r.params.get("id")) return { body: options.file === undefined ? null : options.file };
      const requests = options.requests ?? [];
      return Array.isArray(requests) ? { body: requests } : requests;
    }
    if (r.path === "/rest/v1/rpc/revoke_document_request") return options.revoke ?? { body: { id: "r-1", invoice_id: BILL(1), counterparty_id: "cp-1", status: "revoked" } };
    return { body: [] };
  });
}

const within = <T,>(client: ReturnType<typeof fakeSupabase>, fn: () => Promise<T>) => runWith(orgTestContext({ config, client: client.client, orgId: ORG }), fn);

beforeEach(() => {
  bestEffortMock.mockReset().mockResolvedValue(undefined);
  storage.openUrl.mockReset().mockResolvedValue({ data: { signedUrl: "https://tests.supabase.invalid/storage/v1/object/sign/documents/f?token=s&download=" }, error: null });
});

describe("each bill's request, as its card shows it (ER3, ER4, ER6)", () => {
  it("shows the latest request of each bill: asked, answered, expired with no answer, or would ask in shadow", async () => {
    const shadow = world({
      setting: "shadow",
      requests: [
        request({ id: "r-4", invoice_id: BILL(4), status: "drafted", sent_at: null, expires_at: null }),
        request({ id: "r-3", invoice_id: BILL(3), status: "answered", answered_at: "2026-10-24T08:00:00Z", po_reference: "PO-4410", note: "Signed.", file_type: "application/pdf", file_size: 2048 }),
        request({ id: "r-2", invoice_id: BILL(2), status: "expired", expires_at: "2026-10-20T09:00:00Z", sent_at: "2026-10-06T09:00:00Z" }),
        request({ id: "r-1", invoice_id: BILL(1) }),
        // An older one of bill 1: the newest is shown.
        request({ id: "r-0", invoice_id: BILL(1), status: "expired", created_at: "2026-09-01T00:00:00Z" }),
      ],
    });
    const views = await within(shadow, () => readDocumentRequests([BILL(1), BILL(2), BILL(3), BILL(4)], db(), NOW));
    expect(views.get(BILL(1))).toEqual({ state: "asked", id: "r-1", missing: ["purchase_order"], sentAt: "2026-10-23T09:00:00Z", expiresAt: "2026-11-06T09:00:00Z" });
    expect(views.get(BILL(2))).toEqual({ state: "expired", missing: ["purchase_order"], sentAt: "2026-10-06T09:00:00Z", expiresAt: "2026-10-20T09:00:00Z" });
    expect(views.get(BILL(3))).toEqual({ state: "answered", id: "r-3", missing: ["purchase_order"], answeredAt: "2026-10-24T08:00:00Z", poReference: "PO-4410", note: "Signed.", fileType: "application/pdf", fileSize: 2048 });
    expect(views.get(BILL(4))).toEqual({ state: "would_ask", missing: ["purchase_order"] });
    const read = shadow.requests.find((r) => r.path === "/rest/v1/document_requests")!;
    expect(read.params.get("org_id")).toBe(`eq.${ORG}`);
  });

  it("shows a drafted request only in shadow, an open one past its date as expired, and nothing for a revoked one or one never emailed", async () => {
    const on = world({
      setting: "on",
      requests: [
        request({ id: "r-4", invoice_id: BILL(4), status: "drafted", sent_at: null, expires_at: null }),
        request({ id: "r-3", invoice_id: BILL(3), status: "revoked" }),
        request({ id: "r-2", invoice_id: BILL(2), status: "open", expires_at: "2026-10-23T00:00:00Z" }),
        request({ id: "r-1", invoice_id: BILL(1), status: "expired", sent_at: null, expires_at: "2026-10-23T00:00:00Z" }),
      ],
    });
    const views = await within(on, () => readDocumentRequests([BILL(1), BILL(2), BILL(3), BILL(4)], db(), NOW));
    expect(views.has(BILL(4))).toBe(false);
    expect(views.has(BILL(3))).toBe(false);
    expect(views.get(BILL(2))?.state).toBe("expired");
    expect(views.has(BILL(1))).toBe(false);
  });

  it("reads none before migration 0142, and none for no bill", async () => {
    const before = world({ requests: { status: 404, body: { code: "PGRST205", message: "Could not find the table 'public.document_requests'" } } });
    expect((await within(before, () => readDocumentRequests([BILL(1)], db(), NOW))).size).toBe(0);
    const none = world();
    expect((await within(none, () => readDocumentRequests([], db(), NOW))).size).toBe(0);
    expect(none.requests).toHaveLength(0);
  });
});

describe("Revoke (ER6)", () => {
  it("stops an open request for an owner or admin, and signs who did", async () => {
    const client = world();
    await within(client, () => revokeDocumentRequest({ actorId: ACTOR, role: "admin", requestId: "r-1" }));
    expect(client.requests.find((r) => r.path === "/rest/v1/rpc/revoke_document_request")?.body).toEqual({ p_org_id: ORG, p_id: "r-1" });
    expect(bestEffortMock).toHaveBeenCalledWith(ORG, {
      actor: "human",
      domain: "ap",
      action: "document_request_revoked",
      summary: "Revoked the request for a missing document; its link no longer works",
      detail: { by: ACTOR, requestId: "r-1", invoiceId: BILL(1), counterpartyId: "cp-1" },
    });
  });

  it("refuses an approver or a viewer, and a request that is not open", async () => {
    await expect(within(world(), () => revokeDocumentRequest({ actorId: ACTOR, role: "approver", requestId: "r-1" }))).rejects.toMatchObject({ code: "forbidden" });
    await expect(within(world(), () => revokeDocumentRequest({ actorId: ACTOR, role: "viewer", requestId: "r-1" }))).rejects.toBeInstanceOf(RevokeDocumentRequestError);
    const closed = world({ revoke: { body: { id: null, invoice_id: null, counterparty_id: null, status: null } } });
    await expect(within(closed, () => revokeDocumentRequest({ actorId: ACTOR, role: "owner", requestId: "r-1" }))).rejects.toMatchObject({ code: "not_open" });
    expect(bestEffortMock).not.toHaveBeenCalled();
  });
});

describe("opening the vendor's file (ER6)", () => {
  it("gives a member a one-minute address for an answered request's file, named for download", async () => {
    const client = world({ file: { id: "r-3", status: "answered", file_path: `${ORG}/document-requests/r-3/abc`, file_type: "image/png" } });
    expect(await within(client, () => documentOpenUrl("0b6c1c9e-4a4f-4a7e-9b1e-0000000003f3"))).toBe("https://tests.supabase.invalid/storage/v1/object/sign/documents/f?token=s&download=");
    expect(storage.openUrl).toHaveBeenCalledWith(`${ORG}/document-requests/r-3/abc`, 60, "document-r-3.png");
  });

  it("gives none for a request with no file, or not of this workspace, or a malformed id", async () => {
    expect(await within(world({ file: { id: "r-1", status: "open", file_path: null, file_type: null } }), () => documentOpenUrl("0b6c1c9e-4a4f-4a7e-9b1e-0000000003f3"))).toBeNull();
    expect(await within(world({ file: null }), () => documentOpenUrl("0b6c1c9e-4a4f-4a7e-9b1e-0000000003f3"))).toBeNull();
    const client = world();
    expect(await within(client, () => documentOpenUrl("not-a-uuid"))).toBeNull();
    expect(client.requests).toHaveLength(0);
    expect(storage.openUrl).not.toHaveBeenCalled();
  });
});
