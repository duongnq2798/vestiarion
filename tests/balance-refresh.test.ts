import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { BalanceSnapshot, ChainProvider, EarnResult, TransferResult } from "@/lib/circle";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * `refreshOnChainBalances` is what the console's balance tile asks for when
 * it mounts: the reconcile stage's balance read, outside a cycle. It calls
 * Circle only when payments are live, the operating account holds a wallet,
 * and the last read is more than 30 seconds old; and it never hands back an
 * error of Circle's, only a fixed sentence.
 */

const { chainModesMock, getChainProviderMock } = vi.hoisted(() => ({
  chainModesMock: vi.fn(),
  getChainProviderMock: vi.fn(),
}));
vi.mock("@/lib/circle", () => ({ chainModes: chainModesMock, getChainProvider: getChainProviderMock }));

import { BALANCE_REFRESH_COOLDOWN_MS, CIRCLE_UNREACHABLE, refreshOnChainBalances } from "@/lib/agent/balances";

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c0c";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const NOW = Date.parse("2026-09-30T12:00:00.000Z");

interface Row { id: string; name: string; kind: string; balance: string; circle_wallet_id: string | null; balance_synced_at: string | null }

const operating = (overrides: Partial<Row> = {}): Row => ({
  id: "acct-op", name: "Operating", kind: "operating", balance: "100.000000", circle_wallet_id: "w-op", balance_synced_at: null, ...overrides,
});
const RESERVE: Row = { id: "acct-res", name: "USYC reserve", kind: "reserve", balance: "30.000000", circle_wallet_id: null, balance_synced_at: null };
const BRIDGE: Row = { id: "acct-br", name: "Bridge", kind: "chain", balance: "5.000000", circle_wallet_id: null, balance_synced_at: null };

class FakeChain implements ChainProvider {
  readonly mode = "live" as const;
  readonly earnMode = "simulate" as const;
  readonly estimatedFeeUsd = 0.01;
  readonly getBalance = vi.fn<(accountId: string) => Promise<BalanceSnapshot>>();
  async transfer(): Promise<TransferResult> { throw new Error("not used"); }
  async reconcileTransfer(): Promise<TransferResult> { throw new Error("not used"); }
  async depositToEarn(): Promise<EarnResult> { throw new Error("not used"); }
  async withdrawFromEarn(): Promise<EarnResult> { throw new Error("not used"); }
}

let chain: FakeChain;
beforeEach(() => {
  vi.clearAllMocks();
  chain = new FakeChain();
  getChainProviderMock.mockReturnValue(chain);
  chainModesMock.mockReturnValue({ mode: "live", earnMode: "simulate" });
});

function run<T>(rows: Row[], fn: () => Promise<T>): { result: Promise<T>; requests: RecordedRequest[] } {
  const fake = fakeSupabase((request): FakeReply => {
    if (request.path === "/rest/v1/accounts" && request.method === "GET") return { body: rows };
    return { body: [] };
  });
  return { result: runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn), requests: fake.requests };
}

const balanceOf = (value: number) => async (accountId: string): Promise<BalanceSnapshot> => ({ accountId, chain: "ARC-TESTNET", token: "USDC", balance: value });

describe("refreshOnChainBalances", () => {
  it("reads the chain, writes the balance, and answers with the non-reserve total and the time of the read", async () => {
    chain.getBalance.mockImplementation(balanceOf(150));
    const { result, requests } = run([operating(), RESERVE], () => refreshOnChainBalances({ now: NOW }));

    const answer = await result;

    expect(chain.getBalance).toHaveBeenCalledTimes(1);
    expect(answer.refreshed).toBe(true);
    expect(answer.balance).toBe(120);
    expect(answer.syncedAt).not.toBeNull();
    const patch = requests.find((r) => r.method === "PATCH");
    expect(patch?.body).toEqual({ balance: 120, balance_synced_at: answer.syncedAt });
  });

  it("does not call Circle within 30 seconds of the last read, and answers with the stored figures", async () => {
    const syncedAt = new Date(NOW - BALANCE_REFRESH_COOLDOWN_MS + 1_000).toISOString();
    const { result, requests } = run([operating({ balance_synced_at: syncedAt }), RESERVE, BRIDGE], () => refreshOnChainBalances({ now: NOW }));

    expect(await result).toEqual({ refreshed: false, reason: "cooldown", balance: 105, syncedAt });
    expect(chain.getBalance).not.toHaveBeenCalled();
    expect(getChainProviderMock).not.toHaveBeenCalled();
    expect(requests.some((r) => r.method === "PATCH")).toBe(false);
  });

  it("calls Circle again once the 30 seconds have passed", async () => {
    chain.getBalance.mockImplementation(balanceOf(130));
    const syncedAt = new Date(NOW - BALANCE_REFRESH_COOLDOWN_MS - 1).toISOString();
    const { result } = run([operating({ balance_synced_at: syncedAt }), RESERVE], () => refreshOnChainBalances({ now: NOW }));

    const answer = await result;
    expect(chain.getBalance).toHaveBeenCalledTimes(1);
    expect(answer.refreshed).toBe(true);
    expect(answer.syncedAt).not.toBe(syncedAt);
  });

  it("makes no Circle call when payments are simulated", async () => {
    chainModesMock.mockReturnValue({ mode: "simulate", earnMode: "simulate" });
    const { result } = run([operating(), RESERVE], () => refreshOnChainBalances({ now: NOW }));

    expect(await result).toEqual({ refreshed: false, reason: "not_live", balance: 100, syncedAt: null });
    expect(getChainProviderMock).not.toHaveBeenCalled();
    expect(chain.getBalance).not.toHaveBeenCalled();
  });

  it("makes no Circle call when the operating account has no wallet", async () => {
    const { result } = run([operating({ circle_wallet_id: null }), RESERVE], () => refreshOnChainBalances({ now: NOW }));

    expect(await result).toEqual({ refreshed: false, reason: "no_wallet", balance: 100, syncedAt: null });
    expect(getChainProviderMock).not.toHaveBeenCalled();
    expect(chain.getBalance).not.toHaveBeenCalled();
  });

  it("asks only about accounts that hold a wallet", async () => {
    chain.getBalance.mockImplementation(balanceOf(130));
    const { result } = run([operating(), RESERVE, BRIDGE], () => refreshOnChainBalances({ now: NOW }));

    const answer = await result;
    expect(chain.getBalance.mock.calls.map(([id]) => id)).toEqual(["acct-op"]);
    expect(answer).toMatchObject({ refreshed: true, balance: 105 });
  });

  it("answers a Circle failure with a fixed sentence, never Circle's own error, and logs none of it", async () => {
    const secret = "Request failed with status 401: invalid entity secret 5f3c…";
    chain.getBalance.mockRejectedValue(new Error(secret));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const previous = new Date(NOW - 10 * 60_000).toISOString();

    const { result, requests } = run([operating({ balance_synced_at: previous }), RESERVE], () => refreshOnChainBalances({ now: NOW }));
    const answer = await result;

    expect(answer).toEqual({ refreshed: false, reason: "unavailable", message: CIRCLE_UNREACHABLE, balance: 100, syncedAt: previous });
    expect(CIRCLE_UNREACHABLE).toBe("Could not reach Circle; showing the last known balance");
    expect(JSON.stringify(answer)).not.toContain("entity secret");
    expect(JSON.stringify(logged.mock.calls)).not.toContain("entity secret");
    expect(requests.some((r) => r.method === "PATCH")).toBe(false);
    logged.mockRestore();
  });

  it("answers the same fixed sentence when the provider cannot even be built", async () => {
    getChainProviderMock.mockImplementation(() => {
      throw new Error("This organization's Circle credentials are stored but could not be read (wrong master key)");
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const { result } = run([operating(), RESERVE], () => refreshOnChainBalances({ now: NOW }));

    expect(await result).toEqual({ refreshed: false, reason: "unavailable", message: CIRCLE_UNREACHABLE, balance: 100, syncedAt: null });
    expect(JSON.stringify(logged.mock.calls)).not.toContain("master key");
    logged.mockRestore();
  });

  it("refuses outside an organization's scope", async () => {
    await expect(runWith({ config, db: fakeSupabase().client }, () => refreshOnChainBalances({ now: NOW }))).rejects.toThrow();
  });
});
