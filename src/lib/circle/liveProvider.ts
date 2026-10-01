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
import { awaitSettlement, FAILED_STATES, withDeadline, type Settlement } from "./settlement";
import { BridgeFeeError, bridgeFee, bridgeStepKey, burnCalls, forwardedMint, type ContractCall } from "./cctp";
import { burnIntent, burnIntentTypedData, estimateGateway, gatewaySalt, gatewayTransferStatus, submitGatewayTransfer, type GatewayTransferStatus } from "./gateway";
import { payeeChain, paidAcrossChains } from "../payee-chains";
import type { ChainConfig } from "../config";

export type LiveProviderClient = Pick<
  CircleDeveloperControlledWalletsClient,
  "createTransaction" | "getWalletTokenBalance" | "getTransaction" | "createContractExecutionTransaction" | "signTypedData"
>;

/**
 * How long a bridge waits for the Forwarding Service's mint before reporting
 * the payment in flight: Circle documents 8–20 s for a fast transfer. Kept to
 * that so a cycle's bridges stay inside the tick's time budget (review I6).
 */
export const BRIDGE_MINT_WAIT_MS = 20_000;
const BRIDGE_MINT_POLL_MS = 3_000;
/** A bridge's provider id: its burn, or its approve when the burn was never sent (X9). */
const BURN_ID = "cctp:";
const APPROVE_ID = "cctp-approve:";
const GATEWAY_ID = "gateway:";

/**
 * The state a Gateway payout is recorded with (review I2). An expired attestation can never be
 * minted, so no money left the Gateway balance: it is Circle's `FAILED`, which a person may pay
 * again as a new attempt, under a new salt. A failed transfer may still be minted with its
 * attestation: `GATEWAY_FAILED` is never a reason to send again. Otherwise Gateway's own word.
 */
function gatewayProviderState(transfer: GatewayTransferStatus): string {
  if (transfer.state === "expired") return "FAILED";
  if (transfer.state === "failed") return "GATEWAY_FAILED";
  return transfer.status;
}

const CREATE_TRANSACTION_DEADLINE_MS = 20_000;
const BALANCE_READ_DEADLINE_MS = 15_000;
const RECONCILE_TRANSFER_DEADLINE_MS = 15_000;

interface AccountRow {
  id: string;
  chain: string;
  token: string;
  circle_wallet_id: string | null;
  address?: string | null;
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
  /** Iris, for a bridge's fee and its mint. */
  private readonly fetch?: typeof fetch;
  private readonly bridgeMintWaitMs: number;

  /**
   * Takes its credentials rather than reading them. Two businesses with two
   * sets of Circle wallets can then exist in one process, which a constructor
   * that consulted `process.env` made impossible.
   */
  constructor(chain: ChainConfig, options: { client?: LiveProviderClient; fetch?: typeof fetch; bridgeMintWaitMs?: number } = {}) {
    if (!chain.circleApiKey || !chain.circleEntitySecret) {
      throw new Error("LiveProvider requires a Circle API key and entity secret");
    }
    this.client = options.client ?? initiateDeveloperControlledWalletsClient({
      apiKey: chain.circleApiKey,
      entitySecret: chain.circleEntitySecret,
    });
    this.usdcTokenId = chain.usdcTokenId;
    this.arcRpcUrl = chain.arcRpcUrl;
    this.fetch = options.fetch;
    this.bridgeMintWaitMs = options.bridgeMintWaitMs ?? BRIDGE_MINT_WAIT_MS;
  }

  private async account(accountId: string): Promise<AccountRow & { walletId: string }> {
    const row = unwrap(
      await db()
        .from("accounts")
        .select("id, chain, token, circle_wallet_id, address")
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
    if (params.route === "escrow") return this.escrowRelease(params, account);
    if (paidAcrossChains(params.destinationChain)) {
      return params.route === "gateway" ? this.gatewayPayout(params, account) : this.bridge(params, account);
    }
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

  /**
   * Pays a milestone locked in escrow by releasing its hold (milestone escrow E4): `release(bytes32)` on the
   * workspace's escrow contract, from the operating wallet (the contract's payer), under the attempt's key. The
   * contract sends the hold to its payee, once; a second release reverts. A plain Circle transaction, so
   * reconciliation reads it as it reads a transfer.
   */
  private async escrowRelease(params: TransferParams, account: { walletId: string; chain: string }): Promise<TransferResult> {
    if (!params.escrow) throw new Error("An escrow release names no hold; nothing was sent.");
    const started = Date.now();
    const created = await withDeadline(
      this.client.createContractExecutionTransaction({
        walletId: account.walletId,
        contractAddress: params.escrow.contract,
        abiFunctionSignature: "release(bytes32)",
        abiParameters: [params.escrow.holdId],
        idempotencyKey: params.idempotencyKey,
        refId: params.memo,
        fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      }),
      CREATE_TRANSACTION_DEADLINE_MS,
      `Circle did not answer the escrow release within ${CREATE_TRANSACTION_DEADLINE_MS} ms; it may or may not have been accepted`
    );
    const txId = created.data?.id;
    if (!txId) throw new Error("Circle did not return a transaction id");
    const { status, transaction } = await awaitSettlement(this.client, txId);
    const txHash = transaction?.txHash ?? null;
    const fee = transaction ? await resolveFee(this.arcRpcUrl, transaction.networkFeeInUSD, txHash ?? undefined) : { feeUsd: ARC_FEE_USD, feeSource: "provider_estimate" as const };
    return {
      providerTxId: txId,
      txHash,
      txRef: txHash ?? txId,
      chain: account.chain,
      status,
      feeUsd: fee.feeUsd,
      feeSource: fee.feeSource,
      providerMode: "live",
      settledInMs: status === "confirmed" ? (transaction ? (measuredSettlementMs(transaction) ?? Date.now() - started) : Date.now() - started) : null,
      providerState: transaction?.state ?? null,
      failureReason: transaction?.errorReason ?? null,
      route: "escrow",
    };
  }

  /**
   * Pays a payee on another chain through CCTP V2 with the Forwarding Service
   * (CCTP payouts X2, X8, X9): approve TokenMessengerV2 for the amount and the
   * fee, then burn both with the forwarding hook, each under a key derived
   * from the attempt's, so the same attempt never burns twice. The burn is on
   * Arc; Circle submits the mint, which is waited for briefly here and then
   * left to reconciliation.
   */
  private async bridge(params: TransferParams, account: AccountRow & { walletId: string }): Promise<TransferResult> {
    if ((params.token ?? "USDC") !== "USDC") {
      throw new Error("Only USDC crosses chains through CCTP; a EURC payment is paid on Arc testnet only.");
    }
    const chain = payeeChain(params.destinationChain);
    const fee = await bridgeFee(chain.id, params.amount, { fetch: this.fetch });
    // The fee is read again here, just before the burn; one above what this
    // payment may pay sends nothing (review I4).
    if (params.maxBridgeFeeUsdc != null && fee.feeUsdc > params.maxBridgeFeeUsdc) {
      throw new BridgeFeeError(
        `The CCTP fee to ${chain.label}, ${fee.feeUsdc} USDC, is above the ${params.maxBridgeFeeUsdc} USDC this payment may pay; nothing was sent.`
      );
    }
    const [approve, burn] = burnCalls({ amount: params.amount, maxFeeUnits: fee.maxFeeUnits, domain: fee.domain, recipient: params.toAddress });
    const started = Date.now();
    const base = { chain: account.chain, providerMode: "live" as const, destinationChain: chain.id, bridgeFeeUsdc: fee.feeUsdc };

    // A failed approve moved nothing; one Circle has not confirmed yet is
    // thrown, so the next attempt sends the same approve, and Circle answers
    // with the one it has.
    const approveId = await this.execute(account.walletId, approve, bridgeStepKey(params.idempotencyKey, "approve"), params.memo);
    const approved = await awaitSettlement(this.client, approveId);
    if (approved.status === "failed") {
      return this.bridgeResult(`${APPROVE_ID}${approveId}`, approved, base, null, started);
    }
    if (approved.status !== "confirmed") throw new Error("Circle has not confirmed the approval for the bridge yet; nothing was burned");

    const burnId = await this.execute(account.walletId, burn, bridgeStepKey(params.idempotencyKey, "burn"), params.memo);
    const burned = await awaitSettlement(this.client, burnId);
    const mint = burned.status === "confirmed" && burned.transaction?.txHash ? await this.awaitMint(burned.transaction.txHash) : null;
    return this.bridgeResult(`${BURN_ID}${burnId}`, burned, base, mint, started);
  }

  /**
   * Pays a payee on another chain from the workspace's Gateway balance
   * (Gateway payouts G3): the Gateway signer signs a burn intent whose salt
   * comes from the attempt's key, Gateway's API takes it with the Forwarding
   * Service, and Circle mints on the payee's chain. Every attempt under the
   * same key asks for the same transfer, which GatewayWallet spends once, so
   * sending it again can never pay twice. Nothing leaves the operating wallet:
   * the balance was deposited when the workspace funded it.
   */
  private async gatewayPayout(params: TransferParams, account: AccountRow & { walletId: string }): Promise<TransferResult> {
    if ((params.token ?? "USDC") !== "USDC") {
      throw new Error("Only USDC crosses chains through Gateway; a EURC payment is paid on Arc testnet only.");
    }
    const chain = payeeChain(params.destinationChain);
    const found = await db().from("gateway_signers").select("circle_wallet_id, address").maybeSingle();
    if (found.error) throw new Error(found.error.message);
    const signer = found.data as { circle_wallet_id: string; address: string } | null;
    if (!signer) throw new Error("This workspace has no Gateway balance yet: an owner or admin funds one on Treasury.");
    if (!account.address) throw new Error("The operating wallet has no address; nothing was sent.");

    const payout = { depositor: account.address, signer: signer.address, recipient: params.toAddress, chain: chain.id, amount: params.amount, salt: gatewaySalt(params.idempotencyKey) };
    const estimate = await estimateGateway(payout, { fetch: this.fetch });
    // The fee is read here, just before the payout; one above what this payment may pay sends nothing.
    // Weighed as the larger of the fee Gateway quotes and the fee the intent is signed to allow (review M2).
    const signedFeeUsdc = Math.max(estimate.feeUsdc, Number(estimate.maxFee) / 1_000_000);
    if (params.maxBridgeFeeUsdc != null && signedFeeUsdc > params.maxBridgeFeeUsdc) {
      throw new BridgeFeeError(
        `The Gateway fee to ${chain.label}, ${signedFeeUsdc} USDC, is above the ${params.maxBridgeFeeUsdc} USDC this payment may pay; nothing was sent.`
      );
    }
    const intent = burnIntent({ ...payout, maxFee: estimate.maxFee, maxBlockHeight: estimate.maxBlockHeight });
    const signed = await withDeadline(
      this.client.signTypedData({ walletId: signer.circle_wallet_id, data: JSON.stringify(burnIntentTypedData(intent)), memo: params.memo }),
      CREATE_TRANSACTION_DEADLINE_MS,
      `Circle did not sign the Gateway transfer within ${CREATE_TRANSACTION_DEADLINE_MS} ms; nothing was sent`
    );
    const signature = signed.data?.signature;
    if (!signature) throw new Error("Circle returned no signature for the Gateway transfer; nothing was sent");

    const started = Date.now();
    const transferId = await submitGatewayTransfer(intent, signature, { fetch: this.fetch });
    // From here the transfer exists: a status read that fails leaves it in flight, for
    // reconciliation to read, never recorded as not sent (review I1).
    let status: GatewayTransferStatus;
    try {
      status = await this.awaitGatewayMint(transferId);
    } catch {
      status = { status: "pending", state: "pending", mintTxHash: null, failureReason: null, destinationChain: chain.id };
    }
    return this.gatewayResult(`${GATEWAY_ID}${transferId}`, status, chain.id, estimate.feeUsdc, started);
  }

  /** A Gateway transfer's status, read until it is minted or failed, or the wait runs out. */
  private async awaitGatewayMint(transferId: string): Promise<GatewayTransferStatus> {
    const deadline = Date.now() + this.bridgeMintWaitMs;
    for (;;) {
      const status = await gatewayTransferStatus(transferId, { fetch: this.fetch });
      if (status.status !== "pending" || Date.now() + BRIDGE_MINT_POLL_MS > deadline) return status;
      await new Promise((resolve) => setTimeout(resolve, BRIDGE_MINT_POLL_MS));
    }
  }

  private gatewayResult(providerTxId: string, transfer: GatewayTransferStatus, destinationChain: string | null, feeUsdc: number | null, started: number | null): TransferResult {
    // Paid once the payee has the money: on the mint, as a CCTP payout is (R5 there).
    const chain = transfer.destinationChain ?? destinationChain;
    return {
      providerTxId,
      txHash: transfer.mintTxHash,
      txRef: transfer.mintTxHash ?? providerTxId,
      // The mint is on the payee's chain, and no Arc transaction belongs to one payout: Gateway burns in batches (G5).
      // Unknown on a reconcile whose answer named no chain: left as recorded (review M3).
      chain: chain ?? "",
      status: transfer.status,
      feeUsd: 0,
      feeSource: "provider_estimate",
      providerMode: "live",
      settledInMs: transfer.status === "confirmed" && started !== null ? Date.now() - started : null,
      providerState: gatewayProviderState(transfer),
      failureReason: transfer.failureReason,
      mintTxHash: transfer.mintTxHash,
      destinationChain: chain,
      ...(feeUsdc != null ? { bridgeFeeUsdc: feeUsdc } : {}),
      route: "gateway",
    };
  }

  private async execute(walletId: string, call: ContractCall, idempotencyKey: string, memo: string | undefined): Promise<string> {
    const created = await withDeadline(
      this.client.createContractExecutionTransaction({
        walletId,
        contractAddress: call.contractAddress,
        abiFunctionSignature: call.abiFunctionSignature,
        abiParameters: call.abiParameters,
        idempotencyKey,
        refId: memo,
        fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      }),
      CREATE_TRANSACTION_DEADLINE_MS,
      `Circle did not answer createContractExecutionTransaction within ${CREATE_TRANSACTION_DEADLINE_MS} ms; it may or may not have been accepted`
    );
    const id = created.data?.id;
    if (!id) throw new Error("Circle did not return a transaction id");
    return id;
  }

  /** The Forwarding Service's mint for a burn, read from Iris until it appears or the wait runs out. */
  private async awaitMint(burnTxHash: string): Promise<string | null> {
    const deadline = Date.now() + this.bridgeMintWaitMs;
    for (;;) {
      const mint = await forwardedMint(burnTxHash, { fetch: this.fetch });
      if (mint) return mint.mintTxHash;
      if (Date.now() + BRIDGE_MINT_POLL_MS > deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, BRIDGE_MINT_POLL_MS));
    }
  }

  private async bridgeResult(
    providerTxId: string,
    settlement: Settlement,
    base: { chain: string; providerMode: "live"; destinationChain: string | null; bridgeFeeUsdc: number | null },
    mintTxHash: string | null,
    started: number
  ): Promise<TransferResult> {
    const transaction = settlement.transaction;
    const txHash = transaction?.txHash ?? null;
    const fee = await resolveFee(this.arcRpcUrl, transaction?.networkFeeInUSD, txHash ?? undefined);
    // Paid once the payee has the money: on the mint, not on the burn (R5).
    const status = settlement.status === "failed" ? "failed" : settlement.status === "confirmed" && mintTxHash ? "confirmed" : "pending";
    return {
      ...base,
      providerTxId,
      txHash,
      txRef: txHash ?? providerTxId,
      status,
      feeUsd: fee.feeUsd,
      feeSource: fee.feeSource,
      settledInMs: status === "confirmed" ? (transaction ? measuredSettlementMs(transaction) : null) ?? Date.now() - started : null,
      providerState: transaction?.state ?? null,
      failureReason: transaction?.errorReason ?? null,
      mintTxHash,
    };
  }

  async reconcileTransfer(providerTxId: string): Promise<TransferResult> {
    if (providerTxId.startsWith(BURN_ID) || providerTxId.startsWith(APPROVE_ID)) return this.reconcileBridge(providerTxId);
    // A Gateway payout, read again: it signs and sends nothing (G4).
    if (providerTxId.startsWith(GATEWAY_ID)) {
      const status = await gatewayTransferStatus(providerTxId.slice(GATEWAY_ID.length), { fetch: this.fetch });
      return this.gatewayResult(providerTxId, status, null, null, null);
    }
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

  /**
   * A bridge, read again: its burn (or, when the burn was never sent, its
   * approve) from Circle, and the mint from Iris. It sends nothing (X9).
   */
  private async reconcileBridge(providerTxId: string): Promise<TransferResult> {
    const started = Date.now();
    const isBurn = providerTxId.startsWith(BURN_ID);
    const id = providerTxId.slice(isBurn ? BURN_ID.length : APPROVE_ID.length);
    const response = await withDeadline(
      this.client.getTransaction({ id }),
      RECONCILE_TRANSFER_DEADLINE_MS,
      `no answer from Circle getTransaction during reconciliation within ${RECONCILE_TRANSFER_DEADLINE_MS} ms`
    );
    const transaction = response.data?.transaction;
    if (!transaction) throw new Error(`Circle returned no transaction for ${providerTxId}`);
    const confirmed = transaction.state === "CONFIRMED" || transaction.state === "COMPLETE";
    const settlement: Settlement = { status: confirmed ? "confirmed" : FAILED_STATES.includes(transaction.state) ? "failed" : "pending", transaction };
    // An approve that confirmed while its burn was never sent is still in
    // flight: only a person's approval, sending the same attempt, burns.
    if (!isBurn) return this.bridgeResult(providerTxId, settlement.status === "failed" ? settlement : { status: "pending", transaction }, { chain: transaction.blockchain, providerMode: "live", destinationChain: null, bridgeFeeUsdc: null }, null, started);
    const mint = confirmed && transaction.txHash ? await forwardedMint(transaction.txHash, { fetch: this.fetch }) : null;
    return this.bridgeResult(providerTxId, settlement, { chain: transaction.blockchain, providerMode: "live", destinationChain: null, bridgeFeeUsdc: null }, mint?.mintTxHash ?? null, started);
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
