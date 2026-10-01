import { beforeEach, describe, expect, it, vi } from "vitest";
import { dismissScreeningMatchAction } from "@/app/actions/compliance";
import { DismissalError } from "@/lib/screening-dismissal";

/**
 * The Not this person action: only members who can decide approvals (R1); the library's own
 * refusals shown; a cycle event once the counterparty was screened again. The library is faked; it
 * is tested in tests/screening-dismissal.test.ts.
 */

const { authorizeMock, dismissMock, raiseMock } = vi.hoisted(() => ({ authorizeMock: vi.fn(), dismissMock: vi.fn(), raiseMock: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));
vi.mock("@/lib/auth/revalidate", () => ({ revalidateOrgPages: vi.fn() }));
vi.mock("@/lib/agent/cycle-soon", () => ({ raiseCycleEvent: raiseMock }));
vi.mock("@/lib/dal/scope", () => ({ inOrg: (_access: unknown, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/screening-dismissal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/screening-dismissal")>()),
  dismissScreeningMatch: dismissMock,
}));

const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1";
const CP = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de";
const ACCESS = { ok: true, user: { id: USER, email: null }, membership: { orgId: "o1", slug: "studio", name: "Studio", mode: "live", role: "approver" } };
const empty = { ok: false, message: "" };

function form(fields: Record<string, string> = {}): FormData {
  const data = new FormData();
  data.set("orgSlug", "studio");
  for (const [key, value] of Object.entries({ counterpartyId: CP, matchedEntityId: "Q-PEP", reason: "Our freelancer, not the politician", ...fields })) data.set(key, value);
  return data;
}

beforeEach(() => {
  authorizeMock.mockReset().mockResolvedValue(ACCESS);
  dismissMock.mockReset().mockResolvedValue({ name: "Quoc Duong", rescreened: true, riskLevel: "clear", paymentLimit: 1 });
  raiseMock.mockReset();
});

describe("dismissScreeningMatchAction", () => {
  it("asks for approval.decide, and dismisses nothing when refused", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "You cannot decide approvals here." });
    expect(await dismissScreeningMatchAction(empty, form())).toEqual({ ok: false, message: "You cannot decide approvals here." });
    expect(authorizeMock).toHaveBeenCalledWith("studio", "approval.decide");
    expect(dismissMock).not.toHaveBeenCalled();
  });

  it("dismisses as the signed-in person, says the new verdict, and starts a cycle", async () => {
    const answer = await dismissScreeningMatchAction(empty, form());
    expect(dismissMock).toHaveBeenCalledWith({ counterpartyId: CP, matchedEntityId: "Q-PEP", actorId: USER, reason: "Our freelancer, not the politician" });
    expect(answer).toEqual({
      ok: true,
      message: "Dismissed. Quoc Duong screened again: clear risk, limit 1 USDC. Payments held on the old risk are decided again within a minute.",
    });
    expect(raiseMock).toHaveBeenCalledWith(ACCESS, "match_dismissed");
  });

  it("starts no cycle when screening could not run again", async () => {
    dismissMock.mockResolvedValueOnce({ name: "Quoc Duong", rescreened: false, riskLevel: "medium", paymentLimit: null });
    expect((await dismissScreeningMatchAction(empty, form())).message).toContain("screened again at the next cycle");
    expect(raiseMock).not.toHaveBeenCalled();
  });

  it("shows the library's refusals, and keeps anything else in the log", async () => {
    dismissMock.mockRejectedValueOnce(new DismissalError("stale"));
    expect(await dismissScreeningMatchAction(empty, form())).toEqual({
      ok: false,
      message: "This counterparty's screening changed after this page loaded. Check the new match and try again.",
    });
    dismissMock.mockRejectedValueOnce(new Error("connection reset"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await dismissScreeningMatchAction(empty, form())).toEqual({ ok: false, message: "That did not work. Try again in a moment." });
    logged.mockRestore();
  });

  it("refuses a malformed counterparty", async () => {
    expect(await dismissScreeningMatchAction(empty, form({ counterpartyId: "nope" }))).toEqual({ ok: false, message: "Counterparty not found." });
  });
});
