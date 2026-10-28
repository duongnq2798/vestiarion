import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The owner's rule for earned vendors from Settings (docs/superpowers/specs/2026-10-28-earned-vendors-design.md AL11,
 * AL17): authorized as `approval.policy`, a number from the form or Turn off, the library's refusals in its own words,
 * and a toast that says the rule now in force. It frees nothing held, so no cycle starts.
 */

const { authorizeMock, changeMock, raiseMock, revalidateMock } = vi.hoisted(() => ({
  authorizeMock: vi.fn(),
  changeMock: vi.fn(),
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
}));

import { setEarnedVendorRuleAction } from "@/app/actions/earned-vendors";
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

    changeMock.mockRejectedValueOnce(new Error("connection reset"));
    expect(await setEarnedVendorRuleAction(INITIAL, form({ orgSlug: "pinecrest", intent: "save", streak: "8" }))).toEqual({
      ok: false,
      message: "That did not work. Try again in a moment.",
    });
    expect(revalidateMock).not.toHaveBeenCalled();
  });
});
