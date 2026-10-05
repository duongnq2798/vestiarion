import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BalanceSnapshot, ChainProvider, EarnDepositParams, EarnResult, TransferResult } from "@/lib/circle";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import {
  bringCashBackByPerson,
  bringCashForApproval,
  bringCashForTodaysPayments,
  CashBackError,
  HELD_FOR_CASH,
  milestonesToRelease,
  payablesDueToday,
  cctpFeeCushion,
  recentPersonCashBack,
  reserveCover,
} from "@/lib/agent/liquidity";
import { heldForCash } from "@/lib/next-step";
import { UsycNotConfirmedError } from "@/lib/circle/usyc";
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

function fake(
  options: { invoices?: Array<Record<string, unknown>>; milestones?: Array<Record<string, unknown>>; paused?: boolean; accounts?: Array<Record<string, unknown>> } = {}
) {
  return fakeSupabase((request: RecordedRequest) => {
    if (request.path === "/rest/v1/rpc/agent_paused") return { body: options.paused === true };
    if (request.path === "/rest/v1/invoices") return { body: options.invoices ?? [] };
    if (request.path === "/rest/v1/milestones") return { body: options.milestones ?? [] };
    if (request.path === "/rest/v1/accounts" && request.method === "GET") {
      const rows = options.accounts ?? [{ id: "operating-1", kind: "operating", balance: "0.119389" }, { id: "reserve-1", kind: "reserve", balance: "60.691351" }];
      // One kind asked for is one row, or none.
      const kind = request.params.get("kind")?.replace(/^eq\./, "");
      return { body: kind ? (rows.find((row) => row.kind === kind) ?? null) : rows };
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

  it("counts the verified milestones waiting to be released, but not one whose USDC is in escrow or being locked there", async () => {
    const client = fake({
      milestones: [
        { amount: "0.10", escrow_state: null },
        { amount: "0.25", escrow_state: "refunded" },
        { amount: "5", escrow_state: "funded" },
        { amount: "3", escrow_state: "funding" },
      ],
    });
    expect(await run(client, () => milestonesToRelease(db()))).toEqual({ total: 0.35, count: 2 });
    const asked = client.requests.find((r) => r.path === "/rest/v1/milestones")!;
    expect(asked.params.get("status")).toBe("eq.verified");
    expect(asked.params.get("verified")).toBe("eq.true");
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

  it("brings back what a verified milestone needs too, so the agent can release it rather than hold it for want of cash", async () => {
    const provider = new ReserveProvider();
    const client = fake({ milestones: [{ amount: "0.10", escrow_state: null }] });

    const moved = await step(client, provider, { operatingBalance: 0 });

    expect(provider.withdrawCalls).toEqual([{ accountId: "operating-1", reserveAccountId: "reserve-1", key: "cycle-1/liquidity/redeem_from_usyc", amount: 0.1 }]);
    expect(moved).toEqual({ operatingBalance: 0.1, line: { domain: "treasury", message: "brought 0.10 USDC back from the reserve for 1 payment due today" } });
    expect(appendMock.mock.calls[0][0].detail).toMatchObject({ neededUsdc: 0.1, payments: 1, operatingBalance: 0 });
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

  it("brings nothing back while payments are switched off, before reading an account (payment safety S4)", async () => {
    const provider = new ReserveProvider();
    const client = fake();
    const off = runWith(orgTestContext({ config: { ...config, paymentsDisabled: true }, client: client.client, orgId: ORG, userId: USER }), () =>
      bringCashBackByPerson({ actorId: USER, amount: null, provider })
    );

    await expect(off).rejects.toThrow("Payments are switched off for every workspace right now.");
    expect(provider.withdrawCalls).toHaveLength(0);
    expect(client.requests.some((request) => request.path === "/rest/v1/accounts")).toBe(false);
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

describe("what the reserve covers of a person's payment (approval cash R1, R2)", () => {
  // testnet-2, 2026-10-05 09:08 UTC: 0.184239 USDC in the operating wallet, 151.8501 USDC in the reserve, a 0.40 USDC bill.
  const operating = { id: "operating-1", kind: "operating", balance: "0.184239" };
  const accounts = [operating, { id: "reserve-1", kind: "reserve", balance: "151.850100" }];

  it("covers what the payment lacks beyond the operating wallet, up to the next micro-USDC", async () => {
    const client = fake({ accounts });
    expect(await run(client, () => reserveCover(db(), { neededUsdc: 0.4, operatingBalance: 0.184239 }))).toEqual({
      cover: { reserveAccountId: "reserve-1", reserveBalance: 151.8501, amount: 0.215761, neededUsdc: 0.4, operatingBalance: 0.184239 },
      reserveBalance: 151.8501,
    });
    // A CCTP payout's fee on top: 0.4 + 0.135342 - 0.184239, without a float leaving it a micro-USDC short.
    expect((await run(client, () => reserveCover(db(), { neededUsdc: 0.535342, operatingBalance: 0.184239 }))).cover?.amount).toBe(0.351103);
    const asked = client.requests.find((r) => r.path === "/rest/v1/accounts")!;
    expect(asked.params.get("kind")).toBe("eq.reserve");
  });

  it("covers a cushion on top when asked, and says how much of it is cushion", async () => {
    // A fifth more of the 0.135342 USDC CCTP fee, which is read again just before the burn (review finding 2).
    expect(cctpFeeCushion(0.135342)).toBe(0.027069);
    const { cover } = await run(fake({ accounts }), () => reserveCover(db(), { neededUsdc: 0.535342, operatingBalance: 0.184239, cushionUsdc: 0.027069 }));
    expect(cover).toEqual({ reserveAccountId: "reserve-1", reserveBalance: 151.8501, amount: 0.378172, neededUsdc: 0.535342, cushionUsdc: 0.027069, operatingBalance: 0.184239 });
  });

  it.each([
    ["the reserve holds less than the payment lacks", [operating, { id: "reserve-1", kind: "reserve", balance: "0.1" }], 0.1],
    ["the reserve is empty", [operating, { id: "reserve-1", kind: "reserve", balance: "0" }], 0],
    ["there is no reserve", [operating], null],
  ])("covers nothing when %s, and says what the reserve holds", async (_label, rows, reserveBalance) => {
    expect(await run(fake({ accounts: rows }), () => reserveCover(db(), { neededUsdc: 0.4, operatingBalance: 0.184239 }))).toEqual({ cover: null, reserveBalance });
  });
});

describe("the redemption a person's payment needs (approval cash R1, R3, R4)", () => {
  const cover = { reserveAccountId: "reserve-1", reserveBalance: 151.8501, amount: 0.215761, neededUsdc: 0.4, operatingBalance: 0.184239 };
  const bring = (client: ReturnType<typeof fakeSupabase>, provider: ChainProvider, source: { type: "invoice" | "milestone"; id: string } = { type: "invoice", id: "inv-1" }) =>
    run(client, () => bringCashForApproval({ actorId: USER, cover, operatingAccountId: "operating-1", provider, source, payee: "Centronex" }));

  it("brings back what the payment lacks now, even while the agent is paused, and records who brought it back and for what", async () => {
    const provider = new ReserveProvider();
    const client = fake({ paused: true });

    expect(await bring(client, provider)).toEqual({ amount: 0.215761, execution: null });

    expect(provider.withdrawCalls).toHaveLength(1);
    expect(provider.withdrawCalls[0]).toMatchObject({ accountId: "operating-1", reserveAccountId: "reserve-1", amount: 0.215761 });
    // One key for this payment, amount and reserve: asking again finds the same redemption at Circle (review finding 1).
    expect(provider.withdrawCalls[0].key).toBe("approval/invoice/inv-1/0.215761/151.8501/redeem_from_usyc");
    expect(client.requests.some((r) => r.path === "/rest/v1/rpc/agent_paused")).toBe(false);
    const action = client.requests.find((r) => r.path === "/rest/v1/treasury_actions" && r.method === "POST")!;
    expect(action.body).toMatchObject({
      action: "redeem_from_usyc",
      amount: 0.215761,
      from_account: "reserve-1",
      to_account: "operating-1",
      reasoning: "A person's approval brought 0.215761 USDC back from the reserve to pay Centronex.",
    });
    expect(bestEffortMock).toHaveBeenCalledWith(ORG, {
      actor: "human",
      domain: "treasury",
      action: "cash_brought_back",
      summary: "Brought 0.215761 USDC back from the reserve to pay Centronex",
      detail: { by: USER, reason: "approval", invoiceId: "inv-1", amount: 0.215761, neededUsdc: 0.4, operatingBalance: 0.184239, reserveBalance: 151.8501, earnMode: "simulate", executed: true },
    });
  });

  it("names the milestone it pays", async () => {
    await bring(fake(), new ReserveProvider(), { type: "milestone", id: "ms-1" });
    expect(bestEffortMock.mock.calls[0][1].detail).toMatchObject({ reason: "approval", milestoneId: "ms-1" });
    expect(bestEffortMock.mock.calls[0][1].detail).not.toHaveProperty("invoiceId");
  });

  it("throws when nothing came back, and records the attempt and why", async () => {
    const provider = new ReserveProvider();
    provider.withdrawFromEarn = async () => {
      throw new Error("redeem failed (FAILED) on Arc testnet");
    };
    const client = fake();

    await expect(bring(client, provider)).rejects.toEqual(new CashBackError("not_moved", "Nothing came back from the reserve: execution failed: redeem failed (FAILED) on Arc testnet."));
    expect(bestEffortMock).toHaveBeenCalledWith(ORG, {
      actor: "human",
      domain: "treasury",
      action: "cash_brought_back",
      summary: "Could not bring 0.215761 USDC back from the reserve to pay Centronex",
      detail: {
        by: USER,
        reason: "approval",
        invoiceId: "inv-1",
        amount: 0.215761,
        neededUsdc: 0.4,
        operatingBalance: 0.184239,
        reserveBalance: 151.8501,
        earnMode: "simulate",
        executed: false,
        executionNote: "execution failed: redeem failed (FAILED) on Arc testnet",
      },
    });
    expect(client.requests.some((r) => r.path === "/rest/v1/treasury_actions")).toBe(false);
  });

  it("says a redemption Arc testnet has not confirmed yet may still land, and asks for the same one again (review finding 1)", async () => {
    const provider = new ReserveProvider();
    provider.withdrawFromEarn = async (params) => {
      provider.withdrawCalls.push(params);
      throw new UsycNotConfirmedError("redeem did not confirm in time on Arc testnet");
    };
    const client = fake();

    await expect(bring(client, provider)).rejects.toEqual(
      new CashBackError(
        "not_confirmed",
        "The reserve's redemption has not confirmed on Arc testnet yet, so nothing was paid. Try again in a minute: once it lands, the cash is in the operating wallet."
      )
    );
    await expect(bring(client, provider)).rejects.toMatchObject({ code: "not_confirmed" });
    // The same payment, amount and reserve: the same redemption at Circle, never a second one.
    expect(provider.withdrawCalls).toHaveLength(2);
    expect(provider.withdrawCalls[1].key).toBe(provider.withdrawCalls[0].key);
    expect(bestEffortMock.mock.calls[0][1]).toMatchObject({ detail: { executed: false, executionNote: "execution failed: redeem did not confirm in time on Arc testnet" } });
  });

  it("records the fee cushion it brought back with a CCTP payout", async () => {
    const withCushion = { ...cover, amount: 0.378172, neededUsdc: 0.535342, cushionUsdc: 0.027069 };
    await run(fake(), () => bringCashForApproval({ actorId: USER, cover: withCushion, operatingAccountId: "operating-1", provider: new ReserveProvider(), source: { type: "invoice", id: "inv-1" }, payee: "STM" }));
    expect(bestEffortMock.mock.calls[0][1].detail).toMatchObject({ amount: 0.378172, neededUsdc: 0.535342, feeCushionUsdc: 0.027069 });
  });

  it("brings nothing back while payments are switched off (payment safety S4)", async () => {
    const provider = new ReserveProvider();
    const client = fake();
    const off = runWith(orgTestContext({ config: { ...config, paymentsDisabled: true }, client: client.client, orgId: ORG, userId: USER }), () =>
      bringCashForApproval({ actorId: USER, cover, operatingAccountId: "operating-1", provider, source: { type: "invoice", id: "inv-1" }, payee: "Centronex" })
    );
    await expect(off).rejects.toThrow("Payments are switched off for every workspace right now.");
    expect(provider.withdrawCalls).toHaveLength(0);
  });
});

describe("a person's cash back the agent leaves alone (approval cash R6)", () => {
  const ledger = (rows: Array<Record<string, unknown>>) => fakeSupabase((request) => (request.path === "/rest/v1/ledger_entries" ? { body: rows } : { body: [] }));
  // testnet-2, 2026-10-05: a person brought 152.21 USDC back at 09:05:30 (#1541); the cycle it started ran at 09:06:07.
  const now = Date.parse("2026-10-05T09:06:07Z");

  it("is the latest Bring cash back by a person within 24 hours, with until when nothing is swept", async () => {
    const client = ledger([{ ts: "2026-10-05T09:05:30.123+00:00", detail: { by: USER, reason: "person", amount: 152.211756, all: true } }]);

    expect(await run(client, () => recentPersonCashBack(db(), now))).toEqual({ amount: 152.211756, at: "2026-10-05T09:05:30.123Z", until: "2026-10-06T09:05:30.123Z" });

    const asked = client.requests.find((r) => r.path === "/rest/v1/ledger_entries")!;
    expect(asked.params.get("action")).toBe("eq.cash_brought_back");
    expect(asked.params.get("actor")).toBe("eq.human");
    // Cash brought back for an approval left with the payment, so only a person's own Bring cash back counts.
    expect(asked.params.get("detail->>reason")).toBe("eq.person");
    expect(asked.params.get("ts")).toBe("gte.2026-10-04T09:06:07.000Z");
    expect(asked.params.get("order")).toBe("seq.desc");
    expect(asked.params.get("limit")).toBe("1");
  });

  it("is null when no person brought cash back within 24 hours", async () => {
    expect(await run(ledger([]), () => recentPersonCashBack(db(), now))).toBeNull();
  });
});
