import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { setAgentBudgetAction } from "@/app/actions/agent";
import { setTwoApprovalsAction } from "@/app/actions/approval-policy";
import { updateCounterpartyLimitAction } from "@/app/actions/intake";
import { tryRuleAction } from "@/app/actions/policy-replay";
import { CounterpartyLimitError } from "@/lib/counterparty-limit";
import { RuleReplayError } from "@/lib/policy-replay-read";
import { fakeSupabase } from "./support/fake-supabase";

/**
 * Trying a rule and applying it (docs/superpowers/specs/2026-10-10-policy-replay-design.md P1, P10), through the real
 * `inOrg`: `server-only`, `authorize`, the replay and the libraries' changes are stand-ins, proven in
 * tests/policy-replay-read.test.ts and each library's own tests. What is held here is the permission each setting
 * asks for, and that Apply goes through the setting's own action with the figure tried and a replay run on the server.
 */

const { ORG, USER, COUNTERPARTY } = vi.hoisted(() => ({
  ORG: "0b6c1c9e-4a4f-4a7e-9b1e-000000000f0f",
  USER: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000f1",
  COUNTERPARTY: "018f8ce0-1557-7b54-a931-4d777f6bca41",
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { authorizeMock, ruleReplayMock, replayForApplyMock, changeLimitMock, changeTwoMock, changeBudgetMock, cycleEventMock } = vi.hoisted(() => ({
  authorizeMock: vi.fn(),
  ruleReplayMock: vi.fn(),
  replayForApplyMock: vi.fn(),
  changeLimitMock: vi.fn(),
  changeTwoMock: vi.fn(),
  changeBudgetMock: vi.fn(),
  cycleEventMock: vi.fn(),
}));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));
vi.mock("@/lib/agent/cycle-soon", () => ({ raiseCycleEvent: cycleEventMock }));
vi.mock("@/lib/policy-replay-read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/policy-replay-read")>()),
  ruleReplay: ruleReplayMock,
  replayForApply: replayForApplyMock,
}));
vi.mock("@/lib/counterparty-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/counterparty-limit")>()),
  changeCounterpartyLimit: changeLimitMock,
}));
vi.mock("@/lib/approval-policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/approval-policy")>()),
  changeTwoApprovals: changeTwoMock,
}));
vi.mock("@/lib/agent-budget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent-budget")>()),
  changeAgentBudget: changeBudgetMock,
}));

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

function run<T>(fn: () => Promise<T>): Promise<T> {
  const orgRow = { id: ORG, slug: "northstar", name: "Northstar", mode: "sandbox", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null };
  const fake = fakeSupabase((request) => (request.path === "/rest/v1/orgs" ? { body: orgRow } : { body: [] }));
  return runWith({ config, db: fake.client, fetch: fake.fetch }, fn);
}

const allowed = (role = "owner") => ({
  ok: true,
  user: { id: USER, email: null },
  membership: { orgId: ORG, slug: "northstar", name: "Northstar", mode: "sandbox" as const, role },
});

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  data.set("orgSlug", "northstar");
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const SUMMARY = { windowDays: 30, from: "2026-09-10T12:00:00.000Z", to: "2026-10-10T12:00:00.000Z", decisions: 4, unchanged: 3, nowHeld: 1, nowPaid: 0, nowTwoPeople: 0, cantTell: 0 };
const INITIAL = { ok: false, message: "" };

beforeEach(() => {
  vi.clearAllMocks();
  replayForApplyMock.mockResolvedValue(SUMMARY);
});

describe("tryRuleAction", () => {
  it.each([
    ["counterparty_limit", "records.write", { counterpartyId: COUNTERPARTY, paymentLimit: "200" }],
    ["two_approvals", "approval.policy", { above: "100" }],
    ["spending_limit", "agent.budget", { daily: "50", weekly: "" }],
  ] as const)("asks for the permission that changes %s (%s), and replays nothing when refused", async (rule, permission, fields) => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "Your role in this workspace (viewer) cannot do that." });
    const result = await tryRuleAction(form({ rule, days: "30", ...fields }));
    expect(authorizeMock).toHaveBeenCalledWith("northstar", permission);
    expect(result).toEqual({ ok: false, message: "Your role in this workspace (viewer) cannot do that." });
    expect(ruleReplayMock).not.toHaveBeenCalled();
  });

  it("returns the replay of the candidate, read from the setting's form", async () => {
    authorizeMock.mockResolvedValueOnce(allowed("admin"));
    ruleReplayMock.mockResolvedValueOnce({ counts: SUMMARY });
    const result = await run(() => tryRuleAction(form({ rule: "counterparty_limit", days: "90", counterpartyId: COUNTERPARTY, paymentLimit: "200" })));
    expect(result).toEqual({ ok: true, message: "", view: { counts: SUMMARY } });
    expect(ruleReplayMock).toHaveBeenCalledWith({
      rule: "counterparty_limit",
      counterpartyId: COUNTERPARTY,
      values: { paymentLimit: "200", above: undefined, daily: undefined, weekly: undefined },
      days: 90,
    });
  });

  it("says what the replay refused", async () => {
    authorizeMock.mockResolvedValueOnce(allowed());
    ruleReplayMock.mockRejectedValueOnce(new RuleReplayError("unchanged", "That is already this counterparty's limit."));
    const result = await run(() => tryRuleAction(form({ rule: "counterparty_limit", days: "30", counterpartyId: COUNTERPARTY, paymentLimit: "500" })));
    expect(result).toEqual({ ok: false, message: "That is already this counterparty's limit." });
  });

  it("refuses a setting or a window it does not know before asking who is signed in", async () => {
    expect(await tryRuleAction(form({ rule: "sandbox_cap", days: "30" }))).toEqual({ ok: false, message: "Choose a setting and a window of 30 or 90 days." });
    expect(await tryRuleAction(form({ rule: "two_approvals", days: "7", above: "100" }))).toEqual({ ok: false, message: "Choose a setting and a window of 30 or 90 days." });
    expect(authorizeMock).not.toHaveBeenCalled();
  });
});

describe("Apply this figure, through each setting's own action", () => {
  it("changes a counterparty's limit as Save does, with the limit tried and a replay run on the server", async () => {
    authorizeMock.mockResolvedValueOnce(allowed());
    changeLimitMock.mockResolvedValueOnce({ name: "Northwind Trading", from: 500, to: 200, current: 200 });

    const result = await run(() =>
      updateCounterpartyLimitAction(INITIAL, form({ counterpartyId: COUNTERPARTY, paymentLimit: "200", replayDays: "30", expectedLimit: "500" }))
    );

    expect(authorizeMock).toHaveBeenCalledWith("northstar", "records.write");
    expect(replayForApplyMock).toHaveBeenCalledWith({
      rule: "counterparty_limit",
      counterpartyId: COUNTERPARTY,
      values: { paymentLimit: "200", above: undefined, daily: undefined, weekly: undefined },
      days: 30,
    });
    expect(changeLimitMock).toHaveBeenCalledWith({ actorId: USER, counterpartyId: COUNTERPARTY, raw: "200", expected: 500, replay: SUMMARY });
    expect(result).toEqual({ ok: true, message: "Northwind Trading's payment limit is now 200 USDC." });
  });

  it("saves without a replay when the form carries none, as before", async () => {
    authorizeMock.mockResolvedValueOnce(allowed());
    changeLimitMock.mockResolvedValueOnce({ name: "Northwind Trading", from: 500, to: 200, current: 200 });
    await run(() => updateCounterpartyLimitAction(INITIAL, form({ counterpartyId: COUNTERPARTY, paymentLimit: "200" })));
    expect(replayForApplyMock).not.toHaveBeenCalled();
    expect(changeLimitMock).toHaveBeenCalledWith({ actorId: USER, counterpartyId: COUNTERPARTY, raw: "200" });
  });

  it("says the limit changed since it was tried, as the library refuses it", async () => {
    authorizeMock.mockResolvedValueOnce(allowed());
    changeLimitMock.mockRejectedValueOnce(new CounterpartyLimitError("stale"));
    const result = await run(() =>
      updateCounterpartyLimitAction(INITIAL, form({ counterpartyId: COUNTERPARTY, paymentLimit: "200", replayDays: "30", expectedLimit: "500" }))
    );
    expect(result).toEqual({ ok: false, message: "This counterparty's limit changed since you tried it. Try it again." });
  });

  it("refuses an Apply whose tried figure is missing or unreadable, changing nothing", async () => {
    authorizeMock.mockResolvedValue(allowed());
    const missing = await run(() => updateCounterpartyLimitAction(INITIAL, form({ counterpartyId: COUNTERPARTY, paymentLimit: "200", replayDays: "30" })));
    const unreadable = await run(() =>
      updateCounterpartyLimitAction(INITIAL, form({ counterpartyId: COUNTERPARTY, paymentLimit: "200", replayDays: "30", expectedLimit: "lots" }))
    );
    expect(missing).toEqual({ ok: false, message: "Try it on past decisions again before you apply it." });
    expect(unreadable).toEqual(missing);
    expect(changeLimitMock).not.toHaveBeenCalled();
    authorizeMock.mockReset();
  });

  it("says what the server's replay refused, changing nothing", async () => {
    authorizeMock.mockResolvedValueOnce(allowed());
    replayForApplyMock.mockRejectedValueOnce(new RuleReplayError("unchanged", "That is already this counterparty's limit."));
    const result = await run(() =>
      updateCounterpartyLimitAction(INITIAL, form({ counterpartyId: COUNTERPARTY, paymentLimit: "200", replayDays: "30", expectedLimit: "500" }))
    );
    expect(result).toEqual({ ok: false, message: "That is already this counterparty's limit." });
    expect(changeLimitMock).not.toHaveBeenCalled();
  });

  it("changes two approvals as Save does, an owner's alone, with the figure tried", async () => {
    authorizeMock.mockResolvedValueOnce(allowed());
    changeTwoMock.mockResolvedValueOnce({ from: null, to: 100 });
    const result = await run(() => setTwoApprovalsAction(INITIAL, form({ above: "100", replayDays: "90", expectedAbove: "" })));
    expect(authorizeMock).toHaveBeenCalledWith("northstar", "approval.policy");
    expect(replayForApplyMock).toHaveBeenCalledWith(expect.objectContaining({ rule: "two_approvals", days: 90, values: expect.objectContaining({ above: "100" }) }));
    expect(changeTwoMock).toHaveBeenCalledWith({ actorId: USER, value: "100", expected: null, replay: SUMMARY });
    expect(result).toEqual({ ok: true, message: "Payments above 100 USDC now need two approvals." });
  });

  it("changes the agent's spending limit as Save does, with both figures tried", async () => {
    authorizeMock.mockResolvedValueOnce(allowed("admin"));
    changeBudgetMock.mockResolvedValueOnce({ from: { dailyUsdc: 100, weeklyUsdc: null }, to: { dailyUsdc: 150, weeklyUsdc: null }, loosened: true });
    const result = await run(() => setAgentBudgetAction(INITIAL, form({ daily: "150", weekly: "", replayDays: "30", expectedDaily: "100", expectedWeekly: "" })));
    expect(authorizeMock).toHaveBeenCalledWith("northstar", "agent.budget");
    expect(changeBudgetMock).toHaveBeenCalledWith({
      actorId: USER,
      daily: "150",
      weekly: "",
      expected: { dailyUsdc: 100, weeklyUsdc: null },
      replay: SUMMARY,
    });
    // A looser limit brings held payments back, as Save does.
    expect(cycleEventMock).toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });
});
