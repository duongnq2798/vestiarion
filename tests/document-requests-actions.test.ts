import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { fakeSupabase } from "./support/fake-supabase";

/**
 * The actions of document requests (docs/superpowers/specs/2026-10-23-document-requests-design.md ER1, ER5, ER6): the
 * owner's setting, authorized as `approval.policy`; an owner's or admin's Revoke, as `records.write`; and the vendor's two
 * calls, which need no session, say only fixed sentences, and pass on the vendor's address for its rate limit.
 */

const { ORG, USER } = vi.hoisted(() => ({
  ORG: "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a",
  USER: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000a1",
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const { afterMock, headersMock, raiseMock } = vi.hoisted(() => ({ afterMock: vi.fn(), headersMock: vi.fn(), raiseMock: vi.fn() }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: afterMock }));
vi.mock("next/headers", () => ({ headers: headersMock }));
vi.mock("@/lib/agent/cycle-soon", () => ({ raiseCycleEvent: raiseMock }));
const { authorizeMock } = vi.hoisted(() => ({ authorizeMock: vi.fn() }));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));
const { changeMock, revokeMock, startMock, submitMock } = vi.hoisted(() => ({ changeMock: vi.fn(), revokeMock: vi.fn(), startMock: vi.fn(), submitMock: vi.fn() }));
vi.mock("@/lib/document-requests/setting", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/document-requests/setting")>()), changeDocumentRequests: changeMock }));
vi.mock("@/lib/document-requests/read", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/document-requests/read")>()), revokeDocumentRequest: revokeMock }));
vi.mock("@/lib/document-requests/intake", () => ({ startDocumentUpload: startMock, submitDocument: submitMock }));

import { revokeDocumentRequestAction, setDocumentRequestsAction } from "@/app/actions/document-requests";
import { startDocumentUploadAction, submitDocumentAction } from "@/app/documents/[token]/actions";
import { RevokeDocumentRequestError } from "@/lib/document-requests/read";
import { DocumentRequestsError } from "@/lib/document-requests/setting";

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

const INITIAL = { ok: false, message: "" };

function form(fields: Record<string, string>): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) formData.set(key, value);
  return formData;
}

function allow(role: "owner" | "admin" | "approver") {
  authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: { orgId: ORG, slug: "pinecrest", name: "Pinecrest", mode: "live", role } });
}

const run = <T,>(fn: () => Promise<T>) => {
  const fake = fakeSupabase((request) =>
    request.path === "/rest/v1/orgs"
      ? { body: { id: ORG, slug: "pinecrest", name: "Pinecrest", mode: "live", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null } }
      : { body: [] }
  );
  return runWith({ config, db: fake.client, fetch: fake.fetch }, fn);
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  headersMock.mockResolvedValue(new Headers({ "x-forwarded-for": "198.51.100.7, 10.0.0.1" }));
});

describe("the setting (ER1)", () => {
  it("asks for approval.policy, sets it as the signed-in owner, and weighs the waiting bills now", async () => {
    allow("owner");
    changeMock.mockResolvedValueOnce({ from: "off", to: "shadow" });
    const result = await run(() => setDocumentRequestsAction(INITIAL, form({ orgSlug: "pinecrest", setting: "shadow" })));
    expect(authorizeMock).toHaveBeenCalledWith("pinecrest", "approval.policy");
    expect(changeMock).toHaveBeenCalledWith({ actorId: USER, to: "shadow" });
    expect(raiseMock).toHaveBeenCalledWith(expect.objectContaining({ user: { id: USER, email: null } }), "document_requests_on");
    expect(result).toEqual({ ok: true, message: "Vendor requests are in shadow: each bill's card says what Vestiarion would ask, and nothing is sent." });
  });

  it("says on checks what vendors send once documents are checked, and part 1's words before migration 0144 (document checks DK1)", async () => {
    allow("owner");
    changeMock.mockResolvedValueOnce({ from: "shadow", to: "on", checks: true });
    expect((await run(() => setDocumentRequestsAction(INITIAL, form({ orgSlug: "pinecrest", setting: "on" })))).message).toBe(
      "Vendor requests are on: Vestiarion emails vendors for a bill's missing purchase order or goods receipt, and checks what they send."
    );
    allow("owner");
    changeMock.mockResolvedValueOnce({ from: "shadow", to: "on", checks: false });
    expect((await run(() => setDocumentRequestsAction(INITIAL, form({ orgSlug: "pinecrest", setting: "on" })))).message).toBe(
      "Vendor requests are on: Vestiarion emails vendors for a bill's missing purchase order or goods receipt."
    );
  });

  it("starts no cycle when turned off", async () => {
    allow("owner");
    changeMock.mockResolvedValueOnce({ from: "on", to: "off" });
    expect((await run(() => setDocumentRequestsAction(INITIAL, form({ orgSlug: "pinecrest", setting: "off" })))).message).toBe(
      "Vendor requests are off. Links already sent still work until they expire."
    );
    expect(raiseMock).not.toHaveBeenCalled();
  });

  it("refuses anyone but an owner, a value it does not know, and says why the library refused", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "Only an owner can do that." });
    expect(await run(() => setDocumentRequestsAction(INITIAL, form({ orgSlug: "pinecrest", setting: "on" })))).toEqual({ ok: false, message: "Only an owner can do that." });
    expect(changeMock).not.toHaveBeenCalled();
    allow("owner");
    expect(await run(() => setDocumentRequestsAction(INITIAL, form({ orgSlug: "pinecrest", setting: "always" })))).toEqual({ ok: false, message: "Choose off, shadow or on." });
    allow("owner");
    changeMock.mockRejectedValueOnce(new DocumentRequestsError("cycle_running"));
    expect((await run(() => setDocumentRequestsAction(INITIAL, form({ orgSlug: "pinecrest", setting: "on" })))).message).toBe("A cycle is running. Try again in a minute, once it has finished.");
    allow("owner");
    changeMock.mockRejectedValueOnce(new Error("relation does not exist"));
    expect((await run(() => setDocumentRequestsAction(INITIAL, form({ orgSlug: "pinecrest", setting: "on" })))).message).toBe("That did not work. Try again in a moment.");
  });
});

describe("Revoke (ER6)", () => {
  it("asks for records.write and revokes as the signed-in owner or admin", async () => {
    allow("admin");
    revokeMock.mockResolvedValueOnce(undefined);
    const result = await run(() => revokeDocumentRequestAction(INITIAL, form({ orgSlug: "pinecrest", requestId: "r-1" })));
    expect(authorizeMock).toHaveBeenCalledWith("pinecrest", "records.write");
    expect(revokeMock).toHaveBeenCalledWith({ actorId: USER, role: "admin", requestId: "r-1" });
    expect(result).toEqual({ ok: true, message: "Revoked. The link no longer works, and Vestiarion will not ask the vendor about this bill again." });
  });

  it("says why it was refused", async () => {
    allow("owner");
    revokeMock.mockRejectedValueOnce(new RevokeDocumentRequestError("not_open"));
    expect((await run(() => revokeDocumentRequestAction(INITIAL, form({ orgSlug: "pinecrest", requestId: "r-1" })))).message).toBe("This request is no longer open.");
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "Only an owner or admin can do that." });
    expect(await run(() => revokeDocumentRequestAction(INITIAL, form({ orgSlug: "pinecrest", requestId: "r-1" })))).toEqual({ ok: false, message: "Only an owner or admin can do that." });
  });
});

describe("the vendor's page (ER5)", () => {
  it("starts an upload with the vendor's first forwarded address, and says each refusal in a fixed sentence", async () => {
    startMock.mockResolvedValueOnce({ ok: true, url: "https://storage.example/upload" });
    expect(await startDocumentUploadAction("vxu_x", 2048, "application/pdf")).toEqual({ ok: true, message: "", url: "https://storage.example/upload" });
    expect(startMock).toHaveBeenCalledWith("vxu_x", { size: 2048, type: "application/pdf" }, "198.51.100.7");
    startMock.mockResolvedValueOnce({ ok: false, reason: "too_large" });
    expect((await startDocumentUploadAction("vxu_x", 99, "application/pdf")).message).toBe("The file is over 10 MB. Send a smaller copy.");
    startMock.mockResolvedValueOnce({ ok: false, reason: "invalid_link" });
    expect((await startDocumentUploadAction("vxu_x", 99, "application/pdf")).message).toBe("This link is no longer valid. If the business still needs a document, ask them for a new link.");
    startMock.mockRejectedValueOnce(new Error("storage down, token vxu_secret"));
    expect(await startDocumentUploadAction("vxu_x", 99, "application/pdf")).toEqual({ ok: false, message: "That did not work. Try again in a moment." });
  });

  it("sends the document, tells the business after the vendor's page, and names nothing of a failure", async () => {
    submitMock.mockResolvedValueOnce({ ok: true, orgName: "Pinecrest Studio" });
    const result = await submitDocumentAction(INITIAL, form({ token: "vxu_x", poReference: "PO-4410", note: "Signed copy." }));
    expect(submitMock).toHaveBeenCalledWith("vxu_x", { poReference: "PO-4410", note: "Signed copy." }, "198.51.100.7", { defer: expect.any(Function) });
    expect(result).toEqual({ ok: true, message: "Thank you. Pinecrest Studio has been told, and has your document. Nothing else is needed from you." });
    const options = submitMock.mock.calls[0][3] as { defer: (work: () => Promise<unknown>) => void };
    const work = async () => undefined;
    options.defer(work);
    expect(afterMock).toHaveBeenCalledWith(work);

    submitMock.mockResolvedValueOnce({ ok: false, reason: "file_type" });
    expect(await submitDocumentAction(INITIAL, form({ token: "vxu_x" }))).toEqual({ ok: false, message: "Send a PDF, PNG or JPEG. This file is none of those.", field: "file" });
    submitMock.mockResolvedValueOnce({ ok: false, reason: "invalid", field: "note", message: "A note has at most 500 characters." });
    expect(await submitDocumentAction(INITIAL, form({ token: "vxu_x" }))).toEqual({ ok: false, message: "A note has at most 500 characters.", field: "note" });
    submitMock.mockResolvedValueOnce({ ok: false, reason: "busy" });
    expect(await submitDocumentAction(INITIAL, form({ token: "vxu_x" }))).toEqual({ ok: false, message: "Too many tries. Wait a minute, then try again." });
    submitMock.mockRejectedValueOnce(new Error("relation does not exist"));
    expect(await submitDocumentAction(INITIAL, form({ token: "vxu_x" }))).toEqual({ ok: false, message: "That did not work. Try again in a moment." });
  });
});
