import { describe, expect, it } from "vitest";
import { configFromEnv, walletTreasuryAvailable } from "@/lib/config";
import { runWithConfig } from "@/lib/context";
import { networkRpcUrl } from "@/lib/circle/arcFees";
import { ARC_MAINNET, ARC_TESTNET } from "@/lib/network";

/**
 * Where a workspace may pay from its owner's own wallet (docs/superpowers/specs/2026-10-07-wallet-treasury-design.md
 * W2, W4): Arc mainnet, on a deployment holding Vestiarion's agent account there, a production key and its secret.
 */

const ENV = { NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" };

describe("the wallet treasury's availability", () => {
  it("is offered on Arc mainnet only", () => {
    expect(ARC_MAINNET.walletTreasury).toBe(true);
    expect(ARC_TESTNET.walletTreasury).toBe(false);
  });

  it("needs the agent account's live key and its secret", () => {
    const both = configFromEnv({ ...ENV, MAINNET_AGENT_CIRCLE_API_KEY: "LIVE_API_KEY:a:b", MAINNET_AGENT_CIRCLE_ENTITY_SECRET: "s" });
    expect(both.chain.mainnetAgentCircleApiKey).toBe("LIVE_API_KEY:a:b");
    expect(both.chain.mainnetAgentCircleEntitySecret).toBe("s");
    expect(walletTreasuryAvailable(both, ARC_MAINNET)).toBe(true);
    expect(walletTreasuryAvailable(both, ARC_TESTNET)).toBe(false);
    const testKey = configFromEnv({ ...ENV, MAINNET_AGENT_CIRCLE_API_KEY: "TEST_API_KEY:a:b", MAINNET_AGENT_CIRCLE_ENTITY_SECRET: "s" });
    expect(walletTreasuryAvailable(testKey, ARC_MAINNET)).toBe(false);
    expect(walletTreasuryAvailable(configFromEnv({ ...ENV, MAINNET_AGENT_CIRCLE_API_KEY: "LIVE_API_KEY:a:b" }), ARC_MAINNET)).toBe(false);
    expect(walletTreasuryAvailable(configFromEnv(ENV), ARC_MAINNET)).toBe(false);
  });
});

describe("the RPC a network is read over", () => {
  it("is ARC_MAINNET_RPC_URL for Arc mainnet when set, and never Arc testnet's override", () => {
    const keyed = configFromEnv({ ...ENV, ARC_RPC_URL: "https://testnet-keyed.example", ARC_MAINNET_RPC_URL: "https://keyed.example/arc" });
    expect(runWithConfig(keyed, () => networkRpcUrl(ARC_MAINNET))).toBe("https://keyed.example/arc");
    expect(runWithConfig(keyed, () => networkRpcUrl(ARC_TESTNET))).toBe("https://testnet-keyed.example");
    const plain = configFromEnv({ ...ENV, ARC_RPC_URL: "https://testnet-keyed.example" });
    expect(runWithConfig(plain, () => networkRpcUrl(ARC_MAINNET))).toBe("https://rpc.mainnet.arc.io");
  });
});
