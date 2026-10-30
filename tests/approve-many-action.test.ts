import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { approveManyAction, type ApproveManyActionResult } from "@/app/actions/approvals";
import { ApprovalError } from "@/lib/agent/approvals";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";

/**
 * `approveManyAction` (docs/superpowers/specs/2026-10-30-approve-many-design.md AM1, AM10, AM11) against a real `inOrg`,
 * the shape of tests/approvals-actions.test.ts: `server-only`, `authorize` and the approvals library's
 * `approveAndPayMany` are stand-ins, while the command between them is real.
 */

const { ORG, USER } = vi.hoisted(() => ({
  ORG: "0b6c1c9e-4a4f-4a7e-9b1e-000000000d1d",
  USER: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e6",
}));
const A = "1b6c1c9e-4a4f-4a7e-9b1e-0000000000a1";
const B = "1b6c1c9e-4a4f-4a7e-9b1e-0000000000b2";
const TX = `0x${"cd".repeat(32)}`;

vi.mock("server-only", () => ({}));

const { revalidatePathMock } = vi.hoisted(() => ({ revalidatePathMock: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

const { authorizeMock } = vi.hoisted(() => ({ authorizeMock: vi.fn() }));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));

const { noticesSoonMock } = vi.hoisted(() => ({ noticesSoonMock: vi.fn() }));
vi.mock("@/lib/payment-notices-soon", () => ({ sendNoticesSoon: noticesSoonMock }));

const { approveAndPayManyMock } = vi.hoisted(() => ({ approveAndPayManyMock: vi.fn() }));
vi.mock("@/lib/agent/approvals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/approvals")>()),
  approveAndPayMany: approveAndPayManyMock,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

const signedIn = () => ({ ok: true, user: { id: USER, email: null }, membership: { orgId: ORG, slug: "northstar", name: "Northstar", mode: "live" as const, role: "approver" as const } });

function run<T>(fn: () => Promise<T>): { requests: RecordedRequest[]; result: Promise<T> } {
  const fake = fakeSupabase((request) =>
    request.path === "/rest/v1/orgs"
      ? { body: { id: ORG, slug: "northstar", name: "Northstar", mode: "live", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null } }
      : { body: [] }
  );
  return { requests: fake.requests, result: runWith({ config, db: fake.client, fetch: fake.fetch }, fn) };
}

const INITIAL: ApproveManyActionResult = { ok: false, message: "" };

function form(items: unknown, extra: Record<string, string> = {}): FormData {
  const formData = new FormData();
  formData.set("orgSlug", "northstar");
  formData.set("items", typeof items === "string" ? items : JSON.stringify(items));
  for (const [key, value] of Object.entries(extra)) formData.set(key, value);
  return formData;
}

const paid = (n: number) => ({ status: "paid" as const, txRef: TX, note: "", paid: { amount: 10, currency: "USDC", payee: `Vendor ${n}` }, batch: { key: "batch-1", size: 2 } });

describe("approveManyAction", () => {
  it("returns the refusal when authorize refuses, asking for approval.decide, and decides nothing", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "You are not a member of this workspace." });
    const result = await approveManyAction(INITIAL, form([{ invoiceId: A }, { invoiceId: B }]));
    expect(result).toEqual({ ok: false, message: "You are not a member of this workspace." });
    expect(authorizeMock).toHaveBeenCalledWith("northstar", "approval.decide");
    expect(approveAndPayManyMock).not.toHaveBeenCalled();
  });

  it("refuses a selection it cannot read, deciding nothing", async () => {
    for (const items of [
      "",
      "not json",
      { invoiceId: A },
      [{ invoiceId: "not-a-uuid" }, { invoiceId: B }],
      [{ invoiceId: A, address: 42 }, { invoiceId: B }],
      [{ invoiceId: A, amount: 1 }, { invoiceId: B }],
    ]) {
      authorizeMock.mockResolvedValueOnce(signedIn());
      const result = await run(() => approveManyAction(INITIAL, form(items))).result;
      expect(result).toEqual({ ok: false, message: "Those bills are not waiting for a decision." });
    }
    expect(approveAndPayManyMock).not.toHaveBeenCalled();
  });

  it("decides the bills sent, each with the address its card showed, and lays out one line per bill and the transaction they shared", async () => {
    authorizeMock.mockResolvedValueOnce(signedIn());
    approveAndPayManyMock.mockResolvedValueOnce([
      { invoiceId: A, bill: { payee: "Vendor 1", amount: 10, currency: "USDC" }, overridesHold: true, outcome: paid(1) },
      { invoiceId: B, bill: { payee: "Vendor 2", amount: 10, currency: "USDC" }, overridesHold: false, outcome: paid(2) },
    ]);

    const { requests, result } = run(() => approveManyAction(INITIAL, form([{ invoiceId: A, address: "0xaaa" }, { invoiceId: B }], { reason: "  Checked by phone  " })));
    const answer = await result;

    expect(approveAndPayManyMock).toHaveBeenCalledWith({ actorId: USER, items: [{ invoiceId: A, shownAddress: "0xaaa" }, { invoiceId: B }] });
    expect(answer).toMatchObject({
      ok: true,
      message: "2 bills: 2 paid.",
      bills: [
        { invoiceId: A, payee: "Vendor 1", amount: 10, currency: "USDC", outcome: "paid", txRef: TX },
        { invoiceId: B, payee: "Vendor 2", amount: 10, currency: "USDC", outcome: "paid", txRef: TX },
      ],
      transaction: { txRef: TX, size: 2, message: "Paid 2 bills in one Arc transaction." },
    });
    // The pages refreshed once, and the payees told once, for the whole selection (AM10).
    expect(revalidatePathMock).toHaveBeenCalledTimes(1);
    expect(noticesSoonMock).toHaveBeenCalledTimes(1);
    // The reason, trimmed, kept for the bill that went against the hold (AM9).
    const kept = requests.filter((request) => request.path === "/rest/v1/decision_reasons" && request.method === "POST").map((request) => request.body as Record<string, unknown>);
    expect(kept.map((row) => [row.subject_id, row.reason])).toEqual([[A, "Checked by phone"]]);
  });

  it("is not ok when no bill was approved, and still lays each out", async () => {
    authorizeMock.mockResolvedValueOnce(signedIn());
    approveAndPayManyMock.mockResolvedValueOnce([A, B].map((invoiceId) => ({
      invoiceId, bill: null, overridesHold: false, error: new ApprovalError("invoice_not_found", "That invoice is not waiting for a decision."),
    })));
    const answer = await run(() => approveManyAction(INITIAL, form([{ invoiceId: A }, { invoiceId: B }]))).result;
    expect(answer).toMatchObject({ ok: false, message: "2 bills: 2 not paid.", bills: [{ outcome: "refused" }, { outcome: "refused" }] });
    expect(answer).not.toHaveProperty("transaction");
  });

  it("returns a selection refused whole in its own words, with no lines and nothing refreshed", async () => {
    authorizeMock.mockResolvedValueOnce(signedIn());
    approveAndPayManyMock.mockRejectedValueOnce(new ApprovalError("selection_size", "Select from 2 to 20 bills to approve together, each once."));
    const answer = await run(() => approveManyAction(INITIAL, form([{ invoiceId: A }]))).result;
    expect(answer).toEqual({ ok: false, message: "Select from 2 to 20 bills to approve together, each once." });
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});
