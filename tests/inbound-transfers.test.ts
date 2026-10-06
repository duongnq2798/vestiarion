import { beforeEach, describe, expect, it, vi } from "vitest";
import { LiveProvider, type LiveProviderClient } from "@/lib/circle/liveProvider";
import type { ChainConfig } from "@/lib/config";
import { ARC_TESTNET } from "@/lib/network";

vi.mock("server-only", () => ({}));

const { accountSingle } = vi.hoisted(() => ({ accountSingle: vi.fn() }));
vi.mock("@/lib/dal", () => ({
  db: () => ({ from: () => ({ select: () => ({ eq: () => ({ single: accountSingle }) }) }) }),
  unwrap: (result: { data: unknown; error?: { message: string } | null }) => {
    if (result.error) throw new Error(result.error.message);
    return result.data;
  },
}));

/**
 * Money in, as Circle reports it for the operating wallet (receivables on Arc §2): completed inbound
 * transfers of USDC or EURC since a point in time, each with its Circle id, hash, sender, amount and
 * token. Anything else the wallet received (another token) is left out.
 */

const CHAIN: ChainConfig = { circleApiKey: "k", circleEntitySecret: "s", usdcTokenId: "usdc-token-id" };

const TOKENS = {
  data: {
    tokenBalances: [
      { token: { id: "usdc-id", symbol: "USDC", isNative: true }, amount: "20" },
      { token: { id: "eurc-id", symbol: "EURC", tokenAddress: ARC_TESTNET.tokens.EURC }, amount: "3" },
      { token: { id: "other-id", symbol: "WETH" }, amount: "1" },
      // A token anyone could deploy and name "USDC" (mainnet go-live M7).
      { token: { id: "spoof-id", symbol: "USDC", tokenAddress: "0x1111111111111111111111111111111111111111", isNative: false }, amount: "1000000" },
    ],
  },
};

const tx = (over: Record<string, unknown>) => ({
  id: "circle-1",
  transactionType: "INBOUND",
  state: "COMPLETE",
  blockchain: "ARC-TESTNET",
  tokenId: "usdc-id",
  amounts: ["12.5"],
  sourceAddress: "0x2222222222222222222222222222222222222222",
  txHash: "0xabc",
  createDate: "2026-10-01T15:00:00Z",
  firstConfirmDate: "2026-10-01T15:00:05Z",
  updateDate: "2026-10-01T15:00:06Z",
  ...over,
});

function provider(listTransactions: ReturnType<typeof vi.fn>) {
  const client = {
    createTransaction: vi.fn(),
    getTransaction: vi.fn(),
    getWalletTokenBalance: vi.fn().mockResolvedValue(TOKENS),
    listTransactions,
  } as unknown as LiveProviderClient;
  return new LiveProvider(CHAIN, { network: ARC_TESTNET, client });
}

beforeEach(() => {
  accountSingle.mockReset().mockResolvedValue({
    data: { id: "operating", chain: "ARC-TESTNET", token: "USDC", circle_wallet_id: "wallet-1", address: "0x1111111111111111111111111111111111111111" },
    error: null,
  });
});

describe("LiveProvider.listInboundTransfers", () => {
  it("asks Circle for the wallet's completed inbound transfers since the given time", async () => {
    const list = vi.fn().mockResolvedValue({ data: { transactions: [] } });
    await provider(list).listInboundTransfers("operating", "2026-09-30T00:00:00Z");
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ walletIds: ["wallet-1"], txType: "INBOUND", state: "COMPLETE", from: "2026-09-30T00:00:00Z", pageSize: 50 })
    );
  });

  it("reads each USDC or EURC transfer: id, hash, sender, amount, token, chain and when it was confirmed", async () => {
    const list = vi.fn().mockResolvedValue({
      data: { transactions: [tx({}), tx({ id: "circle-2", tokenId: "eurc-id", amounts: ["3"], txHash: "0xdef" })] },
    });
    expect(await provider(list).listInboundTransfers("operating", null)).toEqual([
      { circleTxId: "circle-1", txHash: "0xabc", from: "0x2222222222222222222222222222222222222222", amount: 12.5, token: "USDC", chain: "ARC-TESTNET", receivedAt: "2026-10-01T15:00:05Z" },
      { circleTxId: "circle-2", txHash: "0xdef", from: "0x2222222222222222222222222222222222222222", amount: 3, token: "EURC", chain: "ARC-TESTNET", receivedAt: "2026-10-01T15:00:05Z" },
    ]);
  });

  it("leaves out another token, one that only calls itself USDC, a transfer not complete or not inbound, and one with no amount", async () => {
    const list = vi.fn().mockResolvedValue({
      data: {
        transactions: [
          tx({ id: "weth", tokenId: "other-id" }),
          tx({ id: "spoof", tokenId: "spoof-id", amounts: ["1000000"] }),
          tx({ id: "pending", state: "CONFIRMED" }),
          tx({ id: "outbound", transactionType: "OUTBOUND" }),
          tx({ id: "empty", amounts: [] }),
        ],
      },
    });
    expect(await provider(list).listInboundTransfers("operating", null)).toEqual([]);
  });
});
