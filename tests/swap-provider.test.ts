import { describe, expect, it, vi } from "vitest";
import { LiveProvider, type LiveProviderClient } from "@/lib/circle/liveProvider";
import { SimulateProvider } from "@/lib/circle/simulateProvider";
import type { ChainProvider } from "@/lib/circle";
import type { ChainConfig } from "@/lib/config";
import { ARC_TESTNET_USDC } from "@/lib/fx/quote";
import { ARC_TESTNET } from "@/lib/network";

/**
 * The live provider's two calls for a USDC→EURC swap (docs/superpowers/specs/2026-10-01-eurc-swap-design.md
 * S6): approve the Adapter for the USDC, then send the Adapter the swap's call, from the operating wallet,
 * each under its own key and waited for. A sandbox's provider has no swap: it is never offered one.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/dal", () => ({
  db: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { id: "account-1", chain: "ARC-TESTNET", token: "USDC", circle_wallet_id: "wallet-op", address: "0x97f8" }, error: null }),
        }),
      }),
    }),
  }),
  unwrap: (result: { data: unknown; error?: { message: string } | null }) => {
    if (result.error) throw new Error(result.error.message);
    return result.data;
  },
}));

const CHAIN: ChainConfig = { circleApiKey: "test-api-key", circleEntitySecret: "test-entity-secret", usdcTokenId: "usdc-token-id" };
const ADAPTER = "0xBBD70b01a1CAbc96d5b7b129Ae1AAabdf50dd40b";
const CALL = `0xaa3e079c${"00".repeat(64)}`;
const SWAP = { fromAccountId: "account-1", adapter: ADAPTER, usdcIn: 2.507384, callData: CALL, approveKey: "k-approve", executeKey: "k-execute" };

function circle(states: Record<string, string>) {
  const created: Array<Record<string, unknown>> = [];
  const client = {
    createTransaction: vi.fn(() => Promise.reject(new Error("a swap makes no transfer"))),
    getWalletTokenBalance: vi.fn(() => Promise.reject(new Error("unexpected"))),
    signTypedData: vi.fn(() => Promise.reject(new Error("a swap signs no permit"))),
    createContractExecutionTransaction: vi.fn(async (input: Record<string, unknown>) => {
      created.push(input);
      return { data: { id: `tx-${input.idempotencyKey as string}` } };
    }),
    getTransaction: vi.fn(async ({ id }: { id: string }) => ({
      data: { transaction: { id, state: states[id] ?? "COMPLETE", txHash: states[id] === "FAILED" ? undefined : `0x${id.length.toString(16).padStart(64, "0")}` } },
    })),
  };
  return { client: client as unknown as LiveProviderClient, raw: client, created };
}

describe("LiveProvider.swapForEurc", () => {
  it("approves the Adapter for the USDC, then sends it the swap's call, each under its own key", async () => {
    const c = circle({});
    const result = await new LiveProvider(CHAIN, { network: ARC_TESTNET, client: c.client }).swapForEurc!(SWAP);

    expect(c.created).toHaveLength(2);
    expect(c.created[0]).toMatchObject({
      walletId: "wallet-op",
      contractAddress: ARC_TESTNET_USDC,
      abiFunctionSignature: "approve(address,uint256)",
      abiParameters: [ADAPTER, "2507384"],
      idempotencyKey: "k-approve",
    });
    expect(c.created[1]).toMatchObject({ walletId: "wallet-op", contractAddress: ADAPTER, callData: CALL, idempotencyKey: "k-execute" });
    expect(c.created[1]).not.toHaveProperty("abiFunctionSignature");
    expect(c.raw.createTransaction).not.toHaveBeenCalled();
    expect(result).toEqual({
      approve: { status: "confirmed", txId: "tx-k-approve", txHash: expect.stringMatching(/^0x/), state: "COMPLETE" },
      execute: { status: "confirmed", txId: "tx-k-execute", txHash: expect.stringMatching(/^0x/), state: "COMPLETE" },
    });
  });

  it("sends no swap when the approval failed", async () => {
    const c = circle({ "tx-k-approve": "FAILED" });
    const result = await new LiveProvider(CHAIN, { network: ARC_TESTNET, client: c.client }).swapForEurc!(SWAP);
    expect(c.created).toHaveLength(1);
    expect(result).toEqual({ approve: { status: "failed", txId: "tx-k-approve", txHash: null, state: "FAILED" }, execute: null });
  });

  it("reports a swap Circle failed as failed, with its state", async () => {
    const c = circle({ "tx-k-execute": "FAILED" });
    const result = await new LiveProvider(CHAIN, { network: ARC_TESTNET, client: c.client }).swapForEurc!(SWAP);
    expect(result.execute).toEqual({ status: "failed", txId: "tx-k-execute", txHash: null, state: "FAILED" });
  });
});

describe("SimulateProvider", () => {
  it("has no swap, so a sandbox is never offered one", () => {
    expect((new SimulateProvider(ARC_TESTNET) as ChainProvider).swapForEurc).toBeUndefined();
  });
});
