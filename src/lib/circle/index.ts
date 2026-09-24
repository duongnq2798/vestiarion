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

let cached: ChainProvider | undefined;

export function getChainProvider(): ChainProvider {
  if (cached) return cached;

  const hasCredentials =
    !!process.env.CIRCLE_API_KEY && !!process.env.CIRCLE_ENTITY_SECRET;

  cached = hasCredentials
    ? new HybridProvider(new LiveProvider(), new SimulateProvider())
    : new SimulateProvider();

  return cached;
}

export type {
  ChainProvider,
  TransferParams,
  TransferResult,
  EarnDepositParams,
  EarnResult,
  BalanceSnapshot,
} from "./types";
