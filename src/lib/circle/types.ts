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

/** The stablecoins a payment can be in (EURC invoices spec E5). */
export type Stablecoin = "USDC" | "EURC";

export interface TransferParams {
  fromAccountId: string;
  toAddress: string;
  amount: number;
  idempotencyKey: string;
  memo?: string;
  /** What is sent; USDC when absent. */
  /**
   * The payee's chain (CCTP payouts X2): absent or ARC-TESTNET pays on Arc; any
   * other is paid from Arc through CCTP V2 with the Forwarding Service.
   */
  destinationChain?: string;
  /** For a bridged payment, the most its CCTP fee may be, in USDC: a higher fee read at the burn sends nothing (review I4). */
  maxBridgeFeeUsdc?: number;
  token?: Stablecoin;
  /**
   * How a payment across chains goes (Gateway payouts G2): from the workspace's
   * Gateway balance, or through CCTP when absent. The payment intent keeps it
   * from its first attempt.
   */
  route?: PayoutRoute;
  /** The escrow route's hold (milestone escrow E4): the workspace's escrow contract and the milestone's hold id. */
  escrow?: { contract: string; holdId: string };
}

/** The two ways a payee on another chain is paid from Arc testnet. */
/** How a payment goes: across chains through CCTP or a Gateway balance, or, for a milestone locked in escrow, by releasing its hold. */
export type PayoutRoute = "cctp" | "gateway" | "escrow";
/** The routes a payment across chains can take. */
export type CrossChainRoute = Exclude<PayoutRoute, "escrow">;

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
  /** Circle's own transaction `state` (e.g. "STUCK", "COMPLETE"), or null for the simulator or when it could not be read. */
  providerState: string | null;
  /** Circle's `errorReason` for a FAILED transaction, or null. */
  failureReason: string | null;
  /** A bridged payment's mint on the payee's chain, once the Forwarding Service submitted it; null before. */
  mintTxHash?: string | null;
  /** The chain a bridged payment is minted on; absent for a payment on Arc. */
  destinationChain?: string | null;
  /** The CCTP fee paid on top of a bridged payment, in USDC. */
  bridgeFeeUsdc?: number | null;
  /** The route a payment across chains took; absent for a payment on Arc. */
  route?: PayoutRoute;
}

export interface EarnDepositParams {
  /** The operating account: where a sweep's USDC comes from and a redemption's goes. */
  accountId: string;
  amount: number;
  /** The reserve account a real USYC move buys into or sells from (USYC live design R2). */
  reserveAccountId?: string;
  /** The seed of the move's Circle idempotency keys, one per step, so a retried cycle never moves twice (R6). */
  key?: string;
}

/** What a real USYC move did on Arc testnet (USYC live design R7). */
export interface UsycExecution {
  approveTxHash?: string | null;
  depositTxHash?: string | null;
  redeemTxHash?: string | null;
  /** USYC bought or sold. */
  shares: number;
  /** USDC per USYC it moved at. */
  price: number;
}

export interface EarnResult {
  txRef: string;
  positionValue: number;
  apy: number;
  /** Set for a real USYC move. */
  execution?: UsycExecution;
}

/** The reserve's USYC as the chain has it, and what it is worth in USDC at the oracle's latest price (R3). */
export interface EarnPosition {
  shares: number;
  valueUsdc: number;
  price: number;
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
/** One of a swap's two calls, as Circle last reported it (EURC swap spec S6). */
export interface SwapStep {
  status: TransferResult["status"];
  txId: string;
  txHash: string | null;
  state: string | null;
}

/** A USDC→EURC swap's two calls from the operating wallet: approve the Adapter, then the swap itself. */
export interface SwapCallParams {
  fromAccountId: string;
  /** The Adapter contract the swap's call is sent to, and approved for the USDC. */
  adapter: string;
  usdcIn: number;
  /** The Adapter's `execute(...)` call, as built from the Stablecoin Service's answer. */
  callData: string;
  approveKey: string;
  executeKey: string;
}

export interface SwapCallResult {
  approve: SwapStep;
  /** Null when the approval did not confirm, so the swap was not sent. */
  execute: SwapStep | null;
}

/** One completed inbound transfer to a workspace wallet, as Circle reports it (receivables on Arc §2). */
export interface InboundTransfer {
  circleTxId: string;
  txHash: string | null;
  /** The sender's address, when Circle knows it. */
  from: string | null;
  amount: number;
  token: Stablecoin;
  chain: string;
  /** When it was first confirmed (or, failing that, last updated). */
  receivedAt: string;
}

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
  /** The real reserve's position, read from the chain; only a provider whose `earnMode` is live has one (R3). */
  getEarnPosition?(reserveAccountId: string): Promise<EarnPosition>;
  getBalance(accountId: string): Promise<BalanceSnapshot>;
  /**
   * One token's balance in an account's wallet (EURC invoices spec E5).
   * Optional: providers that only ever hold USDC may leave it out, and a caller
   * then has no EURC balance to rely on.
   */
  getTokenBalance?(accountId: string, token: Stablecoin): Promise<BalanceSnapshot>;
  /**
   * Swaps USDC for EURC through the Adapter App Kit names (EURC swap spec S6), under the swap's keys.
   * Optional: a provider without it is never offered a swap.
   */
  swapForEurc?(params: SwapCallParams): Promise<SwapCallResult>;
  /**
   * Completed inbound USDC and EURC transfers to an account's wallet since a time, or the last 50
   * (receivables on Arc §2). Optional: a provider without a real wallet (a sandbox's) has none.
   */
  listInboundTransfers?(accountId: string, since: string | null): Promise<InboundTransfer[]>;
}
