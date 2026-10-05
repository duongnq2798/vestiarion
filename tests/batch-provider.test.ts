import { describe, expect, it, vi } from "vitest";
import { BatchNotSentError, SCA_EXECUTE_BATCH } from "@/lib/circle/batch";
import { ARC_TESTNET_USDC } from "@/lib/circle/cctp";
import { LiveProvider, type LiveProviderClient } from "@/lib/circle/liveProvider";
import { SimulateProvider } from "@/lib/circle/simulateProvider";
import type { ChainConfig } from "@/lib/config";

/**
 * The live provider's batch (docs/superpowers/specs/2026-10-02-batch-payouts-design.md §2, R3, R5): one
 * contract execution of the operating wallet's own executeBatch, under the batch's key, which is also its
 * refId; and a batch whose answer was lost, found among the wallet's transactions by that refId.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/dal", () => ({
  db: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { id: "operating-1", chain: "ARC-TESTNET", token: "USDC", circle_wallet_id: "wallet-op", address: `0x${"9".repeat(40)}` }, error: null }),
        }),
      }),
    }),
  }),
  unwrap: (result: { data: unknown; error?: { message: string } | null }) => {
    if (result.error) throw new Error(result.error.message);
    return result.data;
  },
}));

const CHAIN: ChainConfig = { circleApiKey: "test-api-key", circleEntitySecret: "test-entity-secret", usdcTokenId: "usdc-token-id", arcRpcUrl: "https://arc.test" };
const KEY = "5b0f8f2e-3c1d-5e4f-9a7b-0c1d2e3f4a5b";
const TRANSFERS = [
  { toAddress: `0x${"1".repeat(40)}`, amount: 1 },
  { toAddress: `0x${"2".repeat(40)}`, amount: 2.5 },
];

function circle(listed: Array<{ id: string; refId?: string }> = []) {
  const created: Array<Record<string, unknown>> = [];
  const listings: Array<Record<string, unknown>> = [];
  const client = {
    createTransaction: vi.fn(() => Promise.reject(new Error("a batch makes no plain transfer"))),
    getWalletTokenBalance: vi.fn(() => Promise.reject(new Error("unexpected"))),
    signTypedData: vi.fn(() => Promise.reject(new Error("unexpected"))),
    createContractExecutionTransaction: vi.fn(async (input: Record<string, unknown>) => {
      created.push(input);
      return { data: { id: "tx-batch" } };
    }),
    getTransaction: vi.fn(async ({ id }: { id: string }) => ({
      data: {
        transaction: {
          id,
          state: "COMPLETE",
          blockchain: "ARC-TESTNET",
          txHash: `0x${"c".repeat(64)}`,
          networkFeeInUSD: "0.009",
          createDate: "2026-10-02T10:00:00Z",
          firstConfirmDate: "2026-10-02T10:00:02Z",
        },
      },
    })),
    listTransactions: vi.fn(async (input: Record<string, unknown>) => {
      listings.push(input);
      return { data: { transactions: listed } };
    }),
  };
  return { client: client as unknown as LiveProviderClient, created, listings };
}

describe("LiveProvider.batchTransfer", () => {
  it("sends one contract execution of the operating wallet's own executeBatch, under the batch's key and refId", async () => {
    const { client, created } = circle();
    const result = await new LiveProvider(CHAIN, { client }).batchTransfer({ fromAccountId: "operating-1", transfers: TRANSFERS, idempotencyKey: KEY });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ walletId: "wallet-op", contractAddress: `0x${"9".repeat(40)}`, abiFunctionSignature: SCA_EXECUTE_BATCH, idempotencyKey: KEY, refId: KEY });
    const [calls] = created[0].abiParameters as [Array<[string, string, string]>];
    expect(calls.map(([target, value, data]) => [target, value, data.slice(0, 10)])).toEqual([
      [ARC_TESTNET_USDC, "0", "0xa9059cbb"],
      [ARC_TESTNET_USDC, "0", "0xa9059cbb"],
    ]);
    expect(result).toMatchObject({ providerTxId: "tx-batch", status: "confirmed", txHash: `0x${"c".repeat(64)}`, feeUsd: 0.009, feeSource: "chain_reported", settledInMs: 2000 });
  });

  it("sends nothing to a payee with no Arc address, and says nothing was sent", async () => {
    const { client, created } = circle();
    const sent = new LiveProvider(CHAIN, { client }).batchTransfer({ fromAccountId: "operating-1", transfers: [TRANSFERS[0], { toAddress: "sim:cp-2", amount: 1 }], idempotencyKey: KEY });
    await expect(sent).rejects.toThrow(BatchNotSentError);
    await expect(sent).rejects.toThrow(/no on-chain address/);
    expect(created).toEqual([]);
  });
});

describe("LiveProvider.findTransferByRef", () => {
  const window = { from: "2026-10-02T09:55:00Z", to: "2026-10-02T10:30:00Z" };

  it("finds the batch by its refId among the wallet's transactions in the window, and reads it again", async () => {
    const { client, listings, created } = circle([{ id: "tx-other", refId: "Milestone 1" }, { id: "tx-batch", refId: KEY }]);
    const found = await new LiveProvider(CHAIN, { client }).findTransferByRef("operating-1", KEY, window);
    expect(listings[0]).toMatchObject({ walletIds: ["wallet-op"], from: window.from, to: window.to, pageSize: 50 });
    expect(found).toMatchObject({ providerTxId: "tx-batch", status: "confirmed" });
    expect(created).toEqual([]);
  });

  it("looks in another wallet when told, and leaves out the transactions it is told to (payment safety R4, R5)", async () => {
    const { client, listings } = circle([{ id: "tx-earlier", refId: "Invoice 1" }, { id: "tx-current", refId: "Invoice 1" }]);
    const found = await new LiveProvider(CHAIN, { client }).findTransferByRef("operating-1", "Invoice 1", window, { walletId: "wallet-agent", exclude: ["tx-earlier"] });
    expect(listings[0]).toMatchObject({ walletIds: ["wallet-agent"] });
    expect(found).toMatchObject({ providerTxId: "tx-current" });
  });

  it("says none when the window holds no such transaction, and cannot say when the page is full", async () => {
    expect(await new LiveProvider(CHAIN, { client: circle([{ id: "tx-other" }]).client }).findTransferByRef("operating-1", KEY, window)).toBeNull();
    const full = Array.from({ length: 50 }, (_, i) => ({ id: `tx-${i}` }));
    await expect(new LiveProvider(CHAIN, { client: circle(full).client }).findTransferByRef("operating-1", KEY, window)).rejects.toThrow(/could not be looked for in full/);
  });
});

describe("SimulateProvider batches", () => {
  it("never has a batch to find", async () => {
    expect(await new SimulateProvider().findTransferByRef()).toBeNull();
  });
});
