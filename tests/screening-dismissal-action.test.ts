import { beforeEach, describe, expect, it, vi } from "vitest";
import { dismissScreeningMatchAction, screenAgainAction } from "@/app/actions/compliance";
import { DismissalError } from "@/lib/screening-dismissal";

/**
 * The Not this person action: only members who can decide approvals (R1); the library's own
 * refusals shown; a cycle event once the counterparty was screened again. The library is faked; it
 * is tested in tests/screening-dismissal.test.ts.
 */

const { authorizeMock, dismissMock, raiseMock, screenMock } = vi.hoisted(() => ({ authorizeMock: vi.fn(), dismissMock: vi.fn(), raiseMock: vi.fn(), screenMock: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));
vi.mock("@/lib/auth/revalidate", () => ({ revalidateOrgPages: vi.fn() }));
vi.mock("@/lib/agent/cycle-soon", () => ({ raiseCycleEvent: raiseMock }));
vi.mock("@/lib/dal/scope", () => ({ inOrg: (_access: unknown, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/compliance", () => ({ screenCounterparty: screenMock, MATCHES_KEPT: 25 }));
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

/** A card that listed several matches sends each one's id. */
function formListing(ids: string[]): FormData {
  const data = form();
  data.delete("matchedEntityId");
  for (const id of ids) data.append("matchedEntityId", id);
  return data;
}

beforeEach(() => {
  authorizeMock.mockReset().mockResolvedValue(ACCESS);
  dismissMock.mockReset().mockResolvedValue({ name: "Quoc Duong", rescreened: true, riskLevel: "clear", paymentLimit: 1, dismissed: 1 });
  raiseMock.mockReset();
  screenMock.mockReset().mockResolvedValue({ counterpartyId: CP, name: "Quoc Duong", riskLevel: "medium", previousRiskLevel: "medium" });
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
    expect(dismissMock).toHaveBeenCalledWith({ counterpartyId: CP, matchedEntityIds: ["Q-PEP"], actorId: USER, reason: "Our freelancer, not the politician" });
    expect(answer).toEqual({
      ok: true,
      message: "Dismissed. Quoc Duong screened again: clear risk, limit 1 USDC. Payments held on the old risk are decided again within a minute.",
    });
    expect(raiseMock).toHaveBeenCalledWith(ACCESS, "match_dismissed");
  });

  it("starts no cycle when screening could not run again", async () => {
    dismissMock.mockResolvedValueOnce({ name: "Quoc Duong", rescreened: false, riskLevel: "medium", paymentLimit: null, dismissed: 1 });
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

  it("passes every match the card listed, and says how many it dismissed", async () => {
    dismissMock.mockResolvedValueOnce({ name: "Quoc Duong", rescreened: true, riskLevel: "clear", paymentLimit: 1, dismissed: 3 });
    const answer = await dismissScreeningMatchAction(empty, formListing(["Q-TAN", "Q-YANG", "Q-LE"]));
    expect(dismissMock).toHaveBeenCalledWith(expect.objectContaining({ matchedEntityIds: ["Q-TAN", "Q-YANG", "Q-LE"] }));
    expect(answer.message).toBe("Dismissed 3 matches. Quoc Duong screened again: clear risk, limit 1 USDC. Payments held on the old risk are decided again within a minute.");
  });
});

describe("screenAgainAction", () => {
  it("asks for approval.decide, and screens nothing when refused", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "You cannot decide approvals here." });
    expect(await screenAgainAction(empty, form())).toEqual({ ok: false, message: "You cannot decide approvals here." });
    expect(authorizeMock).toHaveBeenCalledWith("studio", "approval.decide");
    expect(screenMock).not.toHaveBeenCalled();
  });

  it("screens the counterparty again and points to Not this person while the match stands; no cycle when nothing changed", async () => {
    expect(await screenAgainAction(empty, form())).toEqual({ ok: true, message: "Quoc Duong screened again: medium risk. If it is someone else, choose Not this person." });
    expect(screenMock).toHaveBeenCalledWith(CP);
    expect(raiseMock).not.toHaveBeenCalled();
  });

  it("starts a cycle when the verdict changed", async () => {
    screenMock.mockResolvedValueOnce({ counterpartyId: CP, name: "Quoc Duong", riskLevel: "clear", previousRiskLevel: "medium" });
    expect((await screenAgainAction(empty, form())).message).toBe("Quoc Duong screened again: clear risk.");
    expect(raiseMock).toHaveBeenCalledWith(ACCESS, "match_dismissed");
  });

  it("says when screening could not be reached, and refuses a malformed counterparty", async () => {
    screenMock.mockRejectedValueOnce(new Error("timeout"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await screenAgainAction(empty, form())).toEqual({ ok: false, message: "Screening could not be reached just now. Try again in a moment." });
    logged.mockRestore();
    expect(await screenAgainAction(empty, form({ counterpartyId: "nope" }))).toEqual({ ok: false, message: "Counterparty not found." });
  });
});
