import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { AllocationError } from "@/lib/allocations/model";
import type { Actor } from "@/lib/commands/actor";
import { applyReceivedPayment, reverseAppliedPayment } from "@/lib/commands/allocations";
import { COMMAND_PERMISSIONS, SURFACE_COMMANDS } from "@/lib/commands/policy";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

/**
 * Applying money received and reversing it, as commands (docs/superpowers/specs/2026-10-12-allocations-design.md L10):
 * owners and admins (`records.write`), from the console only; the gate runs before anything is read, and a refusal
 * reads in its own words.
 */

const { mocks } = vi.hoisted(() => ({ mocks: { applyPayment: vi.fn(), reverseAllocation: vi.fn() } }));
vi.mock("@/lib/allocations/apply", async (original) => ({
  ...(await original<typeof import("@/lib/allocations/apply")>()),
  applyPayment: mocks.applyPayment,
  reverseAllocation: mocks.reverseAllocation,
}));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a81";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000a8";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fakeSupabase().client, orgId: ORG }), fn);
const actor = (fields: Partial<Actor> = {}): Actor => ({ orgId: ORG, userId: USER, role: "owner", mode: "live", surface: { kind: "console" }, ...fields });

const APPLY = { paymentId: "p-1", version: 0, lines: [{ invoiceId: "inv-1", amount: "300" }], fees: [] };
const row = (over: Record<string, unknown>) => ({ id: "r", kind: "payment", invoiceId: "inv-1", amount: 300_000_000, currency: "USDC", label: "Invoice INV-1", customer: "Acme Corp", outstandingAfter: 0, ...over });

beforeEach(() => {
  mocks.applyPayment.mockReset();
  mocks.reverseAllocation.mockReset();
});

describe("who may apply money received", () => {
  it("is the permission that adds invoices, from the console only", () => {
    expect(COMMAND_PERMISSIONS["receivable.apply_payment"]).toBe("records.write");
    expect(COMMAND_PERMISSIONS["receivable.reverse_allocation"]).toBe("records.write");
    for (const surface of ["api", "slack", "telegram", "github"] as const) {
      expect(SURFACE_COMMANDS[surface]).not.toContain("receivable.apply_payment");
      expect(SURFACE_COMMANDS[surface]).not.toContain("receivable.reverse_allocation");
    }
  });

  it.each(["owner", "admin"] as const)("lets an %s apply a payment, and says what it did", async (role) => {
    mocks.applyPayment.mockResolvedValueOnce({
      rows: [row({ invoiceId: "a" }), row({ invoiceId: "b" }), row({ invoiceId: "c", outstandingAfter: 50_000_000 })],
      unappliedAfter: 25_000_000,
      currency: "USDC",
      customer: "Acme Corp",
    });
    const outcome = await run(() => applyReceivedPayment(actor({ role }), APPLY));
    expect(outcome).toEqual({
      ok: true,
      message: "Applied to 3 invoices. 2 are now paid. 25.00 USDC of the payment is left as credit for Acme Corp.",
      applied: 3,
      settled: 2,
      unappliedAfter: 25_000_000,
    });
    expect(mocks.applyPayment).toHaveBeenCalledWith({ ...APPLY, actorId: USER });
  });

  it("says a fee was recorded beside the payment", async () => {
    mocks.applyPayment.mockResolvedValueOnce({ rows: [row({}), row({ id: "f", kind: "fee", amount: 300_000 })], unappliedAfter: 0, currency: "USDC", customer: "Acme Corp" });
    const outcome = await run(() => applyReceivedPayment(actor(), APPLY));
    expect(outcome).toMatchObject({ ok: true, message: "Applied to 1 invoice, and recorded 1 fee. 1 is now paid." });
  });

  it.each(["approver", "viewer"] as const)("refuses an %s before anything is read", async (role) => {
    expect(await run(() => applyReceivedPayment(actor({ role }), APPLY))).toMatchObject({ ok: false, code: "forbidden" });
    expect(await run(() => reverseAppliedPayment(actor({ role }), { allocationId: "r", reason: "x" }))).toMatchObject({ ok: false, code: "forbidden" });
    expect(mocks.applyPayment).not.toHaveBeenCalled();
    expect(mocks.reverseAllocation).not.toHaveBeenCalled();
  });

  it("refuses from another surface", async () => {
    const api = actor({ surface: { kind: "api", apiKeyId: "k-1" } });
    expect(await run(() => applyReceivedPayment(api, APPLY))).toMatchObject({ ok: false, code: "surface" });
  });

  it("says a refusal in its own words, and asks the page to show the payment again when it moved", async () => {
    mocks.applyPayment.mockRejectedValueOnce(new AllocationError("stale"));
    expect(await run(() => applyReceivedPayment(actor(), APPLY))).toEqual({
      ok: false,
      code: "stale",
      message: "Someone applied this payment a moment ago. Reload the page to see what is left of it.",
      changed: true,
    });
    mocks.applyPayment.mockRejectedValueOnce(new AllocationError("not_ready"));
    expect(await run(() => applyReceivedPayment(actor(), APPLY))).toMatchObject({ ok: false, code: "not_ready", message: "Applying payments is not set up on this deployment yet." });
    mocks.applyPayment.mockRejectedValueOnce(new Error("connection reset"));
    expect(await run(() => applyReceivedPayment(actor(), APPLY))).toMatchObject({ ok: false, code: "failed" });
  });
});

describe("reversing", () => {
  it("says what is owed after, and that the fees beside the payment went with it", async () => {
    mocks.reverseAllocation.mockResolvedValueOnce({ rows: [row({ kind: "reversal" }), row({ kind: "reversal" })], invoiceId: "inv-1", outstandingAfter: 100_000_000, currency: "USDC", label: "Invoice INV-1" });
    expect(await run(() => reverseAppliedPayment(actor({ role: "admin" }), { allocationId: "r", reason: "Wrong invoice" }))).toEqual({
      ok: true,
      message: "Reversed, with the fee recorded beside it. 100.00 USDC is owed on Invoice INV-1.",
      reversed: 2,
      outstandingAfter: 100_000_000,
    });
    expect(mocks.reverseAllocation).toHaveBeenCalledWith({ allocationId: "r", reason: "Wrong invoice", actorId: USER });
  });
});
