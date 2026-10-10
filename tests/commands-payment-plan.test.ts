import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { Actor } from "@/lib/commands/actor";
import { approvePlanLines } from "@/lib/commands/payment-plan";
import { COMMAND_PERMISSIONS, SURFACE_COMMANDS } from "@/lib/commands/policy";
import { planPayments, type PaymentPlan, type PaymentPlanInput, type PlanBill } from "@/lib/payment-plan";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

/**
 * Approving payment plan lines (docs/superpowers/specs/2026-10-11-payment-plan-design.md P9–P13): the gate, then the
 * plan read again and compared with the one shown, then each line's own checks, the maker-checker rule among them, and
 * only then the move. The read, the move and the sole-approver answer are stand-ins; the planner is the real one.
 */

const { mocks } = vi.hoisted(() => ({
  mocks: {
    readPaymentPlan: vi.fn(),
    moveScheduledPayment: vi.fn(),
    hasRunningCycle: vi.fn(),
    isSoleApprover: vi.fn(),
    runCycleSoon: vi.fn(),
  },
}));
vi.mock("@/lib/payment-plan-read", () => ({ readPaymentPlan: mocks.readPaymentPlan }));
vi.mock("@/lib/payment-plan-apply", () => ({ moveScheduledPayment: mocks.moveScheduledPayment }));
vi.mock("@/lib/agent/cycle-running", () => ({ hasRunningCycle: mocks.hasRunningCycle }));
vi.mock("@/lib/agent/sole-approver", () => ({ isSoleApprover: mocks.isSoleApprover }));
vi.mock("@/lib/agent/cycle-soon", () => ({ runCycleSoon: mocks.runCycleSoon }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c31";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c6";
const OTHER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c7";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const NOW = Date.UTC(2026, 9, 11, 9, 0);

const approver = (fields: Partial<Actor> = {}): Actor => ({ orgId: ORG, userId: USER, role: "approver", mode: "live", surface: { kind: "console" }, ...fields });
const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fakeSupabase().client, orgId: ORG }), fn);

const bill = (fields: Partial<PlanBill>): PlanBill => ({
  id: "b-1",
  counterpartyId: "c-1",
  payee: "Northwind Supply",
  payeeAddress: "0xabc",
  amount: 100,
  currency: "USDC",
  dueDate: "2026-10-22T12:00:00.000Z",
  status: "scheduled",
  scheduledFor: "2026-10-22T00:00:00.000Z",
  discount: { pct: 2, deadline: "2026-10-15T12:00:00.000Z" },
  paymentLimit: null,
  riskLevel: "clear",
  createdBy: OTHER,
  ...fields,
});

const planOf = (fields: Partial<PaymentPlanInput> = {}): PaymentPlan =>
  planPayments({
    now: NOW,
    operatingUsdc: 1000,
    reserveUsdc: 0,
    cushion: 0,
    bills: [
      bill({ id: "deal", payee: "Northwind Supply" }),
      bill({ id: "mine", payee: "Harbor Office Supply", counterpartyId: "c-2", createdBy: USER }),
      bill({ id: "today", payee: "Atlas Compute", counterpartyId: "c-3", discount: { pct: 1, deadline: "2026-10-11T12:00:00.000Z" } }),
      bill({ id: "capped", payee: "Big Vendor", counterpartyId: "c-4", paymentLimit: 50 }),
    ],
    milestones: [],
    limits: { budget: null, twoApprovalsAbove: null },
    balance: { kind: "simulated" },
    unread: [],
    ...fields,
  });

const request = (plan: PaymentPlan, ids: string[]) => ({
  planFingerprint: plan.fingerprint,
  lines: ids.map((id) => ({ invoiceId: id, fingerprint: plan.lines.find((line) => line.id === id)!.fingerprint })),
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.hasRunningCycle.mockResolvedValue(false);
  mocks.isSoleApprover.mockResolvedValue(false);
  mocks.moveScheduledPayment.mockResolvedValue(true);
});

describe("the command", () => {
  it("needs approval.decide, and runs from the console only", () => {
    expect(COMMAND_PERMISSIONS["payment_plan.approve"]).toBe("approval.decide");
    for (const surface of ["telegram", "slack", "api", "github"] as const) expect(SURFACE_COMMANDS[surface]).not.toContain("payment_plan.approve");
  });

  it("refuses a viewer before reading anything", async () => {
    const outcome = await run(() => approvePlanLines(approver({ role: "viewer" }), { planFingerprint: "x", lines: [{ invoiceId: "deal", fingerprint: "y" }] }));
    expect(outcome).toMatchObject({ ok: false, code: "forbidden" });
    expect(mocks.readPaymentPlan).not.toHaveBeenCalled();
  });
});

describe("approvePlanLines", () => {
  it("moves a line whose checks pass, and says the agent checks it again on its day", async () => {
    const plan = planOf();
    mocks.readPaymentPlan.mockResolvedValueOnce(plan);
    const outcome = await run(() => approvePlanLines(approver(), request(plan, ["deal"])));
    expect(outcome).toEqual({
      ok: true,
      message: "Moved: Northwind Supply pays on Oct 15, 2026. The agent checks it again on that day before it pays.",
      results: [{ invoiceId: "deal", payee: "Northwind Supply", ok: true, message: "Moves to Oct 15, 2026." }],
    });
    expect(mocks.moveScheduledPayment).toHaveBeenCalledWith({ actorId: USER, line: plan.lines.find((line) => line.id === "deal"), planFingerprint: plan.fingerprint, soleApprover: false });
    expect(mocks.runCycleSoon).not.toHaveBeenCalled();
  });

  it("refuses everything while a cycle is running", async () => {
    mocks.hasRunningCycle.mockResolvedValueOnce(true);
    const outcome = await run(() => approvePlanLines(approver(), { planFingerprint: "x", lines: [{ invoiceId: "deal", fingerprint: "y" }] }));
    expect(outcome).toEqual({ ok: false, code: "cycle_running", message: "A cycle is running. Try again in a minute, once it has finished." });
    expect(mocks.moveScheduledPayment).not.toHaveBeenCalled();
  });

  it("refuses a plan whose balance is stale, with the reason, and moves nothing (I20)", async () => {
    const stale = planOf({ balance: { kind: "chain", syncedAt: new Date(NOW - 30 * 60_000).toISOString() } });
    mocks.readPaymentPlan.mockResolvedValueOnce(stale);
    const outcome = await run(() => approvePlanLines(approver(), request(stale, ["deal"])));
    expect(outcome).toEqual({ ok: false, code: "stale", message: "The balance was read from the chain 30 minutes ago. Refresh it to approve the plan." });
    expect(mocks.moveScheduledPayment).not.toHaveBeenCalled();
  });

  it("refuses a plan that changed since it was shown: the balance, an amount, a payee", async () => {
    const shown = planOf();
    for (const changed of [planOf({ operatingUsdc: 999 }), planOf({ bills: [bill({ id: "deal", amount: 101 })] }), planOf({ bills: [bill({ id: "deal", payeeAddress: "0xnew" })] })]) {
      mocks.readPaymentPlan.mockResolvedValueOnce(changed);
      const outcome = await run(() => approvePlanLines(approver(), request(shown, ["deal"])));
      expect(outcome).toEqual({ ok: false, code: "plan_changed", message: "The plan changed since it was shown. Look at the new plan, then approve again." });
    }
    expect(mocks.moveScheduledPayment).not.toHaveBeenCalled();
  });

  it("never lets a person approve the day of a bill they created, unless they are the only approver (I21)", async () => {
    const plan = planOf();
    mocks.readPaymentPlan.mockResolvedValueOnce(plan);
    const refusedOutcome = await run(() => approvePlanLines(approver(), request(plan, ["mine"])));
    expect(refusedOutcome).toEqual({
      ok: false,
      code: "not_moved",
      message: "Nothing was moved. Harbor Office Supply: You created this bill, so someone else must approve its day.",
    });
    expect(mocks.moveScheduledPayment).not.toHaveBeenCalled();

    mocks.readPaymentPlan.mockResolvedValueOnce(plan);
    mocks.isSoleApprover.mockResolvedValueOnce(true);
    const sole = await run(() => approvePlanLines(approver(), request(plan, ["mine"])));
    expect(sole.ok).toBe(true);
    expect(mocks.moveScheduledPayment).toHaveBeenCalledWith(expect.objectContaining({ soleApprover: true }));
  });

  it("applies a batch line by line: only the lines whose own checks pass move, and the rest say why (I21)", async () => {
    const plan = planOf();
    mocks.readPaymentPlan.mockResolvedValueOnce(plan);
    const outcome = await run(() => approvePlanLines(approver(), request(plan, ["deal", "mine", "capped", "today"])));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.results).toEqual([
      { invoiceId: "deal", payee: "Northwind Supply", ok: true, message: "Moves to Oct 15, 2026." },
      { invoiceId: "mine", payee: "Harbor Office Supply", ok: false, message: "You created this bill, so someone else must approve its day." },
      { invoiceId: "capped", payee: "Big Vendor", ok: false, message: "Above Big Vendor's payment limit of 50.00 USDC: a person approves it." },
      { invoiceId: "today", payee: "Atlas Compute", ok: true, message: "Moves to today." },
    ]);
    expect(outcome.message).toBe(
      "Moved 2 payments. The agent checks each again on its day before it pays. Not moved: Harbor Office Supply (You created this bill, so someone else must approve its day.); Big Vendor (Above Big Vendor's payment limit of 50.00 USDC: a person approves it.)."
    );
    expect(mocks.moveScheduledPayment).toHaveBeenCalledTimes(2);
    // A move to today is decided at a cycle raised now, not the next scheduled one.
    expect(mocks.runCycleSoon).toHaveBeenCalledWith({ orgId: ORG, userId: USER, sandbox: false, kind: "plan_approved" });
  });

  it("refuses a line whose own fingerprint is not the one shown, or that has nothing to move", async () => {
    const plan = planOf();
    mocks.readPaymentPlan.mockResolvedValueOnce(plan);
    const outcome = await run(() =>
      approvePlanLines(approver(), {
        planFingerprint: plan.fingerprint,
        lines: [
          { invoiceId: "deal", fingerprint: "not-the-one" },
          { invoiceId: "gone", fingerprint: "x" },
        ],
      })
    );
    expect(outcome).toEqual({
      ok: false,
      code: "not_moved",
      message: "Nothing was moved. Northwind Supply: This bill changed since the plan was shown. Look at the new plan. A bill: It is no longer in the plan.",
    });
  });

  it("says when a bill changed between the read and the move", async () => {
    const plan = planOf();
    mocks.readPaymentPlan.mockResolvedValueOnce(plan);
    mocks.moveScheduledPayment.mockResolvedValueOnce(false);
    const outcome = await run(() => approvePlanLines(approver(), request(plan, ["deal"])));
    expect(outcome).toMatchObject({ ok: false, code: "not_moved", message: "Nothing was moved. Northwind Supply: This bill changed a moment ago. Look at the new plan.", changed: true });
  });

  it("refuses an empty request", async () => {
    const outcome = await run(() => approvePlanLines(approver(), { planFingerprint: "x", lines: [] }));
    expect(outcome).toEqual({ ok: false, code: "nothing", message: "There is no line to approve." });
  });
});
