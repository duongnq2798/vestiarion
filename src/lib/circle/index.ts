import type {
  BalanceSnapshot,
  BatchTransferParams,
  ChainProvider,
  EarnDepositParams,
  EarnPosition,
  EarnResult,
  InboundTransfer,
  Stablecoin,
  SwapCallParams,
  SwapCallResult,
  TransferParams,
  TransferResult,
} from "./types";
import { SimulateProvider } from "./simulateProvider";
import { LiveProvider } from "./liveProvider";
import { currentOrgConfig } from "../context";
import type { VestiarionConfig } from "../config";

/**
 * Payments settle on Arc testnet through Circle's Developer-Controlled
 * Wallets. The USYC reserve is real once an owner or admin turned it on for
 * the workspace, after Circle allowlisted its wallets (USYC live design R1);
 * until then it is simulated. Both facts are reported (`mode`, `earnMode`)
 * rather than hidden behind a single "live" flag.
 */
class HybridProvider implements ChainProvider {
  readonly mode = "live" as const;
  readonly earnMode: "live" | "simulate";
  readonly estimatedFeeUsd: number;

  constructor(
    private readonly live: LiveProvider,
    private readonly simulated: SimulateProvider,
    usycLive = false
  ) {
    // Payments are the real leg, so the real leg's fee is the one that prices
    // a round trip.
    this.estimatedFeeUsd = live.estimatedFeeUsd;
    this.earnMode = usycLive ? "live" : "simulate";
  }

  transfer(params: TransferParams): Promise<TransferResult> {
    return this.live.transfer(params);
  }

  reconcileTransfer(providerTxId: string): Promise<TransferResult> {
    return this.live.reconcileTransfer(providerTxId);
  }

  /**
   * A batch is a payment, so it is the live leg's (batch payouts §2): the operating wallet's own
   * `executeBatch`, as is finding one whose answer was lost (R5).
   */
  batchTransfer(params: BatchTransferParams): Promise<TransferResult> {
    return this.live.batchTransfer(params);
  }

  findTransferByRef(fromAccountId: string, refId: string, window: { from: string; to: string }): Promise<TransferResult | null> {
    return this.live.findTransferByRef(fromAccountId, refId, window);
  }

  getBalance(accountId: string): Promise<BalanceSnapshot> {
    return this.live.getBalance(accountId);
  }

  getTokenBalance(accountId: string, token: Stablecoin): Promise<BalanceSnapshot> {
    return this.live.getTokenBalance(accountId, token);
  }

  /**
   * The swap is a payment-side call, so it goes to the live leg. Without it the
   * agent's `provider.swapForEurc` check failed for every live workspace, and
   * a EURC payable short of EURC was never offered a swap (EURC swap spec S6).
   */
  swapForEurc(params: SwapCallParams): Promise<SwapCallResult> {
    return this.live.swapForEurc(params);
  }

  /** Money in is read from the real wallet (receivables on Arc §2), like every other payment-side call. */
  listInboundTransfers(accountId: string, since: string | null): Promise<InboundTransfer[]> {
    return this.live.listInboundTransfers(accountId, since);
  }

  depositToEarn(params: EarnDepositParams): Promise<EarnResult> {
    return this.earnMode === "live" ? this.live.depositToEarn(params) : this.simulated.depositToEarn(params);
  }

  withdrawFromEarn(params: EarnDepositParams): Promise<EarnResult> {
    return this.earnMode === "live" ? this.live.withdrawFromEarn(params) : this.simulated.withdrawFromEarn(params);
  }

  /** Only a real reserve has a position on chain to read. */
  getEarnPosition(reserveAccountId: string): Promise<EarnPosition> {
    if (this.earnMode !== "live") return Promise.reject(new Error("The USYC reserve is simulated"));
    return this.live.getEarnPosition(reserveAccountId);
  }
}

/**
 * One provider per configuration, not one per process.
 *
 * This was a module-level `cached` built from `process.env`, so the first
 * caller decided which Circle credentials the whole process used and everyone
 * after inherited them. Keyed by the context's config object instead, two
 * businesses can hold two sets of Circle wallets in the same process — which
 * is the point of the exercise.
 *
 * A `WeakMap` because the key is the config the context already holds: when a
 * context goes away, so does its provider, with no cache to invalidate.
 */
const providers = new WeakMap<VestiarionConfig, ChainProvider>();

export function getChainProvider(): ChainProvider {
  const config = currentOrgConfig();
  const existing = providers.get(config);
  if (existing) return existing;

  const { circleApiKey, circleEntitySecret, credentialsUnreadable } = config.chain;
  if (credentialsUnreadable) {
    // A stored Circle credential this deployment could not decrypt must not
    // be treated as "no credentials configured": that would silently drop a
    // live organization into simulated payments, which then mark invoices
    // paid for money that never moved (spec §5.4, R12).
    throw new Error(
      `This organization's Circle credentials are stored but could not be read (${credentialsUnreadable}); refusing to fall back to simulated payments`
    );
  }
  const provider: ChainProvider =
    circleApiKey && circleEntitySecret
      ? new HybridProvider(new LiveProvider(config.chain, { paymentsDisabled: config.paymentsDisabled === true }), new SimulateProvider(), config.chain.usycLive === true)
      : new SimulateProvider();

  providers.set(config, provider);
  return provider;
}

/** What a page shows about payments and yield, computed inside the organization's scope. */
export function chainModes(): { mode: "live" | "simulate"; earnMode: "live" | "simulate" } {
  // getChainProvider() refuses outright when the organization's stored Circle
  // credentials could not be read (R12) — a page must still render, and the
  // warning already reaches it through ledgerReadWarnings(), so this reports
  // the safe simulate/simulate default rather than propagating that throw.
  if (currentOrgConfig().chain.credentialsUnreadable) return { mode: "simulate", earnMode: "simulate" };
  const provider = getChainProvider();
  return { mode: provider.mode, earnMode: provider.earnMode };
}

export type {
  BatchTransferParams,
  ChainProvider,
  TransferParams,
  TransferResult,
  EarnDepositParams,
  EarnPosition,
  EarnResult,
  BalanceSnapshot,
  Stablecoin,
  SwapCallParams,
  SwapCallResult,
  SwapStep,
} from "./types";
