import { ArcTestnet } from "@circle-fin/app-kit/chains";
import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith, runWithConfig } from "@/lib/context";
import { networkRpcUrl, rpcUrlFor } from "@/lib/circle/arcFees";
import { ARC_MAINNET, ARC_TESTNET, FeatureOffError } from "@/lib/network";
import { addressUrl, chainById, ChainNotOnNetworkError, chainOn, chainsOn, homeChain, networkOfChain, paidAcrossChains, txUrl } from "@/lib/payee-chains";
import { workspaceNetwork } from "@/lib/workspace-network";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

/**
 * Every chain fact in its network's profile, and the helpers that read it
 * (docs/superpowers/specs/2026-10-05-network-threading-design.md P1–P3, P5, P6).
 */

const BASE = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

describe("each network's payee chains (P3)", () => {
  it("lists Arc testnet's own chain, then the three Sepolia chains CCTP and Gateway pay, with today's facts", () => {
    expect(ARC_TESTNET.payeeChains).toEqual([
      { id: "ARC-TESTNET", label: "Arc testnet", domain: 26, usdc: "0x3600000000000000000000000000000000000000", rpcUrl: "https://rpc.testnet.arc.network", explorerTx: "https://explorer.testnet.arc.io/tx/", nativeUsdc: "0xfffffffffffffffffffffffffffffffffffffffe" },
      { id: "BASE-SEPOLIA", label: "Base Sepolia", domain: 6, usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", rpcUrl: "https://sepolia.base.org", explorerTx: "https://sepolia.basescan.org/tx/" },
      { id: "ARB-SEPOLIA", label: "Arbitrum Sepolia", domain: 3, usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc", explorerTx: "https://sepolia.arbiscan.io/tx/" },
      { id: "ETH-SEPOLIA", label: "Ethereum Sepolia", domain: 0, usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com", explorerTx: "https://sepolia.etherscan.io/tx/" },
    ]);
  });

  it("lists Arc mainnet's own chain alone, with no CCTP domain until it is verified there, and its native USDC emitter (mainnet limits L5)", () => {
    expect(ARC_MAINNET.payeeChains).toEqual([
      {
        id: "ARC",
        label: "Arc mainnet",
        domain: null,
        usdc: "0x3600000000000000000000000000000000000000",
        rpcUrl: "https://rpc.mainnet.arc.io",
        explorerTx: "https://explorer.arc.io/tx/",
        nativeUsdc: "0xfffffffffffffffffffffffffffffffffffffffe",
      },
    ]);
  });

  it("keeps the swap's adapter equal to Circle's App Kit, since it is the spender the swap approves (Review Focus 4)", () => {
    expect(ARC_TESTNET.swapAdapter).toBe(ArcTestnet.kitContracts.adapter);
    expect(ARC_MAINNET.swapAdapter).toBeNull();
  });

  it("names a feature a network lacks", () => {
    expect(new FeatureOffError("Paying through CCTP", ARC_MAINNET).message).toBe("Paying through CCTP does not run on Arc mainnet yet");
  });
});

describe("a chain on a network (P3)", () => {
  it("reads no chain as the network's own, and a chain by its id (Review Focus 2)", () => {
    expect(homeChain("arc-testnet").id).toBe("ARC-TESTNET");
    expect(homeChain("arc-mainnet").id).toBe("ARC");
    expect(chainOn("arc-testnet", null)).toBe(ARC_TESTNET.payeeChains[0]);
    expect(chainOn("arc-mainnet", undefined)).toBe(ARC_MAINNET.payeeChains[0]);
    expect(chainOn("arc-testnet", "BASE-SEPOLIA").domain).toBe(6);
    expect(chainsOn("arc-mainnet").map((chain) => chain.id)).toEqual(["ARC"]);
  });

  it("refuses a chain from another network, or one no network lists, in plain words (Review Focus 3)", () => {
    expect(() => chainOn("arc-testnet", "ARC")).toThrow(ChainNotOnNetworkError);
    expect(() => chainOn("arc-testnet", "ARC")).toThrow("ARC is not a chain this workspace pays on");
    expect(() => chainOn("arc-mainnet", "ARB-SEPOLIA")).toThrow("ARB-SEPOLIA is not a chain this workspace pays on");
    expect(() => chainOn("arc-testnet", "SOL-DEVNET")).toThrow("SOL-DEVNET is not a chain this workspace pays on");
  });

  it("finds the network a chain is on, since each chain is on one network's list", () => {
    expect(networkOfChain("ARC-TESTNET")).toBe("arc-testnet");
    expect(networkOfChain("ETH-SEPOLIA")).toBe("arc-testnet");
    expect(networkOfChain("ARC")).toBe("arc-mainnet");
    expect(chainById("ARB-SEPOLIA").usdc).toBe("0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d");
    expect(() => networkOfChain("SOL-DEVNET")).toThrow('"SOL-DEVNET" is not a chain Vestiarion knows');
  });

  it("pays each network's own chain directly and the others across chains", () => {
    expect(paidAcrossChains(null)).toBe(false);
    expect(paidAcrossChains("ARC-TESTNET")).toBe(false);
    expect(paidAcrossChains("ARC")).toBe(false);
    expect(paidAcrossChains("BASE-SEPOLIA")).toBe(true);
    expect(() => paidAcrossChains("SOL-DEVNET")).toThrow('"SOL-DEVNET" is not a chain Vestiarion knows');
  });
});

describe("a link names its network (P6)", () => {
  it("opens that network's explorer", () => {
    expect(txUrl("arc-testnet", "0xabc")).toBe("https://explorer.testnet.arc.io/tx/0xabc");
    expect(txUrl("arc-mainnet", "0xabc")).toBe("https://explorer.arc.io/tx/0xabc");
    expect(addressUrl("arc-testnet", "0xdef")).toBe("https://explorer.testnet.arc.io/address/0xdef");
    expect(addressUrl("arc-mainnet", "0xdef")).toBe("https://explorer.arc.io/address/0xdef");
  });
});

describe("the workspace's network (P1)", () => {
  it("is the profile of the workspace in scope, Arc testnet for a row from before 0075", () => {
    const { client } = fakeSupabase();
    expect(runWith(orgTestContext({ config: { ...BASE, network: "arc-mainnet" }, client, orgId: "org-1" }), () => workspaceNetwork())).toBe(ARC_MAINNET);
    expect(runWith(orgTestContext({ config: BASE, client, orgId: "org-1" }), () => workspaceNetwork())).toBe(ARC_TESTNET);
  });

  it("throws outside a workspace's scope rather than assume Arc testnet", () => {
    expect(() => runWithConfig(BASE, () => workspaceNetwork())).toThrow();
  });
});

describe("a network's RPC (P2)", () => {
  it("lets ARC_RPC_URL replace Arc testnet's, and nothing replace another network's", () => {
    expect(rpcUrlFor(ARC_TESTNET, "https://keyed.example/rpc")).toBe("https://keyed.example/rpc");
    expect(rpcUrlFor(ARC_TESTNET, undefined)).toBe("https://rpc.testnet.arc.network");
    expect(rpcUrlFor(ARC_MAINNET, "https://keyed.example/rpc")).toBe("https://rpc.mainnet.arc.io");
    const keyed = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k", ARC_RPC_URL: "https://keyed.example/rpc" });
    expect(runWithConfig(keyed, () => networkRpcUrl(ARC_TESTNET))).toBe("https://keyed.example/rpc");
    expect(runWithConfig(keyed, () => networkRpcUrl(ARC_MAINNET))).toBe("https://rpc.mainnet.arc.io");
  });
});
