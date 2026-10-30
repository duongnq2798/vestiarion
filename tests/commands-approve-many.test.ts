import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { ApprovalError, type SelectionDecision } from "@/lib/agent/approvals";
import type { Actor } from "@/lib/commands/actor";
import { approvePayables } from "@/lib/commands/payables";
import { COMMAND_PERMISSIONS, SURFACE_COMMANDS } from "@/lib/commands/policy";
import { txUrl } from "@/lib/payee-chains";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

/**
 * Several held payables approved with one confirmation, as one command (docs/superpowers/specs/2026-10-30-approve-many-design.md
 * AM9-AM13): the gate first, the approvals library's `approveAndPayMany` (tests/approve-many.test.ts's, a stand-in here),
 * then what follows once for the selection: the reason kept for each bill that went against the agent's hold and decided
 * a new payment, one notice to payees, and one line per bill in the words Approve and pay uses for one.
 */

const { mocks } = vi.hoisted(() => ({ mocks: { approveAndPayMany: vi.fn(), sendNoticesSoon: vi.fn() } }));
vi.mock("@/lib/agent/approvals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/approvals")>()),
  approveAndPayMany: mocks.approveAndPayMany,
}));
vi.mock("@/lib/payment-notices-soon", () => ({ sendNoticesSoon: mocks.sendNoticesSoon }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c12";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c5";
const ID = (n: number) => `1b6c1c9e-4a4f-4a7e-9b1e-00000000a00${n}`;
const TX = `0x${"ab".repeat(32)}`;
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

const approver = (fields: Partial<Actor> = {}): Actor => ({ orgId: ORG, userId: USER, role: "approver", mode: "live", surface: { kind: "console" }, ...fields });
let fake: ReturnType<typeof fakeSupabase>;
const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn);
const kept = () => fake.requests.filter((request) => request.path === "/rest/v1/decision_reasons" && request.method === "POST").map((request) => request.body as Record<string, unknown>);

const bill = (n: number, amount = 10 * n) => ({ payee: `Vendor ${n}`, amount, currency: "USDC" as const });
const paidIn = (batch: { key: string; size: number } | null, amount: number, n: number) => ({
  status: "paid" as const,
  txRef: TX,
  note: "",
  paid: { amount, currency: "USDC", payee: `Vendor ${n}` },
  ...(batch ? { batch } : {}),
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  fake = fakeSupabase();
});

describe("approvePayables: who may, and where (approve many AM1, AM13)", () => {
  it("is a decision for owners, admins and approvers, in the console only", () => {
    expect(COMMAND_PERMISSIONS["payable.approve_many"]).toBe("approval.decide");
    expect(SURFACE_COMMANDS.console).toContain("payable.approve_many");
    for (const surface of ["telegram", "slack", "api", "github", "chrome"] as const) expect(SURFACE_COMMANDS[surface]).not.toContain("payable.approve_many");
  });

  it("refuses a viewer, and Slack, which approves one bill at a time, before calling anything", async () => {
    const selection = { items: [{ invoiceId: ID(1) }, { invoiceId: ID(2) }] };
    expect(await run(() => approvePayables(approver({ role: "viewer" }), selection))).toMatchObject({ ok: false, code: "forbidden" });
    const slack = approver({ surface: { kind: "slack", linkId: "l-1", decisionsLimitUsdc: 1000 } });
    expect(await run(() => approvePayables(slack, selection))).toMatchObject({ ok: false, code: "surface" });
    expect(mocks.approveAndPayMany).not.toHaveBeenCalled();
  });
});

describe("approvePayables: what the person reads (approve many AM11)", () => {
  it("decides the selection as the actor, and says one line per bill and the transaction they shared", async () => {
    const batch = { key: "batch-1", size: 2 };
    mocks.approveAndPayMany.mockResolvedValueOnce([
      { invoiceId: ID(1), bill: bill(1), overridesHold: false, outcome: paidIn(batch, 9.8, 1) },
      { invoiceId: ID(2), bill: bill(2), overridesHold: false, outcome: paidIn(batch, 20, 2) },
      { invoiceId: ID(3), bill: bill(3), overridesHold: false, outcome: { status: "approved", txRef: null, note: "" } },
      { invoiceId: ID(4), bill: bill(4), overridesHold: false, outcome: { status: "held", txRef: "circle-tx-4", note: " [transfer failed: Circle reported FAILED]" } },
      { invoiceId: ID(5), bill: bill(5, 50), overridesHold: false, error: new ApprovalError("approve_alone", "Approve it on its own: it is in EURC.") },
      { invoiceId: ID(6), bill: null, overridesHold: false, error: new ApprovalError("invoice_not_found", "That invoice is not waiting for a decision.") },
    ] satisfies SelectionDecision[]);
    const items = [1, 2, 3, 4, 5, 6].map((n) => ({ invoiceId: ID(n), shownAddress: `0x${n}` }));

    const outcome = await run(() => approvePayables(approver(), { items }));

    expect(mocks.approveAndPayMany).toHaveBeenCalledWith({ actorId: USER, items });
    expect(outcome).toMatchObject({ ok: true, message: "6 bills: 2 paid, 1 approved, 3 not paid." });
    if (!outcome.ok) throw new Error("refused");
    expect(outcome.bills).toEqual([
      { invoiceId: ID(1), payee: "Vendor 1", amount: 9.8, currency: "USDC", outcome: "paid", message: "Paid 9.80 USDC to Vendor 1; Circle confirmed it on Arc testnet.", txRef: TX },
      { invoiceId: ID(2), payee: "Vendor 2", amount: 20, currency: "USDC", outcome: "paid", message: "Paid 20.00 USDC to Vendor 2; Circle confirmed it on Arc testnet.", txRef: TX },
      { invoiceId: ID(3), payee: "Vendor 3", amount: 30, currency: "USDC", outcome: "approved", message: "Approved. One more approval, by another person, pays it.", txRef: null },
      {
        invoiceId: ID(4), payee: "Vendor 4", amount: 40, currency: "USDC", outcome: "held",
        message: "The transfer failed: Circle reported FAILED. The invoice is held.", txRef: "circle-tx-4",
      },
      { invoiceId: ID(5), payee: "Vendor 5", amount: 50, currency: "USDC", outcome: "refused", message: "Approve it on its own: it is in EURC.", txRef: null },
      { invoiceId: ID(6), payee: null, amount: null, currency: null, outcome: "refused", message: "That invoice is not waiting for a decision.", txRef: null },
    ]);
    expect(outcome.transaction).toEqual({ txRef: TX, size: 2, txUrl: txUrl("arc-testnet", TX), message: "Paid 2 bills in one Arc transaction." });
    // Payees hear of confirmed payments once, for the whole selection (AM10).
    expect(mocks.sendNoticesSoon).toHaveBeenCalledTimes(1);
    expect(mocks.sendNoticesSoon).toHaveBeenCalledWith({ user: { id: USER }, membership: { orgId: ORG, mode: "live" } });
  });

  it("says a shared transaction is submitted until Circle confirms it, and never sent while Circle has not answered", async () => {
    const batch = { key: "batch-1", size: 2 };
    const submitted = (txRef: string | null, n: number) => ({ status: "matched" as const, txRef, note: "", paid: { amount: 10, currency: "USDC", payee: `Vendor ${n}` }, batch });
    mocks.approveAndPayMany.mockResolvedValueOnce([1, 2].map((n) => ({ invoiceId: ID(n), bill: bill(n), overridesHold: false, outcome: submitted("circle-batch-1", n) })));
    const waiting = await run(() => approvePayables(approver(), { items: [{ invoiceId: ID(1) }, { invoiceId: ID(2) }] }));
    expect(waiting).toMatchObject({
      message: "2 bills: 2 submitted.",
      transaction: { size: 2, txUrl: null, message: "Submitted 2 bills in one Arc transaction; waiting for Circle to confirm it." },
    });

    mocks.approveAndPayMany.mockResolvedValueOnce([1, 2].map((n) => ({ invoiceId: ID(n), bill: bill(n), overridesHold: false, outcome: submitted(null, n) })));
    const unanswered = await run(() => approvePayables(approver(), { items: [{ invoiceId: ID(1) }, { invoiceId: ID(2) }] }));
    expect(unanswered).toMatchObject({
      transaction: { txRef: null, message: "Submitted 2 bills in one Arc transaction; Circle has not answered yet, so the outcome is unknown and nothing goes out again until it does." },
    });
    expect(mocks.sendNoticesSoon).not.toHaveBeenCalled();
  });

  it("names no shared transaction when the bills went alone, or the one they shared failed", async () => {
    mocks.approveAndPayMany.mockResolvedValueOnce([1, 2].map((n) => ({ invoiceId: ID(n), bill: bill(n), overridesHold: false, outcome: paidIn(null, 10, n) })));
    expect(await run(() => approvePayables(approver(), { items: [{ invoiceId: ID(1) }, { invoiceId: ID(2) }] }))).toMatchObject({ transaction: null });

    const failed = { status: "held" as const, txRef: "circle-batch-1", note: " [transfer failed: Circle reported FAILED]", batch: { key: "batch-1", size: 2 } };
    mocks.approveAndPayMany.mockResolvedValueOnce([1, 2].map((n) => ({ invoiceId: ID(n), bill: bill(n), overridesHold: false, outcome: failed })));
    expect(await run(() => approvePayables(approver(), { items: [{ invoiceId: ID(1) }, { invoiceId: ID(2) }] }))).toMatchObject({
      message: "2 bills: 2 not paid.",
      transaction: null,
    });
  });

  it("says a sandbox's shared transaction was simulated, with no link", async () => {
    const batch = { key: "batch-1", size: 2 };
    mocks.approveAndPayMany.mockResolvedValueOnce(
      [1, 2].map((n) => ({ invoiceId: ID(n), bill: bill(n), overridesHold: false, outcome: { ...paidIn(batch, 10, n), txRef: TX, paid: { amount: 10, currency: "USDC", payee: `Vendor ${n}`, simulated: true as const } } }))
    );
    expect(await run(() => approvePayables(approver({ mode: "sandbox" }), { items: [{ invoiceId: ID(1) }, { invoiceId: ID(2) }] }))).toMatchObject({
      transaction: { txUrl: null, message: "Paid 2 bills in one transaction in the sandbox (simulated)." },
    });
  });

  it("passes a selection refused whole in its own words, and logs anything else", async () => {
    mocks.approveAndPayMany.mockRejectedValueOnce(new ApprovalError("insufficient_funds", "These 2 bills come to 210 USDC; the operating wallet holds 200 USDC."));
    expect(await run(() => approvePayables(approver(), { items: [{ invoiceId: ID(1) }, { invoiceId: ID(2) }] }))).toEqual({
      ok: false,
      code: "insufficient_funds",
      message: "These 2 bills come to 210 USDC; the operating wallet holds 200 USDC.",
    });

    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.approveAndPayMany.mockRejectedValueOnce(new Error("connection refused"));
    expect(await run(() => approvePayables(approver(), { items: [{ invoiceId: ID(1) }, { invoiceId: ID(2) }] }))).toEqual({
      ok: false,
      code: "failed",
      message: "That did not work. Try again in a moment.",
    });
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("says a bill given back after its send threw in general words, logging the error", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.approveAndPayMany.mockResolvedValueOnce([1, 2].map((n) => ({ invoiceId: ID(n), bill: bill(n), overridesHold: false, error: new Error("connection reset") })));
    const outcome = await run(() => approvePayables(approver(), { items: [{ invoiceId: ID(1) }, { invoiceId: ID(2) }] }));
    expect(outcome).toMatchObject({ ok: true, message: "2 bills: 2 not paid." });
    if (!outcome.ok) throw new Error("refused");
    expect(outcome.bills.map((line) => [line.outcome, line.message])).toEqual([
      ["refused", "That did not work. Try again in a moment."],
      ["refused", "That did not work. Try again in a moment."],
    ]);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});

describe("approvePayables: the reason (approve many AM9)", () => {
  it("keeps the one reason for each bill whose approval went against the hold and decided a new payment", async () => {
    mocks.approveAndPayMany.mockResolvedValueOnce([
      // Against the hold, paid: kept.
      { invoiceId: ID(1), bill: bill(1), overridesHold: true, outcome: paidIn(null, 10, 1) },
      // Against the hold, the first of two approvals: kept, as Approve and pay keeps it.
      { invoiceId: ID(2), bill: bill(2), overridesHold: true, outcome: { status: "approved", txRef: null, note: "" } },
      // Held for cash, which the agent would have paid: not asked about, not kept.
      { invoiceId: ID(3), bill: bill(3), overridesHold: false, outcome: paidIn(null, 30, 3) },
      // Against the hold, but its transfer failed, or it only checked an earlier transfer, or it was refused: not kept.
      { invoiceId: ID(4), bill: bill(4), overridesHold: true, outcome: { status: "held", txRef: null, note: " [transfer failed: x]" } },
      { invoiceId: ID(5), bill: bill(5), overridesHold: true, outcome: { ...paidIn(null, 50, 5), checkedFirst: true as const } },
      { invoiceId: ID(6), bill: bill(6), overridesHold: true, error: new ApprovalError("high_risk", "This counterparty is screened high risk. Clear it in Compliance first.") },
    ] satisfies SelectionDecision[]);

    await run(() => approvePayables(approver(), { items: [1, 2, 3, 4, 5, 6].map((n) => ({ invoiceId: ID(n) })), reason: "Known suppliers, checked by phone" }));

    expect(kept().map((row) => [row.subject_id, row.feature, row.decision, row.reason, row.surface, row.given_by])).toEqual([
      [ID(1), "approvals", "pay_held", "Known suppliers, checked by phone", "console", USER],
      [ID(2), "approvals", "pay_held", "Known suppliers, checked by phone", "console", USER],
    ]);
  });

  it("keeps nothing when no reason was given", async () => {
    mocks.approveAndPayMany.mockResolvedValueOnce([1, 2].map((n) => ({ invoiceId: ID(n), bill: bill(n), overridesHold: true, outcome: paidIn(null, 10, n) })));
    await run(() => approvePayables(approver(), { items: [{ invoiceId: ID(1) }, { invoiceId: ID(2) }] }));
    expect(kept()).toEqual([]);
  });
});
