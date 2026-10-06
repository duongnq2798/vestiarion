import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith, runWithConfig } from "@/lib/context";
import { networkRpcUrl } from "@/lib/circle/arcFees";
import { bridgeFee, cctpOf } from "@/lib/circle/cctp";
import { estimateGateway, gatewayOf } from "@/lib/circle/gateway";
import { readUsycPrice, usycOf } from "@/lib/circle/usyc";
import { SimulateProvider } from "@/lib/circle/simulateProvider";
import { quoteEurcInUsdc } from "@/lib/fx/quote";
import { quoteUsdcForEurc } from "@/lib/fx/swap-service";
import { counterpartyChainProblem } from "@/lib/intake-validation";
import { ARC_MAINNET } from "@/lib/network";
import { passkeyWalletOffered } from "@/lib/passkey-wallet";
import { addressUrl, chainOn, chainsOn, homeChain, txUrl } from "@/lib/payee-chains";
import { buildReceipt } from "@/lib/receipts/facts";
import { readOnChain } from "@/lib/receipts/onchain";
import { workspaceNetwork } from "@/lib/workspace-network";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";
import { chainModes, getChainProvider } from "@/lib/circle";
import { BatchNotSentError } from "@/lib/circle/batch";
import { setUpEscrow } from "@/lib/circle/escrow-setup";
import { enforceSpendingLimit } from "@/lib/circle/spending-limit-setup";
import { stablecoinEntry } from "@/lib/circle/stablecoins";
import { MAINNET_NOT_CONNECTED, MAINNET_NOT_LIVE } from "@/lib/mainnet";
import { forgetPaymentsSwitch, paymentsHold } from "@/lib/payments-switch";

/**
 * The mainnet dry run (docs/superpowers/specs/2026-10-05-network-threading-design.md P9): the modules built with Arc
 * mainnet's profile, with Circle and the RPC faked, each asking for mainnet's facts or refusing by name. N3 still keeps
 * a mainnet workspace from paying; this proves what phase 2 will find once it does not.
 */

const PAYEE = "0x840de234Bfc3F66fA380888A0a8204D9487D60d4";
const HASH = `0x${"ab".repeat(32)}`;
const noRequest = (() => {
  throw new Error("no request expected");
}) as unknown as typeof globalThis.fetch;
const BASE = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k", ARC_RPC_URL: "https://keyed.example/rpc" });

describe("a workspace on Arc mainnet", () => {
  it("reads its own profile in its scope", () => {
    const { client } = fakeSupabase();
    expect(runWith(orgTestContext({ config: { ...BASE, network: "arc-mainnet" }, client, orgId: "org-main" }), () => workspaceNetwork())).toBe(ARC_MAINNET);
  });

  it("reads mainnet's RPC, which ARC_RPC_URL does not replace", () => {
    expect(runWithConfig(BASE, () => networkRpcUrl(ARC_MAINNET))).toBe("https://rpc.mainnet.arc.io");
  });

  it("pays its own chain, ARC, and no Sepolia chain", () => {
    expect(homeChain("arc-mainnet").id).toBe("ARC");
    expect(chainsOn("arc-mainnet").map((chain) => chain.id)).toEqual(["ARC"]);
    for (const chain of ["BASE-SEPOLIA", "ARB-SEPOLIA", "ETH-SEPOLIA", "ARC-TESTNET"]) {
      expect(() => chainOn("arc-mainnet", chain)).toThrow(`${chain} is not a chain this workspace pays on`);
      expect(counterpartyChainProblem("arc-mainnet", chain)).toBe(`${chain} is not a chain this workspace pays on`);
    }
  });

  it("settles a simulated transfer on ARC", async () => {
    expect((await new SimulateProvider(ARC_MAINNET).reconcileTransfer("sim-1")).chain).toBe("ARC");
  });

  it("links mainnet's explorer", () => {
    expect(txUrl("arc-mainnet", HASH)).toBe(`https://explorer.arc.io/tx/${HASH}`);
    expect(addressUrl("arc-mainnet", PAYEE)).toBe(`https://explorer.arc.io/address/${PAYEE}`);
  });

  it("refuses by name what mainnet does not offer yet, before any request", async () => {
    expect(() => cctpOf(ARC_MAINNET)).toThrow("Paying through CCTP does not run on Arc mainnet yet");
    expect(() => gatewayOf(ARC_MAINNET)).toThrow("Paying through Gateway does not run on Arc mainnet yet");
    expect(() => usycOf(ARC_MAINNET)).toThrow("The USYC reserve does not run on Arc mainnet yet");
    await expect(bridgeFee(ARC_MAINNET, "ARC", 1, { fetch: noRequest })).rejects.toThrow("Paying through CCTP does not run on Arc mainnet yet");
    await expect(estimateGateway(ARC_MAINNET, { depositor: PAYEE, signer: PAYEE, recipient: PAYEE, chain: "ARC", amount: 1, salt: HASH as `0x${string}` }, { fetch: noRequest })).rejects.toThrow(
      "Paying through Gateway does not run on Arc mainnet yet"
    );
    await expect(readUsycPrice({ network: ARC_MAINNET, rpcUrl: ARC_MAINNET.rpcUrl, fetch: noRequest })).rejects.toThrow("The USYC reserve does not run on Arc mainnet yet");
    await expect(quoteUsdcForEurc(1, { network: ARC_MAINNET, fromAddress: PAYEE, fetch: noRequest })).rejects.toThrow("The EURC swap does not run on Arc mainnet yet");
    await expect(quoteEurcInUsdc(1, { network: ARC_MAINNET, fromAddress: PAYEE, fetch: noRequest })).rejects.toThrow("The EURC swap does not run on Arc mainnet yet");
    expect(passkeyWalletOffered("ARC", { clientKey: "TEST_CLIENT_KEY:k", clientUrl: "https://modular-sdk.circle.com/v1/rpc/w3s/buidl" })).toBe(false);
  });

  it("keeps a payment's receipt on ARC, read from mainnet's RPC with no scope", async () => {
    const built = buildReceipt({
      invoice: { id: "inv-1", status: "paid", direction: "payable" },
      intent: {
        status: "confirmed", provider_mode: "live", token: "USDC", amount: 1, destination: PAYEE, tx_hash: HASH, chain: null, destination_chain: null,
        mint_tx_hash: null, bridge_fee: null, payout_route: null, confirmed_at: "2026-10-06T00:00:00Z", network: "arc-mainnet",
      },
      entries: [{ seq: 1, ts: "2026-10-06T00:00:01Z", hash: `0x${"cd".repeat(32)}`, action: "ap_pay", detail: { invoiceId: "inv-1", txHash: HASH } }] as never,
    });
    if (!built.ok) throw new Error(built.reason);
    expect(built.facts.chain).toBe("ARC");
    const asked: string[] = [];
    const fetch = (async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }));
    }) as unknown as typeof globalThis.fetch;
    await readOnChain(built.facts, { fetch });
    expect(asked).toEqual(["https://rpc.mainnet.arc.io"]);
  });
});

/**
 * The mainnet path with the switch on (docs/superpowers/specs/2026-10-06-mainnet-go-live-design.md): a workspace on Arc
 * mainnet is held until it is live, with a provider that refuses every send, EOA wallets that pay their own gas, its
 * USDC chosen by contract, and what mainnet leaves out refused by name. Circle and the database are faked.
 */
describe("a workspace on Arc mainnet with the switch on (mainnet go-live)", () => {
  const MAINNET = { ...BASE, mainnetEnabled: true, network: "arc-mainnet" as const };
  const connected = { ...MAINNET.chain, circleApiKey: "LIVE_API_KEY:k", circleEntitySecret: "s" };
  const scope = <T>(chain: typeof MAINNET.chain, fn: () => Promise<T> | T) => {
    forgetPaymentsSwitch();
    const { client } = fakeSupabase(() => ({ body: null }));
    return runWith(orgTestContext({ config: { ...MAINNET, chain }, client, orgId: "org-main" }), fn);
  };
  const TRANSFER = { fromAccountId: "op", toAddress: PAYEE, amount: 1, memo: "m", idempotencyKey: "k" };

  it("is held until live, with a provider on mainnet's profile that refuses every send", async () => {
    await scope({ ...connected, networkHold: MAINNET_NOT_LIVE }, async () => {
      expect(await paymentsHold()).toBe(MAINNET_NOT_LIVE);
      const provider = getChainProvider();
      expect(provider.network).toBe(ARC_MAINNET);
      await expect(provider.transfer(TRANSFER)).rejects.toThrow(MAINNET_NOT_LIVE);
      expect(workspaceNetwork().walletAccountType).toBe("EOA");
    });
  });

  it("gets no provider before its Circle account is connected, and its pages still read", async () => {
    await scope({ ...MAINNET.chain, networkHold: MAINNET_NOT_LIVE }, () => {
      expect(() => getChainProvider()).toThrow(MAINNET_NOT_CONNECTED);
      expect(chainModes()).toEqual({ mode: "simulate", earnMode: "simulate" });
    });
  });

  it("once live, still refuses what mainnet leaves out, by name, before any request", async () => {
    await scope(connected, async () => {
      const provider = getChainProvider();
      const batch = provider.batchTransfer!({ fromAccountId: "op", transfers: [{ toAddress: PAYEE, amount: 1 }, { toAddress: PAYEE, amount: 2 }], idempotencyKey: "b" });
      await expect(batch).rejects.toBeInstanceOf(BatchNotSentError);
      await expect(batch).rejects.toThrow("Paying in one batch does not run on Arc mainnet yet");
      await expect(provider.depositToEarn({ accountId: "op", amount: 1 })).rejects.toThrow("The USYC reserve does not run on Arc mainnet yet");
      await expect(setUpEscrow({ actorId: "user-1" })).rejects.toThrow("Escrow does not run on Arc mainnet yet");
      await expect(enforceSpendingLimit({ actorId: "user-1" })).rejects.toThrow("Enforcing the spending limit in a contract does not run on Arc mainnet yet");
    });
  });

  it("knows its USDC by contract: the ERC-20 at 0x3600… or the native token, never a token named USDC", () => {
    const balances = [
      { token: { id: "spoof", symbol: "USDC", tokenAddress: "0x1111111111111111111111111111111111111111", isNative: false } },
      { token: { id: "usdc", symbol: "USDC", tokenAddress: ARC_MAINNET.tokens.USDC, isNative: false } },
    ];
    expect(stablecoinEntry(balances, "USDC", ARC_MAINNET)?.token.id).toBe("usdc");
  });
});
