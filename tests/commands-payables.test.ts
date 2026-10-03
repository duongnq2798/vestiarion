import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { ApprovalError } from "@/lib/agent/approvals";
import type { Actor } from "@/lib/commands/actor";
import { addPayableDetails, approvePayable, rejectPayable, returnPayable } from "@/lib/commands/payables";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

/**
 * A person's decisions on a held payable, as one command each (integrations design §9, Phase 0): the gate first, the
 * approvals library as the console has always called it, then what follows — the payee's notice after a confirmed
 * payment, the agent's next look after a return or added details — so every surface gets the same. The approvals
 * library itself is tests/approvals.test.ts's; here it is a stand-in.
 */

const { mocks } = vi.hoisted(() => ({
  mocks: {
    approveAndPay: vi.fn(),
    rejectInvoice: vi.fn(),
    returnInvoice: vi.fn(),
    addInvoiceDetails: vi.fn(),
    runCycleSoon: vi.fn(),
    sendNoticesSoon: vi.fn(),
  },
}));
vi.mock("@/lib/agent/approvals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/approvals")>()),
  approveAndPay: mocks.approveAndPay,
  rejectInvoice: mocks.rejectInvoice,
  returnInvoice: mocks.returnInvoice,
  addInvoiceDetails: mocks.addInvoiceDetails,
}));
vi.mock("@/lib/agent/cycle-soon", () => ({ runCycleSoon: mocks.runCycleSoon }));
vi.mock("@/lib/payment-notices-soon", () => ({ sendNoticesSoon: mocks.sendNoticesSoon }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c11";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c4";
const INVOICE = "1b6c1c9e-4a4f-4a7e-9b1e-0000000000f1";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

const approver = (fields: Partial<Actor> = {}): Actor => ({
  orgId: ORG, userId: USER, role: "approver", mode: "live", surface: { kind: "console" }, ...fields,
});
const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fakeSupabase().client, orgId: ORG }), fn);

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe("approvePayable", () => {
  it("pays as the actor, with nothing about the surface from the console, and tells the payee", async () => {
    mocks.approveAndPay.mockResolvedValueOnce({ status: "paid", txRef: "0xabc", note: "" });

    const outcome = await run(() => approvePayable(approver(), { invoiceId: INVOICE, shownAddress: "0xdead" }));

    expect(mocks.approveAndPay).toHaveBeenCalledWith({ actorId: USER, invoiceId: INVOICE, shownAddress: "0xdead" });
    expect(Object.keys(mocks.approveAndPay.mock.calls[0][0])).not.toContain("provenance");
    expect(outcome).toEqual({ ok: true, message: "Paid.", status: "paid", txRef: "0xabc" });
    expect(mocks.sendNoticesSoon).toHaveBeenCalledWith({ user: { id: USER }, membership: { orgId: ORG, mode: "live" } });
  });

  it("says a submitted payment is waiting, and leaves the notice to the cycle that confirms it", async () => {
    mocks.approveAndPay.mockResolvedValueOnce({ status: "matched", txRef: "0xabc", note: "" });
    const outcome = await run(() => approvePayable(approver(), { invoiceId: INVOICE }));
    expect(outcome).toMatchObject({ ok: true, message: "Payment submitted; waiting for confirmation." });
    expect(mocks.sendNoticesSoon).not.toHaveBeenCalled();
  });

  it("refuses a held transfer, marked changed, in the provider's words", async () => {
    mocks.approveAndPay.mockResolvedValueOnce({ status: "held", txRef: null, note: " [transfer failed: insufficient allowance]" });
    const outcome = await run(() => approvePayable(approver(), { invoiceId: INVOICE }));
    expect(outcome).toEqual({
      ok: false, code: "transfer_failed", message: "The transfer failed: insufficient allowance. The invoice is held.", changed: true,
    });
    expect(mocks.sendNoticesSoon).not.toHaveBeenCalled();
  });

  it("passes an ApprovalError's code and words", async () => {
    mocks.approveAndPay.mockRejectedValueOnce(new ApprovalError("self_approval", "You created this invoice, so someone else must approve it."));
    const outcome = await run(() => approvePayable(approver(), { invoiceId: INVOICE }));
    expect(outcome).toEqual({ ok: false, code: "self_approval", message: "You created this invoice, so someone else must approve it." });
  });

  it("logs and answers in general words for anything else", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.approveAndPay.mockRejectedValueOnce(new Error("connection refused"));
    const outcome = await run(() => approvePayable(approver(), { invoiceId: INVOICE }));
    expect(outcome).toEqual({ ok: false, code: "failed", message: "That did not work. Try again in a moment." });
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("refuses a viewer, and a surface that may not decide, before calling anything", async () => {
    expect(await run(() => approvePayable(approver({ role: "viewer" }), { invoiceId: INVOICE }))).toMatchObject({ ok: false, code: "forbidden" });
    const telegram = approver({ surface: { kind: "telegram", linkId: "l-1" } });
    expect(await run(() => approvePayable(telegram, { invoiceId: INVOICE }))).toMatchObject({ ok: false, code: "surface" });
    expect(mocks.approveAndPay).not.toHaveBeenCalled();
  });
});

describe("rejectPayable, returnPayable, addPayableDetails", () => {
  it("rejects with the reason given", async () => {
    mocks.rejectInvoice.mockResolvedValueOnce(undefined);
    expect(await run(() => rejectPayable(approver(), { invoiceId: INVOICE, reason: "duplicate bill" }))).toEqual({ ok: true, message: "Rejected." });
    expect(mocks.rejectInvoice).toHaveBeenCalledWith({ actorId: USER, invoiceId: INVOICE, reason: "duplicate bill" });
  });

  it("returns the payable, and has the agent look again", async () => {
    mocks.returnInvoice.mockResolvedValueOnce(undefined);
    const outcome = await run(() => returnPayable(approver({ mode: "sandbox" }), { invoiceId: INVOICE }));
    expect(outcome).toEqual({ ok: true, message: "Returned to the agent. It usually decides it again within a minute." });
    expect(mocks.runCycleSoon).toHaveBeenCalledWith({ orgId: ORG, userId: USER, sandbox: true, kind: "payable_returned" });
  });

  it("raises nothing when the return is refused", async () => {
    mocks.returnInvoice.mockRejectedValueOnce(
      new ApprovalError("payment_in_flight", "A payment for this invoice was already sent. Approve and pay records it.")
    );
    expect(await run(() => returnPayable(approver(), { invoiceId: INVOICE }))).toMatchObject({ ok: false, code: "payment_in_flight" });
    expect(mocks.runCycleSoon).not.toHaveBeenCalled();
  });

  it("adds details as an owner or admin, and has the agent decide again", async () => {
    mocks.addInvoiceDetails.mockResolvedValueOnce({ poReference: "PO-100" });
    const outcome = await run(() => addPayableDetails(approver({ role: "admin" }), { invoiceId: INVOICE, poReference: "PO-100", goodsReceived: false }));
    expect(outcome).toEqual({ ok: true, message: "Details added. The agent usually decides it again within a minute." });
    expect(mocks.addInvoiceDetails).toHaveBeenCalledWith({ actorId: USER, invoiceId: INVOICE, poReference: "PO-100", goodsReceived: false });
    expect(mocks.runCycleSoon).toHaveBeenCalledWith({ orgId: ORG, userId: USER, sandbox: false, kind: "details_added" });
  });

  it("does not let an approver add details: approvers decide, they do not enter", async () => {
    const outcome = await run(() => addPayableDetails(approver(), { invoiceId: INVOICE, poReference: "PO-1", goodsReceived: true }));
    expect(outcome).toMatchObject({ ok: false, code: "forbidden" });
    expect(mocks.addInvoiceDetails).not.toHaveBeenCalled();
  });
});
