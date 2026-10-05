import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { BalanceSnapshot, ChainProvider, EarnResult, TransferResult } from "@/lib/circle";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * `refreshOnChainBalances` is what the console's balance tile asks for when
 * it mounts: the reconcile stage's balance read, outside a cycle. It calls
 * Circle only when payments are live, the operating account holds a wallet,
 * the last read is more than 30 seconds old, no cycle is running, and it won
 * the claim on the operating account; its writes are compare-and-set, so a
 * concurrent writer is never overwritten; and it never hands back an error
 * of Circle's, only a fixed sentence.
 */

const { chainModesMock, getChainProviderMock } = vi.hoisted(() => ({
  chainModesMock: vi.fn(),
  getChainProviderMock: vi.fn(),
}));
vi.mock("@/lib/circle", () => ({ chainModes: chainModesMock, getChainProvider: getChainProviderMock }));

import { BALANCE_REFRESH_COOLDOWN_MS, CIRCLE_UNREACHABLE, refreshOnChainBalances } from "@/lib/agent/balances";
import { ARC_TESTNET } from "@/lib/network";

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c0c";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const NOW = Date.parse("2026-09-30T12:00:00.000Z");

interface Row {
  id: string; name: string; kind: string; balance: string; circle_wallet_id: string | null;
  balance_synced_at: string | null; balance_refresh_claimed_at: string | null;
}

const operating = (overrides: Partial<Row> = {}): Row => ({
  id: "acct-op", name: "Operating", kind: "operating", balance: "100.000000", circle_wallet_id: "w-op",
  balance_synced_at: null, balance_refresh_claimed_at: null, ...overrides,
});
const reserve = (): Row => ({
  id: "acct-res", name: "USYC reserve", kind: "reserve", balance: "30.000000", circle_wallet_id: null, balance_synced_at: null, balance_refresh_claimed_at: null,
});
const bridge = (): Row => ({
  id: "acct-br", name: "Bridge", kind: "chain", balance: "5.000000", circle_wallet_id: null, balance_synced_at: null, balance_refresh_claimed_at: null,
});

class FakeChain implements ChainProvider {
  readonly network = ARC_TESTNET;
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

const ids = (filter: string | null): string[] =>
  !filter ? [] : filter.startsWith("eq.") ? [filter.slice(3)] : filter.replace(/^in\.\(|\)$/g, "").split(",");

/**
 * The accounts and cycle_runs tables behind the fake wire, with state: a PATCH
 * changes the rows it matches, honouring the compare-and-set (`balance=eq.`)
 * and the claim's `or` filter the way PostgREST would.
 */
function database(rows: Row[], options: { runningCycle?: boolean; beforeWrite?: (rows: Row[]) => void } = {}) {
  const fake = fakeSupabase((request: RecordedRequest): FakeReply => {
    if (request.path === "/rest/v1/cycle_runs") {
      return { body: options.runningCycle ? [{ id: "run-1" }] : [] };
    }
    if (request.path !== "/rest/v1/accounts") return { body: [] };
    if (request.method === "GET") {
      const kind = request.params.get("kind");
      return { body: kind ? rows.filter((row) => `eq.${row.kind}` === kind) : rows };
    }
    if (request.method === "PATCH") {
      const body = request.body as Partial<Row> & { balance?: number };
      if (body.balance !== undefined) options.beforeWrite?.(rows);
      const expectedBalance = request.params.get("balance");
      const claim = request.params.get("or");
      const cutoff = claim ? Date.parse(claim.replace(/.*\.lt\./, "").replace(/\)$/, "")) : null;
      const matched = rows.filter((row) =>
        ids(request.params.get("id")).includes(row.id) &&
        (!expectedBalance || expectedBalance === `eq.${row.balance}`) &&
        (cutoff === null || row.balance_refresh_claimed_at === null || Date.parse(row.balance_refresh_claimed_at) < cutoff)
      );
      for (const row of matched) {
        Object.assign(row, body, body.balance !== undefined ? { balance: Number(body.balance).toFixed(6) } : {});
      }
      return { body: request.params.get("select") ? matched.map((row) => ({ id: row.id })) : [] };
    }
    return { body: [] };
  });
  return fake;
}

function run<T>(fake: ReturnType<typeof fakeSupabase>, fn: () => Promise<T>): Promise<T> {
  return runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn);
}

const balanceOf = (value: number) => async (accountId: string): Promise<BalanceSnapshot> => ({ accountId, chain: "ARC-TESTNET", token: "USDC", balance: value });
const balanceWrites = (requests: RecordedRequest[]) =>
  requests.filter((r) => r.method === "PATCH" && (r.body as Record<string, unknown>).balance !== undefined);

describe("refreshOnChainBalances", () => {
  it("reads the chain, writes the balance, and answers with the non-reserve total and the time of the read", async () => {
    chain.getBalance.mockImplementation(balanceOf(150));
    const rows = [operating(), reserve()];
    const fake = database(rows);

    const answer = await run(fake, () => refreshOnChainBalances({ now: NOW }));

    expect(chain.getBalance).toHaveBeenCalledTimes(1);
    expect(answer.refreshed).toBe(true);
    expect(answer.balance).toBe(120);
    expect(answer.syncedAt).not.toBeNull();
    expect(rows[0].balance).toBe("120.000000");
    expect(rows[0].balance_synced_at).toBe(answer.syncedAt);
  });

  it("does not call Circle within 30 seconds of the last read, and answers with the stored figures", async () => {
    const syncedAt = new Date(NOW - BALANCE_REFRESH_COOLDOWN_MS + 1_000).toISOString();
    const fake = database([operating({ balance_synced_at: syncedAt }), reserve(), bridge()]);

    expect(await run(fake, () => refreshOnChainBalances({ now: NOW }))).toEqual({ refreshed: false, reason: "cooldown", balance: 105, syncedAt });
    expect(chain.getBalance).not.toHaveBeenCalled();
    expect(getChainProviderMock).not.toHaveBeenCalled();
    expect(fake.requests.some((r) => r.method === "PATCH")).toBe(false);
  });

  it("calls Circle again once the 30 seconds have passed", async () => {
    chain.getBalance.mockImplementation(balanceOf(130));
    const syncedAt = new Date(NOW - BALANCE_REFRESH_COOLDOWN_MS - 1).toISOString();
    const answer = await run(database([operating({ balance_synced_at: syncedAt }), reserve()]), () => refreshOnChainBalances({ now: NOW }));

    expect(chain.getBalance).toHaveBeenCalledTimes(1);
    expect(answer.refreshed).toBe(true);
    expect(answer.syncedAt).not.toBe(syncedAt);
  });

  it("makes no Circle call when payments are simulated", async () => {
    chainModesMock.mockReturnValue({ mode: "simulate", earnMode: "simulate" });
    const answer = await run(database([operating(), reserve()]), () => refreshOnChainBalances({ now: NOW }));

    expect(answer).toEqual({ refreshed: false, reason: "not_live", balance: 100, syncedAt: null });
    expect(getChainProviderMock).not.toHaveBeenCalled();
    expect(chain.getBalance).not.toHaveBeenCalled();
  });

  it("makes no Circle call when the operating account has no wallet", async () => {
    const answer = await run(database([operating({ circle_wallet_id: null }), reserve()]), () => refreshOnChainBalances({ now: NOW }));

    expect(answer).toEqual({ refreshed: false, reason: "no_wallet", balance: 100, syncedAt: null });
    expect(getChainProviderMock).not.toHaveBeenCalled();
    expect(chain.getBalance).not.toHaveBeenCalled();
  });

  it("makes no Circle call while a cycle is running, and answers from the database", async () => {
    const fake = database([operating(), reserve()], { runningCycle: true });

    const answer = await run(fake, () => refreshOnChainBalances({ now: NOW }));

    expect(answer).toEqual({ refreshed: false, reason: "cycle_running", balance: 100, syncedAt: null });
    expect(chain.getBalance).not.toHaveBeenCalled();
    const [runs] = fake.requests.filter((r) => r.path === "/rest/v1/cycle_runs");
    expect(runs.params.get("status")).toBe("eq.running");
    expect(runs.params.get("started_at")).toBe(`gt.${new Date(NOW - 15 * 60_000).toISOString()}`);
    expect(fake.requests.some((r) => r.method === "PATCH")).toBe(false);
  });

  it("claims the operating account before calling Circle, only while no claim is 30 seconds fresh", async () => {
    chain.getBalance.mockImplementation(balanceOf(130));
    const fake = database([operating(), reserve()]);

    await run(fake, () => refreshOnChainBalances({ now: NOW }));

    const [claim] = fake.requests.filter((r) => r.method === "PATCH");
    expect(claim.body).toEqual({ balance_refresh_claimed_at: new Date(NOW).toISOString() });
    expect(claim.params.get("id")).toBe("eq.acct-op");
    expect(claim.params.get("or")).toBe(
      `(balance_refresh_claimed_at.is.null,balance_refresh_claimed_at.lt.${new Date(NOW - BALANCE_REFRESH_COOLDOWN_MS).toISOString()})`
    );
    expect(claim.params.get("select")).toBe("id");
  });

  it("answers from the database when another request holds the claim: one Circle call between two tabs", async () => {
    chain.getBalance.mockImplementation(balanceOf(130));
    const rows = [operating(), reserve()];

    const first = await run(database(rows), () => refreshOnChainBalances({ now: NOW }));
    const second = await run(database(rows), () => refreshOnChainBalances({ now: NOW + 1_000 }));

    expect(chain.getBalance).toHaveBeenCalledTimes(1);
    expect(first.refreshed).toBe(true);
    expect(second).toMatchObject({ refreshed: false, reason: "cooldown", balance: 100 });
  });

  it("backs off after a failed read too: the claim holds for 30 seconds", async () => {
    chain.getBalance.mockRejectedValue(new Error("no answer"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const rows = [operating(), reserve()];

    const first = await run(database(rows), () => refreshOnChainBalances({ now: NOW }));
    const second = await run(database(rows), () => refreshOnChainBalances({ now: NOW + 5_000 }));
    const third = await run(database(rows), () => refreshOnChainBalances({ now: NOW + BALANCE_REFRESH_COOLDOWN_MS + 1 }));

    expect(first.reason).toBe("unavailable");
    expect(second.reason).toBe("cooldown");
    expect(third.reason).toBe("unavailable");
    expect(chain.getBalance).toHaveBeenCalledTimes(2);
    vi.mocked(console.error).mockRestore();
  });

  it("never overwrites a balance a concurrent writer changed, and answers with the database's value", async () => {
    chain.getBalance.mockImplementation(balanceOf(150));
    const rows = [operating(), reserve()];
    // A cycle pays 40 out between this refresh's read of the table and its write.
    const fake = database(rows, { beforeWrite: (current) => { current[0].balance = "60.000000"; } });

    const answer = await run(fake, () => refreshOnChainBalances({ now: NOW }));

    expect(rows[0].balance).toBe("60.000000");
    expect(answer.balance).toBe(60);
    const [write] = balanceWrites(fake.requests);
    expect(write.params.get("balance")).toBe("eq.100.000000");
  });

  it("asks only about accounts that hold a wallet", async () => {
    chain.getBalance.mockImplementation(balanceOf(130));
    const answer = await run(database([operating(), reserve(), bridge()]), () => refreshOnChainBalances({ now: NOW }));

    expect(chain.getBalance.mock.calls.map(([id]) => id)).toEqual(["acct-op"]);
    expect(answer).toMatchObject({ refreshed: true, balance: 105 });
  });

  it("answers a Circle failure with a fixed sentence, never Circle's own error, and logs none of it", async () => {
    const secret = "Request failed with status 401: invalid entity secret 5f3c…";
    chain.getBalance.mockRejectedValue(new Error(secret));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const previous = new Date(NOW - 10 * 60_000).toISOString();
    const fake = database([operating({ balance_synced_at: previous }), reserve()]);

    const answer = await run(fake, () => refreshOnChainBalances({ now: NOW }));

    expect(answer).toEqual({ refreshed: false, reason: "unavailable", message: CIRCLE_UNREACHABLE, balance: 100, syncedAt: previous });
    expect(CIRCLE_UNREACHABLE).toBe("Could not reach Circle; showing the last known balance");
    expect(JSON.stringify(answer)).not.toContain("entity secret");
    expect(JSON.stringify(logged.mock.calls)).not.toContain("entity secret");
    expect(balanceWrites(fake.requests)).toEqual([]);
    logged.mockRestore();
  });

  it("answers the same fixed sentence when the provider cannot even be built", async () => {
    getChainProviderMock.mockImplementation(() => {
      throw new Error("This organization's Circle credentials are stored but could not be read (wrong master key)");
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const answer = await run(database([operating(), reserve()]), () => refreshOnChainBalances({ now: NOW }));

    expect(answer).toEqual({ refreshed: false, reason: "unavailable", message: CIRCLE_UNREACHABLE, balance: 100, syncedAt: null });
    expect(JSON.stringify(logged.mock.calls)).not.toContain("master key");
    logged.mockRestore();
  });

  it("refuses outside an organization's scope", async () => {
    await expect(runWith({ config, db: fakeSupabase().client }, () => refreshOnChainBalances({ now: NOW }))).rejects.toThrow();
  });
});
