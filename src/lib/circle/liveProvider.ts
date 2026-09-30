import {
  initiateDeveloperControlledWalletsClient,
  type CircleDeveloperControlledWalletsClient,
} from "@circle-fin/developer-controlled-wallets";
import { db, unwrap } from "../dal";
import type {
  BalanceSnapshot,
  ChainProvider,
  EarnResult,
  Stablecoin,
  TransferParams,
  TransferResult,
} from "./types";
import { ARC_FEE_USD } from "./types";
import { fetchArcFeeUsd } from "./arcFees";
import { awaitSettlement, FAILED_STATES, withDeadline } from "./settlement";
import type { ChainConfig } from "../config";

export type LiveProviderClient = Pick<
  CircleDeveloperControlledWalletsClient,
  "createTransaction" | "getWalletTokenBalance" | "getTransaction"
>;

const CREATE_TRANSACTION_DEADLINE_MS = 20_000;
const BALANCE_READ_DEADLINE_MS = 15_000;
const RECONCILE_TRANSFER_DEADLINE_MS = 15_000;

interface AccountRow {
  id: string;
  chain: string;
  token: string;
  circle_wallet_id: string | null;
}

function measuredSettlementMs(transaction: { createDate: string; firstConfirmDate?: string }): number | null {
  if (!transaction.firstConfirmDate) return null;
  const elapsed = Date.parse(transaction.firstConfirmDate) - Date.parse(transaction.createDate);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}

function reportedFeeUsd(value: string | undefined): number | null {
  if (!value) return null;
  const fee = Number(value);
  return Number.isFinite(fee) && fee >= 0 ? fee : null;
}

/**
 * Circle's `networkFeeInUSD` is empty on Arc testnet — confirmed by
 * re-fetching settled transactions long after confirmation — so the chain
 * itself is the only place a real fee can be read. Circle first, Arc second,
 * estimate last, and the caller records which of the three it got.
 */
async function resolveFee(
  rpcUrl: string | undefined,
  circleReported: string | undefined,
  txHash: string | undefined
): Promise<{ feeUsd: number; feeSource: TransferResult["feeSource"] }> {
  const fromCircle = reportedFeeUsd(circleReported);
  if (fromCircle != null) return { feeUsd: fromCircle, feeSource: "chain_reported" };

  if (txHash) {
    const fromChain = await fetchArcFeeUsd(txHash, { url: rpcUrl });
    if (fromChain != null) return { feeUsd: fromChain, feeSource: "chain_reported" };
  }

  return { feeUsd: ARC_FEE_USD, feeSource: "provider_estimate" };
}

/**
 * Real Arc-testnet implementation over Circle's Developer-Controlled Wallets
 * SDK. Activated automatically by `./index.ts` once CIRCLE_API_KEY and
 * CIRCLE_ENTITY_SECRET are set.
 *
 * Per-account Circle wallet ids come from the `accounts` table, populated by
 * "Create treasury wallets" in Settings → Go live (or, for the demo seed,
 * `npm run bootstrap:circle`). The USDC token id is discovered from the
 * wallet's own balances the first time it is needed, so no hand-copied UUID
 * has to stay in sync with the environment.
 */
export class LiveProvider implements ChainProvider {
  readonly mode = "live" as const;
  readonly earnMode = "live" as const;
  readonly estimatedFeeUsd = ARC_FEE_USD;
  private readonly client: LiveProviderClient;
  private usdcTokenId?: string;
  /** EURC's token id in each wallet, as Circle's token list names it; read once per wallet. */
  private readonly eurcTokenIds = new Map<string, string>();

  private readonly arcRpcUrl?: string;

  /**
   * Takes its credentials rather than reading them. Two businesses with two
   * sets of Circle wallets can then exist in one process, which a constructor
   * that consulted `process.env` made impossible.
   */
  constructor(chain: ChainConfig, options: { client?: LiveProviderClient } = {}) {
    if (!chain.circleApiKey || !chain.circleEntitySecret) {
      throw new Error("LiveProvider requires a Circle API key and entity secret");
    }
    this.client = options.client ?? initiateDeveloperControlledWalletsClient({
      apiKey: chain.circleApiKey,
      entitySecret: chain.circleEntitySecret,
    });
    this.usdcTokenId = chain.usdcTokenId;
    this.arcRpcUrl = chain.arcRpcUrl;
  }

  private async account(accountId: string): Promise<AccountRow & { walletId: string }> {
    const row = unwrap(
      await db()
        .from("accounts")
        .select("id, chain, token, circle_wallet_id")
        .eq("id", accountId)
        .single<AccountRow>()
    );
    if (!row.circle_wallet_id) {
      throw new Error(
        `Account ${accountId} has no Circle wallet. Create the treasury wallets in Settings → Go live.`
      );
    }
    return { ...row, walletId: row.circle_wallet_id };
  }

  private async resolveUsdcTokenId(walletId: string): Promise<string> {
    if (this.usdcTokenId) return this.usdcTokenId;
    const balances = await withDeadline(
      this.client.getWalletTokenBalance({ id: walletId }),
      BALANCE_READ_DEADLINE_MS,
      `no answer from Circle getWalletTokenBalance within ${BALANCE_READ_DEADLINE_MS} ms`
    );
    const usdc = balances.data?.tokenBalances?.find((b) => b.token?.symbol === "USDC");
    if (!usdc?.token?.id) {
      throw new Error(
        `Could not resolve the USDC token id from wallet ${walletId}. Fund it with testnet USDC first (see README).`
      );
    }
    this.usdcTokenId = usdc.token.id;
    return this.usdcTokenId;
  }

  /** The token id for a transfer: USDC's as before; EURC's from the wallet's own token list. */
  private async resolveTokenId(walletId: string, token: Stablecoin): Promise<string> {
    if (token === "USDC") return this.resolveUsdcTokenId(walletId);
    const known = this.eurcTokenIds.get(walletId);
    if (known) return known;
    const balances = await withDeadline(
      this.client.getWalletTokenBalance({ id: walletId }),
      BALANCE_READ_DEADLINE_MS,
      `no answer from Circle getWalletTokenBalance within ${BALANCE_READ_DEADLINE_MS} ms`
    );
    const eurc = balances.data?.tokenBalances?.find((b) => b.token?.symbol === "EURC");
    if (!eurc?.token?.id) {
      throw new Error(`Wallet ${walletId} has never held EURC. Fund it with EURC from Circle's faucet first.`);
    }
    this.eurcTokenIds.set(walletId, eurc.token.id);
    return eurc.token.id;
  }

  async transfer(params: TransferParams): Promise<TransferResult> {
    if (params.toAddress.startsWith("sim:")) {
      throw new Error(
        `Counterparty has no on-chain address (${params.toAddress}). Add this counterparty's Arc address on the Counterparties page.`
      );
    }

    const account = await this.account(params.fromAccountId);
    const tokenId = await this.resolveTokenId(account.walletId, params.token ?? "USDC");
    const started = Date.now();

    const created = await withDeadline(
      this.client.createTransaction({
        walletId: account.walletId,
        tokenId,
        destinationAddress: params.toAddress,
        amount: [params.amount.toFixed(6)],
        idempotencyKey: params.idempotencyKey,
        refId: params.memo,
        fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      }),
      CREATE_TRANSACTION_DEADLINE_MS,
      `Circle did not answer createTransaction within ${CREATE_TRANSACTION_DEADLINE_MS} ms; the transfer may or may not have been accepted`
    );

    const txId = created.data?.id;
    if (!txId) throw new Error("Circle did not return a transaction id");

    // Arc settles in well under a second, but Circle's pipeline
    // (INITIATED -> CLEARED -> QUEUED -> SENT -> CONFIRMED -> COMPLETE) is
    // asynchronous. awaitSettlement waits, with a deadline on every request so
    // a cycle cannot block on one payment, and reports failed only when Circle
    // itself reports a terminal state.
    const { status, transaction } = await awaitSettlement(this.client, txId);
    const txHash = transaction?.txHash;
    let feeUsd = ARC_FEE_USD;
    let feeSource: TransferResult["feeSource"] = "provider_estimate";
    let settledInMs: number | null = null;
    if (transaction) {
      const resolved = await resolveFee(this.arcRpcUrl, transaction.networkFeeInUSD, txHash);
      feeUsd = resolved.feeUsd;
      feeSource = resolved.feeSource;
      settledInMs = measuredSettlementMs(transaction);
    }
    if (status === "confirmed" && settledInMs == null) settledInMs = Date.now() - started;

    return {
      providerTxId: txId,
      txHash: txHash ?? null,
      txRef: txHash ?? txId,
      chain: account.chain,
      status,
      feeUsd,
      feeSource,
      providerMode: "live",
      settledInMs,
      providerState: transaction?.state ?? null,
      failureReason: transaction?.errorReason ?? null,
    };
  }

  async reconcileTransfer(providerTxId: string): Promise<TransferResult> {
    const started = Date.now();
    const response = await withDeadline(
      this.client.getTransaction({ id: providerTxId }),
      RECONCILE_TRANSFER_DEADLINE_MS,
      `no answer from Circle getTransaction during reconciliation within ${RECONCILE_TRANSFER_DEADLINE_MS} ms`
    );
    const transaction = response.data?.transaction;
    if (!transaction) throw new Error(`Circle returned no transaction for ${providerTxId}`);

    const confirmed = transaction.state === "CONFIRMED" || transaction.state === "COMPLETE";
    const failed = FAILED_STATES.includes(transaction.state);
    const txHash = transaction.txHash ?? null;
    // Reconciliation is also the backfill path: a transfer that settled before
    // its receipt was readable gets its real fee on the next pass.
    const fee = await resolveFee(this.arcRpcUrl, transaction.networkFeeInUSD, txHash ?? undefined);
    return {
      providerTxId,
      txHash,
      txRef: txHash ?? providerTxId,
      chain: transaction.blockchain,
      status: confirmed ? "confirmed" : failed ? "failed" : "pending",
      feeUsd: fee.feeUsd,
      feeSource: fee.feeSource,
      providerMode: "live",
      settledInMs: measuredSettlementMs(transaction) ?? (confirmed ? Date.now() - started : null),
      providerState: transaction.state,
      failureReason: transaction.errorReason ?? null,
    };
  }

  async depositToEarn(): Promise<EarnResult> {
    throw new Error(
      "EarnKit (USYC) live integration needs KIT_KEY plus a selected vault id — see src/lib/circle/liveProvider.ts"
    );
  }

  async withdrawFromEarn(): Promise<EarnResult> {
    throw new Error(
      "EarnKit (USYC) live integration needs KIT_KEY plus a selected vault id — see src/lib/circle/liveProvider.ts"
    );
  }

  getBalance(accountId: string): Promise<BalanceSnapshot> {
    return this.getTokenBalance(accountId, "USDC");
  }

  async getTokenBalance(accountId: string, token: Stablecoin): Promise<BalanceSnapshot> {
    const account = await this.account(accountId);
    const balances = await withDeadline(
      this.client.getWalletTokenBalance({ id: account.walletId }),
      BALANCE_READ_DEADLINE_MS,
      `no answer from Circle getWalletTokenBalance within ${BALANCE_READ_DEADLINE_MS} ms`
    );
    const held = balances.data?.tokenBalances?.find((b) => b.token?.symbol === token);
    return {
      accountId,
      chain: account.chain,
      token,
      balance: held ? Number(held.amount) : 0,
    };
  }
}
