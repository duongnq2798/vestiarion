import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db, unwrap, type OrgDb } from "@/lib/dal";
import { liveOperatingBalance, syncOnChainBalances } from "@/lib/agent/balances";
import { reconcileLines, type CycleLogLine } from "@/lib/agent/orchestrator";
import type { BalanceSnapshot, ChainProvider, EarnResult, TransferResult } from "@/lib/circle";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * `syncOnChainBalances` is the reconcile stage's balance read, pulled out of
 * `runAgentCycle()` so the console's balance tile can run the same read. The
 * stage must write exactly what it wrote before the extraction: the parity
 * tests below run the stage body as it was, copied verbatim, against the same
 * fake chain and database, and compare both the ledger lines and every
 * balance write, byte for byte. The one addition, `balance_synced_at`, is a
 * separate best-effort write after the balances, which never throws and never
 * adds a line.
 */

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000b0b";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

interface Row { id: string; name: string; kind: string; balance: string; circle_wallet_id: string | null }

const OPERATING: Row = { id: "acct-op", name: "Operating", kind: "operating", balance: "100.000000", circle_wallet_id: "w-op" };
const RESERVE: Row = { id: "acct-res", name: "USYC reserve", kind: "reserve", balance: "30.000000", circle_wallet_id: null };
const PAYROLL: Row = { id: "acct-pay", name: "Payroll", kind: "chain", balance: "12.500000", circle_wallet_id: "w-pay" };
const BRIDGE: Row = { id: "acct-br", name: "Bridge", kind: "chain", balance: "0.000000", circle_wallet_id: null };

class FakeChain implements ChainProvider {
  readonly mode = "live" as const;
  readonly estimatedFeeUsd = 0.01;
  readonly reads: string[] = [];
  constructor(private readonly balances: Record<string, number | Error>, readonly earnMode: "simulate" | "live" = "simulate") {}
  async getBalance(accountId: string): Promise<BalanceSnapshot> {
    this.reads.push(accountId);
    const answer = this.balances[accountId];
    if (answer instanceof Error) throw answer;
    if (answer === undefined) throw new Error(`Account ${accountId} has no Circle wallet. Create the treasury wallets in Settings → Go live.`);
    return { accountId, chain: "ARC-TESTNET", token: "USDC", balance: answer };
  }
  async transfer(): Promise<TransferResult> { throw new Error("not used"); }
  async reconcileTransfer(): Promise<TransferResult> { throw new Error("not used"); }
  async depositToEarn(): Promise<EarnResult> { throw new Error("not used"); }
  async withdrawFromEarn(): Promise<EarnResult> { throw new Error("not used"); }
}

const isAccountPatch = (r: RecordedRequest) => r.path === "/rest/v1/accounts" && r.method === "PATCH";
const touchesSyncedAt = (r: RecordedRequest) => Object.keys((r.body as Record<string, unknown>) ?? {}).includes("balance_synced_at");

interface FakeOptions {
  /** A PATCH the database refuses, as PostgREST would: a 400 with its message. */
  refuse?: (request: RecordedRequest) => boolean;
  /** What a compare-and-set PATCH (one that asks for `select=id`) matches: its rows, or none. */
  casMatches?: (request: RecordedRequest) => boolean;
  /** The reserve's balance when it is read again, for the compare-and-set's re-check. */
  reserveNow?: string;
}

/** The accounts table behind the fake wire. */
function accountsFake(rows: Row[], options: FakeOptions = {}) {
  return fakeSupabase((request: RecordedRequest): FakeReply => {
    if (request.path !== "/rest/v1/accounts") return { body: [] };
    if (request.method === "GET") {
      if (request.params.get("kind") === "eq.reserve") {
        const reserve = rows.find((row) => row.kind === "reserve");
        return { body: reserve ? [{ balance: options.reserveNow ?? reserve.balance }] : [] };
      }
      return { body: rows };
    }
    if (request.method === "PATCH" && options.refuse?.(request)) {
      return { status: 400, body: { message: "Could not find the 'balance_synced_at' column of 'accounts' in the schema cache", code: "PGRST204" } };
    }
    if (request.method === "PATCH" && request.params.get("select") === "id") {
      const id = request.params.get("id")?.replace(/^eq\./, "");
      return { body: (options.casMatches ?? (() => true))(request) ? [{ id }] : [] };
    }
    return { body: [] };
  });
}

function inScope<T>(fake: ReturnType<typeof fakeSupabase>, fn: () => Promise<T>): Promise<T> {
  return runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn);
}

/** Each PATCH to accounts as PostgREST receives it: its filters and its body. */
const patchesOf = (requests: RecordedRequest[]) =>
  requests.filter(isAccountPatch).map((r) => ({ query: r.params.toString(), body: r.body as Record<string, unknown> }));
const balancePatches = (requests: RecordedRequest[]) => patchesOf(requests.filter((r) => !touchesSyncedAt(r)));
const syncedAtPatches = (requests: RecordedRequest[]) =>
  requests.filter((r) => isAccountPatch(r) && touchesSyncedAt(r)).map((r) => ({ id: r.params.get("id"), body: r.body }));

const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0));

/** The reconcile stage's body before the extraction, verbatim but for its inputs: the reference the stage is held to. */
async function legacyReconcile(provider: ChainProvider, orgDb: OrgDb, lines: CycleLogLine[]): Promise<void> {
  if (provider.mode === "live") {
    const rows = unwrap(
      await orgDb.from("accounts").select("id, name, kind, balance")
    ) as Array<{ id: string; name: string; kind: string; balance: string }>;

    const notionalReserve =
      provider.earnMode === "simulate"
        ? num(rows.find((a) => a.kind === "reserve")?.balance)
        : 0;

    for (const account of rows.filter((a) => a.kind !== "reserve")) {
      try {
        const snapshot = await provider.getBalance(account.id);
        const { spendable, reserve: carveOut } = liveOperatingBalance(
          snapshot.balance,
          account.kind === "operating" ? notionalReserve : 0
        );
        const stored = num(account.balance);
        if (Math.abs(spendable - stored) < 0.000001) continue;

        const res = await orgDb
          .from("accounts")
          .update({ balance: spendable })
          .eq("id", account.id);
        if (res.error) throw new Error(res.error.message);

        const note = carveOut > 0 ? ` (on-chain ${snapshot.balance} less ${carveOut} notional reserve)` : "";
        lines.push({
          domain: "treasury",
          message: `Reconciled ${account.name}: ${stored} → ${spendable} USDC${note}`,
        });
      } catch (err) {
        lines.push({
          domain: "treasury",
          message: `Could not reconcile ${account.name}: ${(err as Error).message}`,
        });
      }
    }
  }
}

describe("syncOnChainBalances — the cycle's path", () => {
  it("carves the notional reserve out of the operating wallet only, and writes each changed balance alone", async () => {
    const fake = accountsFake([OPERATING, RESERVE, PAYROLL]);
    const chain = new FakeChain({ "acct-op": 150, "acct-pay": 20 });

    const sync = await inScope(fake, () => syncOnChainBalances(chain, db()));

    expect(chain.reads).toEqual(["acct-op", "acct-pay"]);
    expect(sync.changes).toEqual([
      { accountId: "acct-op", name: "Operating", from: 100, to: 120, note: "on-chain 150 less 30 notional reserve" },
      { accountId: "acct-pay", name: "Payroll", from: 12.5, to: 20, note: null },
    ]);
    expect(sync.failures).toEqual([]);
    const writes = fake.requests.filter((r) => isAccountPatch(r) && !touchesSyncedAt(r));
    expect(writes.map((r) => ({ id: r.params.get("id"), balance: r.params.get("balance"), body: r.body }))).toEqual([
      { id: "eq.acct-op", balance: null, body: { balance: 120 } },
      { id: "eq.acct-pay", balance: null, body: { balance: 20 } },
    ]);
  });

  it("carves nothing out when the USYC leg is live", async () => {
    const fake = accountsFake([OPERATING, RESERVE]);
    const sync = await inScope(fake, () => syncOnChainBalances(new FakeChain({ "acct-op": 150 }, "live"), db()));
    expect(sync.changes).toEqual([{ accountId: "acct-op", name: "Operating", from: 100, to: 150, note: null }]);
  });

  it("records balance_synced_at in one separate write, after the balances, for every account read — changed or not", async () => {
    const fake = accountsFake([OPERATING, RESERVE, PAYROLL]);
    const sync = await inScope(fake, () => syncOnChainBalances(new FakeChain({ "acct-op": 130, "acct-pay": 20 }), db()));

    expect(Number.isNaN(Date.parse(sync.syncedAt))).toBe(false);
    expect(syncedAtPatches(fake.requests)).toEqual([{ id: "in.(acct-op,acct-pay)", body: { balance_synced_at: sync.syncedAt } }]);
    const patches = fake.requests.filter(isAccountPatch);
    expect(touchesSyncedAt(patches[patches.length - 1])).toBe(true);
  });

  it("writes no balance when it did not change", async () => {
    const fake = accountsFake([OPERATING, RESERVE]);
    const sync = await inScope(fake, () => syncOnChainBalances(new FakeChain({ "acct-op": 130 }), db()));
    expect(sync.changes).toEqual([]);
    expect(balancePatches(fake.requests)).toEqual([]);
  });

  it("treats a refused balance_synced_at write as nothing: no throw, no failure, the balances still written", async () => {
    const fake = accountsFake([OPERATING, RESERVE], { refuse: touchesSyncedAt });
    const sync = await inScope(fake, () => syncOnChainBalances(new FakeChain({ "acct-op": 150 }), db()));

    expect(sync.failures).toEqual([]);
    expect(sync.changes.map((change) => change.to)).toEqual([120]);
    expect(reconcileLines(sync)).toEqual([
      { domain: "treasury", message: "Reconciled Operating: 100 → 120 USDC (on-chain 150 less 30 notional reserve)" },
    ]);
  });

  it("records a per-account failure, carries on with the next account, and does not mark the failed one synced", async () => {
    const fake = accountsFake([OPERATING, RESERVE, PAYROLL]);
    const chain = new FakeChain({ "acct-op": new Error("no answer from Circle getWalletTokenBalance within 15000 ms"), "acct-pay": 20 });

    const sync = await inScope(fake, () => syncOnChainBalances(chain, db()));

    expect(sync.failures).toEqual([
      { accountId: "acct-op", name: "Operating", message: "no answer from Circle getWalletTokenBalance within 15000 ms" },
    ]);
    expect(sync.changes.map((change) => change.name)).toEqual(["Payroll"]);
    expect(syncedAtPatches(fake.requests).map((patch) => patch.id)).toEqual(["in.(acct-pay)"]);
  });

  it("counts a balance write the database refused as that account's failure", async () => {
    const fake = accountsFake([OPERATING, RESERVE], { refuse: (r) => !touchesSyncedAt(r) });
    const sync = await inScope(fake, () => syncOnChainBalances(new FakeChain({ "acct-op": 150 }), db()));
    expect(sync.changes).toEqual([]);
    expect(sync.failures.map((failure) => failure.name)).toEqual(["Operating"]);
    expect(syncedAtPatches(fake.requests)).toEqual([]);
  });

  it("asks the chain about every non-reserve account by default, and only those with a wallet when told to", async () => {
    const everyAccount = new FakeChain({ "acct-op": 130 });
    const sync = await inScope(accountsFake([OPERATING, RESERVE, BRIDGE]), () => syncOnChainBalances(everyAccount, db()));
    expect(everyAccount.reads).toEqual(["acct-op", "acct-br"]);
    expect(sync.failures.map((failure) => failure.name)).toEqual(["Bridge"]);

    const walletsOnly = new FakeChain({ "acct-op": 130 });
    const scoped = await inScope(accountsFake([OPERATING, RESERVE, BRIDGE]), () =>
      syncOnChainBalances(walletsOnly, db(), { walletsOnly: true })
    );
    expect(walletsOnly.reads).toEqual(["acct-op"]);
    expect(scoped.failures).toEqual([]);
  });
});

describe("syncOnChainBalances — compare-and-set, for the console's refresh", () => {
  it("writes a changed balance only while it still holds the value that was read", async () => {
    const fake = accountsFake([OPERATING, RESERVE]);
    const sync = await inScope(fake, () => syncOnChainBalances(new FakeChain({ "acct-op": 150 }), db(), { compareAndSet: true }));

    const [write] = fake.requests.filter((r) => isAccountPatch(r) && !touchesSyncedAt(r));
    expect(write.body).toEqual({ balance: 120 });
    expect(write.params.get("id")).toBe("eq.acct-op");
    expect(write.params.get("balance")).toBe("eq.100.000000");
    expect(write.params.get("select")).toBe("id");
    expect(sync.changes.map((change) => change.to)).toEqual([120]);
  });

  it("keeps what a concurrent writer wrote when the compare-and-set matches nothing, and does not mark it synced", async () => {
    const fake = accountsFake([OPERATING, RESERVE], { casMatches: () => false });
    const sync = await inScope(fake, () => syncOnChainBalances(new FakeChain({ "acct-op": 150 }), db(), { compareAndSet: true }));

    expect(sync.changes).toEqual([]);
    expect(sync.failures).toEqual([]);
    expect(sync.outcomes).toEqual([{ kind: "superseded", accountId: "acct-op", name: "Operating" }]);
    expect(syncedAtPatches(fake.requests)).toEqual([]);
  });

  it("skips the write when the reserve it carved out has changed since it was read", async () => {
    const fake = accountsFake([OPERATING, RESERVE], { reserveNow: "50.000000" });
    const sync = await inScope(fake, () => syncOnChainBalances(new FakeChain({ "acct-op": 150 }), db(), { compareAndSet: true }));

    expect(balancePatches(fake.requests)).toEqual([]);
    expect(sync.outcomes).toEqual([{ kind: "superseded", accountId: "acct-op", name: "Operating" }]);
  });

  it("writes when the reserve is unchanged", async () => {
    const fake = accountsFake([OPERATING, RESERVE], { reserveNow: "30.000000" });
    const sync = await inScope(fake, () => syncOnChainBalances(new FakeChain({ "acct-op": 150 }), db(), { compareAndSet: true }));
    expect(sync.changes.map((change) => change.to)).toEqual([120]);
  });

  it("never re-reads the reserve on the cycle's path", async () => {
    const fake = accountsFake([OPERATING, RESERVE], { reserveNow: "50.000000" });
    await inScope(fake, () => syncOnChainBalances(new FakeChain({ "acct-op": 150 }), db()));
    expect(fake.requests.filter((r) => r.method === "GET")).toHaveLength(1);
  });
});

describe("the reconcile stage — unchanged by the extraction, in its lines and in its balance writes", () => {
  const scenarios: Array<{ name: string; rows: Row[]; balances: Record<string, number | Error>; earnMode?: "simulate" | "live"; refuse?: FakeOptions["refuse"] }> = [
    { name: "a change with the notional carve-out", rows: [OPERATING, RESERVE, PAYROLL], balances: { "acct-op": 150, "acct-pay": 12.5 } },
    { name: "nothing changed", rows: [OPERATING, RESERVE], balances: { "acct-op": 130 } },
    { name: "a failure before a change", rows: [OPERATING, RESERVE, PAYROLL], balances: { "acct-op": new Error("Circle is down"), "acct-pay": 3 } },
    { name: "a change before a failure", rows: [PAYROLL, OPERATING, RESERVE], balances: { "acct-pay": 3, "acct-op": new Error("Circle is down") } },
    { name: "an account with no wallet", rows: [OPERATING, RESERVE, BRIDGE], balances: { "acct-op": 90 } },
    { name: "a reserve larger than the wallet", rows: [{ ...OPERATING, balance: "5" }, { ...RESERVE, balance: "3000" }], balances: { "acct-op": 20 } },
    { name: "the USYC leg live", rows: [OPERATING, RESERVE], balances: { "acct-op": 150 }, earnMode: "live" },
    { name: "a refused balance write", rows: [OPERATING, RESERVE], balances: { "acct-op": 150 }, refuse: () => true },
    { name: "an unchanged balance while every write is refused", rows: [OPERATING, RESERVE], balances: { "acct-op": 130 }, refuse: () => true },
    { name: "a change while the balance_synced_at column is missing", rows: [OPERATING, RESERVE, PAYROLL], balances: { "acct-op": 150, "acct-pay": 20 }, refuse: touchesSyncedAt },
    { name: "no change while the balance_synced_at column is missing", rows: [OPERATING, RESERVE], balances: { "acct-op": 130 }, refuse: touchesSyncedAt },
    { name: "no reserve row", rows: [OPERATING], balances: { "acct-op": 101.25 } },
  ];

  it.each(scenarios)("$name", async ({ rows, balances, earnMode, refuse }) => {
    const before: CycleLogLine[] = [];
    const legacyFake = accountsFake(rows, { refuse });
    await inScope(legacyFake, () => legacyReconcile(new FakeChain(balances, earnMode), db(), before));

    const fake = accountsFake(rows, { refuse });
    const sync = await inScope(fake, () => syncOnChainBalances(new FakeChain(balances, earnMode), db()));

    expect(reconcileLines(sync)).toEqual(before);
    expect(balancePatches(fake.requests)).toEqual(patchesOf(legacyFake.requests));
  });

  it("writes the lines the stage always wrote", async () => {
    const sync = await inScope(accountsFake([OPERATING, RESERVE, PAYROLL]), () =>
      syncOnChainBalances(new FakeChain({ "acct-op": 150, "acct-pay": new Error("Circle is down") }), db())
    );
    expect(reconcileLines(sync)).toEqual([
      { domain: "treasury", message: "Reconciled Operating: 100 → 120 USDC (on-chain 150 less 30 notional reserve)" },
      { domain: "treasury", message: "Could not reconcile Payroll: Circle is down" },
    ]);
  });
});

describe("syncOnChainBalances — a real USYC reserve (USYC live design R3)", () => {
  const LIVE_RESERVE: Row = { id: "acct-res", name: "USYC reserve", kind: "reserve", balance: "30.000000", circle_wallet_id: "w-res" };
  class UsycChain extends FakeChain {
    constructor(private readonly position: { shares: number; valueUsdc: number; price: number; apy?: number | null } | Error) {
      super({ "acct-op": 150 }, "live");
    }
    async getEarnPosition() {
      if (this.position instanceof Error) throw this.position;
      return this.position;
    }
  }

  it("writes the reserve's balance from its USYC at the oracle's price, and names both in the line", async () => {
    const fake = accountsFake([OPERATING, LIVE_RESERVE]);
    const sync = await inScope(fake, () => syncOnChainBalances(new UsycChain({ shares: 30, valueUsdc: 34.166935, price: 1.138897, apy: 0.0345 }), db()));
    // The fund's real yield replaces the configured one, so a sweep is priced at it.
    expect(patchesOf(fake.requests)).toContainEqual({ query: `org_id=eq.${ORG}&id=eq.acct-res`, body: { apy: 0.0345 } });
    expect(balancePatches(fake.requests)).toContainEqual({ query: `org_id=eq.${ORG}&id=eq.acct-res&select=id`, body: { balance: 34.166935 } });
    // The operating wallet's USDC is all spendable: nothing is carved out for a real reserve.
    expect(balancePatches(fake.requests)).toContainEqual({ query: `org_id=eq.${ORG}&id=eq.acct-op`, body: { balance: 150 } });
    expect(sync.changes).toContainEqual({ accountId: "acct-res", name: "USYC reserve", from: 30, to: 34.166935, note: "30 USYC at 1.138897 USDC" });
  });

  it("records a reserve it could not read as a failure, and leaves its balance as it was", async () => {
    const fake = accountsFake([OPERATING, LIVE_RESERVE]);
    const sync = await inScope(fake, () => syncOnChainBalances(new UsycChain(new Error("Arc testnet did not answer a USYC read")), db()));
    expect(sync.failures).toContainEqual({ accountId: "acct-res", name: "USYC reserve", message: "Arc testnet did not answer a USYC read" });
    expect(balancePatches(fake.requests).some((p) => p.query.includes("acct-res"))).toBe(false);
  });

  it("reads no position for a simulated reserve", async () => {
    const fake = accountsFake([OPERATING, LIVE_RESERVE]);
    const chain = new FakeChain({ "acct-op": 150 }, "simulate") as FakeChain & { getEarnPosition?: () => never };
    chain.getEarnPosition = () => {
      throw new Error("a simulated reserve has no position");
    };
    const sync = await inScope(fake, () => syncOnChainBalances(chain, db()));
    expect(sync.failures).toEqual([]);
  });
});
