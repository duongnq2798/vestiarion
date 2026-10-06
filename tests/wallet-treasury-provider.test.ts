import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { getChainProvider } from "@/lib/circle";
import type { LiveProvider } from "@/lib/circle/liveProvider";
import { WALLET_CONTRACT_ONLY, WalletTreasuryProvider } from "@/lib/circle/wallet-treasury-provider";
import { PaymentsDisabledError } from "@/lib/payments-switch";
import type { TreasuryChain } from "@/lib/treasury/chain";
import { ARC_MAINNET } from "@/lib/network";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

/**
 * The provider of a workspace paying from its owner's own wallet (docs/superpowers/specs/2026-10-07-wallet-treasury-
 * design.md W11, W12): every transfer goes through the workspace's spending limit contract, from the agent's wallet,
 * or not at all; and what the agent can move is read from the chain, never from Circle, which holds no such wallet.
 */

const WALLET = "0x5af3107a4000000000000000000000000000b0b0" as Hex;
const CONTRACT = "0x5af3107a4000000000000000000000000000e5c0" as Hex;
const PAYMENT = { contract: CONTRACT, agentWalletId: "agent-wallet", ref: `0x${"12".repeat(32)}` as Hex };
const TRANSFER = {
  fromAccountId: "acct-op",
  toAddress: "0x1111111111111111111111111111111111111111",
  amount: 2,
  memo: "Invoice i-1",
  idempotencyKey: "00000000-0000-4000-8000-000000000001",
};
const SENT = { providerTxId: "circle-tx-1", status: "pending" };

function fakeLive() {
  const transfer = vi.fn(async () => SENT);
  const reconcileTransfer = vi.fn(async () => SENT);
  const findTransferByRef = vi.fn(async () => null);
  const live = { network: ARC_MAINNET, estimatedFeeUsd: 0.01, transfer, reconcileTransfer, findTransferByRef } as unknown as LiveProvider;
  return { live, transfer, findTransferByRef };
}

function fakeChain(balance: bigint, allowance: bigint) {
  const allowanceRead = vi.fn(async () => allowance);
  const chain = { usdcBalance: vi.fn(async () => balance), allowance: allowanceRead } as unknown as TreasuryChain;
  return { chain, allowanceRead };
}

const treasuryOf = (contract: Hex | null) => async () => ({ address: WALLET, contract });

describe("WalletTreasuryProvider", () => {
  it("refuses a transfer that does not go through the contract, and sends nothing", async () => {
    const { live, transfer } = fakeLive();
    const provider = new WalletTreasuryProvider(live, ARC_MAINNET, { chain: fakeChain(0n, 0n).chain, treasuryOf: treasuryOf(CONTRACT) });
    const refused = provider.transfer(TRANSFER);
    await expect(refused).rejects.toBeInstanceOf(PaymentsDisabledError);
    await expect(refused).rejects.toThrow(WALLET_CONTRACT_ONLY);
    expect(transfer).not.toHaveBeenCalled();
  });

  it("sends one through the contract from the agent's wallet", async () => {
    const { live, transfer } = fakeLive();
    const provider = new WalletTreasuryProvider(live, ARC_MAINNET, { chain: fakeChain(0n, 0n).chain, treasuryOf: treasuryOf(CONTRACT) });
    await expect(provider.transfer({ ...TRANSFER, spendingLimit: PAYMENT })).resolves.toBe(SENT);
    expect(transfer).toHaveBeenCalledWith({ ...TRANSFER, spendingLimit: PAYMENT });
  });

  it("looks for a lost send only in the agent's wallet", async () => {
    const { live, findTransferByRef } = fakeLive();
    const provider = new WalletTreasuryProvider(live, ARC_MAINNET, { chain: fakeChain(0n, 0n).chain, treasuryOf: treasuryOf(CONTRACT) });
    const window = { from: "2026-10-07T00:00:00Z", to: "2026-10-07T01:00:00Z" };
    expect(await provider.findTransferByRef("acct-op", "Invoice i-1", window)).toBeNull();
    expect(findTransferByRef).not.toHaveBeenCalled();
    await provider.findTransferByRef("acct-op", "Invoice i-1", window, { walletId: "agent-wallet" });
    expect(findTransferByRef).toHaveBeenCalledWith("acct-op", "Invoice i-1", window, { walletId: "agent-wallet" });
  });

  it("reads what the agent can move: the lesser of the wallet's USDC and its approval", async () => {
    const capped = new WalletTreasuryProvider(fakeLive().live, ARC_MAINNET, { chain: fakeChain(12_500_000n, 3_000_000n).chain, treasuryOf: treasuryOf(CONTRACT) });
    expect(await capped.getBalance("acct-op")).toEqual({ accountId: "acct-op", chain: "ARC", token: "USDC", balance: 3 });
    const unlimited = new WalletTreasuryProvider(fakeLive().live, ARC_MAINNET, { chain: fakeChain(2_000_000n, 2n ** 256n - 1n).chain, treasuryOf: treasuryOf(CONTRACT) });
    expect((await unlimited.getBalance("acct-op")).balance).toBe(2);
  });

  it("reads nothing the agent can move before the contract exists", async () => {
    const { chain, allowanceRead } = fakeChain(12_500_000n, 0n);
    const provider = new WalletTreasuryProvider(fakeLive().live, ARC_MAINNET, { chain, treasuryOf: treasuryOf(null) });
    expect((await provider.getBalance("acct-op")).balance).toBe(0);
    expect(allowanceRead).not.toHaveBeenCalled();
  });

  it("refuses the reserve by name", async () => {
    const provider = new WalletTreasuryProvider(fakeLive().live, ARC_MAINNET, { chain: fakeChain(0n, 0n).chain, treasuryOf: treasuryOf(CONTRACT) });
    await expect(provider.depositToEarn({ fromAccountId: "a", toAccountId: "b", amount: 1, idempotencyKey: "k" } as never)).rejects.toThrow(
      "The reserve does not run on Arc mainnet yet"
    );
    await expect(provider.withdrawFromEarn({ fromAccountId: "a", toAccountId: "b", amount: 1, idempotencyKey: "k" } as never)).rejects.toThrow(
      "The reserve does not run on Arc mainnet yet"
    );
  });

  it("is the provider of a workspace whose host is its owner's wallet", () => {
    const base = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
    const config = {
      ...base,
      network: "arc-mainnet" as const,
      chain: { ...base.chain, walletHost: "external" as const, circleApiKey: "LIVE_API_KEY:a:b", circleEntitySecret: "secret" },
    };
    const provider = runWith(orgTestContext({ config, client: fakeSupabase().client, orgId: "org-own-wallet" }), () => getChainProvider());
    expect(provider).toBeInstanceOf(WalletTreasuryProvider);
    expect(provider.treasury).toBe("external");
    expect(provider.mode).toBe("live");
  });
});
