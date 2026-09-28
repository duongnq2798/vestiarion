import { beforeEach, describe, expect, it, vi } from "vitest";
import { acceptInvitationAction, type AcceptInvitationResult } from "@/app/invite/actions";
import { MemberError } from "@/lib/platform/members";

/**
 * `acceptInvitationAction` against stand-ins for the session, `redirect` and
 * the platform module's `acceptInvitation` — the same shape as
 * `tests/members-actions.test.ts`: the real `MemberError` class is kept
 * through `importOriginal`, so `instanceof` checks in the action still work.
 */

vi.mock("server-only", () => ({}));

const { getSessionUserMock } = vi.hoisted(() => ({ getSessionUserMock: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: getSessionUserMock }));

const { acceptInvitationMock } = vi.hoisted(() => ({ acceptInvitationMock: vi.fn() }));
vi.mock("@/lib/platform/members", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform/members")>();
  return { ...actual, acceptInvitation: acceptInvitationMock };
});

// `redirect` throws to navigate; the mock reproduces that so the action's
// control flow after a success can be observed the same way it runs for real.
const { redirectMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock("next/navigation", () => ({ redirect: redirectMock }));

beforeEach(() => {
  vi.clearAllMocks();
});

const USER = { id: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1", email: "person@example.com" };
const VALID_TOKEN = "a".repeat(32);

const INITIAL: AcceptInvitationResult = { ok: false, message: "" };

function form(token?: string): FormData {
  const data = new FormData();
  if (token !== undefined) data.set("token", token);
  return data;
}

describe("acceptInvitationAction", () => {
  it("refuses a signed-out visitor, and never calls acceptInvitation", async () => {
    getSessionUserMock.mockResolvedValueOnce(null);

    const result = await acceptInvitationAction(INITIAL, form(VALID_TOKEN));

    expect(result).toEqual({ ok: false, message: "Your session has ended. Sign in again." });
    expect(acceptInvitationMock).not.toHaveBeenCalled();
  });

  it("refuses a malformed token, without calling acceptInvitation", async () => {
    getSessionUserMock.mockResolvedValueOnce(USER);

    const result = await acceptInvitationAction(INITIAL, form("too-short"));

    expect(result).toEqual({ ok: false, message: "This invitation link is not valid." });
    expect(acceptInvitationMock).not.toHaveBeenCalled();
  });

  it("refuses a missing token, without calling acceptInvitation", async () => {
    getSessionUserMock.mockResolvedValueOnce(USER);

    const result = await acceptInvitationAction(INITIAL, form());

    expect(result).toEqual({ ok: false, message: "This invitation link is not valid." });
    expect(acceptInvitationMock).not.toHaveBeenCalled();
  });

  it("maps a MemberError to its message", async () => {
    getSessionUserMock.mockResolvedValueOnce(USER);
    acceptInvitationMock.mockRejectedValueOnce(new MemberError("invitation_email_mismatch"));

    const result = await acceptInvitationAction(INITIAL, form(VALID_TOKEN));

    expect(result).toEqual({
      ok: false,
      message: "This invitation was sent to a different email address. Sign in with that address to accept it.",
    });
  });

  it("redirects to the organization's console on success", async () => {
    getSessionUserMock.mockResolvedValueOnce(USER);
    acceptInvitationMock.mockResolvedValueOnce({ orgId: "org-1", slug: "acme", role: "viewer" });

    await expect(acceptInvitationAction(INITIAL, form(VALID_TOKEN))).rejects.toThrow("REDIRECT:/o/acme/console");
    expect(acceptInvitationMock).toHaveBeenCalledWith({ token: VALID_TOKEN, userId: USER.id });
  });
});
