import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BalanceSnapshot, ChainProvider, EarnDepositParams, EarnResult, TransferResult } from "@/lib/circle";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { bringCashBackByPerson, bringCashForTodaysPayments, CashBackError, HELD_FOR_CASH, payablesDueToday } from "@/lib/agent/liquidity";
import { heldForCash } from "@/lib/next-step";
import { fakeSupabase, orgTestContext, type RecordedRequest } from "./support/fake-supabase";

/**
 * Cash back from the reserve (docs/superpowers/specs/2026-10-03-reserve-cash-back-design.md): the cycle brings back
 * what today's payments need before it decides them (R3), and a person brings back what they ask (R2).
 */

const { appendMock, bestEffortMock } = vi.hoisted(() => ({ appendMock: vi.fn(), bestEffortMock: vi.fn() }));
vi.mock("@/lib/ledger", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ledger")>()), appendLedgerEntry: appendMock }));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: bestEffortMock }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c4c";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c5";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

beforeEach(() => {
  appendMock.mockReset().mockResolvedValue(undefined);
  bestEffortMock.mockReset().mockResolvedValue(undefined);
});

class ReserveProvider implements ChainProvider {
  readonly mode = "simulate" as const;
  readonly earnMode = "simulate" as const;
  readonly estimatedFeeUsd = 0.01;
  withdrawCalls: EarnDepositParams[] = [];
  async transfer(): Promise<TransferResult> {
    throw new Error("not used");
  }
  async reconcileTransfer(): Promise<TransferResult> {
    throw new Error("not used");
  }
  async getBalance(): Promise<BalanceSnapshot> {
    throw new Error("not used");
  }
  async depositToEarn(): Promise<EarnResult> {
    throw new Error("not used");
  }
  async withdrawFromEarn(params: EarnDepositParams): Promise<EarnResult> {
    this.withdrawCalls.push(params);
    return { txRef: "sim_redeem_1", positionValue: params.amount, apy: 0 };
  }
}

function fake(options: { invoices?: Array<Record<string, unknown>>; paused?: boolean; accounts?: Array<Record<string, unknown>> } = {}) {
  return fakeSupabase((request: RecordedRequest) => {
    if (request.path === "/rest/v1/rpc/agent_paused") return { body: options.paused === true };
    if (request.path === "/rest/v1/invoices") return { body: options.invoices ?? [] };
    if (request.path === "/rest/v1/accounts" && request.method === "GET") {
      return { body: options.accounts ?? [{ id: "operating-1", kind: "operating", balance: "0.119389" }, { id: "reserve-1", kind: "reserve", balance: "60.691351" }] };
    }
    return { body: [] };
  });
}
const run = <T>(client: ReturnType<typeof fakeSupabase>, fn: () => Promise<T>) => runWith(orgTestContext({ config, client: client.client, orgId: ORG, userId: USER }), fn);
const invoice = (over: Record<string, unknown> = {}) => ({ amount: "0.20", currency: "USDC", status: "pending", due_date: "2026-10-03T12:00:00+00:00", scheduled_for: null, ...over });

describe("the hold for want of cash", () => {
  it("is the marker the cards read, so a held payable says what it waits for", () => {
    expect(heldForCash({ execution: { heldBecause: HELD_FOR_CASH } })).toBe(true);
  });
});

describe("what today's payments need", () => {
  it("counts payables due today or overdue, and those scheduled for today, in USDC", async () => {
    const client = fake({
      invoices: [
        invoice(),
        invoice({ due_date: "2026-10-01T00:00:00+00:00", amount: "1" }),
        invoice({ status: "scheduled", scheduled_for: "2026-10-03", due_date: "2026-10-09", amount: "2" }),
        invoice({ status: "scheduled", scheduled_for: "2026-10-05", amount: "50" }),
        invoice({ due_date: "2026-10-04T00:00:00+00:00", amount: "40" }),
        invoice({ currency: "EURC", amount: "30" }),
      ],
    });
    expect(await run(client, () => payablesDueToday(db(), "2026-10-03"))).toEqual({ total: 3.2, count: 3 });
    const asked = client.requests.find((r) => r.path === "/rest/v1/invoices")!;
    expect(asked.params.get("direction")).toBe("eq.payable");
    expect(asked.params.get("status")).toBe("in.(pending,scheduled)");
  });
});

describe("the cycle's liquidity step (R3)", () => {
  const step = (client: ReturnType<typeof fakeSupabase>, provider: ChainProvider, over: Partial<Parameters<typeof bringCashForTodaysPayments>[0]> = {}) =>
    run(client, () =>
      bringCashForTodaysPayments({
        db: db(),
        provider,
        operatingAccountId: "operating-1",
        reserveAccountId: "reserve-1",
        operatingBalance: 0.119389,
        reserveBalance: 60.691351,
        moveKey: "cycle-1/liquidity",
        today: "2026-10-03",
        ...over,
      })
    );

  it("brings back what today's payments need beyond the operating wallet, before they are decided, and records it", async () => {
    const provider = new ReserveProvider();
    const client = fake({ invoices: [invoice({ amount: "0.35" }), invoice({ amount: "0.21" })] });

    const moved = await step(client, provider);

    expect(provider.withdrawCalls).toEqual([{ accountId: "operating-1", reserveAccountId: "reserve-1", key: "cycle-1/liquidity/redeem_from_usyc", amount: 0.440611 }]);
    expect(moved).toEqual({ operatingBalance: 0.56, line: { domain: "treasury", message: "brought 0.440611 USDC back from the reserve for 2 payments due today" } });
    const action = client.requests.find((r) => r.path === "/rest/v1/treasury_actions" && r.method === "POST")!;
    expect(action.body).toMatchObject({ action: "redeem_from_usyc", amount: 0.440611, from_account: "reserve-1", to_account: "operating-1" });
    expect(appendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: "agent",
        domain: "treasury",
        action: "cash_brought_back",
        summary: "Brought 0.440611 USDC back from the reserve for payments due today",
        detail: expect.objectContaining({ reason: "payments_due_today", amount: 0.440611, neededUsdc: 0.56, payments: 2, executed: true }),
      })
    );
    // Not a decision: the ledger entry carries no `decision`, so /open never counts it as one.
    expect(appendMock.mock.calls[0][0].detail).not.toHaveProperty("decision");
  });

  it.each<[string, Parameters<typeof fake>[0], Partial<Parameters<typeof bringCashForTodaysPayments>[0]>]>([
    ["nothing is due today", { invoices: [invoice({ due_date: "2026-10-09T00:00:00+00:00" })] }, {}],
    ["the operating wallet covers it", { invoices: [invoice({ amount: "0.10" })] }, {}],
    ["the reserve is empty", { invoices: [invoice()] }, { reserveBalance: 0 }],
  ])("moves nothing when %s", async (_label, options, over) => {
    const provider = new ReserveProvider();
    const client = fake(options);
    expect(await step(client, provider, over)).toBeNull();
    expect(provider.withdrawCalls).toEqual([]);
    expect(appendMock).not.toHaveBeenCalled();
  });

  it("brings back no more than the reserve holds", async () => {
    const provider = new ReserveProvider();
    const client = fake({ invoices: [invoice({ amount: "100" })] });
    const moved = await step(client, provider);
    expect(provider.withdrawCalls[0].amount).toBe(60.691351);
    expect(moved?.operatingBalance).toBe(60.81074);
  });

  it("moves nothing while the agent is paused, and says so", async () => {
    const provider = new ReserveProvider();
    const client = fake({ invoices: [invoice()], paused: true });
    const moved = await step(client, provider);
    expect(provider.withdrawCalls).toEqual([]);
    expect(moved?.line.message).toMatch(/^cash back for today's payments not moved/);
    expect(appendMock.mock.calls[0][0]).toMatchObject({ summary: "Could not bring 0.080611 USDC back from the reserve for payments due today", detail: { executed: false, heldBecause: "agent_paused" } });
  });
});

describe("a person's Bring cash back (R2)", () => {
  it("brings everything back when no amount is asked, even while the agent is paused, and records who did", async () => {
    const provider = new ReserveProvider();
    const client = fake({ paused: true });

    const result = await run(client, () => bringCashBackByPerson({ actorId: USER, amount: null, provider }));

    expect(result).toEqual({ amount: 60.691351, execution: null });
    expect(provider.withdrawCalls[0]).toMatchObject({ amount: 60.691351, accountId: "operating-1", reserveAccountId: "reserve-1" });
    expect(provider.withdrawCalls[0].key).toMatch(/^cash-back\/[0-9a-f-]{36}\/redeem_from_usyc$/);
    expect(client.requests.some((r) => r.path === "/rest/v1/rpc/agent_paused")).toBe(false);
    expect(bestEffortMock).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ actor: "human", domain: "treasury", action: "cash_brought_back", summary: "Brought 60.691351 USDC back from the reserve", detail: expect.objectContaining({ by: USER, reason: "person", all: true }) })
    );
  });

  it("brings back the amount asked", async () => {
    const provider = new ReserveProvider();
    expect((await run(fake(), () => bringCashBackByPerson({ actorId: USER, amount: 5, provider }))).amount).toBe(5);
    expect(provider.withdrawCalls[0].amount).toBe(5);
  });

  it.each([
    ["more than the reserve holds", { amount: 100 }, "too_much", "The reserve holds 60.691351 USDC; bring back that much or less."],
    ["from an empty reserve", { amount: null, accounts: [{ id: "operating-1", kind: "operating", balance: "1" }, { id: "reserve-1", kind: "reserve", balance: "0" }] }, "empty", "The reserve holds nothing to bring back."],
    ["with no reserve", { amount: null, accounts: [{ id: "operating-1", kind: "operating", balance: "1" }] }, "no_reserve", "This workspace has no reserve to bring cash back from."],
  ] as const)("refuses to bring back %s, moving nothing", async (_label, options, code, message) => {
    const provider = new ReserveProvider();
    const client = fake({ accounts: "accounts" in options ? [...options.accounts] : undefined });
    await expect(run(client, () => bringCashBackByPerson({ actorId: USER, amount: options.amount, provider }))).rejects.toEqual(new CashBackError(code, message));
    expect(provider.withdrawCalls).toEqual([]);
  });
});
