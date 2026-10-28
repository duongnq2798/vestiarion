import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The owner's rule for earned vendors from Settings (docs/superpowers/specs/2026-10-28-earned-vendors-design.md AL11,
 * AL17): authorized as `approval.policy`, a number from the form or Turn off, the library's refusals in its own words,
 * any other failure said plainly with the page read again, since it may have left a rule in force without its entry,
 * and a toast that says the rule now in force. It frees nothing held, so no cycle starts. Step 3's switch (AL21) is
 * the same: an owner's, on or off from the form, the library's refusals in its own words.
 */

const { authorizeMock, changeMock, switchMock, raiseMock, revalidateMock } = vi.hoisted(() => ({
  authorizeMock: vi.fn(),
  changeMock: vi.fn(),
  switchMock: vi.fn(),
  raiseMock: vi.fn(),
  revalidateMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/revalidate", () => ({ revalidateOrgPages: revalidateMock }));
vi.mock("@/lib/agent/cycle-soon", () => ({ raiseCycleEvent: raiseMock }));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));
vi.mock("@/lib/dal/scope", () => ({ inOrg: (_access: unknown, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/earned-vendors-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/earned-vendors-store")>()),
  changeEarnedVendorRule: changeMock,
  changeEarnedVendorPayments: switchMock,
}));

import { setEarnedVendorPaymentsAction, setEarnedVendorRuleAction } from "@/app/actions/earned-vendors";
import { EarnedVendorsError } from "@/lib/earned-vendors-store";

const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1";
const INITIAL = { ok: false, message: "" };

function form(fields: Record<string, string>): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) formData.set(key, value);
  return formData;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  authorizeMock.mockResolvedValue({ ok: true, user: { id: USER, email: null }, membership: { orgId: "org-1", slug: "pinecrest", role: "owner" } });
});

describe("setEarnedVendorRuleAction (AL11)", () => {
  it("is an owner's: it asks for approval.policy before anything is changed", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "Your role in this workspace (approver) cannot do that." });
    expect(await setEarnedVendorRuleAction(INITIAL, form({ orgSlug: "pinecrest", intent: "save", streak: "8" }))).toEqual({
      ok: false,
      message: "Your role in this workspace (approver) cannot do that.",
    });
    expect(authorizeMock).toHaveBeenCalledWith("pinecrest", "approval.policy");
    expect(changeMock).not.toHaveBeenCalled();
  });

  it("sets the number from the form as the signed-in owner, and says the rule", async () => {
    changeMock.mockResolvedValueOnce({ from: null, to: 8 });
    expect(await setEarnedVendorRuleAction(INITIAL, form({ orgSlug: "pinecrest", intent: "save", streak: " 8 " }))).toEqual({
      ok: true,
      message: "Earned vendors: 8 agreed verdicts in a row.",
    });
    expect(changeMock).toHaveBeenCalledWith({ actorId: USER, streak: 8 });
    expect(revalidateMock).toHaveBeenCalled();
    // Nothing held is freed: no cycle starts.
    expect(raiseMock).not.toHaveBeenCalled();
  });

  it("turns it off from Turn off, whatever the field holds", async () => {
    changeMock.mockResolvedValueOnce({ from: 8, to: null });
    expect(await setEarnedVendorRuleAction(INITIAL, form({ orgSlug: "pinecrest", intent: "off", streak: "12" }))).toEqual({ ok: true, message: "Earned vendors are off." });
    expect(changeMock).toHaveBeenCalledWith({ actorId: USER, streak: null });
  });

  it("refuses what is not a number from 5 to 50 in the library's words, and says any other failure plainly", async () => {
    changeMock.mockRejectedValueOnce(new EarnedVendorsError("invalid"));
    expect(await setEarnedVendorRuleAction(INITIAL, form({ orgSlug: "pinecrest", intent: "save", streak: "" }))).toEqual({ ok: false, message: "Choose a number from 5 to 50." });
    // An empty or unreadable field reaches the library as a number it refuses, never as Turn off.
    expect(changeMock).toHaveBeenCalledWith({ actorId: USER, streak: Number.NaN });

    changeMock.mockRejectedValueOnce(new EarnedVendorsError("not_signed"));
    expect((await setEarnedVendorRuleAction(INITIAL, form({ orgSlug: "pinecrest", intent: "save", streak: "8" }))).message).toBe(
      "The change could not be signed in the ledger, so nothing changed. Try again in a moment."
    );
    // A refusal changed nothing: the page stays as it is.
    expect(revalidateMock).not.toHaveBeenCalled();

    // Any other failure may have left the rule changed without its entry (AL17): the page is read again, so Settings
    // shows the rule in force, and asking for it again signs it.
    changeMock.mockRejectedValueOnce(new Error("earned vendors: rule changed without its entry, and not put back: database unavailable"));
    expect(await setEarnedVendorRuleAction(INITIAL, form({ orgSlug: "pinecrest", intent: "save", streak: "8" }))).toEqual({
      ok: false,
      message: "That did not work. Try again in a moment.",
    });
    expect(revalidateMock).toHaveBeenCalledTimes(1);
  });
});

describe("setEarnedVendorPaymentsAction (AL21)", () => {
  it("is an owner's: it asks for approval.policy before anything is changed", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "Your role in this workspace (approver) cannot do that." });
    expect((await setEarnedVendorPaymentsAction(INITIAL, form({ orgSlug: "pinecrest", on: "true" }))).ok).toBe(false);
    expect(authorizeMock).toHaveBeenCalledWith("pinecrest", "approval.policy");
    expect(switchMock).not.toHaveBeenCalled();
  });

  it("turns it on or off from the form as the signed-in owner, and says what it does now", async () => {
    switchMock.mockResolvedValueOnce({ from: false, to: true });
    expect(await setEarnedVendorPaymentsAction(INITIAL, form({ orgSlug: "pinecrest", on: "true" }))).toEqual({
      ok: true,
      message: "The agent pays earned vendors on its own now, and you give your verdict after.",
    });
    expect(switchMock).toHaveBeenCalledWith({ actorId: USER, on: true });
    switchMock.mockResolvedValueOnce({ from: true, to: false });
    expect(await setEarnedVendorPaymentsAction(INITIAL, form({ orgSlug: "pinecrest", on: "false" }))).toEqual({
      ok: true,
      message: "Earned vendors' payments wait for your verdict again.",
    });
    expect(switchMock).toHaveBeenLastCalledWith({ actorId: USER, on: false });
    expect(revalidateMock).toHaveBeenCalledTimes(2);
    expect(raiseMock).not.toHaveBeenCalled();
  });

  it("says the library's refusals in its words, and any other failure plainly, reading the page again", async () => {
    switchMock.mockRejectedValueOnce(new EarnedVendorsError("no_spending_limit"));
    expect(await setEarnedVendorPaymentsAction(INITIAL, form({ orgSlug: "pinecrest", on: "true" }))).toEqual({
      ok: false,
      message: "Set the agent's spending limit first, in Settings: the agent's own payments always count against it.",
    });
    expect(revalidateMock).not.toHaveBeenCalled();
    switchMock.mockRejectedValueOnce(new Error("earned vendors: switch changed without its entry, and not put back: database unavailable"));
    expect(await setEarnedVendorPaymentsAction(INITIAL, form({ orgSlug: "pinecrest", on: "true" }))).toEqual({ ok: false, message: "That did not work. Try again in a moment." });
    expect(revalidateMock).toHaveBeenCalledTimes(1);
  });
});
