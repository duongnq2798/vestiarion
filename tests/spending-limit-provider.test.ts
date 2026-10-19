import { describe, expect, it, vi } from "vitest";
import { LiveProvider, type LiveProviderClient } from "@/lib/circle/liveProvider";
import type { ChainConfig } from "@/lib/config";
import { PAY_ACROSS_CHAINS_SIGNATURE, PAY_SIGNATURE, spendingLimitRef } from "@/lib/spending-limit/onchain";
import { ARC_MAINNET, ARC_TESTNET } from "@/lib/network";

/**
 * The live provider paying through the workspace's spending limit contract
 * (docs/superpowers/specs/2026-10-03-onchain-spending-limit-design.md R3, R12): `pay(address,uint256,bytes32)` called
 * from the agent's own wallet, under the attempt's key, with no transfer from the operating wallet; and nothing at all
 * for a payment the contract cannot carry.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/dal", () => ({
  db: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { id: "account-1", chain: "ARC-TESTNET", token: "USDC", circle_wallet_id: "wallet-op", address: OPERATING, balance: "100" }, error: null }),
        }),
      }),
    }),
  }),
  unwrap: (result: { data: unknown; error?: { message: string } | null }) => {
    if (result.error) throw new Error(result.error.message);
    if (result.data === null) throw new Error("Supabase returned no data");
    return result.data;
  },
}));

const OPERATING = "0x97F85033bBD83870a841cF7153F35b387746B6b6";
const CHAIN: ChainConfig = { circleApiKey: "test-api-key", circleEntitySecret: "test-entity-secret", usdcTokenId: "usdc-token-id" };
const KEY = "00000000-0000-4000-8000-000000000001";
const PAYEE = "0x19801dAA2F1E5E5e707b7E57Ff664f3d27fFdd12";
const LIMIT = { contract: "0x11a1700000000000000000000000000000001111", agentWalletId: "wallet-agent", ref: spendingLimitRef("invoice", "inv-1") };

function circle(state = "COMPLETE") {
  const client = {
    createTransaction: vi.fn(() => Promise.reject(new Error("a payment through the contract makes no transfer from the wallet"))),
    getWalletTokenBalance: vi.fn(() => Promise.reject(new Error("unexpected"))),
    createContractExecutionTransaction: vi.fn(async () => ({ data: { id: "circle-pay-1" } })),
    // Circle reports the fee, so the provider never reads it from Arc's RPC: a test that reached the chain could outlast its timeout.
    getTransaction: vi.fn(async () => ({ data: { transaction: { id: "circle-pay-1", state, txHash: `0x${"4".repeat(64)}`, networkFeeInUSD: "0.01" } } })),
  };
  return { client: client as unknown as LiveProviderClient, raw: client };
}

describe("LiveProvider: a payment through the spending limit contract", () => {
  it("calls pay(address,uint256,bytes32) from the agent's wallet, in token units, under the attempt's key, and transfers nothing", async () => {
    const c = circle();
    const result = await new LiveProvider(CHAIN, { network: ARC_TESTNET, client: c.client }).transfer({
      fromAccountId: "account-1",
      toAddress: PAYEE,
      amount: 1.2,
      memo: "Invoice inv-1",
      idempotencyKey: KEY,
      spendingLimit: LIMIT,
    });
    expect(c.raw.createContractExecutionTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: "wallet-agent",
        contractAddress: LIMIT.contract,
        abiFunctionSignature: PAY_SIGNATURE,
        abiParameters: [PAYEE, "1200000", LIMIT.ref],
        idempotencyKey: KEY,
        refId: "Invoice inv-1",
      })
    );
    expect(c.raw.createTransaction).not.toHaveBeenCalled();
    expect(result).toMatchObject({ providerTxId: "circle-pay-1", status: "confirmed", txHash: `0x${"4".repeat(64)}`, chain: "ARC-TESTNET" });
  });

  it("reports a call Circle failed as a failed transfer, with Circle's reason", async () => {
    const c = circle("FAILED");
    const result = await new LiveProvider(CHAIN, { network: ARC_TESTNET, client: c.client }).transfer({
      fromAccountId: "account-1",
      toAddress: PAYEE,
      amount: 9,
      memo: "Invoice inv-1",
      idempotencyKey: KEY,
      spendingLimit: LIMIT,
    });
    expect(result).toMatchObject({ status: "failed", providerState: "FAILED" });
  });

  it("sends nothing for a payment the contract cannot carry: EURC, another chain, or a release from escrow", async () => {
    const base = { fromAccountId: "account-1", toAddress: PAYEE, amount: 1, memo: "Invoice inv-1", idempotencyKey: KEY, spendingLimit: LIMIT };
    for (const extra of [
      { token: "EURC" as const },
      { destinationChain: "BASE-SEPOLIA" },
      { route: "escrow" as const, escrow: { contract: `0x${"e5".repeat(20)}`, holdId: `0x${"1".repeat(64)}` } },
    ]) {
      const c = circle();
      await expect(new LiveProvider(CHAIN, { network: ARC_TESTNET, client: c.client }).transfer({ ...base, ...extra })).rejects.toThrow(/nothing was sent/);
      expect(c.raw.createContractExecutionTransaction).not.toHaveBeenCalled();
      expect(c.raw.createTransaction).not.toHaveBeenCalled();
    }
  });
});

describe("LiveProvider: a payout to another chain through a version 2 contract (spending limit v2 V11)", () => {
  const MINT = `0x${"7".repeat(64)}`;
  const BURN = `0x${"4".repeat(64)}`;
  const V2 = { ...LIMIT, version: 2 as const };
  const base = { fromAccountId: "account-1", toAddress: PAYEE, amount: 1, memo: "Invoice inv-1", idempotencyKey: KEY, destinationChain: "BASE", maxBridgeFeeUsdc: 1 };

  /** Iris on Arc mainnet: a fast forwarded route to Base at `forwardUnits`, and the mint once asked about the burn. */
  function iris(forwardUnits = 54_000) {
    return vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("/v2/burn/USDC/fees/26/6")) return new Response(JSON.stringify([{ finalityThreshold: 1000, minimumFee: 0, forwardFee: { low: 1, med: 2, high: forwardUnits } }]));
      if (href.includes(`/v2/messages/26?transactionHash=${BURN}`)) return new Response(JSON.stringify({ messages: [{ forwardTxHash: MINT }] }));
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
  }

  it("calls payAcrossChains from the agent's wallet with the amount, the fee read now, Base's domain and the payee, and is paid on the mint", async () => {
    const c = circle();
    const fetch = iris();
    const result = await new LiveProvider(CHAIN, { network: ARC_MAINNET, client: c.client, fetch, bridgeMintWaitMs: 0 }).transfer({ ...base, spendingLimit: V2 });
    expect(c.raw.createContractExecutionTransaction).toHaveBeenCalledTimes(1);
    expect(c.raw.createContractExecutionTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: "wallet-agent",
        contractAddress: LIMIT.contract,
        abiFunctionSignature: PAY_ACROSS_CHAINS_SIGNATURE,
        abiParameters: ["1000000", "54000", "6", `0x${"0".repeat(24)}${PAYEE.slice(2).toLowerCase()}`, LIMIT.ref],
        idempotencyKey: KEY,
      })
    );
    // No transfer, and no approve: the contract approves TokenMessengerV2 itself.
    expect(c.raw.createTransaction).not.toHaveBeenCalled();
    expect(result).toMatchObject({ providerTxId: "cctp:circle-pay-1", status: "confirmed", destinationChain: "BASE", bridgeFeeUsdc: 0.054, mintTxHash: MINT, txHash: BURN });
    // Read again, as any bridge's burn: the mint from Iris.
    expect(await new LiveProvider(CHAIN, { network: ARC_MAINNET, client: c.client, fetch }).reconcileTransfer("cctp:circle-pay-1")).toMatchObject({ status: "confirmed", mintTxHash: MINT });
  });

  it("stays in flight while the mint has not appeared", async () => {
    const c = circle();
    const none = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("/fees/") ? new Response(JSON.stringify([{ finalityThreshold: 1000, minimumFee: 0, forwardFee: { high: 54_000 } }])) : new Response(JSON.stringify({ messages: [] }))
    ) as unknown as typeof fetch;
    const result = await new LiveProvider(CHAIN, { network: ARC_MAINNET, client: c.client, fetch: none, bridgeMintWaitMs: 0 }).transfer({ ...base, spendingLimit: V2 });
    expect(result).toMatchObject({ status: "pending", mintTxHash: null });
  });

  it("sends nothing when the fee is above what the payment may pay, or above the contract's own cap", async () => {
    for (const [forwardUnits, extra] of [
      [54_000, { maxBridgeFeeUsdc: 0.05 }],
      // 0.2 USDC on a 1 USDC payout is within a person's ceiling of the invoice, but past the contract's 10%.
      [200_000, {}],
    ] as const) {
      const c = circle();
      await expect(
        new LiveProvider(CHAIN, { network: ARC_MAINNET, client: c.client, fetch: iris(forwardUnits), bridgeMintWaitMs: 0 }).transfer({ ...base, ...extra, spendingLimit: V2 })
      ).rejects.toThrow(/nothing was sent/);
      expect(c.raw.createContractExecutionTransaction).not.toHaveBeenCalled();
    }
  });

  it("sends nothing to another chain through version 1, or through Gateway, or in EURC", async () => {
    for (const extra of [{ spendingLimit: LIMIT }, { spendingLimit: V2, route: "gateway" as const }, { spendingLimit: V2, token: "EURC" as const }]) {
      const c = circle();
      await expect(new LiveProvider(CHAIN, { network: ARC_MAINNET, client: c.client, fetch: iris(), bridgeMintWaitMs: 0 }).transfer({ ...base, ...extra })).rejects.toThrow(
        /nothing was sent/
      );
      expect(c.raw.createContractExecutionTransaction).not.toHaveBeenCalled();
    }
  });
});
