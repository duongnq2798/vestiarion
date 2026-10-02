import { describe, expect, it } from "vitest";
import { agentOutflowUsdc, budgetGate, budgetRoom, budgetWindows, parseBudgetForm } from "@/lib/agent/outflow-budget";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/** The agent's spending limit (docs/superpowers/specs/2026-10-02-outflow-budget-design.md R1–R5). */

const pay = (detail: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
  actor: "agent",
  action: "ap_pay",
  detail: { currency: "USDC", amountPaid: 40, observed: { amount: 40 }, execution: { resultingStatus: "paid" }, ...detail },
  ...overrides,
});

describe("agentOutflowUsdc (R1, R2)", () => {
  it("counts what an agent payment sent, settled or in flight", () => {
    expect(agentOutflowUsdc(pay({}))).toBe(40);
    expect(agentOutflowUsdc(pay({ execution: { resultingStatus: "matched" } }))).toBe(40);
    // With an early-payment discount, what went out.
    expect(agentOutflowUsdc(pay({ amountPaid: 39.2 }))).toBe(39.2);
  });

  it("counts a EURC payment at the USDC value its decision recorded", () => {
    expect(agentOutflowUsdc(pay({ currency: "EURC", amountPaid: 10, usdcValue: 11.6, observed: { amount: 10 } }))).toBe(11.6);
    // After a 2% discount: 9.8 EURC at the same rate.
    expect(agentOutflowUsdc(pay({ currency: "EURC", amountPaid: 9.8, usdcValue: 11.6, observed: { amount: 10 } }))).toBe(11.368);
  });

  it("counts a milestone the agent released", () => {
    expect(agentOutflowUsdc({ actor: "agent", action: "milestone_release", detail: { observed: { amount: 25 }, execution: { resultingStatus: "paid" } } })).toBe(25);
  });

  it("counts nothing that did not send money, or that a person decided", () => {
    expect(agentOutflowUsdc(pay({ execution: { resultingStatus: "held" } }))).toBe(0);
    expect(agentOutflowUsdc(pay({ amountPaid: null }))).toBe(0);
    expect(agentOutflowUsdc(pay({}, { actor: "human" }))).toBe(0);
    expect(agentOutflowUsdc(pay({}, { action: "ap_schedule" }))).toBe(0);
    expect(agentOutflowUsdc({ actor: "agent", action: "milestone_hold", detail: { observed: { amount: 25 }, execution: { resultingStatus: "held" } } })).toBe(0);
  });
});

describe("budgetWindows (R3)", () => {
  it("is the current UTC day, and it with the six UTC days before it", () => {
    expect(budgetWindows(new Date("2026-10-02T03:15:00Z"))).toEqual({ dayStart: "2026-10-02T00:00:00.000Z", weekStart: "2026-09-26T00:00:00.000Z" });
  });
});

describe("budgetRoom", () => {
  it("is null with no figure set", () => {
    expect(budgetRoom(null, { today: 5, week: 5 })).toBeNull();
    expect(budgetRoom({ dailyUsdc: null, weeklyUsdc: null }, { today: 5, week: 5 })).toBeNull();
  });

  it("is what the tighter figure leaves, never below zero", () => {
    expect(budgetRoom({ dailyUsdc: 100, weeklyUsdc: 500 }, { today: 30, week: 450 })).toEqual({
      dailyUsdc: 100,
      weeklyUsdc: 500,
      spentToday: 30,
      spentThisWeek: 450,
      remaining: 50,
      binding: "week",
    });
    expect(budgetRoom({ dailyUsdc: 100, weeklyUsdc: null }, { today: 130, week: 130 })).toMatchObject({ remaining: 0, binding: "day" });
    expect(budgetRoom({ dailyUsdc: null, weeklyUsdc: 300 }, { today: 0, week: 120.5 })).toMatchObject({ remaining: 179.5, binding: "week" });
  });
});

describe("budgetGate (R5, R8)", () => {
  const NOW = new Date("2026-10-02T09:00:00Z");
  const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
  const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000b0b";
  let fake: ReturnType<typeof fakeSupabase>;
  const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn);
  const reads = (path: string) => fake.requests.filter((r) => r.path === path && r.method === "GET");

  function workspace(budget: unknown[], entries: unknown[], fail = false) {
    return (r: RecordedRequest): FakeReply => {
      if (r.path === "/rest/v1/agent_budgets") return fail ? { status: 500, body: { message: "connection reset" } } : { body: budget };
      if (r.path === "/rest/v1/ledger_entries") return { body: entries };
      return { body: [] };
    };
  }

  it("reads the limit and what the agent paid once, then adds each payment made this cycle", async () => {
    fake = fakeSupabase(
      workspace(
        [{ daily_usdc: "100.000000", weekly_usdc: "300.000000" }],
        [
          { ts: "2026-10-02T01:00:00Z", ...pay({ amountPaid: 30 }) },
          { ts: "2026-09-29T12:00:00Z", ...pay({ amountPaid: 210 }) },
          { ts: "2026-10-02T02:00:00Z", ...pay({ amountPaid: 500 }, { actor: "human" }) },
        ]
      )
    );
    await run(async () => {
      const gate = budgetGate(db(), () => NOW);
      expect(await gate.room()).toMatchObject({ spentToday: 30, spentThisWeek: 240, remaining: 60, binding: "week" });
      gate.spend(20);
      expect(await gate.room()).toMatchObject({ spentToday: 50, spentThisWeek: 260, remaining: 40, binding: "week" });
    });
    const ledger = reads("/rest/v1/ledger_entries");
    expect(ledger).toHaveLength(1);
    // Only the agent's payment decisions since the 7-day window opened (R1, R3).
    expect(ledger[0].params.get("actor")).toBe("eq.agent");
    expect(ledger[0].params.get("action")).toBe("in.(ap_pay,milestone_release)");
    expect(ledger[0].params.get("ts")).toBe("gte.2026-09-26T00:00:00.000Z");
    expect(reads("/rest/v1/agent_budgets")).toHaveLength(1);
  });

  it("reads nothing more once it knows no limit is set", async () => {
    fake = fakeSupabase(workspace([], []));
    await run(async () => {
      const gate = budgetGate(db(), () => NOW);
      expect(await gate.room()).toBeNull();
      gate.spend(10);
      expect(await gate.room()).toBeNull();
    });
    expect(reads("/rest/v1/ledger_entries")).toHaveLength(0);
    expect(reads("/rest/v1/agent_budgets")).toHaveLength(1);
  });

  it("fails when the limit cannot be read, rather than paying past it", async () => {
    fake = fakeSupabase(workspace([], [], true));
    await run(async () => {
      await expect(budgetGate(db(), () => NOW).room()).rejects.toThrow(/connection reset/);
    });
  });
});

describe("parseBudgetForm (R7)", () => {
  it("reads each figure as positive USDC, or none when blank", () => {
    expect(parseBudgetForm({ daily: "100", weekly: "" })).toEqual({ ok: true, budget: { dailyUsdc: 100, weeklyUsdc: null } });
    expect(parseBudgetForm({ daily: " ", weekly: "1,000.5" })).toEqual({ ok: true, budget: { dailyUsdc: null, weeklyUsdc: 1000.5 } });
    expect(parseBudgetForm({ daily: "", weekly: "" })).toEqual({ ok: true, budget: { dailyUsdc: null, weeklyUsdc: null } });
  });

  it("refuses zero, a negative or unreadable figure, more than six decimals, and a 7-day figure below the daily one", () => {
    expect(parseBudgetForm({ daily: "0", weekly: "" })).toEqual({ ok: false, message: "The daily limit must be more than 0 USDC." });
    expect(parseBudgetForm({ daily: "-5", weekly: "" })).toMatchObject({ ok: false });
    expect(parseBudgetForm({ daily: "abc", weekly: "" })).toEqual({ ok: false, message: "The daily limit must be a number of USDC." });
    expect(parseBudgetForm({ daily: "1.0000001", weekly: "" })).toEqual({ ok: false, message: "The daily limit can have at most 6 decimal places." });
    expect(parseBudgetForm({ daily: "100", weekly: "50" })).toEqual({ ok: false, message: "The 7-day limit cannot be lower than the daily limit." });
  });
});
