import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { MilestoneDecisionError } from "@/lib/agent/milestone-decisions";
import type { Actor } from "@/lib/commands/actor";
import { closeMilestoneUnpaid, payMilestoneNow } from "@/lib/commands/milestones";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

/**
 * A person's decisions on a held milestone, as commands (held milestone actions R2, R3; integrations design §9):
 * the gate first, then the milestone library as the console has always called it, then the payee's notice after a
 * confirmed payment. The library itself is tests/milestone-decisions.test.ts's; here it is a stand-in.
 */

const { mocks } = vi.hoisted(() => ({ mocks: { payHeldMilestone: vi.fn(), closeMilestone: vi.fn(), sendNoticesSoon: vi.fn() } }));
vi.mock("@/lib/agent/milestone-decisions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/milestone-decisions")>()),
  payHeldMilestone: mocks.payHeldMilestone,
  closeMilestone: mocks.closeMilestone,
}));
vi.mock("@/lib/payment-notices-soon", () => ({ sendNoticesSoon: mocks.sendNoticesSoon }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c21";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c5";
const MILESTONE = "1b6c1c9e-4a4f-4a7e-9b1e-0000000000f2";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const approver = (fields: Partial<Actor> = {}): Actor => ({
  orgId: ORG, userId: USER, role: "approver", mode: "live", surface: { kind: "console" }, ...fields,
});
const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fakeSupabase().client, orgId: ORG }), fn);

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe("payMilestoneNow", () => {
  it("pays as the actor and tells the payee", async () => {
    mocks.payHeldMilestone.mockResolvedValueOnce({ status: "paid", txRef: "0xabc", note: "" });
    expect(await run(() => payMilestoneNow(approver(), { milestoneId: MILESTONE }))).toEqual({ ok: true, message: "Paid.", status: "paid", txRef: "0xabc" });
    expect(mocks.payHeldMilestone).toHaveBeenCalledWith({ actorId: USER, milestoneId: MILESTONE });
    expect(mocks.sendNoticesSoon).toHaveBeenCalledTimes(1);
  });

  it("says what came back from the reserve to pay it (approval cash R7)", async () => {
    mocks.payHeldMilestone.mockResolvedValueOnce({ status: "paid", txRef: "0xabc", note: "", fromReserveUsdc: 0.1 });
    expect(await run(() => payMilestoneNow(approver(), { milestoneId: MILESTONE }))).toEqual({
      ok: true,
      message: "Paid. 0.1 USDC came back from the USYC reserve first.",
      status: "paid",
      txRef: "0xabc",
    });
  });

  it("says an approval was recorded and one more pays it, telling no payee (two approvals T8)", async () => {
    mocks.payHeldMilestone.mockResolvedValueOnce({ status: "approved", txRef: null, note: "" });
    expect(await run(() => payMilestoneNow(approver(), { milestoneId: MILESTONE }))).toEqual({
      ok: true, message: "Approved. One more approval, by another person, pays it.", status: "approved", txRef: null,
    });
    expect(mocks.sendNoticesSoon).not.toHaveBeenCalled();
  });

  it("says a submitted transfer waits for Circle", async () => {
    mocks.payHeldMilestone.mockResolvedValueOnce({ status: "verified", txRef: null, note: "" });
    expect(await run(() => payMilestoneNow(approver(), { milestoneId: MILESTONE }))).toMatchObject({
      ok: true, message: "Payment submitted; waiting for Circle to confirm it.",
    });
    expect(mocks.sendNoticesSoon).not.toHaveBeenCalled();
  });

  it("refuses, marked changed, when it was not paid, with the reason from the note", async () => {
    mocks.payHeldMilestone.mockResolvedValueOnce({ status: "held", txRef: null, note: " [transfer failed: ESTIMATION_ERROR]" });
    expect(await run(() => payMilestoneNow(approver(), { milestoneId: MILESTONE }))).toEqual({
      ok: false, code: "not_paid", message: "Not paid: ESTIMATION_ERROR. The milestone is still held.", changed: true,
    });
  });

  it("says only that it was not paid when the note gives no reason", async () => {
    mocks.payHeldMilestone.mockResolvedValueOnce({ status: "held", txRef: null, note: "" });
    expect(await run(() => payMilestoneNow(approver(), { milestoneId: MILESTONE }))).toMatchObject({
      ok: false, message: "Not paid. The milestone is still held.", changed: true,
    });
  });

  it("passes a MilestoneDecisionError's code and words, and logs anything else", async () => {
    mocks.payHeldMilestone.mockRejectedValueOnce(new MilestoneDecisionError("not_held"));
    expect(await run(() => payMilestoneNow(approver(), { milestoneId: MILESTONE }))).toMatchObject({ ok: false, code: "not_held" });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.payHeldMilestone.mockRejectedValueOnce(new Error("boom"));
    expect(await run(() => payMilestoneNow(approver(), { milestoneId: MILESTONE }))).toEqual({
      ok: false, code: "failed", message: "That did not work. Try again in a moment: nothing is sent twice.",
    });
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("refuses a viewer before calling anything", async () => {
    expect(await run(() => payMilestoneNow(approver({ role: "viewer" }), { milestoneId: MILESTONE }))).toMatchObject({ ok: false, code: "forbidden" });
    expect(mocks.payHeldMilestone).not.toHaveBeenCalled();
  });
});

describe("closeMilestoneUnpaid", () => {
  it("closes with the reason given", async () => {
    mocks.closeMilestone.mockResolvedValueOnce(undefined);
    expect(await run(() => closeMilestoneUnpaid(approver(), { milestoneId: MILESTONE, reason: "Paid in cash" }))).toEqual({
      ok: true, message: "Closed without paying.",
    });
    expect(mocks.closeMilestone).toHaveBeenCalledWith({ actorId: USER, milestoneId: MILESTONE, reason: "Paid in cash" });
  });

  it("refuses a surface that may not decide, before calling anything", async () => {
    const telegram = approver({ surface: { kind: "telegram", linkId: "l-1" } });
    expect(await run(() => closeMilestoneUnpaid(telegram, { milestoneId: MILESTONE, reason: "x" }))).toMatchObject({ ok: false, code: "surface" });
    expect(mocks.closeMilestone).not.toHaveBeenCalled();
  });
});
