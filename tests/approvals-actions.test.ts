import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import {
  addInvoiceDetailsAction,
  approveInvoiceAction,
  rejectInvoiceAction,
  returnInvoiceAction,
  type ApprovalActionResult,
} from "@/app/actions/approvals";
import { ApprovalError } from "@/lib/agent/approvals";
import { fakeSupabase } from "./support/fake-supabase";

/**
 * `src/app/actions/approvals.ts` against a real `inOrg`, the same shape as
 * `tests/members-actions.test.ts`: `server-only`, `authorize` and
 * `@/lib/agent/approvals`'s deciding functions are stand-ins — that library
 * was already proven against PostgREST elsewhere — while `inOrg` and the org
 * lookup it makes are real, against a fake network that only answers the
 * organization row.
 */

const { ORG, USER } = vi.hoisted(() => ({
  ORG: "0b6c1c9e-4a4f-4a7e-9b1e-000000000d0d",
  USER: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e5",
}));

const VALID_ID = "1b6c1c9e-4a4f-4a7e-9b1e-0000000000f1";

vi.mock("server-only", () => ({}));

const { revalidatePathMock } = vi.hoisted(() => ({ revalidatePathMock: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

const { authorizeMock } = vi.hoisted(() => ({ authorizeMock: vi.fn() }));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));

const { approveAndPayMock, rejectInvoiceMock, returnInvoiceMock, addInvoiceDetailsMock } = vi.hoisted(() => ({
  approveAndPayMock: vi.fn(),
  rejectInvoiceMock: vi.fn(),
  returnInvoiceMock: vi.fn(),
  addInvoiceDetailsMock: vi.fn(),
}));
vi.mock("@/lib/agent/approvals", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent/approvals")>();
  return {
    ...actual,
    approveAndPay: approveAndPayMock,
    rejectInvoice: rejectInvoiceMock,
    returnInvoice: returnInvoiceMock,
    addInvoiceDetails: addInvoiceDetailsMock,
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

function membership(role: "owner" | "admin" | "approver" | "viewer") {
  return { orgId: ORG, slug: "northstar", name: "Northstar", mode: "live" as const, role };
}

function orgRow() {
  return { id: ORG, slug: "northstar", name: "Northstar", mode: "live", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null };
}

function run<T>(fn: () => Promise<T>): Promise<T> {
  const fake = fakeSupabase((request) => (request.path === "/rest/v1/orgs" ? { body: orgRow() } : { body: [] }));
  return runWith({ config, db: fake.client, fetch: fake.fetch }, fn);
}

const INITIAL: ApprovalActionResult = { ok: false, message: "" };

function form(invoiceId: string, extra: Record<string, string> = {}): FormData {
  const formData = new FormData();
  formData.set("orgSlug", "northstar");
  formData.set("invoiceId", invoiceId);
  for (const [key, value] of Object.entries(extra)) formData.set(key, value);
  return formData;
}

describe("approveInvoiceAction", () => {
  it("returns the refusal when authorize refuses, and never calls approveAndPay", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "You are not a member of this workspace." });

    const result = await approveInvoiceAction(INITIAL, form(VALID_ID));

    expect(result).toEqual({ ok: false, message: "You are not a member of this workspace." });
    expect(approveAndPayMock).not.toHaveBeenCalled();
  });

  it("rejects an invoiceId that is not a uuid, without calling approveAndPay", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("owner") });

    const result = await run(() => approveInvoiceAction(INITIAL, form("not-a-uuid")));

    expect(result).toEqual({ ok: false, message: "That invoice is not waiting for a decision." });
    expect(approveAndPayMock).not.toHaveBeenCalled();
  });

  it("returns 'Paid.' when approveAndPay resolves paid, and revalidates", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("approver") });
    approveAndPayMock.mockResolvedValueOnce({ status: "paid", txRef: "0xabc", note: "" });

    const result = await run(() => approveInvoiceAction(INITIAL, form(VALID_ID, { address: "0xdead" })));

    // The address the card showed goes with the approval, so a changed one is refused rather than confirmed unseen.
    expect(approveAndPayMock).toHaveBeenCalledWith({ actorId: USER, invoiceId: VALID_ID, shownAddress: "0xdead" });
    expect(result).toEqual({ ok: true, message: "Paid." });
    expect(revalidatePathMock).toHaveBeenCalled();
  });

  it("returns the waiting-for-confirmation message when approveAndPay resolves matched", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("approver") });
    approveAndPayMock.mockResolvedValueOnce({ status: "matched", txRef: "0xabc", note: "" });

    const result = await run(() => approveInvoiceAction(INITIAL, form(VALID_ID)));

    expect(result).toEqual({ ok: true, message: "Payment submitted; waiting for confirmation." });
  });

  it("reports a failed transfer as a failure, from a ' [transfer failed: …]' note", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("approver") });
    approveAndPayMock.mockResolvedValueOnce({ status: "held", txRef: null, note: " [transfer failed: insufficient allowance]" });

    const result = await run(() => approveInvoiceAction(INITIAL, form(VALID_ID)));

    // The invoice changed (it is held with the provider's reason), so the pages refresh — but a person must
    // read a failed payment as a failure, not as a success toast.
    expect(result).toEqual({ ok: false, message: "The transfer failed: insufficient allowance. The invoice is held." });
    expect(revalidatePathMock).toHaveBeenCalled();
  });

  it("builds the failed-transfer message from a ' [execution failed: …]' note", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("approver") });
    approveAndPayMock.mockResolvedValueOnce({ status: "held", txRef: null, note: " [execution failed: provider unavailable]" });

    const result = await run(() => approveInvoiceAction(INITIAL, form(VALID_ID)));

    expect(result).toEqual({ ok: false, message: "The transfer failed: provider unavailable. The invoice is held." });
  });

  it("falls back to the trimmed note when it does not parse", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("approver") });
    approveAndPayMock.mockResolvedValueOnce({ status: "held", txRef: null, note: "  something odd happened  " });

    const result = await run(() => approveInvoiceAction(INITIAL, form(VALID_ID)));

    expect(result).toEqual({ ok: false, message: "The transfer failed: something odd happened. The invoice is held." });
  });

  it("returns an ApprovalError's message", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("approver") });
    approveAndPayMock.mockRejectedValueOnce(new ApprovalError("self_approval", "You created this invoice, so someone else must approve it."));

    const result = await run(() => approveInvoiceAction(INITIAL, form(VALID_ID)));

    expect(result).toEqual({ ok: false, message: "You created this invoice, so someone else must approve it." });
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("logs and returns the generic message for anything else", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("approver") });
    approveAndPayMock.mockRejectedValueOnce(new Error("connection refused"));

    const result = await run(() => approveInvoiceAction(INITIAL, form(VALID_ID)));

    expect(result).toEqual({ ok: false, message: "That did not work. Try again in a moment." });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("rejectInvoiceAction", () => {
  it("passes the reason through to rejectInvoice, and returns 'Rejected.'", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("approver") });
    rejectInvoiceMock.mockResolvedValueOnce(undefined);

    const result = await run(() => rejectInvoiceAction(INITIAL, form(VALID_ID, { reason: "duplicate bill" })));

    expect(rejectInvoiceMock).toHaveBeenCalledWith({ actorId: USER, invoiceId: VALID_ID, reason: "duplicate bill" });
    expect(result).toEqual({ ok: true, message: "Rejected." });
    expect(revalidatePathMock).toHaveBeenCalled();
  });

  it("rejects an invoiceId that is not a uuid, without calling rejectInvoice", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("owner") });

    const result = await run(() => rejectInvoiceAction(INITIAL, form("nope")));

    expect(result).toEqual({ ok: false, message: "That invoice is not waiting for a decision." });
    expect(rejectInvoiceMock).not.toHaveBeenCalled();
  });

  it("returns the refusal when authorize refuses, and never calls rejectInvoice", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "You are not a member of this workspace." });

    const result = await rejectInvoiceAction(INITIAL, form(VALID_ID));

    expect(result).toEqual({ ok: false, message: "You are not a member of this workspace." });
    expect(rejectInvoiceMock).not.toHaveBeenCalled();
  });
});

describe("returnInvoiceAction", () => {
  it("calls returnInvoice and returns the agent-decides-again message", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("approver") });
    returnInvoiceMock.mockResolvedValueOnce(undefined);

    const result = await run(() => returnInvoiceAction(INITIAL, form(VALID_ID)));

    expect(returnInvoiceMock).toHaveBeenCalledWith({ actorId: USER, invoiceId: VALID_ID });
    expect(result).toEqual({ ok: true, message: "Returned to the agent. It usually decides it again within a minute." });
    expect(revalidatePathMock).toHaveBeenCalled();
  });

  it("returns an ApprovalError's message without revalidating", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("approver") });
    returnInvoiceMock.mockRejectedValueOnce(new ApprovalError("already_decided", "Someone else decided this invoice a moment ago."));

    const result = await run(() => returnInvoiceAction(INITIAL, form(VALID_ID)));

    expect(result).toEqual({ ok: false, message: "Someone else decided this invoice a moment ago." });
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});

describe("addInvoiceDetailsAction", () => {
  it("lets owners and admins add details, reads the form as the invoice form does, and says the agent decides it again", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("admin") });
    addInvoiceDetailsMock.mockResolvedValueOnce({ poReference: "PO-100", goodsReceived: true });

    const result = await run(() => addInvoiceDetailsAction(INITIAL, form(VALID_ID, { poReference: "  PO-100 ", goodsReceived: "on" })));

    // Entering facts is a records write (complete held invoice R1): approvers decide, they do not enter.
    expect(authorizeMock).toHaveBeenCalledWith("northstar", "records.write");
    expect(addInvoiceDetailsMock).toHaveBeenCalledWith({ actorId: USER, invoiceId: VALID_ID, poReference: "PO-100", goodsReceived: true });
    expect(result).toEqual({ ok: true, message: "Details added. The agent usually decides it again within a minute." });
    expect(revalidatePathMock).toHaveBeenCalled();
  });

  it("reads a blank purchase order as none, and an unticked box as not received", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("owner") });
    addInvoiceDetailsMock.mockRejectedValueOnce(new ApprovalError("nothing_to_add", "Enter a PO reference or tick Goods or services received."));

    const result = await run(() => addInvoiceDetailsAction(INITIAL, form(VALID_ID, { poReference: "   " })));

    expect(addInvoiceDetailsMock).toHaveBeenCalledWith({ actorId: USER, invoiceId: VALID_ID, poReference: null, goodsReceived: false });
    expect(result).toEqual({ ok: false, message: "Enter a PO reference or tick Goods or services received." });
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("refuses a purchase order longer than the invoice form takes, without calling addInvoiceDetails", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("owner") });

    const result = await run(() => addInvoiceDetailsAction(INITIAL, form(VALID_ID, { poReference: "P".repeat(101) })));

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/^PO reference: /);
    expect(addInvoiceDetailsMock).not.toHaveBeenCalled();
  });

  it("rejects an invoiceId that is not a uuid, without calling addInvoiceDetails", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("owner") });

    const result = await run(() => addInvoiceDetailsAction(INITIAL, form("nope", { goodsReceived: "on" })));

    expect(result).toEqual({ ok: false, message: "That invoice is not waiting for a decision." });
    expect(addInvoiceDetailsMock).not.toHaveBeenCalled();
  });

  it("returns the refusal when authorize refuses, and never calls addInvoiceDetails", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "You do not have permission to do that." });

    const result = await addInvoiceDetailsAction(INITIAL, form(VALID_ID, { goodsReceived: "on" }));

    expect(result).toEqual({ ok: false, message: "You do not have permission to do that." });
    expect(addInvoiceDetailsMock).not.toHaveBeenCalled();
  });
});
