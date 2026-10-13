import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Don't show again" and "Keep these limits" (docs/superpowers/specs/2026-10-13-role-onboarding-evidence-access-design.md
 * R1, R4): each checks the session's membership first, then records one mark for that person in that workspace's scope,
 * and only for the checklist the person's own role sees.
 */

vi.mock("server-only", () => ({}));

const { authorizeMock, recordMock, inOrgMock, revalidateMock, revalidatePathMock } = vi.hoisted(() => ({
  authorizeMock: vi.fn(),
  recordMock: vi.fn(async () => true),
  inOrgMock: vi.fn(async (_access: unknown, fn: () => Promise<unknown>) => fn()),
  revalidateMock: vi.fn(),
  revalidatePathMock: vi.fn(),
}));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));
vi.mock("@/lib/onboarding/read", () => ({ recordOnboardingMarks: recordMock }));
vi.mock("@/lib/dal/scope", () => ({ inOrg: inOrgMock }));
vi.mock("@/lib/auth/revalidate", () => ({ revalidateOrgPages: revalidateMock }));
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

import { confirmLimitsAction, dismissChecklistAction } from "@/app/actions/onboarding";

const USER = { id: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000a1", email: "lena@ledgerline.example" };
const member = (role: string) => ({ ok: true, user: USER, membership: { orgId: "org-1", slug: "acme", name: "Acme", mode: "live", role, network: "arc-testnet" } });

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("dismissChecklistAction", () => {
  it.each([
    ["owner", "owner", "dismissed_owner"],
    ["admin", "owner", "dismissed_owner"],
    ["approver", "approver", "dismissed_approver"],
    ["accountant", "accountant", "dismissed_accountant"],
  ])("a %s dismisses the %s checklist for good, as themselves, in the workspace's scope", async (role, checklist, mark) => {
    authorizeMock.mockResolvedValueOnce(member(role));
    await dismissChecklistAction(form({ orgSlug: "acme", role: checklist }));
    expect(authorizeMock).toHaveBeenCalledWith("acme", "workspace.read");
    expect(inOrgMock).toHaveBeenCalledTimes(1);
    expect(recordMock).toHaveBeenCalledWith(USER.id, [mark]);
    expect(revalidateMock).toHaveBeenCalled();
  });

  it("records nothing for another role's checklist, a viewer's, or one that is not a checklist", async () => {
    for (const [role, checklist] of [
      ["approver", "owner"],
      ["owner", "accountant"],
      ["viewer", "owner"],
      ["owner", "anything"],
    ]) {
      authorizeMock.mockResolvedValueOnce(member(role));
      await dismissChecklistAction(form({ orgSlug: "acme", role: checklist }));
    }
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("records nothing for someone the session does not make a member", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "You are not a member of this workspace." });
    await dismissChecklistAction(form({ orgSlug: "acme", role: "owner" }));
    expect(inOrgMock).not.toHaveBeenCalled();
    expect(recordMock).not.toHaveBeenCalled();
  });
});

describe("confirmLimitsAction", () => {
  it("records the limits kept, for whoever may change them", async () => {
    authorizeMock.mockResolvedValueOnce(member("admin"));
    await confirmLimitsAction(form({ orgSlug: "acme" }));
    expect(authorizeMock).toHaveBeenCalledWith("acme", "agent.budget");
    expect(recordMock).toHaveBeenCalledWith(USER.id, ["limits_confirmed"]);
  });

  it("records nothing when the role may not change the limits", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "Your role in this workspace (approver) cannot do that." });
    await confirmLimitsAction(form({ orgSlug: "acme" }));
    expect(recordMock).not.toHaveBeenCalled();
  });
});
