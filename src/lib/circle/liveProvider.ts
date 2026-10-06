import {
  initiateDeveloperControlledWalletsClient,
  type CircleDeveloperControlledWalletsClient,
} from "@circle-fin/developer-controlled-wallets";
import { db, unwrap } from "../dal";
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
  SwapStep,
  TransferParams,
  TransferResult,
  SpendingLimitPayment,
} from "./types";
import { ARC_FEE_USD } from "./types";
import { fetchArcFeeUsd, rpcUrlFor } from "./arcFees";
import { FeatureOffError, type NetworkProfile } from "../network";
import { awaitSettlement, FAILED_STATES, MAY_HAVE_BEEN_ACCEPTED, withDeadline, type Settlement } from "./settlement";
import { circleHttpStatus } from "./check";
import { batchCalls, BatchNotSentError, SCA_EXECUTE_BATCH } from "./batch";
import { stablecoinEntry, stablecoinOf } from "./stablecoins";
import { PAYMENTS_OFF, PaymentsDisabledError } from "../payments-switch";
import { BridgeFeeError, bridgeFee, bridgeStepKey, burnCalls, cctpOf, forwardedMint, type ContractCall } from "./cctp";
import { burnIntent, burnIntentTypedData, estimateGateway, gatewaySalt, gatewayTransferStatus, submitGatewayTransfer, type GatewayTransferStatus } from "./gateway";
import { chainOn, paidAcrossChains } from "../payee-chains";
import { toBaseUnits } from "../fx/quote";
import { PAY_SIGNATURE, usdcUnits } from "../spending-limit/onchain";
import type { ChainConfig } from "../config";
import {
  fromUnits,
  priceValue,
  readUsycApy,
  readUsycPrice,
  readUsycShares,
  sharesToRedeem,
  sharesValue,
  toUnits as usycUnits,
  usycOf,
  usycStepKey,
  usycSubscriptionsOpen,
  UsycNotConfirmedError,
  UsycSubscriptionsClosedError,
} from "./usyc";

export type LiveProviderClient = Pick<
  CircleDeveloperControlledWalletsClient,
  "createTransaction" | "getWalletTokenBalance" | "getTransaction" | "createContractExecutionTransaction" | "signTypedData" | "listTransactions"
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

/** Connection failures in which the request never left, so Circle cannot hold it (payment safety R1). */
const NEVER_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"]);

/**
 * Sends a write that moves money, under the deadline, and returns the id Circle gave it (payment safety R1). When
 * Circle never says what became of it — the deadline runs out, the connection drops after the request left, Circle
 * answers 5xx, or it answers with no id — the error says it may or may not have been accepted: Circle may hold it
 * under its idempotency key, so nothing closes over it, and the same write sent again under that key returns it
 * rather than repeats it. A refusal (4xx), a connection never made, and an error that is not an HTTP one keep their
 * own words. The SDK's errors carry an HTTP `status` when Circle answered, and a network `code` when it did not.
 * A write that moves no money (`movesMoney` false: a bridge's approve) says so instead, since nothing could have left
 * (payment safety R8).
 */
async function sendToCircle(work: Promise<{ data?: { id?: string } }>, what: string, subject = "it", movesMoney = true): Promise<string> {
  const unknown = movesMoney ? `${subject} ${MAY_HAVE_BEEN_ACCEPTED}` : `${subject} moved no money`;
  let created: { data?: { id?: string } };
  try {
    created = await withDeadline(work, CREATE_TRANSACTION_DEADLINE_MS, `Circle did not answer ${what} within ${CREATE_TRANSACTION_DEADLINE_MS} ms; ${unknown}`);
  } catch (error) {
    const status = circleHttpStatus(error);
    const code = (error as { code?: unknown } | null)?.code;
    if (status !== undefined && status >= 500) throw new Error(`Circle answered ${what} with HTTP ${status}, which does not say what became of it; ${unknown}`);
    if (status === undefined && typeof code === "string" && !NEVER_SENT.has(code)) throw new Error(`Circle did not answer ${what} (${code}); ${unknown}`);
    throw error;
  }
  const id = created.data?.id;
  if (!id) throw new Error(`Circle answered ${what} with no transaction id; ${unknown}`);
  return id;
}

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
  rpcUrl: string,
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

  /** The network it pays on (network threading P2): every chain fact below is this profile's. */
  readonly network: NetworkProfile;
  /** Its network's RPC; ARC_RPC_URL replaces Arc testnet's only. */
  private readonly rpcUrl: string;
  /** Iris, for a bridge's fee and its mint. */
  private readonly fetch?: typeof fetch;
  private readonly bridgeMintWaitMs: number;

  /**
   * Takes its credentials rather than reading them. Two businesses with two
   * sets of Circle wallets can then exist in one process, which a constructor
   * that consulted `process.env` made impossible.
   */
  /**
   * The platform's stop switch (payment safety S2, S7), and the workspace's network hold (mainnet go-live M4): every
   * way of moving money refuses, with the reason, before an account is read. `getChainProvider` hands it the hold to
   * read at each call; a test may hand it a fixed answer.
   */
  private readonly paymentsHold: () => Promise<string | null>;

  constructor(
    chain: ChainConfig,
    options: {
      network: NetworkProfile;
      client?: LiveProviderClient;
      fetch?: typeof fetch;
      bridgeMintWaitMs?: number;
      /** True, or the reason as words, while payments may not move; a function is read at each call. */
      paymentsDisabled?: boolean | (() => Promise<boolean | string | null>);
    }
  ) {
    if (!chain.circleApiKey || !chain.circleEntitySecret) {
      throw new Error("LiveProvider requires a Circle API key and entity secret");
    }
    this.client = options.client ?? initiateDeveloperControlledWalletsClient({
      apiKey: chain.circleApiKey,
      entitySecret: chain.circleEntitySecret,
    });
    this.usdcTokenId = chain.usdcTokenId;
    this.network = options.network;
    this.rpcUrl = rpcUrlFor(this.network, chain.arcRpcUrl);
    this.fetch = options.fetch;
    this.bridgeMintWaitMs = options.bridgeMintWaitMs ?? BRIDGE_MINT_WAIT_MS;
    const off = options.paymentsDisabled;
    const reasonOf = (answer: boolean | string | null | undefined): string | null =>
      typeof answer === "string" ? answer : answer === true ? PAYMENTS_OFF : null;
    this.paymentsHold = typeof off === "function" ? async () => reasonOf(await off()) : async () => reasonOf(off);
  }

  private async refuseWhilePaymentsOff(): Promise<void> {
    const hold = await this.paymentsHold();
    if (hold) throw new PaymentsDisabledError(hold);
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

  private async resolveUsdcTokenId(walletId: string, chain: string): Promise<string> {
    if (this.usdcTokenId) return this.usdcTokenId;
    const balances = await withDeadline(
      this.client.getWalletTokenBalance({ id: walletId }),
      BALANCE_READ_DEADLINE_MS,
      `no answer from Circle getWalletTokenBalance within ${BALANCE_READ_DEADLINE_MS} ms`
    );
    // By its contract, never its symbol (mainnet go-live M7): a token anyone named "USDC" is never sent.
    const usdc = stablecoinEntry(balances.data?.tokenBalances, "USDC", this.network, chain);
    if (!usdc?.token?.id) {
      throw new Error(`Could not resolve the USDC token id from wallet ${walletId}. Fund it with USDC on ${this.network.label} first (see README).`);
    }
    this.usdcTokenId = usdc.token.id;
    return this.usdcTokenId;
  }

  /** The token id for a transfer: USDC's as before; EURC's from the wallet's own token list. */
  private async resolveTokenId(walletId: string, token: Stablecoin, chain: string): Promise<string> {
    if (token === "USDC") return this.resolveUsdcTokenId(walletId, chain);
    const known = this.eurcTokenIds.get(walletId);
    if (known) return known;
    const balances = await withDeadline(
      this.client.getWalletTokenBalance({ id: walletId }),
      BALANCE_READ_DEADLINE_MS,
      `no answer from Circle getWalletTokenBalance within ${BALANCE_READ_DEADLINE_MS} ms`
    );
    const eurc = stablecoinEntry(balances.data?.tokenBalances, "EURC", this.network, chain);
    if (!eurc?.token?.id) {
      throw new Error(`Wallet ${walletId} has never held EURC. Fund it with EURC from Circle's faucet first.`);
    }
    this.eurcTokenIds.set(walletId, eurc.token.id);
    return eurc.token.id;
  }

  async transfer(params: TransferParams): Promise<TransferResult> {
    await this.refuseWhilePaymentsOff();
    if (params.toAddress.startsWith("sim:")) {
      throw new Error(
        `Counterparty has no on-chain address (${params.toAddress}). Add this counterparty's Arc address on the Counterparties page.`
      );
    }

    if (params.spendingLimit) return this.spendingLimitPay(params, params.spendingLimit);
    const account = await this.account(params.fromAccountId);
    if (params.route === "escrow") return this.escrowRelease(params, account);
    if (paidAcrossChains(params.destinationChain)) {
      return params.route === "gateway" ? this.gatewayPayout(params, account) : this.bridge(params, account);
    }
    const tokenId = await this.resolveTokenId(account.walletId, params.token ?? "USDC", account.chain);
    const started = Date.now();

    const txId = await sendToCircle(
      this.client.createTransaction({
        walletId: account.walletId,
        tokenId,
        destinationAddress: params.toAddress,
        amount: [params.amount.toFixed(6)],
        idempotencyKey: params.idempotencyKey,
        refId: params.memo,
        fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      }),
      "createTransaction",
      "the transfer"
    );

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
      const resolved = await resolveFee(this.rpcUrl, transaction.networkFeeInUSD, txHash);
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
   * Several USDC transfers on Arc testnet in one transaction (batch payouts §2): a contract execution of the
   * operating wallet's own `executeBatch`, as Circle documents for its smart accounts. The wallet calls
   * `USDC.transfer` once per payment, as itself, and reverts them all if one fails. The batch's key is
   * Circle's idempotency key and the transaction's refId (R3, R5). The result is the whole transaction's:
   * its fee is the batch's, shared by the caller (R6). A batch that cannot be built throws
   * `BatchNotSentError` before Circle is called.
   */
  async batchTransfer(params: BatchTransferParams): Promise<TransferResult> {
    // Nothing leaves: the batch is undone and each payment sent alone, which `transfer` refuses in turn (R4).
    const hold = await this.paymentsHold();
    if (hold) throw new BatchNotSentError(hold.replace(/\.$/, ""));
    // A batch is the smart account's own executeBatch, which an EOA does not have (mainnet go-live M6).
    if (this.network.walletAccountType !== "SCA") throw new BatchNotSentError(new FeatureOffError("Paying in one batch", this.network).message);
    const unpaid = params.transfers.find((transfer) => transfer.toAddress.startsWith("sim:"));
    if (unpaid) {
      throw new BatchNotSentError(`Counterparty has no on-chain address (${unpaid.toAddress}). Add this counterparty's Arc address on the Counterparties page`);
    }
    const calls = batchCalls(params.transfers, this.network.tokens.USDC);
    let account: AccountRow & { walletId: string };
    try {
      account = await this.account(params.fromAccountId);
    } catch (error) {
      throw new BatchNotSentError(error instanceof Error ? error.message.replace(/\.$/, "") : "The operating wallet could not be read");
    }
    if (!account.address) throw new BatchNotSentError("The operating wallet's address is not known");
    const started = Date.now();
    const txId = await sendToCircle(
      this.client.createContractExecutionTransaction({
        walletId: account.walletId,
        // The wallet itself: Circle runs `executeBatch` on the smart account rather than wrapping it in `execute`.
        contractAddress: account.address,
        abiFunctionSignature: SCA_EXECUTE_BATCH,
        abiParameters: [calls],
        idempotencyKey: params.idempotencyKey,
        refId: params.idempotencyKey,
        fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      } as Parameters<LiveProviderClient["createContractExecutionTransaction"]>[0]),
      "the batch"
    );
    const { status, transaction } = await awaitSettlement(this.client, txId);
    const txHash = transaction?.txHash ?? null;
    const fee = transaction ? await resolveFee(this.rpcUrl, transaction.networkFeeInUSD, txHash ?? undefined) : { feeUsd: ARC_FEE_USD, feeSource: "provider_estimate" as const };
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
    };
  }

  /**
   * A send whose answer was lost, found by its refId among the wallet's transactions created within the window,
   * and read again: a batch (batch payouts R5), or one payment (payment safety R4). It sends nothing. The wallet is
   * the account's unless `walletId` names another, and `exclude` leaves out transactions already known. Circle
   * lists 50 at most: a full page without it cannot say the send is not there, so that throws rather than answer null.
   */
  async findTransferByRef(
    fromAccountId: string,
    refId: string,
    window: { from: string; to: string },
    options: { walletId?: string; exclude?: string[] } = {}
  ): Promise<TransferResult | null> {
    const walletId = options.walletId ?? (await this.account(fromAccountId)).walletId;
    const excluded = new Set(options.exclude ?? []);
    const listed = await withDeadline(
      this.client.listTransactions({
        walletIds: [walletId],
        from: window.from,
        to: window.to,
        pageSize: 50,
      } as Parameters<LiveProviderClient["listTransactions"]>[0]),
      BALANCE_READ_DEADLINE_MS,
      `no answer from Circle listTransactions within ${BALANCE_READ_DEADLINE_MS} ms`
    );
    const transactions = listed.data?.transactions ?? [];
    const found = transactions.find((transaction) => transaction.refId === refId && !excluded.has(transaction.id));
    if (found) return this.reconcileTransfer(found.id);
    if (transactions.length >= 50) throw new Error("Circle listed 50 transactions around the batch without it; it could not be looked for in full");
    return null;
  }

  /**
   * Pays through the workspace's spending limit contract (onchain spending limit R3, R12): `pay` from the agent's
   * own wallet, which holds no USDC, so the contract draws the amount from the operating wallet within the daily and
   * 7-day figures, and pays each ref once. Only USDC on Arc goes this way; anything else sends nothing. A plain Circle
   * transaction, so reconciliation reads it as it reads a transfer.
   */
  private async spendingLimitPay(params: TransferParams, limit: SpendingLimitPayment): Promise<TransferResult> {
    if ((params.token ?? "USDC") !== "USDC" || paidAcrossChains(params.destinationChain) || params.route || params.escrow) {
      throw new Error("Only USDC paid on Arc testnet goes through the spending limit contract; nothing was sent.");
    }
    const started = Date.now();
    const txId = await sendToCircle(
      this.client.createContractExecutionTransaction({
        walletId: limit.agentWalletId,
        contractAddress: limit.contract,
        abiFunctionSignature: PAY_SIGNATURE,
        abiParameters: [params.toAddress, usdcUnits(params.amount).toString(), limit.ref],
        idempotencyKey: params.idempotencyKey,
        refId: params.memo,
        fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      }),
      "the payment through the spending limit contract"
    );
    const { status, transaction } = await awaitSettlement(this.client, txId);
    const txHash = transaction?.txHash ?? null;
    const fee = transaction ? await resolveFee(this.rpcUrl, transaction.networkFeeInUSD, txHash ?? undefined) : { feeUsd: ARC_FEE_USD, feeSource: "provider_estimate" as const };
    return {
      providerTxId: txId,
      txHash,
      txRef: txHash ?? txId,
      chain: this.network.circleBlockchain,
      status,
      feeUsd: fee.feeUsd,
      feeSource: fee.feeSource,
      providerMode: "live",
      settledInMs: status === "confirmed" ? (transaction ? (measuredSettlementMs(transaction) ?? Date.now() - started) : Date.now() - started) : null,
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
    const txId = await sendToCircle(
      this.client.createContractExecutionTransaction({
        walletId: account.walletId,
        contractAddress: params.escrow.contract,
        abiFunctionSignature: "release(bytes32)",
        abiParameters: [params.escrow.holdId],
        idempotencyKey: params.idempotencyKey,
        refId: params.memo,
        fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      }),
      "the escrow release"
    );
    const { status, transaction } = await awaitSettlement(this.client, txId);
    const txHash = transaction?.txHash ?? null;
    const fee = transaction ? await resolveFee(this.rpcUrl, transaction.networkFeeInUSD, txHash ?? undefined) : { feeUsd: ARC_FEE_USD, feeSource: "provider_estimate" as const };
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
    const chain = chainOn(this.network.id, params.destinationChain);
    const fee = await bridgeFee(this.network, chain.id, params.amount, { fetch: this.fetch });
    // The fee is read again here, just before the burn; one above what this
    // payment may pay sends nothing (review I4).
    if (params.maxBridgeFeeUsdc != null && fee.feeUsdc > params.maxBridgeFeeUsdc) {
      throw new BridgeFeeError(
        `The CCTP fee to ${chain.label}, ${fee.feeUsdc} USDC, is above the ${params.maxBridgeFeeUsdc} USDC this payment may pay; nothing was sent.`
      );
    }
    const [approve, burn] = burnCalls({ amount: params.amount, maxFeeUnits: fee.maxFeeUnits, domain: fee.domain, recipient: params.toAddress, usdc: this.network.tokens.USDC, tokenMessenger: cctpOf(this.network).tokenMessenger });
    const started = Date.now();
    const base = { chain: account.chain, providerMode: "live" as const, destinationChain: chain.id, bridgeFeeUsdc: fee.feeUsdc };

    // A failed approve moved nothing; one Circle has not confirmed yet is
    // thrown, so the next attempt sends the same approve, and Circle answers
    // with the one it has.
    // The approve moves no money: one Circle did not answer is never a payment that may exist (R8).
    const approveId = await this.execute(account.walletId, approve, bridgeStepKey(params.idempotencyKey, "approve"), params.memo, {
      what: "the approve for the bridge",
      movesMoney: false,
    });
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
    const chain = chainOn(this.network.id, params.destinationChain);
    const found = await db().from("gateway_signers").select("circle_wallet_id, address").maybeSingle();
    if (found.error) throw new Error(found.error.message);
    const signer = found.data as { circle_wallet_id: string; address: string } | null;
    if (!signer) throw new Error("This workspace has no Gateway balance yet: an owner or admin funds one on Treasury.");
    if (!account.address) throw new Error("The operating wallet has no address; nothing was sent.");

    const payout = { depositor: account.address, signer: signer.address, recipient: params.toAddress, chain: chain.id, amount: params.amount, salt: gatewaySalt(params.idempotencyKey) };
    const estimate = await estimateGateway(this.network, payout, { fetch: this.fetch });
    // The fee is read here, just before the payout; one above what this payment may pay sends nothing.
    // Weighed as the larger of the fee Gateway quotes and the fee the intent is signed to allow (review M2).
    const signedFeeUsdc = Math.max(estimate.feeUsdc, Number(estimate.maxFee) / 1_000_000);
    if (params.maxBridgeFeeUsdc != null && signedFeeUsdc > params.maxBridgeFeeUsdc) {
      throw new BridgeFeeError(
        `The Gateway fee to ${chain.label}, ${signedFeeUsdc} USDC, is above the ${params.maxBridgeFeeUsdc} USDC this payment may pay; nothing was sent.`
      );
    }
    const intent = burnIntent(this.network, { ...payout, maxFee: estimate.maxFee, maxBlockHeight: estimate.maxBlockHeight });
    const signed = await withDeadline(
      this.client.signTypedData({ walletId: signer.circle_wallet_id, data: JSON.stringify(burnIntentTypedData(intent)), memo: params.memo }),
      CREATE_TRANSACTION_DEADLINE_MS,
      `Circle did not sign the Gateway transfer within ${CREATE_TRANSACTION_DEADLINE_MS} ms; nothing was sent`
    );
    const signature = signed.data?.signature;
    if (!signature) throw new Error("Circle returned no signature for the Gateway transfer; nothing was sent");

    const started = Date.now();
    const transferId = await submitGatewayTransfer(this.network, intent, signature, { fetch: this.fetch });
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
      const status = await gatewayTransferStatus(this.network, transferId, { fetch: this.fetch });
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

  private async execute(
    walletId: string,
    call: ContractCall,
    idempotencyKey: string,
    memo: string | undefined,
    options: { what?: string; movesMoney?: boolean } = {}
  ): Promise<string> {
    return sendToCircle(
      this.client.createContractExecutionTransaction({
        walletId,
        contractAddress: call.contractAddress,
        abiFunctionSignature: call.abiFunctionSignature,
        abiParameters: call.abiParameters,
        idempotencyKey,
        refId: memo,
        fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      }),
      options.what ?? "createContractExecutionTransaction",
      "it",
      options.movesMoney ?? true
    );
  }

  /** The Forwarding Service's mint for a burn, read from Iris until it appears or the wait runs out. */
  private async awaitMint(burnTxHash: string): Promise<string | null> {
    const deadline = Date.now() + this.bridgeMintWaitMs;
    for (;;) {
      const mint = await forwardedMint(this.network, burnTxHash, { fetch: this.fetch });
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
    const fee = await resolveFee(this.rpcUrl, transaction?.networkFeeInUSD, txHash ?? undefined);
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
      const status = await gatewayTransferStatus(this.network, providerTxId.slice(GATEWAY_ID.length), { fetch: this.fetch });
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
    const fee = await resolveFee(this.rpcUrl, transaction.networkFeeInUSD, txHash ?? undefined);
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
    const mint = confirmed && transaction.txHash ? await forwardedMint(this.network, transaction.txHash, { fetch: this.fetch }) : null;
    return this.bridgeResult(providerTxId, settlement, { chain: transaction.blockchain, providerMode: "live", destinationChain: null, bridgeFeeUsdc: null }, mint?.mintTxHash ?? null, started);
  }

  /**
   * A sweep into real USYC (USYC live design R2, R4, R6): the operating wallet approves the Teller for
   * the USDC, then deposits it with the reserve wallet as receiver, each call under its own key and
   * waited for. Refused before anything is sent while USYC cannot be bought.
   */
  async depositToEarn(params: EarnDepositParams): Promise<EarnResult> {
    await this.refuseWhilePaymentsOff();
    const { operating, reserve, key } = await this.usycAccounts(params);
    const read = { network: this.network, rpcUrl: this.rpcUrl, fetch: this.fetch };
    if (!(await usycSubscriptionsOpen(read))) throw new UsycSubscriptionsClosedError();
    const units = usycUnits(params.amount).toString();
    const approve = await this.usycCall(operating.walletId, { contractAddress: this.network.tokens.USDC, abiFunctionSignature: "approve(address,uint256)", abiParameters: [usycOf(this.network).teller, units] }, `${key}/approve`);
    const deposit = await this.usycCall(operating.walletId, { contractAddress: usycOf(this.network).teller, abiFunctionSignature: "deposit(uint256,address)", abiParameters: [units, reserve.address] }, `${key}/deposit`);
    const price = await readUsycPrice(read);
    const shares = (BigInt(units) * 10n ** 18n) / price;
    return {
      txRef: deposit,
      positionValue: params.amount,
      apy: 0,
      execution: { approveTxHash: approve, depositTxHash: deposit, shares: fromUnits(shares), price: priceValue(price) },
    };
  }

  /**
   * A redemption from real USYC (R2, R5, R6): the reserve wallet redeems the whole shares that cover
   * the USDC asked, never more than it holds, with the operating wallet as receiver.
   */
  async withdrawFromEarn(params: EarnDepositParams): Promise<EarnResult> {
    await this.refuseWhilePaymentsOff();
    const { operating, reserve, key } = await this.usycAccounts(params);
    const read = { network: this.network, rpcUrl: this.rpcUrl, fetch: this.fetch };
    const [price, held] = await Promise.all([readUsycPrice(read), readUsycShares(reserve.address, read)]);
    if (held === 0n) throw new Error("The reserve wallet holds no USYC to redeem");
    const shares = sharesToRedeem(usycUnits(params.amount), price, held);
    const redeem = await this.usycCall(
      reserve.walletId,
      { contractAddress: usycOf(this.network).teller, abiFunctionSignature: "redeem(uint256,address,address)", abiParameters: [shares.toString(), operating.address, reserve.address] },
      `${key}/redeem`
    );
    return {
      txRef: redeem,
      positionValue: fromUnits(sharesValue(held - shares, price)),
      apy: 0,
      execution: { redeemTxHash: redeem, shares: fromUnits(shares), price: priceValue(price) },
    };
  }

  /** The reserve's USYC and its USDC value at the oracle's latest price (R3). */
  async getEarnPosition(reserveAccountId: string): Promise<EarnPosition> {
    const reserve = await this.account(reserveAccountId);
    if (!reserve.address) throw new Error(`Account ${reserveAccountId} has no address`);
    const read = { network: this.network, rpcUrl: this.rpcUrl, fetch: this.fetch };
    const [price, shares, apy] = await Promise.all([readUsycPrice(read), readUsycShares(reserve.address, read), readUsycApy(read).catch(() => null)]);
    return { shares: fromUnits(shares), valueUsdc: fromUnits(sharesValue(shares, price)), price: priceValue(price), apy };
  }

  private async usycAccounts(params: EarnDepositParams) {
    if (!params.reserveAccountId || !params.key) throw new Error("A USYC move needs the reserve account and a key");
    const [operating, reserve] = await Promise.all([this.account(params.accountId), this.account(params.reserveAccountId)]);
    if (!operating.address || !reserve.address) throw new Error("The operating and reserve wallets need addresses for USYC");
    return { operating: { ...operating, address: operating.address }, reserve: { ...reserve, address: reserve.address }, key: params.key };
  }

  /** One USYC call, sent under its step's key and waited for; its transaction hash, or a throw saying what Circle reported. */
  private async usycCall(walletId: string, call: ContractCall, seed: string): Promise<string> {
    const txId = await this.execute(walletId, call, usycStepKey(seed), undefined);
    const { status, transaction } = await awaitSettlement(this.client, txId);
    if (status !== "confirmed" || !transaction?.txHash) {
      const name = call.abiFunctionSignature.split("(")[0];
      if (status === "failed") throw new Error(`${name} failed (${transaction?.state ?? "unknown"}) on Arc testnet`);
      // Taken but not confirmed within the wait: it may still land, and the same key finds it again.
      throw new UsycNotConfirmedError(`${name} did not confirm in time on Arc testnet`);
    }
    return transaction.txHash;
  }

  getBalance(accountId: string): Promise<BalanceSnapshot> {
    return this.getTokenBalance(accountId, "USDC");
  }

  /**
   * A USDC→EURC swap's two calls from the operating wallet (EURC swap spec S6): approve the Adapter for
   * the USDC, then send it the swap's call, each under its own key and waited for. The keys are the
   * swap's, so a call whose answer was lost is the same call when the swap is resumed. No swap is sent
   * when the approval did not confirm.
   */
  async swapForEurc(params: SwapCallParams): Promise<SwapCallResult> {
    await this.refuseWhilePaymentsOff();
    const account = await this.account(params.fromAccountId);
    const send = async (call: Record<string, unknown>, key: string): Promise<SwapStep> => {
      const created = await withDeadline(
        this.client.createContractExecutionTransaction({
          walletId: account.walletId,
          ...call,
          idempotencyKey: key,
          fee: { type: "level", config: { feeLevel: "MEDIUM" } },
        } as Parameters<LiveProviderClient["createContractExecutionTransaction"]>[0]),
        CREATE_TRANSACTION_DEADLINE_MS,
        `Circle did not answer a swap call within ${CREATE_TRANSACTION_DEADLINE_MS} ms; it may or may not have been accepted`
      );
      const txId = created.data?.id;
      if (!txId) throw new Error("Circle did not return a transaction id");
      const { status, transaction } = await awaitSettlement(this.client, txId);
      return { status, txId, txHash: transaction?.txHash ?? null, state: transaction?.state ?? null };
    };
    // In base units the way the swap's call was built (src/lib/fx/swap-service.ts), never by a float multiply (review #10).
    const units = toBaseUnits(params.usdcIn);
    const approve = await send({ contractAddress: this.network.tokens.USDC, abiFunctionSignature: "approve(address,uint256)", abiParameters: [params.adapter, units] }, params.approveKey);
    if (approve.status !== "confirmed") return { approve, execute: null };
    const execute = await send({ contractAddress: params.adapter, callData: params.callData }, params.executeKey);
    return { approve, execute };
  }

  /**
   * Completed inbound USDC and EURC transfers to the account's wallet (receivables on Arc §2). The
   * wallet's token list names each token id; a transfer of anything else, not yet complete, or with
   * no amount is left out. Circle answers 50 at most, oldest first from `since`.
   */
  async listInboundTransfers(accountId: string, since: string | null): Promise<InboundTransfer[]> {
    const account = await this.account(accountId);
    const balances = await withDeadline(
      this.client.getWalletTokenBalance({ id: account.walletId }),
      BALANCE_READ_DEADLINE_MS,
      `no answer from Circle getWalletTokenBalance within ${BALANCE_READ_DEADLINE_MS} ms`
    );
    const tokens = new Map<string, Stablecoin>();
    // Money in is USDC or EURC by its contract (mainnet go-live M7): a token that only calls itself so is not money received.
    for (const balance of balances.data?.tokenBalances ?? []) {
      const coin = stablecoinOf(balance.token, this.network, account.chain);
      if (balance.token?.id && coin) tokens.set(balance.token.id, coin);
    }
    const listed = await withDeadline(
      this.client.listTransactions({
        walletIds: [account.walletId],
        txType: "INBOUND",
        state: "COMPLETE",
        ...(since ? { from: since } : {}),
        pageSize: 50,
      } as Parameters<LiveProviderClient["listTransactions"]>[0]),
      BALANCE_READ_DEADLINE_MS,
      `no answer from Circle listTransactions within ${BALANCE_READ_DEADLINE_MS} ms`
    );
    return (listed.data?.transactions ?? []).flatMap((tx): InboundTransfer[] => {
      const token = tx.tokenId ? tokens.get(tx.tokenId) : undefined;
      const amount = Number(tx.amounts?.[0]);
      if (!token || tx.state !== "COMPLETE" || tx.transactionType !== "INBOUND" || !(amount > 0)) return [];
      return [
        {
          circleTxId: tx.id,
          txHash: tx.txHash ?? null,
          from: tx.sourceAddress ?? null,
          amount,
          token,
          chain: tx.blockchain,
          receivedAt: tx.firstConfirmDate ?? tx.updateDate ?? tx.createDate,
        },
      ];
    });
  }

  async getTokenBalance(accountId: string, token: Stablecoin): Promise<BalanceSnapshot> {
    const account = await this.account(accountId);
    const balances = await withDeadline(
      this.client.getWalletTokenBalance({ id: account.walletId }),
      BALANCE_READ_DEADLINE_MS,
      `no answer from Circle getWalletTokenBalance within ${BALANCE_READ_DEADLINE_MS} ms`
    );
    const held = stablecoinEntry(balances.data?.tokenBalances, token, this.network, account.chain);
    return {
      accountId,
      chain: account.chain,
      token,
      balance: held ? Number(held.amount) : 0,
    };
  }
}
