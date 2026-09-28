import { describe, expect, it, vi } from "vitest";

/**
 * `authorize`'s own refusal messages, each stubbing only what it reads
 * directly (`getSessionUser`, `membershipFor`) so the real `can` from
 * `roles.ts` still decides the permission check.
 */

vi.mock("server-only", () => ({}));

const { getSessionUser } = vi.hoisted(() => ({ getSessionUser: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSessionUser }));

const { membershipFor } = vi.hoisted(() => ({ membershipFor: vi.fn() }));
vi.mock("@/lib/auth/membership", () => ({ membershipFor }));

const { touchOrgActivity } = vi.hoisted(() => ({ touchOrgActivity: vi.fn() }));
vi.mock("@/lib/platform/activity", () => ({ touchOrgActivity }));

const { authorize } = await import("@/lib/auth/authorize");

const USER = { id: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1", email: null };

describe("authorize", () => {
  it("refuses a slug that is missing or not a string", async () => {
    expect(await authorize(undefined, "workspace.read")).toEqual({ ok: false, message: "Missing workspace." });
    expect(await authorize(42, "workspace.read")).toEqual({ ok: false, message: "Missing workspace." });
  });

  it("refuses a signed-out caller", async () => {
    getSessionUser.mockResolvedValueOnce(null);
    expect(await authorize("northstar", "workspace.read")).toEqual({
      ok: false,
      message: "Your session has ended. Sign in again.",
    });
  });

  it("refuses a signed-in caller who is not a member of the workspace", async () => {
    getSessionUser.mockResolvedValueOnce(USER);
    membershipFor.mockResolvedValueOnce(null);
    expect(await authorize("northstar", "workspace.read")).toEqual({
      ok: false,
      message: "You are not a member of this workspace.",
    });
  });

  it("refuses a member whose role lacks the permission", async () => {
    getSessionUser.mockResolvedValueOnce(USER);
    membershipFor.mockResolvedValueOnce({ orgId: "org-1", slug: "northstar", name: "Northstar", mode: "sandbox", role: "viewer" });
    expect(await authorize("northstar", "org.administer")).toEqual({
      ok: false,
      message: "Your role in this workspace (viewer) cannot do that.",
    });
  });

  it("never touches activity when authorization is refused", async () => {
    getSessionUser.mockResolvedValueOnce(USER);
    membershipFor.mockResolvedValueOnce(null);
    await authorize("northstar", "workspace.read");
    expect(touchOrgActivity).not.toHaveBeenCalled();
  });

  it("authorizes a member whose role holds the permission, and touches the workspace's activity", async () => {
    getSessionUser.mockResolvedValueOnce(USER);
    const membership = { orgId: "org-1", slug: "northstar", name: "Northstar", mode: "sandbox" as const, role: "owner" as const };
    membershipFor.mockResolvedValueOnce(membership);
    expect(await authorize("northstar", "org.administer")).toEqual({ ok: true, user: USER, membership });
    expect(touchOrgActivity).toHaveBeenCalledWith("org-1");
  });
});
