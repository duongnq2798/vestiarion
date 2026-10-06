import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { ARC_MAINNET } from "@/lib/network";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

/**
 * An EOA pays its own gas in USDC (docs/superpowers/specs/2026-10-06-mainnet-go-live-design.md M6): the operating
 * balance people and the agent spend from keeps the network's gas reserve aside. The provider is a stand-in for a
 * live one on Arc mainnet, which reads the wallet's 42 USDC.
 */

vi.mock("@/lib/circle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/circle")>()),
  getChainProvider: () => ({
    network: ARC_MAINNET,
    mode: "live",
    earnMode: "simulate",
    getBalance: async (accountId: string) => ({ accountId, chain: "ARC", token: "USDC", balance: 42 }),
  }),
}));

import { syncOperatingBalance } from "@/lib/agent/pay";

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

describe("syncOperatingBalance on a network whose wallets pay their own gas (mainnet go-live M6)", () => {
  it("keeps the gas reserve aside", async () => {
    const fake = fakeSupabase(() => ({ body: [] }));
    const balance = await runWith(orgTestContext({ config: { ...config, network: "arc-mainnet" }, client: fake.client, orgId: "org-gas" }), () =>
      syncOperatingBalance("account-operating")
    );
    expect(balance).toBe(41.9);
    const write = fake.requests.find((request) => request.method === "PATCH" && request.path === "/rest/v1/accounts");
    expect(write?.body).toEqual({ balance: 41.9 });
  });
});
