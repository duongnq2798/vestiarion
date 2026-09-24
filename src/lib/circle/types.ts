/**
 * Arc's transfer cost, as measured rather than asserted.
 *
 * This was 0.01 — a round number nobody had checked. Once `payment_intents`
 * started recording real executions, four Arc-testnet transfers were read back
 * from the chain by receipt (`src/lib/circle/arcFees.ts`), and the real cost is
 * about a third of that:
 *
 *     gasUsed ~127,400 x 25-25.5 gwei, USDC-denominated gas at 18 decimals
 *     => $0.003186, $0.003186, $0.003186, $0.003248
 *
 * It stays a constant only because it is the *fallback* used when the chain
 * cannot be reached; a live transfer reads its own receipt and records
 * `chain_reported` instead. Treat this as the last resort, not the number.
 *
 * It matters beyond display: `planTreasury` prices a sweep-and-redeem round
 * trip at twice this figure, so a 3x-inflated estimate made the agent three
 * times more reluctant to put idle cash to work than the economics justified.
 */
export const ARC_FEE_USD = 0.00319;

/**
 * Observed settlement latency on Arc testnet, in milliseconds, from Circle's
 * own create-to-first-confirm timestamps across the same four transfers:
 * 2000, 2000, 3000, 5000. The simulator draws from this range.
 *
 * The previous simulated range was 320-470ms, carrying a comment claiming it
 * reproduced "Arc's real fee and latency profile". Measurement disagreed by
 * roughly 5-10x. A simulator that flatters the chain it stands in for is worse
 * than no simulator, because every number downstream inherits the flattery.
 */
export const ARC_SETTLEMENT_MS_MIN = 2_000;
export const ARC_SETTLEMENT_MS_MAX = 5_000;

export interface TransferParams {
  fromAccountId: string;
  toAddress: string;
  amount: number;
  idempotencyKey: string;
  memo?: string;
}

export interface TransferResult {
  providerTxId: string;
  txHash: string | null;
  txRef: string;
  chain: string;
  status: "confirmed" | "pending" | "failed";
  feeUsd: number;
  feeSource: "chain_reported" | "provider_estimate" | "simulated_profile";
  providerMode: "live" | "simulate";
  settledInMs: number | null;
}

export interface EarnDepositParams {
  accountId: string;
  amount: number;
}

export interface EarnResult {
  txRef: string;
  positionValue: number;
  apy: number;
}

export interface BalanceSnapshot {
  accountId: string;
  chain: string;
  token: string;
  balance: number;
}

/**
 * Everything Vestiarion needs from "the chain": moving USDC (Wallets +
 * Paymaster), parking idle cash in USYC (EarnKit), and reading balances.
 *
 * `mode` and `earnMode` are reported separately and surfaced in the UI and
 * the audit log, because they can legitimately differ: payments settle on
 * Arc testnet for real while the USYC leg is still simulated. Labelling that
 * honestly matters more than a dashboard that looks uniformly "live".
 */
export interface ChainProvider {
  readonly mode: "simulate" | "live";
  readonly earnMode: "simulate" | "live";
  /**
   * Typical cost of one transfer, in USD. Arc is ~$0.01. The treasury policy
   * prices a sweep-and-redeem round trip from this rather than a constant, so
   * a chain with different economics changes the agent's behaviour without a
   * change to its reasoning.
   */
  readonly estimatedFeeUsd: number;
  transfer(params: TransferParams): Promise<TransferResult>;
  reconcileTransfer(providerTxId: string): Promise<TransferResult>;
  depositToEarn(params: EarnDepositParams): Promise<EarnResult>;
  withdrawFromEarn(params: EarnDepositParams): Promise<EarnResult>;
  getBalance(accountId: string): Promise<BalanceSnapshot>;
}
