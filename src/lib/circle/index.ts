import type {
  BalanceSnapshot,
  ChainProvider,
  EarnDepositParams,
  EarnResult,
  TransferParams,
  TransferResult,
} from "./types";
import { SimulateProvider } from "./simulateProvider";
import { LiveProvider } from "./liveProvider";
import { currentConfig } from "../context";
import type { VestiarionConfig } from "../config";

/**
 * Payments settle on Arc testnet through Circle's Developer-Controlled
 * Wallets; the USYC leg falls back to the simulator until EarnKit is wired
 * up with a KIT_KEY and a vault id. Both facts are reported (`mode`,
 * `earnMode`) rather than hidden behind a single "live" flag — Circle's own
 * arc-fintech sample mocks reward accrual on Arc testnet for the same
 * reason.
 */
class HybridProvider implements ChainProvider {
  readonly mode = "live" as const;
  readonly earnMode = "simulate" as const;
  readonly estimatedFeeUsd: number;

  constructor(
    private readonly live: LiveProvider,
    private readonly simulated: SimulateProvider
  ) {
    // Payments are the real leg, so the real leg's fee is the one that prices
    // a round trip.
    this.estimatedFeeUsd = live.estimatedFeeUsd;
  }

  transfer(params: TransferParams): Promise<TransferResult> {
    return this.live.transfer(params);
  }

  reconcileTransfer(providerTxId: string): Promise<TransferResult> {
    return this.live.reconcileTransfer(providerTxId);
  }

  getBalance(accountId: string): Promise<BalanceSnapshot> {
    return this.live.getBalance(accountId);
  }

  depositToEarn(params: EarnDepositParams): Promise<EarnResult> {
    return this.simulated.depositToEarn(params);
  }

  withdrawFromEarn(params: EarnDepositParams): Promise<EarnResult> {
    return this.simulated.withdrawFromEarn(params);
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
  const config = currentConfig();
  const existing = providers.get(config);
  if (existing) return existing;

  const { circleApiKey, circleEntitySecret } = config.chain;
  const provider: ChainProvider =
    circleApiKey && circleEntitySecret
      ? new HybridProvider(new LiveProvider(config.chain), new SimulateProvider())
      : new SimulateProvider();

  providers.set(config, provider);
  return provider;
}

export type {
  ChainProvider,
  TransferParams,
  TransferResult,
  EarnDepositParams,
  EarnResult,
  BalanceSnapshot,
} from "./types";
