import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountDeletionPlanAction, deleteAccountAction, type DeleteAccountActionResult } from "@/app/account/actions";
import { AccountDeletionError } from "@/lib/platform/delete-account";

/**
 * `src/app/account/actions.ts` (spec §6, A1, A3). Not an organization action:
 * the session is the gate, and the person acted on is always the session's
 * user, never one named by the form. The library is proven in
 * `tests/delete-account-lib.test.ts`; here it, the session, the Supabase
 * server client and `redirect` are stand-ins.
 */

const { SESSION_USER, FORM_USER } = vi.hoisted(() => ({
  SESSION_USER: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000a1",
  FORM_USER: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000ff",
}));

vi.mock("server-only", () => ({}));

const { redirectMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((path: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;push;${path};303;` });
  }),
}));
vi.mock("next/navigation", () => ({ redirect: redirectMock }));

const { getSessionUserMock } = vi.hoisted(() => ({ getSessionUserMock: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: getSessionUserMock }));

const { signOutMock } = vi.hoisted(() => ({ signOutMock: vi.fn() }));
vi.mock("@/lib/auth/supabase-server", () => ({
  createSupabaseServerClient: async () => ({ auth: { signOut: signOutMock } }),
}));

const { deleteAccountMock, planMock } = vi.hoisted(() => ({ deleteAccountMock: vi.fn(), planMock: vi.fn() }));
vi.mock("@/lib/platform/delete-account", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform/delete-account")>();
  return { ...actual, deleteAccount: deleteAccountMock, accountDeletionPlan: planMock };
});

const INITIAL: DeleteAccountActionResult = { ok: false, message: "" };

function form(fields: Record<string, string> = { confirmText: "delete my account" }): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const logged: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  logged.length = 0;
  signOutMock.mockResolvedValue({ error: null });
  for (const level of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((arg) => (typeof arg === "string" ? arg : inspect(arg, { depth: 6 }))).join(" "));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deleteAccountAction", () => {
  it("stops a signed-out request before the library", async () => {
    getSessionUserMock.mockResolvedValueOnce(null);
    const result = await deleteAccountAction(INITIAL, form());
    expect(result).toEqual({ ok: false, message: "Your session has ended. Sign in again." });
    expect(deleteAccountMock).not.toHaveBeenCalled();
    expect(signOutMock).not.toHaveBeenCalled();
  });

  it("deletes the session's user, signs out, then redirects to /", async () => {
    getSessionUserMock.mockResolvedValueOnce({ id: SESSION_USER, email: "me@example.com" });
    deleteAccountMock.mockResolvedValueOnce(undefined);

    await expect(deleteAccountAction(INITIAL, form())).rejects.toThrow("NEXT_REDIRECT");

    expect(deleteAccountMock).toHaveBeenCalledWith({ userId: SESSION_USER, confirmText: "delete my account" });
    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).toHaveBeenCalledWith("/");
    expect(signOutMock.mock.invocationCallOrder[0]).toBeLessThan(redirectMock.mock.invocationCallOrder[0]);
    expect(logged).toEqual([]);
  });

  it("never trusts a user id from the form", async () => {
    getSessionUserMock.mockResolvedValueOnce({ id: SESSION_USER, email: null });
    deleteAccountMock.mockResolvedValueOnce(undefined);

    await expect(
      deleteAccountAction(INITIAL, form({ confirmText: "delete my account", userId: FORM_USER, user_id: FORM_USER, id: FORM_USER }))
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(deleteAccountMock).toHaveBeenCalledTimes(1);
    expect(deleteAccountMock.mock.calls[0][0].userId).toBe(SESSION_USER);
    expect(JSON.stringify(deleteAccountMock.mock.calls)).not.toContain(FORM_USER);
  });

  it("still redirects when signing out fails: the account is already gone", async () => {
    getSessionUserMock.mockResolvedValueOnce({ id: SESSION_USER, email: null });
    deleteAccountMock.mockResolvedValueOnce(undefined);
    signOutMock.mockRejectedValueOnce(new Error("session_not_found"));

    await expect(deleteAccountAction(INITIAL, form())).rejects.toThrow("NEXT_REDIRECT");
    expect(redirectMock).toHaveBeenCalledWith("/");
  });

  it("passes a missing confirmation as an empty string, for the library to refuse", async () => {
    getSessionUserMock.mockResolvedValueOnce({ id: SESSION_USER, email: null });
    deleteAccountMock.mockRejectedValueOnce(new AccountDeletionError("confirm_mismatch"));

    const result = await deleteAccountAction(INITIAL, form({}));

    expect(deleteAccountMock).toHaveBeenCalledWith({ userId: SESSION_USER, confirmText: "" });
    expect(result).toEqual({ ok: false, message: "Type delete my account exactly to confirm." });
  });

  it.each([
    [new AccountDeletionError("blocked"), "Make someone else an owner of each workspace listed, or delete it, first."],
    [
      new AccountDeletionError("workspace_refused", "solo-co: A payment is being made; try again in a few minutes. Your account was not deleted."),
      "solo-co: A payment is being made; try again in a few minutes. Your account was not deleted.",
    ],
  ])("returns an AccountDeletionError's message, without signing out or redirecting", async (error, message) => {
    getSessionUserMock.mockResolvedValueOnce({ id: SESSION_USER, email: null });
    deleteAccountMock.mockRejectedValueOnce(error);

    const result = await deleteAccountAction(INITIAL, form());

    expect(result).toEqual({ ok: false, message });
    expect(signOutMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
    expect(logged).toEqual([]);
  });

  it("returns a generic message for anything else, logging the action's name only", async () => {
    getSessionUserMock.mockResolvedValueOnce({ id: SESSION_USER, email: "me@example.com" });
    deleteAccountMock.mockRejectedValueOnce(new Error(`Database error deleting user ${SESSION_USER} me@example.com`));

    const result = await deleteAccountAction(INITIAL, form());

    expect(result).toEqual({ ok: false, message: "Something went wrong; try again." });
    expect(logged).toEqual(["account: deleteAccountAction failed"]);
    expect(signOutMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });
});

describe("accountDeletionPlanAction", () => {
  const PLAN = { blocked: [], soleWorkspaces: [{ slug: "solo-co", name: "Solo", live: false, paused: false, walletCount: 0, hosted: false }] };

  it("returns the session user's plan", async () => {
    getSessionUserMock.mockResolvedValueOnce({ id: SESSION_USER, email: null });
    planMock.mockResolvedValueOnce(PLAN);

    expect(await accountDeletionPlanAction()).toEqual({ ok: true, plan: PLAN });
    expect(planMock).toHaveBeenCalledWith(SESSION_USER);
  });

  it("stops a signed-out request", async () => {
    getSessionUserMock.mockResolvedValueOnce(null);
    expect(await accountDeletionPlanAction()).toEqual({ ok: false, message: "Your session has ended. Sign in again." });
    expect(planMock).not.toHaveBeenCalled();
  });

  it("returns a generic message when the plan cannot be read, logging the action's name only", async () => {
    getSessionUserMock.mockResolvedValueOnce({ id: SESSION_USER, email: null });
    planMock.mockRejectedValueOnce(new Error("connection refused"));

    expect(await accountDeletionPlanAction()).toEqual({ ok: false, message: "Your workspaces could not be read; try again." });
    expect(logged).toEqual(["account: accountDeletionPlanAction failed"]);
  });
});
