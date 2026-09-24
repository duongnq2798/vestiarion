/** Arc's published transfer cost. One number, used by every provider. */
export const ARC_FEE_USD = 0.01;

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
