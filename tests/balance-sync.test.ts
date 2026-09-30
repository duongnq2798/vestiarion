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
 * stage keeps its ledger lines by mapping over the result (`reconcileLines`),
 * and those lines must not change: the parity tests below run the stage body
 * as it was before the extraction, copied verbatim, against the same fake
 * chain and database, and compare the lines byte for byte.
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

/** The accounts table behind the fake wire: GET answers the rows, PATCH succeeds unless `failPatchFor` names the account. */
function accountsFake(rows: Row[], failPatchFor?: string) {
  return fakeSupabase((request: RecordedRequest): FakeReply => {
    if (request.path !== "/rest/v1/accounts") return { body: [] };
    if (request.method === "GET") return { body: rows };
    if (request.method === "PATCH" && failPatchFor && request.params.get("id") === `eq.${failPatchFor}`) {
      return { status: 400, body: { message: "permission denied for table accounts", code: "42501" } };
    }
    return { body: [] };
  });
}

function inScope<T>(fake: ReturnType<typeof fakeSupabase>, fn: () => Promise<T>): Promise<T> {
  return runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn);
}

const patches = (requests: RecordedRequest[]) =>
  requests
    .filter((r) => r.path === "/rest/v1/accounts" && r.method === "PATCH")
    .map((r) => ({ id: r.params.get("id"), body: r.body as Record<string, unknown> }));

const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0));

/** The reconcile stage's body before the extraction, verbatim but for its inputs: the reference the lines are held to. */
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

describe("syncOnChainBalances", () => {
  it("carves the notional reserve out of the operating wallet only, and reports the change with its note", async () => {
    const fake = accountsFake([OPERATING, RESERVE, PAYROLL]);
    const chain = new FakeChain({ "acct-op": 150, "acct-pay": 20 });

    const sync = await inScope(fake, () => syncOnChainBalances(chain, db()));

    expect(chain.reads).toEqual(["acct-op", "acct-pay"]);
    expect(sync.changes).toEqual([
      { accountId: "acct-op", name: "Operating", from: 100, to: 120, note: "on-chain 150 less 30 notional reserve" },
      { accountId: "acct-pay", name: "Payroll", from: 12.5, to: 20, note: null },
    ]);
    expect(sync.failures).toEqual([]);
    expect(patches(fake.requests)).toEqual([
      { id: "eq.acct-op", body: { balance: 120, balance_synced_at: sync.syncedAt } },
      { id: "eq.acct-pay", body: { balance: 20, balance_synced_at: sync.syncedAt } },
    ]);
  });

  it("carves nothing out when the USYC leg is live", async () => {
    const fake = accountsFake([OPERATING, RESERVE]);
    const sync = await inScope(fake, () => syncOnChainBalances(new FakeChain({ "acct-op": 150 }, "live"), db()));
    expect(sync.changes).toEqual([{ accountId: "acct-op", name: "Operating", from: 100, to: 150, note: null }]);
  });

  it("writes balance_synced_at even when the balance did not change, and leaves the balance alone", async () => {
    const fake = accountsFake([OPERATING, RESERVE]);
    const sync = await inScope(fake, () => syncOnChainBalances(new FakeChain({ "acct-op": 130 }), db()));

    expect(sync.changes).toEqual([]);
    expect(sync.failures).toEqual([]);
    expect(Number.isNaN(Date.parse(sync.syncedAt))).toBe(false);
    expect(patches(fake.requests)).toEqual([{ id: "eq.acct-op", body: { balance_synced_at: sync.syncedAt } }]);
  });

  it("records a per-account failure and carries on with the next account", async () => {
    const fake = accountsFake([OPERATING, RESERVE, PAYROLL]);
    const chain = new FakeChain({ "acct-op": new Error("no answer from Circle getWalletTokenBalance within 15000 ms"), "acct-pay": 20 });

    const sync = await inScope(fake, () => syncOnChainBalances(chain, db()));

    expect(sync.failures).toEqual([
      { accountId: "acct-op", name: "Operating", message: "no answer from Circle getWalletTokenBalance within 15000 ms" },
    ]);
    expect(sync.changes.map((change) => change.name)).toEqual(["Payroll"]);
    // The failed account is not marked as synced.
    expect(patches(fake.requests).map((patch) => patch.id)).toEqual(["eq.acct-pay"]);
  });

  it("counts a write the database refused as that account's failure", async () => {
    const fake = accountsFake([OPERATING, RESERVE], "acct-op");
    const sync = await inScope(fake, () => syncOnChainBalances(new FakeChain({ "acct-op": 150 }), db()));
    expect(sync.changes).toEqual([]);
    expect(sync.failures).toEqual([{ accountId: "acct-op", name: "Operating", message: "permission denied for table accounts" }]);
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

describe("the reconcile stage's lines — unchanged by the extraction", () => {
  const scenarios: Array<{ name: string; rows: Row[]; balances: Record<string, number | Error>; earnMode?: "simulate" | "live"; failPatchFor?: string }> = [
    { name: "a change with the notional carve-out", rows: [OPERATING, RESERVE, PAYROLL], balances: { "acct-op": 150, "acct-pay": 12.5 } },
    { name: "nothing changed", rows: [OPERATING, RESERVE], balances: { "acct-op": 130 } },
    { name: "a failure before a change", rows: [OPERATING, RESERVE, PAYROLL], balances: { "acct-op": new Error("Circle is down"), "acct-pay": 3 } },
    { name: "a change before a failure", rows: [PAYROLL, OPERATING, RESERVE], balances: { "acct-pay": 3, "acct-op": new Error("Circle is down") } },
    { name: "an account with no wallet", rows: [OPERATING, RESERVE, BRIDGE], balances: { "acct-op": 90 } },
    { name: "a reserve larger than the wallet", rows: [{ ...OPERATING, balance: "5" }, { ...RESERVE, balance: "3000" }], balances: { "acct-op": 20 } },
    { name: "the USYC leg live", rows: [OPERATING, RESERVE], balances: { "acct-op": 150 }, earnMode: "live" },
    { name: "a refused write", rows: [OPERATING, RESERVE], balances: { "acct-op": 150 }, failPatchFor: "acct-op" },
    { name: "no reserve row", rows: [OPERATING], balances: { "acct-op": 101.25 } },
  ];

  it.each(scenarios)("$name", async ({ rows, balances, earnMode, failPatchFor }) => {
    const before: CycleLogLine[] = [];
    await inScope(accountsFake(rows, failPatchFor), () => legacyReconcile(new FakeChain(balances, earnMode), db(), before));

    const sync = await inScope(accountsFake(rows, failPatchFor), () => syncOnChainBalances(new FakeChain(balances, earnMode), db()));

    expect(reconcileLines(sync)).toEqual(before);
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
