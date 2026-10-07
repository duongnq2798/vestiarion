import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { agentBudgetStatus, AgentBudgetError, budgetLoosened, changeAgentBudget } from "@/lib/agent-budget";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * Setting the agent's spending limit (docs/superpowers/specs/2026-10-02-outflow-budget-design.md R7):
 * one row per workspace, written as a whole, refused while a cycle runs, each change in the ledger.
 */

const { ledgerMock, setLimitsMock } = vi.hoisted(() => ({ ledgerMock: vi.fn(), setLimitsMock: vi.fn() }));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: ledgerMock }));
vi.mock("@/lib/circle/spending-limit-setup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/circle/spending-limit-setup")>()),
  setLimitsOnChain: setLimitsMock,
}));

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c0c";
const ACTOR = "a1b2c3d4-0000-4000-8000-000000000001";

let fake: ReturnType<typeof fakeSupabase>;
const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: ACTOR }), fn);

function workspace(over: { budget?: unknown[]; running?: unknown[]; payments?: unknown[]; upsert?: FakeReply; onChain?: Record<string, unknown> } = {}) {
  return (r: RecordedRequest): FakeReply => {
    if (r.path === "/rest/v1/spending_limit_contracts") return { body: over.onChain ?? null };
    if (r.path === "/rest/v1/agent_budgets" && r.method === "GET") return { body: over.budget ?? [] };
    if (r.path === "/rest/v1/agent_budgets" && r.method === "POST") return over.upsert ?? { status: 201, body: null };
    if (r.path === "/rest/v1/cycle_runs") return { body: over.running ?? [] };
    if (r.path === "/rest/v1/ledger_entries") return { body: over.payments ?? [] };
    return { body: [] };
  };
}

beforeEach(() => {
  ledgerMock.mockReset().mockResolvedValue(undefined);
  setLimitsMock.mockReset().mockResolvedValue({ contract: ENFORCED.address, txHash: "0xset" });
});

const ENFORCED = {
  id: "lim-1",
  address: "0x11a1700000000000000000000000000000001111",
  agent_wallet_id: "wallet-agent",
  agent_address: "0xA9e7000000000000000000000000000000000A9e",
  approve_tx_id: "tx-a",
  enforced: true,
};

describe("changeAgentBudget while the limit is enforced on Arc (onchain spending limit R10)", () => {
  it("changes the contract first, then saves the figures and records the change with its transaction", async () => {
    fake = fakeSupabase(workspace({ budget: [{ daily_usdc: "5", weekly_usdc: "20" }], onChain: ENFORCED }));
    await run(() => changeAgentBudget({ actorId: ACTOR, daily: "8", weekly: "30" }));

    expect(setLimitsMock).toHaveBeenCalledWith({ dailyUsdc: 8, weeklyUsdc: 30 });
    const post = fake.requests.find((r) => r.path === "/rest/v1/agent_budgets" && r.method === "POST");
    expect(post?.body).toMatchObject({ daily_usdc: 8, weekly_usdc: 30 });
    expect(ledgerMock.mock.calls[0][1].detail).toEqual({
      by: ACTOR,
      from: { dailyUsdc: 5, weeklyUsdc: 20 },
      to: { dailyUsdc: 8, weeklyUsdc: 30 },
      onChain: { contract: ENFORCED.address, txHash: "0xset" },
    });
  });

  it("changes nothing when Circle does not change the contract", async () => {
    setLimitsMock.mockRejectedValue(new Error("Circle did not change the figures on the contract (FAILED). The limit was not changed."));
    fake = fakeSupabase(workspace({ budget: [{ daily_usdc: "5", weekly_usdc: "20" }], onChain: ENFORCED }));
    const attempt = run(() => changeAgentBudget({ actorId: ACTOR, daily: "8", weekly: "30" }));
    await expect(attempt).rejects.toBeInstanceOf(AgentBudgetError);
    await expect(attempt).rejects.toThrow(/The limit was not changed/);
    expect(fake.requests.some((r) => r.path === "/rest/v1/agent_budgets" && r.method === "POST")).toBe(false);
    expect(ledgerMock).not.toHaveBeenCalled();
  });

  it("refuses removing both figures while it is enforced, before anything reaches Circle", async () => {
    fake = fakeSupabase(workspace({ budget: [{ daily_usdc: "5", weekly_usdc: "20" }], onChain: ENFORCED }));
    await expect(run(() => changeAgentBudget({ actorId: ACTOR, daily: "", weekly: "" }))).rejects.toThrow(/Keep a daily or 7-day figure while the limit is enforced on Arc/);
    expect(setLimitsMock).not.toHaveBeenCalled();
  });

  it("leaves the contract alone when the limit is not enforced on Arc", async () => {
    fake = fakeSupabase(workspace({ budget: [{ daily_usdc: "5", weekly_usdc: "20" }], onChain: { ...ENFORCED, enforced: false } }));
    await run(() => changeAgentBudget({ actorId: ACTOR, daily: "8", weekly: "30" }));
    expect(setLimitsMock).not.toHaveBeenCalled();
    expect(ledgerMock.mock.calls[0][1].detail).not.toHaveProperty("onChain");
  });
});

describe("changeAgentBudget", () => {
  it("writes both figures as one row for the workspace, and records the change", async () => {
    fake = fakeSupabase(workspace({ budget: [{ daily_usdc: "100.000000", weekly_usdc: null }] }));
    const result = await run(() => changeAgentBudget({ actorId: ACTOR, daily: "150", weekly: "600" }));

    expect(result).toEqual({ from: { dailyUsdc: 100, weeklyUsdc: null }, to: { dailyUsdc: 150, weeklyUsdc: 600 }, loosened: true });
    const post = fake.requests.find((r) => r.path === "/rest/v1/agent_budgets" && r.method === "POST")!;
    expect(post.params.get("on_conflict")).toBe("org_id");
    expect(post.body).toMatchObject({ org_id: ORG, daily_usdc: 150, weekly_usdc: 600, updated_by: ACTOR });
    expect(ledgerMock).toHaveBeenCalledWith(ORG, {
      actor: "human",
      domain: "system",
      action: "agent_budget_changed",
      summary: "Changed the agent's spending limit from 100 USDC a day and no 7-day limit to 150 USDC a day and 600 USDC in 7 days",
      detail: { by: ACTOR, from: { dailyUsdc: 100, weeklyUsdc: null }, to: { dailyUsdc: 150, weeklyUsdc: 600 } },
    });
  });

  it("clears the limit when both figures are blank", async () => {
    fake = fakeSupabase(workspace({ budget: [{ daily_usdc: "100", weekly_usdc: "300" }] }));
    const result = await run(() => changeAgentBudget({ actorId: ACTOR, daily: "", weekly: "" }));
    expect(result.to).toEqual({ dailyUsdc: null, weeklyUsdc: null });
    expect(ledgerMock.mock.calls[0][1].summary).toBe("Removed the agent's spending limit of 100 USDC a day and 300 USDC in 7 days");
  });

  it("refuses an invalid figure, an unchanged limit, and a change while a cycle runs, writing nothing", async () => {
    fake = fakeSupabase(workspace({ budget: [{ daily_usdc: "100", weekly_usdc: null }] }));
    await expect(run(() => changeAgentBudget({ actorId: ACTOR, daily: "0", weekly: "" }))).rejects.toThrow("The daily limit must be more than 0 USDC.");
    await expect(run(() => changeAgentBudget({ actorId: ACTOR, daily: "100", weekly: "" }))).rejects.toMatchObject({ code: "unchanged" });

    fake = fakeSupabase(workspace({ running: [{ id: "run-1" }] }));
    await expect(run(() => changeAgentBudget({ actorId: ACTOR, daily: "50", weekly: "" }))).rejects.toMatchObject({ code: "cycle_running" });
    expect(fake.requests.some((r) => r.method === "POST")).toBe(false);
    expect(ledgerMock).not.toHaveBeenCalled();
  });

  it("reports a failed write rather than recording a change that did not happen", async () => {
    fake = fakeSupabase(workspace({ upsert: { status: 500, body: { message: "connection reset" } } }));
    await expect(run(() => changeAgentBudget({ actorId: ACTOR, daily: "50", weekly: "" }))).rejects.toThrow(/connection reset/);
    expect(ledgerMock).not.toHaveBeenCalled();
  });

  it("is an instance of AgentBudgetError for the person-facing refusals", async () => {
    fake = fakeSupabase(workspace());
    await expect(run(() => changeAgentBudget({ actorId: ACTOR, daily: "100", weekly: "50" }))).rejects.toBeInstanceOf(AgentBudgetError);
  });
});

describe("budgetLoosened", () => {
  it("is true when a figure rose or was removed, so a payment held under the old one may now fit", () => {
    expect(budgetLoosened({ dailyUsdc: 100, weeklyUsdc: null }, { dailyUsdc: 150, weeklyUsdc: null })).toBe(true);
    expect(budgetLoosened({ dailyUsdc: 100, weeklyUsdc: 300 }, { dailyUsdc: 100, weeklyUsdc: null })).toBe(true);
    expect(budgetLoosened({ dailyUsdc: 100, weeklyUsdc: null }, { dailyUsdc: 50, weeklyUsdc: null })).toBe(false);
    expect(budgetLoosened({ dailyUsdc: null, weeklyUsdc: null }, { dailyUsdc: 50, weeklyUsdc: null })).toBe(false);
  });
});

describe("agentBudgetStatus", () => {
  it("is the limit, and what the agent paid on its own today and in 7 days, even with no limit set", async () => {
    fake = fakeSupabase(
      workspace({
        payments: [{ ts: new Date().toISOString(), actor: "agent", action: "ap_pay", detail: { currency: "USDC", amountPaid: 12.5, execution: { resultingStatus: "paid" } } }],
      })
    );
    expect(await run(() => agentBudgetStatus())).toEqual({ budget: null, spent: { today: 12.5, week: 12.5 }, room: null });
  });
});

describe("changeAgentBudget on Arc mainnet (mainnet go-live M9)", () => {
  const mainnet = { ...config, network: "arc-mainnet" as const };
  const onMainnet = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config: mainnet, client: fake.client, orgId: ORG, userId: ACTOR }), fn);

  it("keeps a figure: removing both is refused, before anything is written", async () => {
    fake = fakeSupabase(workspace({ budget: [{ daily_usdc: "50", weekly_usdc: "150" }] }));
    const attempt = onMainnet(() => changeAgentBudget({ actorId: ACTOR, daily: "", weekly: "" }));
    await expect(attempt).rejects.toMatchObject({ code: "mainnet_needs_figure" });
    await expect(attempt).rejects.toThrow("A workspace on Arc mainnet keeps a daily or 7-day limit.");
    expect(fake.requests.some((r) => r.path === "/rest/v1/agent_budgets" && r.method === "POST")).toBe(false);
  });

  it("still changes a figure, or keeps one of the two", async () => {
    fake = fakeSupabase(workspace({ budget: [{ daily_usdc: "50", weekly_usdc: "150" }] }));
    await onMainnet(() => changeAgentBudget({ actorId: ACTOR, daily: "", weekly: "100" }));
    const post = fake.requests.find((r) => r.path === "/rest/v1/agent_budgets" && r.method === "POST");
    expect(post?.body).toMatchObject({ daily_usdc: null, weekly_usdc: 100 });
  });
});

describe("changeAgentBudget for a workspace paying from its owner's own wallet (wallet treasury W14)", () => {
  it("refuses once its contract is deployed, since only the owner's wallet can change the contract's figures", async () => {
    fake = fakeSupabase(workspace({ budget: [{ daily_usdc: "50", weekly_usdc: "150" }], onChain: ENFORCED }));
    const external = { ...config, network: "arc-mainnet" as const, chain: { ...config.chain, walletHost: "external" as const } };
    const attempt = runWith(orgTestContext({ config: external, client: fake.client, orgId: ORG, userId: ACTOR }), () =>
      changeAgentBudget({ actorId: ACTOR, daily: "60", weekly: "150" })
    );
    await expect(attempt).rejects.toMatchObject({ code: "wallet_contract" });
    expect(setLimitsMock).not.toHaveBeenCalled();
    expect(fake.requests.some((r) => r.path === "/rest/v1/agent_budgets" && r.method === "POST")).toBe(false);
  });
});
