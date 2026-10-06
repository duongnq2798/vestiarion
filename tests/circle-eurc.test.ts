import { beforeEach, describe, expect, it, vi } from "vitest";
import { LiveProvider, type LiveProviderClient } from "@/lib/circle/liveProvider";
import type { ChainConfig } from "@/lib/config";
import { ARC_TESTNET } from "@/lib/network";

/**
 * EURC through the chain providers (EURC invoices spec E5, E7): a transfer
 * names its token, USDC by default; the live provider pays EURC with the EURC
 * token id from the wallet's own token list and reads either token's balance;
 * the simulated provider simulates an EURC payment without touching the
 * account's USDC balance.
 */

vi.mock("server-only", () => ({}));

const { accountRow, updates } = vi.hoisted(() => ({
  accountRow: vi.fn(),
  updates: [] as unknown[],
}));
vi.mock("@/lib/dal", () => ({
  db: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ single: accountRow }) }),
      update: (values: unknown) => {
        updates.push(values);
        return { eq: async () => ({ error: null }) };
      },
    }),
  }),
  unwrap: (result: { data: unknown; error?: { message: string } | null }) => {
    if (result.error) throw new Error(result.error.message);
    return result.data;
  },
}));

const CHAIN: ChainConfig = { circleApiKey: "k", circleEntitySecret: "s", usdcTokenId: "usdc-token-id" };
const TRANSFER = { fromAccountId: "account-1", toAddress: "0x1111111111111111111111111111111111111111", amount: 5, idempotencyKey: "00000000-0000-4000-8000-000000000001" };
const STOP = new Error("stop after createTransaction");

function client(balances: Array<{ amount: string; token: { id: string; symbol: string } }>) {
  const getWalletTokenBalance = vi.fn(async () => ({ data: { tokenBalances: balances } }));
  const createTransaction = vi.fn(async () => {
    throw STOP;
  });
  const fake = { getWalletTokenBalance, createTransaction, getTransaction: vi.fn() } as unknown as LiveProviderClient;
  return { fake, getWalletTokenBalance, createTransaction };
}

beforeEach(() => {
  updates.length = 0;
  accountRow.mockReset().mockResolvedValue({ data: { id: "account-1", chain: "ARC-TESTNET", token: "USDC", circle_wallet_id: "wallet-1", balance: "100", apy: "0" }, error: null });
});

describe("the live provider", () => {
  const WALLET = [
    { amount: "40", token: { id: "usdc-token-id", symbol: "USDC" } },
    { amount: "25.5", token: { id: "eurc-token-id", symbol: "EURC" } },
  ];

  it("pays EURC with the wallet's EURC token id", async () => {
    const { fake, createTransaction } = client(WALLET);
    await expect(new LiveProvider(CHAIN, { network: ARC_TESTNET, client: fake }).transfer({ ...TRANSFER, token: "EURC" })).rejects.toBe(STOP);
    expect(createTransaction).toHaveBeenCalledWith(expect.objectContaining({ tokenId: "eurc-token-id", amount: ["5.000000"], walletId: "wallet-1" }));
  });

  it("remembers the EURC token id per wallet", async () => {
    const { fake, getWalletTokenBalance } = client(WALLET);
    const provider = new LiveProvider(CHAIN, { network: ARC_TESTNET, client: fake });
    await expect(provider.transfer({ ...TRANSFER, token: "EURC" })).rejects.toBe(STOP);
    await expect(provider.transfer({ ...TRANSFER, token: "EURC" })).rejects.toBe(STOP);
    expect(getWalletTokenBalance).toHaveBeenCalledTimes(1);
  });

  it("says to fund EURC first when the wallet has never held any, and sends nothing", async () => {
    const { fake, createTransaction } = client([WALLET[0]]);
    await expect(new LiveProvider(CHAIN, { network: ARC_TESTNET, client: fake }).transfer({ ...TRANSFER, token: "EURC" })).rejects.toThrow(
      /Fund it with EURC from Circle's faucet first/
    );
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it("still pays USDC by default, with the configured token id and no balance read", async () => {
    const { fake, createTransaction, getWalletTokenBalance } = client(WALLET);
    await expect(new LiveProvider(CHAIN, { network: ARC_TESTNET, client: fake }).transfer(TRANSFER)).rejects.toBe(STOP);
    expect(createTransaction).toHaveBeenCalledWith(expect.objectContaining({ tokenId: "usdc-token-id" }));
    expect(getWalletTokenBalance).not.toHaveBeenCalled();
  });

  it("reads either token's balance, and none as zero", async () => {
    const provider = new LiveProvider(CHAIN, { network: ARC_TESTNET, client: client(WALLET).fake });
    await expect(provider.getTokenBalance("account-1", "EURC")).resolves.toEqual({ accountId: "account-1", chain: "ARC-TESTNET", token: "EURC", balance: 25.5 });
    await expect(provider.getTokenBalance("account-1", "USDC")).resolves.toMatchObject({ token: "USDC", balance: 40 });
    const empty = new LiveProvider(CHAIN, { network: ARC_TESTNET, client: client([WALLET[0]]).fake });
    await expect(empty.getTokenBalance("account-1", "EURC")).resolves.toMatchObject({ token: "EURC", balance: 0 });
  });
});

describe("the simulated provider", () => {
  it("simulates an EURC payment without touching the account's USDC balance", async () => {
    const { SimulateProvider } = await import("@/lib/circle/simulateProvider");
    const result = await new SimulateProvider(ARC_TESTNET).transfer({ ...TRANSFER, amount: 500, token: "EURC" });
    expect(result).toMatchObject({ status: "confirmed", providerMode: "simulate" });
    expect(updates).toEqual([]);
  });

  it("still debits a simulated USDC payment", async () => {
    const { SimulateProvider } = await import("@/lib/circle/simulateProvider");
    await new SimulateProvider(ARC_TESTNET).transfer(TRANSFER);
    expect(updates).toEqual([{ balance: 95 }]);
  });

  it("holds no simulated EURC", async () => {
    const { SimulateProvider } = await import("@/lib/circle/simulateProvider");
    await expect(new SimulateProvider(ARC_TESTNET).getTokenBalance("account-1", "EURC")).resolves.toMatchObject({ token: "EURC", balance: 0 });
    await expect(new SimulateProvider(ARC_TESTNET).getTokenBalance("account-1", "USDC")).resolves.toMatchObject({ token: "USDC", balance: 100 });
  });
});
