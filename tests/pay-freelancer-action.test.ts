import { beforeEach, describe, expect, it, vi } from "vitest";
import { payFreelancerAction } from "@/app/actions/pay-freelancer";

/**
 * The action behind Pay a freelancer: authorization first, the form's
 * validation, the message that says whether the link was emailed, and a cycle
 * event only in a sandbox (pay a freelancer R5). The library is faked; it is
 * tested in tests/pay-freelancer.test.ts.
 */

const { authorizeMock, setUpMock, raiseMock } = vi.hoisted(() => ({ authorizeMock: vi.fn(), setUpMock: vi.fn(), raiseMock: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));
vi.mock("@/lib/auth/revalidate", () => ({ revalidateOrgPages: vi.fn() }));
vi.mock("@/lib/agent/cycle-soon", () => ({ raiseCycleEvent: raiseMock }));
vi.mock("@/lib/dal/scope", () => ({ inOrg: (_access: unknown, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/pay-freelancer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pay-freelancer")>()),
  setUpFreelancerPayment: setUpMock,
}));

const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1";
const access = (mode: "live" | "sandbox") => ({
  ok: true,
  user: { id: USER, email: null },
  membership: { orgId: "o1", slug: "mai", name: "Mai Studio", mode, role: "owner" },
});
const URL = `https://www.vestiarion.xyz/payee/vxp_${"A".repeat(43)}`;

function form(fields: Record<string, string> = {}): FormData {
  const data = new FormData();
  data.set("orgSlug", "mai");
  for (const [key, value] of Object.entries({ name: "Linh", email: "linh@example.com", work: "10 Canva posts", amount: "12.5", evidence: "", ...fields })) {
    data.set(key, value);
  }
  return data;
}

const empty = { ok: false, message: "" };
const result = (emailed: boolean | null) => ({
  counterpartyId: "c1", milestoneId: "m1", name: "Linh", url: URL, expiresAt: "2026-10-08T15:00:00+00:00", emailed, screening: "clear",
});

beforeEach(() => {
  authorizeMock.mockReset().mockResolvedValue(access("live"));
  setUpMock.mockReset().mockResolvedValue(result(true));
  raiseMock.mockReset();
});

describe("payFreelancerAction", () => {
  it("asks for records.write, and sets up nothing when refused", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "Only an owner or admin can do that." });
    expect(await payFreelancerAction(empty, form())).toEqual({ ok: false, message: "Only an owner or admin can do that." });
    expect(authorizeMock).toHaveBeenCalledWith("mai", "records.write");
    expect(setUpMock).not.toHaveBeenCalled();
  });

  it("says what is wrong with the form", async () => {
    expect(await payFreelancerAction(empty, form({ email: "nope" }))).toEqual({ ok: false, message: "That email address does not look right" });
    expect(setUpMock).not.toHaveBeenCalled();
  });

  it("sets the payment up as the signed-in person, and returns the link with what comes next", async () => {
    const answer = await payFreelancerAction(empty, form());
    expect(setUpMock).toHaveBeenCalledWith({
      name: "Linh", email: "linh@example.com", work: "10 Canva posts", amount: "12.5", evidence: null, actorId: USER, orgName: "Mai Studio",
    });
    expect(answer).toMatchObject({ ok: true, url: URL, name: "Linh", emailed: true });
    expect(answer.message).toContain("Emailed Linh a link");
    expect(answer.message).toContain("confirm it on Counterparties");
  });

  it("asks the person to send the link when there was no email, or it did not go out", async () => {
    setUpMock.mockResolvedValueOnce(result(null));
    expect((await payFreelancerAction(empty, form({ email: "" }))).message).toContain("Send Linh this link");
    setUpMock.mockResolvedValueOnce(result(false));
    expect((await payFreelancerAction(empty, form())).message).toContain("did not go out");
  });

  it("starts a cycle in a sandbox, which pays simulated at once, and not in a live workspace", async () => {
    await payFreelancerAction(empty, form());
    expect(raiseMock).not.toHaveBeenCalled();
    authorizeMock.mockResolvedValueOnce(access("sandbox"));
    await payFreelancerAction(empty, form());
    expect(raiseMock).toHaveBeenCalledWith(access("sandbox"), "milestone_verified");
  });

  it("keeps the database's message in the server log", async () => {
    setUpMock.mockRejectedValueOnce(new Error("duplicate key value violates unique constraint"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await payFreelancerAction(empty, form())).toEqual({ ok: false, message: "That did not work. Try again in a moment." });
    logged.mockRestore();
  });
});
