import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { setTwoApprovalsAction, type TwoApprovalsActionResult } from "@/app/actions/approval-policy";
import { ApprovalPolicyError } from "@/lib/approval-policy";
import { fakeSupabase } from "./support/fake-supabase";

/**
 * `src/app/actions/approval-policy.ts` against a real `inOrg` (the tests/ledger-key-actions.test.ts shape): `server-only`,
 * `authorize`, the library call and the cycle event are stand-ins, proven elsewhere (tests/approval-policy.test.ts).
 */

const { ORG, USER } = vi.hoisted(() => ({
  ORG: "0b6c1c9e-4a4f-4a7e-9b1e-000000000c0c",
  USER: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000fc",
}));

vi.mock("server-only", () => ({}));

const { revalidatePathMock } = vi.hoisted(() => ({ revalidatePathMock: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

const { authorizeMock } = vi.hoisted(() => ({ authorizeMock: vi.fn() }));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));

const { changeMock } = vi.hoisted(() => ({ changeMock: vi.fn() }));
vi.mock("@/lib/approval-policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/approval-policy")>()),
  changeTwoApprovals: changeMock,
}));

const { cycleEventMock } = vi.hoisted(() => ({ cycleEventMock: vi.fn() }));
vi.mock("@/lib/agent/cycle-soon", () => ({ raiseCycleEvent: cycleEventMock }));

beforeEach(() => {
  vi.clearAllMocks();
});

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

const allowed = () => ({
  ok: true,
  user: { id: USER, email: null },
  membership: { orgId: ORG, slug: "northstar", name: "Northstar", mode: "live" as const, role: "owner" as const },
});

function run<T>(fn: () => Promise<T>): Promise<T> {
  const orgRow = { id: ORG, slug: "northstar", name: "Northstar", mode: "live", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null };
  const fake = fakeSupabase((request) => (request.path === "/rest/v1/orgs" ? { body: orgRow } : { body: [] }));
  return runWith({ config, db: fake.client, fetch: fake.fetch }, fn);
}

const INITIAL: TwoApprovalsActionResult = { ok: false, message: "" };

function form(above: string): FormData {
  const data = new FormData();
  data.set("orgSlug", "northstar");
  data.set("above", above);
  return data;
}

describe("setTwoApprovalsAction", () => {
  it("asks for approval.policy and does nothing when refused", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "Your role in this workspace cannot do that." });

    const result = await setTwoApprovalsAction(INITIAL, form("100"));

    expect(authorizeMock).toHaveBeenCalledWith("northstar", "approval.policy");
    expect(result).toEqual({ ok: false, message: "Your role in this workspace cannot do that." });
    expect(changeMock).not.toHaveBeenCalled();
  });

  it("sets the figure as the signed-in person, and says what it now means", async () => {
    authorizeMock.mockResolvedValueOnce(allowed());
    changeMock.mockResolvedValueOnce({ from: null, to: 100 });

    const result = await run(() => setTwoApprovalsAction(INITIAL, form("100")));

    expect(changeMock).toHaveBeenCalledWith({ actorId: USER, value: "100" });
    expect(result).toEqual({ ok: true, message: "Payments above 100 USDC now need two approvals." });
    expect(revalidatePathMock).toHaveBeenCalledWith("/o/[slug]", "layout");
    // Tighter: nothing held can now be paid that could not before.
    expect(cycleEventMock).not.toHaveBeenCalled();
  });

  it("asks the agent to look again when the figure is raised or turned off", async () => {
    authorizeMock.mockResolvedValueOnce(allowed());
    changeMock.mockResolvedValueOnce({ from: 100, to: 500 });
    expect(await run(() => setTwoApprovalsAction(INITIAL, form("500")))).toEqual({ ok: true, message: "Payments above 500 USDC now need two approvals." });
    expect(cycleEventMock).toHaveBeenCalledWith(expect.objectContaining({ user: { id: USER, email: null } }), "two_approvals_raised");

    cycleEventMock.mockClear();
    authorizeMock.mockResolvedValueOnce(allowed());
    changeMock.mockResolvedValueOnce({ from: 100, to: null });
    expect(await run(() => setTwoApprovalsAction(INITIAL, form("")))).toEqual({ ok: true, message: "Two approvals are off: one approval pays any payment." });
    expect(cycleEventMock).toHaveBeenCalledWith(expect.anything(), "two_approvals_raised");
  });

  it("shows an ApprovalPolicyError's own message, and hides any other", async () => {
    authorizeMock.mockResolvedValueOnce(allowed());
    changeMock.mockRejectedValueOnce(new ApprovalPolicyError("too_few_approvers"));
    expect(await run(() => setTwoApprovalsAction(INITIAL, form("100")))).toEqual({
      ok: false,
      message: "Two approvals need two people who can approve payments. Add an approver on Members first.",
    });

    authorizeMock.mockResolvedValueOnce(allowed());
    changeMock.mockRejectedValueOnce(new Error("relation does not exist"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await run(() => setTwoApprovalsAction(INITIAL, form("100")))).toEqual({ ok: false, message: "That did not work. Try again in a moment." });
    logged.mockRestore();
  });
});
