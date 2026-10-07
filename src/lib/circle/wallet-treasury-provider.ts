import { decodeFunctionResult, encodeFunctionData, erc20Abi, type Hex } from "viem";
import { db, unwrap } from "../dal";
import { FeatureOffError, type NetworkProfile } from "../network";
import { PaymentsDisabledError } from "../payments-switch";
import { asAddress, treasuryChain, type TreasuryChain } from "../treasury/chain";
import type { LiveProvider } from "./liveProvider";
import { readSpendingLimitContract } from "./spending-limit-setup";
import type { BalanceSnapshot, ChainProvider, EarnDepositParams, EarnResult, Stablecoin, TransferParams, TransferResult } from "./types";

/**
 * The provider of a workspace paying from its owner's own wallet (docs/superpowers/specs/2026-10-07-wallet-treasury-
 * design.md W11, W12). Its treasury is a wallet Circle does not hold: every transfer goes through the workspace's
 * spending limit contract, from the agent's wallet in Vestiarion's agent account, or not at all; and what the agent can
 * move is read from the chain. Earning, swaps, batches and other chains are not offered.
 */

/** Why a transfer that does not go through the contract is refused, before anything is sent (W11). */
export const WALLET_CONTRACT_ONLY = "This workspace pays only through its wallet's spending limit contract.";

const UNITS = 1_000_000;

/** The owner's wallet behind an account, and the contract the agent pays through; null before it is deployed. */
export type TreasuryOf = (accountId: string) => Promise<{ address: Hex; contract: Hex | null }>;

/** The operating account's wallet address, and the workspace's contract, read in the workspace's scope. */
async function storedTreasury(accountId: string): Promise<{ address: Hex; contract: Hex | null }> {
  const row = unwrap(await db().from("accounts").select("address").eq("id", accountId).single()) as { address: string | null };
  if (!row.address) throw new Error(`Account ${accountId} has no wallet yet. Choose your own wallet in Settings → Go live.`);
  const limit = await readSpendingLimitContract();
  return { address: asAddress(row.address), contract: limit?.address ? asAddress(limit.address) : null };
}

export class WalletTreasuryProvider implements ChainProvider {
  readonly mode = "live" as const;
  // No reserve earns anything here; "simulate" keeps every page reading as a workspace without a real reserve does.
  readonly earnMode = "simulate" as const;
  readonly treasury = "external" as const;
  readonly network: NetworkProfile;
  readonly estimatedFeeUsd: number;
  private readonly chain: TreasuryChain;
  private readonly treasuryOf: TreasuryOf;

  constructor(
    private readonly live: LiveProvider,
    network: NetworkProfile,
    deps: { chain?: TreasuryChain; treasuryOf?: TreasuryOf } = {}
  ) {
    this.network = network;
    this.estimatedFeeUsd = live.estimatedFeeUsd;
    this.chain = deps.chain ?? treasuryChain(network);
    this.treasuryOf = deps.treasuryOf ?? storedTreasury;
  }

  /** Only through the contract (W11): without it nothing is sent, and the payment holds as payments switched off do. */
  async transfer(params: TransferParams): Promise<TransferResult> {
    if (!params.spendingLimit) throw new PaymentsDisabledError(WALLET_CONTRACT_ONLY);
    return this.live.transfer(params);
  }

  reconcileTransfer(providerTxId: string): Promise<TransferResult> {
    return this.live.reconcileTransfer(providerTxId);
  }

  /** A lost send is looked for in the agent's wallet, the only one that sends: never in the owner's, which Circle does not hold. */
  async findTransferByRef(
    fromAccountId: string,
    refId: string,
    window: { from: string; to: string },
    options: { walletId?: string; exclude?: string[] } = {}
  ): Promise<TransferResult | null> {
    if (!options.walletId) return null;
    return this.live.findTransferByRef(fromAccountId, refId, window, options);
  }

  depositToEarn(params: EarnDepositParams): Promise<EarnResult> {
    void params;
    return Promise.reject(new FeatureOffError("The reserve", this.network));
  }

  withdrawFromEarn(params: EarnDepositParams): Promise<EarnResult> {
    void params;
    return Promise.reject(new FeatureOffError("The reserve", this.network));
  }

  getBalance(accountId: string): Promise<BalanceSnapshot> {
    return this.getTokenBalance(accountId, "USDC");
  }

  /**
   * USDC: what the agent can move, the lesser of the wallet's USDC and its approval to the contract, 0 before the
   * contract exists (W12). EURC: the wallet's own, which no payment here can move, for what a page shows.
   */
  async getTokenBalance(accountId: string, token: Stablecoin): Promise<BalanceSnapshot> {
    const { address, contract } = await this.treasuryOf(accountId);
    let units: bigint;
    if (token === "USDC") {
      const [balance, allowance] = await Promise.all([this.chain.usdcBalance(address), contract ? this.chain.allowance(address, contract) : Promise.resolve(0n)]);
      units = balance < allowance ? balance : allowance;
    } else {
      units = await this.eurcBalance(address);
    }
    return { accountId, chain: this.network.circleBlockchain, token, balance: Number(units) / UNITS };
  }

  private async eurcBalance(owner: Hex): Promise<bigint> {
    const data = await this.chain.read(asAddress(this.network.tokens.EURC), encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [owner] }));
    return decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data });
  }
}
