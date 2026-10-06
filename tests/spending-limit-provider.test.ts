import { describe, expect, it, vi } from "vitest";
import { LiveProvider, type LiveProviderClient } from "@/lib/circle/liveProvider";
import type { ChainConfig } from "@/lib/config";
import { PAY_SIGNATURE, spendingLimitRef } from "@/lib/spending-limit/onchain";
import { ARC_TESTNET } from "@/lib/network";

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
    getTransaction: vi.fn(async () => ({ data: { transaction: { id: "circle-pay-1", state, txHash: `0x${"4".repeat(64)}` } } })),
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
