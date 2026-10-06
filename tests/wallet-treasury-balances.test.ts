import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import type { BalanceSnapshot, ChainProvider } from "@/lib/circle";
import { ARC_MAINNET } from "@/lib/network";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * The operating balance of a workspace paying from its owner's own wallet (docs/superpowers/specs/2026-10-07-wallet-
 * treasury-design.md W12): what the agent can move, with nothing set aside, since the agent's own wallet pays the gas
 * and there is no reserve. The account has the owner's address and no Circle wallet.
 */

const external = {
  network: ARC_MAINNET,
  mode: "live",
  earnMode: "simulate",
  treasury: "external",
  estimatedFeeUsd: 0.01,
  getBalance: vi.fn(async (accountId: string): Promise<BalanceSnapshot> => ({ accountId, chain: "ARC", token: "USDC", balance: 5 })),
} as unknown as ChainProvider;

vi.mock("@/lib/circle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/circle")>()),
  getChainProvider: () => external,
}));

import { syncOperatingBalance } from "@/lib/agent/pay";
import { syncOnChainBalances } from "@/lib/agent/balances";

const base = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const config = { ...base, network: "arc-mainnet" as const, chain: { ...base.chain, walletHost: "external" as const } };
const OPERATING = { id: "acct-op", name: "Operating", kind: "operating", balance: "0", circle_wallet_id: null, address: "0x5af3107a4000000000000000000000000000b0b0" };

function accountsFake() {
  return fakeSupabase((request: RecordedRequest): FakeReply => {
    if (request.path !== "/rest/v1/accounts") return { body: [] };
    if (request.method === "GET") return { body: [OPERATING] };
    if (request.method === "PATCH" && request.params.get("select") === "id") return { body: [{ id: OPERATING.id }] };
    return { body: [] };
  });
}

describe("the operating balance of a wallet treasury", () => {
  it("keeps nothing aside for gas, and reads no reserve", async () => {
    const fake = accountsFake();
    const balance = await runWith(orgTestContext({ config, client: fake.client, orgId: "org-own-wallet" }), () => syncOperatingBalance("acct-op"));
    expect(balance).toBe(5);
    expect(fake.requests.find((request) => request.method === "PATCH")?.body).toEqual({ balance: 5 });
    expect(fake.requests.some((request) => request.method === "GET" && request.params.get("kind") === "eq.reserve")).toBe(false);
  });

  it("is read for the operating account the owner's address stands for, though it has no Circle wallet", async () => {
    const fake = accountsFake();
    const sync = await runWith(orgTestContext({ config, client: fake.client, orgId: "org-own-wallet" }), () =>
      syncOnChainBalances(external, db(), { walletsOnly: true, compareAndSet: true })
    );
    expect(sync.failures).toEqual([]);
    const written = fake.requests.filter((request) => request.method === "PATCH" && "balance" in ((request.body as Record<string, unknown>) ?? {}));
    expect(written.map((request) => (request.body as { balance: number }).balance)).toEqual([5]);
  });
});

describe("the console's refresh of a wallet treasury", () => {
  it("reads the owner's wallet, though its operating account has no Circle wallet", async () => {
    const { refreshOnChainBalances } = await import("@/lib/agent/balances");
    const fake = fakeSupabase((request: RecordedRequest): FakeReply => {
      if (request.path === "/rest/v1/cycle_runs") return { body: [] };
      if (request.path !== "/rest/v1/accounts") return { body: [] };
      if (request.method === "GET") return { body: [{ ...OPERATING, balance_synced_at: null }] };
      if (request.method === "PATCH" && request.params.get("select") === "id") return { body: [{ id: OPERATING.id }] };
      return { body: [] };
    });
    // Live, as a workspace paying from its owner's wallet is: its provider is built from the agent pair.
    const live = { ...config, chain: { ...config.chain, circleApiKey: "LIVE_API_KEY:a:b", circleEntitySecret: "secret" } };
    const refreshed = await runWith(orgTestContext({ config: live, client: fake.client, orgId: "org-own-wallet" }), () => refreshOnChainBalances());
    expect(refreshed.reason).not.toBe("no_wallet");
    expect(refreshed.refreshed).toBe(true);
  });
});
