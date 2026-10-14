import { beforeEach, describe, expect, it, vi } from "vitest";
import { appVersion } from "@/lib/app-version";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { Actor } from "@/lib/commands/actor";
import { approvePayable, rejectPayable, returnPayable } from "@/lib/commands/payables";
import { cleanReason, readDecisionReasons, reasonFromRow, recordDecisionReason } from "@/lib/decision-reasons";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";
import pkg from "../package.json";

/**
 * Why a person went against the agent, asked in the moment (docs/superpowers/specs/2026-10-14-capability-and-reasons-
 * design.md R9-R13): optional everywhere, kept with the feature and the surface it came from and the app's version, and
 * never in the way: before migration 0120, or when the write fails, the decision goes on as before.
 */

const { mocks } = vi.hoisted(() => ({
  mocks: { approveAndPay: vi.fn(), rejectInvoice: vi.fn(), returnInvoice: vi.fn(), runCycleSoon: vi.fn(), sendNoticesSoon: vi.fn(), checkChatDecision: vi.fn() },
}));
vi.mock("@/lib/agent/approvals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/approvals")>()),
  approveAndPay: mocks.approveAndPay,
  rejectInvoice: mocks.rejectInvoice,
  returnInvoice: mocks.returnInvoice,
}));
vi.mock("@/lib/agent/cycle-soon", () => ({ runCycleSoon: mocks.runCycleSoon }));
vi.mock("@/lib/payment-notices-soon", () => ({ sendNoticesSoon: mocks.sendNoticesSoon }));
vi.mock("@/lib/commands/chat-decisions", () => ({ checkChatDecision: mocks.checkChatDecision }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000d11";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000d4";
const INVOICE = "1b6c1c9e-4a4f-4a7e-9b1e-0000000000d1";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

let fake: ReturnType<typeof fakeSupabase>;
const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn);
const kept = () => fake.requests.filter((request) => request.path === "/rest/v1/decision_reasons" && request.method === "POST").map((request) => request.body as Record<string, unknown>);
const actor = (surface: Actor["surface"] = { kind: "console" }): Actor => ({ orgId: ORG, userId: USER, role: "approver", mode: "live", surface });
const NOT_SET_UP: FakeReply = { status: 404, body: { code: "PGRST205", message: "Could not find the table public.decision_reasons in the schema cache" } };

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.checkChatDecision.mockResolvedValue({ ok: true, address: null });
  fake = fakeSupabase();
});

describe("a reason as it is kept", () => {
  it("is one trimmed line of at most 280 characters, or nothing", () => {
    expect(cleanReason("  Waiting on\nthe corrected   invoice. ")).toBe("Waiting on the corrected invoice.");
    expect(cleanReason("   ")).toBeNull();
    expect(cleanReason(undefined)).toBeNull();
    expect(cleanReason("x".repeat(300))).toHaveLength(280);
  });

  it("carries the build that asked: the deployment's commit, or the package's version", () => {
    expect(appVersion({ VERCEL_GIT_COMMIT_SHA: "A1B2C3D4E5F60718293a4b5c6d7e8f9012345678" })).toBe("a1b2c3d4e5f6");
    expect(appVersion({})).toBe(`v${pkg.version}`);
    expect(appVersion({ VERCEL_GIT_COMMIT_SHA: "not a sha" })).toBe(`v${pkg.version}`);
  });

  it("is a row with where it came from, the surface, the subject, who gave it and the build", async () => {
    expect(await run(() => recordDecisionReason({ source: "approvals.return", surface: "slack", subject: "invoice", subjectId: INVOICE, reason: " PO missing ", givenBy: USER }))).toBe(true);
    expect(kept()).toEqual([
      { org_id: ORG, feature: "approvals", decision: "return", surface: "slack", subject: "invoice", subject_id: INVOICE, reason: "PO missing", app_version: appVersion(), given_by: USER },
    ]);
  });

  it("writes nothing when no reason was given", async () => {
    expect(await run(() => recordDecisionReason({ source: "approvals.reject", surface: "console", subject: "invoice", subjectId: INVOICE, reason: "", givenBy: USER }))).toBe(false);
    expect(fake.requests).toEqual([]);
  });

  it("never throws before migration 0120 runs, or when the write fails", async () => {
    fake = fakeSupabase(() => NOT_SET_UP);
    expect(await run(() => recordDecisionReason({ source: "approvals.reject", surface: "console", subject: "invoice", subjectId: INVOICE, reason: "Duplicate", givenBy: USER }))).toBe(false);
    fake = fakeSupabase(() => ({ status: 500, body: { message: "boom" } }));
    expect(await run(() => recordDecisionReason({ source: "approvals.reject", surface: "console", subject: "invoice", subjectId: INVOICE, reason: "Duplicate", givenBy: USER }))).toBe(false);
  });
});

describe("the workspace's latest reasons", () => {
  const ROW = { feature: "approvals", decision: "pay_held", surface: "telegram", subject: "invoice", subject_id: INVOICE, reason: "Known supplier.", app_version: "v0.1.0", given_at: "2026-10-14T09:00:00Z" };

  it("reads them newest first, in the words a page shows", async () => {
    fake = fakeSupabase((request: RecordedRequest) => (request.path === "/rest/v1/decision_reasons" ? { body: [ROW, { ...ROW, feature: "settings" }] } : { body: [] }));
    const read = await run(() => readDecisionReasons(5));
    expect(read.available).toBe(true);
    expect(read.reasons).toEqual([
      { source: "approvals.pay_held", what: "Paid a bill the agent held", surface: "Telegram", subject: "invoice", subjectId: INVOICE, reason: "Known supplier.", appVersion: "v0.1.0", givenAt: "2026-10-14T09:00:00Z" },
    ]);
    const asked = fake.requests.find((request) => request.path === "/rest/v1/decision_reasons");
    expect(asked?.params.get("order")).toBe("given_at.desc");
    expect(asked?.params.get("limit")).toBe("5");
    expect(asked?.params.get("org_id")).toBe(`eq.${ORG}`);
  });

  it("says they are not set up before migration 0120 runs", async () => {
    fake = fakeSupabase(() => NOT_SET_UP);
    expect(await run(() => readDecisionReasons())).toEqual({ available: false, reasons: [] });
  });

  it("names a row from a feature this build does not know as nothing", () => {
    expect(reasonFromRow({ ...ROW, decision: "dismiss" })).toBeNull();
  });
});

describe("the payable commands keep the reason given, with the surface it came from (R10, R11)", () => {
  it("keeps a return's reason, and passes it to the ledger entry", async () => {
    await run(() => returnPayable(actor(), { invoiceId: INVOICE, reason: "Waiting on the PO" }));
    expect(mocks.returnInvoice).toHaveBeenCalledWith(expect.objectContaining({ invoiceId: INVOICE, reason: "Waiting on the PO" }));
    expect(kept()).toEqual([expect.objectContaining({ feature: "approvals", decision: "return", surface: "console", reason: "Waiting on the PO", subject_id: INVOICE })]);
  });

  it("keeps reasons from the console only, the one surface that says Vestiarion's team reads them; the ledger still has it", async () => {
    await run(() => returnPayable(actor({ kind: "slack", linkId: "link-1", decisionsLimitUsdc: 1000 }), { invoiceId: INVOICE, reason: "Waiting on the PO" }));
    await run(() => rejectPayable(actor({ kind: "slack", linkId: "link-1", decisionsLimitUsdc: 1000 }), { invoiceId: INVOICE, reason: "Duplicate" }));
    expect(mocks.returnInvoice).toHaveBeenCalledWith(expect.objectContaining({ reason: "Waiting on the PO" }));
    expect(mocks.rejectInvoice).toHaveBeenCalledWith(expect.objectContaining({ reason: "Duplicate" }));
    expect(kept()).toEqual([]);
  });

  it("keeps a rejection's reason, and a payment of a held bill's", async () => {
    await run(() => rejectPayable(actor(), { invoiceId: INVOICE, reason: "Duplicate of INV-7" }));
    mocks.approveAndPay.mockResolvedValueOnce({ status: "paid", txRef: "0xabc", note: "" });
    await run(() => approvePayable(actor(), { invoiceId: INVOICE, reason: "Known supplier, new bank details checked by phone" }));
    expect(kept().map((row) => [row.decision, row.reason])).toEqual([
      ["reject", "Duplicate of INV-7"],
      ["pay_held", "Known supplier, new bank details checked by phone"],
    ]);
  });

  it("keeps nothing when no reason was given, for a verdict's own settling, or when the decision was refused", async () => {
    await run(() => returnPayable(actor(), { invoiceId: INVOICE }));
    await run(() => rejectPayable(actor(), { invoiceId: INVOICE, reason: "Said in the verdict", forVerdict: true }));
    mocks.approveAndPay.mockResolvedValueOnce({ status: "held", txRef: null, note: " [transfer failed: insufficient balance]" });
    await run(() => approvePayable(actor(), { invoiceId: INVOICE, reason: "Pay it" }));
    expect(kept()).toEqual([]);
  });

  it("never fails the decision over a reason it could not keep", async () => {
    fake = fakeSupabase(() => NOT_SET_UP);
    const outcome = await run(() => returnPayable(actor(), { invoiceId: INVOICE, reason: "Later" }));
    expect(outcome.ok).toBe(true);
  });
});
