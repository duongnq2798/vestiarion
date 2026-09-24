import {
  initiateDeveloperControlledWalletsClient,
  type CircleDeveloperControlledWalletsClient,
} from "@circle-fin/developer-controlled-wallets";
import { supabase, unwrap } from "../supabase";
import type {
  BalanceSnapshot,
  ChainProvider,
  EarnResult,
  TransferParams,
  TransferResult,
} from "./types";
import { ARC_FEE_USD } from "./types";

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
 * Real Arc-testnet implementation over Circle's Developer-Controlled Wallets
 * SDK. Activated automatically by `./index.ts` once CIRCLE_API_KEY and
 * CIRCLE_ENTITY_SECRET are set.
 *
 * Per-account Circle wallet ids come from the `accounts` table, populated by
 * `npm run bootstrap:circle`. The USDC token id is discovered from the
 * wallet's own balances the first time it is needed, so no hand-copied UUID
 * has to stay in sync with the environment.
 */
export class LiveProvider implements ChainProvider {
  readonly mode = "live" as const;
  readonly earnMode = "live" as const;
  readonly estimatedFeeUsd = ARC_FEE_USD;
  private client: CircleDeveloperControlledWalletsClient;
  private usdcTokenId?: string;

  constructor() {
    const apiKey = process.env.CIRCLE_API_KEY;
    const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
    if (!apiKey || !entitySecret) {
      throw new Error("LiveProvider requires CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET");
    }
    this.client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
    this.usdcTokenId = process.env.CIRCLE_USDC_TOKEN_ID || undefined;
  }

  private async account(accountId: string): Promise<AccountRow & { walletId: string }> {
    const row = unwrap(
      await supabase()
        .from("accounts")
        .select("id, chain, token, circle_wallet_id")
        .eq("id", accountId)
        .single<AccountRow>()
    );
    if (!row.circle_wallet_id) {
      throw new Error(
        `Account ${accountId} has no circle_wallet_id — run \`npm run bootstrap:circle\` first`
      );
    }
    return { ...row, walletId: row.circle_wallet_id };
  }

  private async resolveUsdcTokenId(walletId: string): Promise<string> {
    if (this.usdcTokenId) return this.usdcTokenId;
    const balances = await this.client.getWalletTokenBalance({ id: walletId });
    const usdc = balances.data?.tokenBalances?.find((b) => b.token?.symbol === "USDC");
    if (!usdc?.token?.id) {
      throw new Error(
        `Could not resolve the USDC token id from wallet ${walletId}. Fund it with testnet USDC first (see README).`
      );
    }
    this.usdcTokenId = usdc.token.id;
    return this.usdcTokenId;
  }

  async transfer(params: TransferParams): Promise<TransferResult> {
    if (params.toAddress.startsWith("sim:")) {
      throw new Error(
        `Counterparty has no on-chain address (${params.toAddress}). Run \`npm run bootstrap:circle\` to give every counterparty a wallet.`
      );
    }

    const account = await this.account(params.fromAccountId);
    const tokenId = await this.resolveUsdcTokenId(account.walletId);
    const started = Date.now();

    const created = await this.client.createTransaction({
      walletId: account.walletId,
      tokenId,
      destinationAddress: params.toAddress,
      amount: [params.amount.toFixed(6)],
      idempotencyKey: params.idempotencyKey,
      refId: params.memo,
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });

    const txId = created.data?.id;
    if (!txId) throw new Error("Circle did not return a transaction id");

    // Arc settles in well under a second, but Circle's pipeline
    // (INITIATED -> CLEARED -> QUEUED -> SENT -> CONFIRMED -> COMPLETE) is
    // asynchronous. The SDK polls for us and rejects on a terminal failure;
    // the abort signal caps how long a cycle can block on one payment.
    let status: TransferResult["status"] = "pending";
    let txHash: string | undefined;
    let feeUsd = ARC_FEE_USD;
    let feeSource: TransferResult["feeSource"] = "provider_estimate";
    let settledInMs: number | null = null;
    try {
      const settled = await this.client.getTransaction({
        id: txId,
        waitForState: "CONFIRMED",
        signal: AbortSignal.timeout(45_000),
      });
      const transaction = settled.data?.transaction;
      const state = transaction?.state;
      txHash = transaction?.txHash;
      status = state === "CONFIRMED" || state === "COMPLETE" ? "confirmed" : "pending";
      const reportedFee = reportedFeeUsd(transaction?.networkFeeInUSD);
      if (reportedFee != null) {
        feeUsd = reportedFee;
        feeSource = "chain_reported";
      }
      settledInMs = transaction ? measuredSettlementMs(transaction) : null;
      if (status === "confirmed" && settledInMs == null) settledInMs = Date.now() - started;
    } catch (err) {
      // A timeout leaves the transfer in flight rather than failed, so those
      // two cases are reported differently — the ledger records which.
      status = (err as Error).name === "TimeoutError" ? "pending" : "failed";
    }

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
    };
  }

  async reconcileTransfer(providerTxId: string): Promise<TransferResult> {
    const started = Date.now();
    const response = await this.client.getTransaction({ id: providerTxId });
    const transaction = response.data?.transaction;
    if (!transaction) throw new Error(`Circle returned no transaction for ${providerTxId}`);

    const confirmed = transaction.state === "CONFIRMED" || transaction.state === "COMPLETE";
    const failed = ["CANCELLED", "DENIED", "FAILED", "STUCK"].includes(transaction.state);
    const txHash = transaction.txHash ?? null;
    const reportedFee = reportedFeeUsd(transaction.networkFeeInUSD);
    return {
      providerTxId,
      txHash,
      txRef: txHash ?? providerTxId,
      chain: transaction.blockchain,
      status: confirmed ? "confirmed" : failed ? "failed" : "pending",
      feeUsd: reportedFee ?? ARC_FEE_USD,
      feeSource: reportedFee == null ? "provider_estimate" : "chain_reported",
      providerMode: "live",
      settledInMs: measuredSettlementMs(transaction) ?? (confirmed ? Date.now() - started : null),
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

  async getBalance(accountId: string): Promise<BalanceSnapshot> {
    const account = await this.account(accountId);
    const balances = await this.client.getWalletTokenBalance({ id: account.walletId });
    const usdc = balances.data?.tokenBalances?.find((b) => b.token?.symbol === "USDC");
    return {
      accountId,
      chain: account.chain,
      token: "USDC",
      balance: usdc ? Number(usdc.amount) : 0,
    };
  }
}
