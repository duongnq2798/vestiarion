import { createHash } from "node:crypto";
import type { ChainProvider, Stablecoin, TransferResult } from "./circle";
import type { PayoutRoute, SpendingLimitPayment } from "./circle/types";
import { BatchNotSentError, MAX_BATCH_SIZE } from "./circle/batch";
import { FAILED_STATES, MAY_HAVE_BEEN_ACCEPTED } from "./circle/settlement";
import { db, unwrap } from "./dal";
import { paidAcrossChains } from "./payee-chains";

export type PaymentSourceType = "invoice" | "milestone";
export type PaymentIntentStatus = "created" | "submitting" | "pending" | "confirmed" | "failed";

/** An attempt Circle ended in a terminal failure, as `begin_payment_retry` (migration 0036) keeps it in `previous_attempts`. */
export interface PreviousPaymentAttempt {
  attempt: number;
  idempotencyKey: string;
  providerTxId: string | null;
  providerState: string | null;
  failureReason: string | null;
  failedAt: string;
}

export interface PaymentIntent {
  id: string;
  sourceType: PaymentSourceType;
  sourceId: string;
  /** The current attempt's key: attempt 1's is derived from the source, a later one is written by `begin_payment_retry`. */
  idempotencyKey: string;
  provider: "circle" | "simulate";
  providerTxId: string | null;
  txHash: string | null;
  amount: number;
  destination: string;
  status: PaymentIntentStatus;
  attemptCount: number;
  lastError: string | null;
  confirmedAt: string | null;
  chain: string | null;
  providerMode: "live" | "simulate" | null;
  feeUsd: number | null;
  feeSource: TransferResult["feeSource"] | null;
  settledInMs: number | null;
  executedAt: string | null;
  /** Circle's `state` for the current attempt's transfer, as last read; null for the simulator or before any read. */
  providerState: string | null;
  /** Circle's `errorReason` for the current attempt's transfer, or null. */
  failureReason: string | null;
  /** Which transfer this is for the source: 1, then one more each time a person sends a terminally failed payment again. */
  transferAttempt: number;
  previousAttempts: PreviousPaymentAttempt[];
  createdAt: string;
  updatedAt: string;
  /** A bridged payment's chain and mint (CCTP payouts X8); null or absent for a payment on Arc. */
  destinationChain?: string | null;
  mintTxHash?: string | null;
  /** The route a bridged payment's first attempt chose (Gateway payouts G2); null for one on Arc, or from before 0045. */
  route?: PayoutRoute | null;
  /** The batch the first attempt was sent in (batch payouts R4): its key, size, and when it was sent; null when sent alone. */
  batchKey?: string | null;
  batchSize?: number | null;
  batchSentAt?: string | null;
  /**
   * The Circle wallet a send under the current key went from, when it was not the account's own: the agent's, through
   * the spending limit contract (0074). A send Circle never answered is looked for there (payment safety R5).
   */
  sentWalletId?: string | null;
}

interface PaymentIntentRow {
  id: string;
  source_type: PaymentSourceType;
  source_id: string;
  idempotency_key: string;
  provider: "circle" | "simulate";
  provider_tx_id: string | null;
  tx_hash: string | null;
  amount: string | number;
  destination: string;
  status: PaymentIntentStatus;
  attempt_count: number;
  last_error: string | null;
  confirmed_at: string | null;
  chain: string | null;
  provider_mode: "live" | "simulate" | null;
  fee_usd: string | number | null;
  fee_source: TransferResult["feeSource"] | null;
  settled_in_ms: string | number | null;
  executed_at: string | null;
  provider_state: string | null;
  failure_reason: string | null;
  transfer_attempt: number;
  previous_attempts: PreviousPaymentAttempt[];
  created_at: string;
  updated_at: string;
  destination_chain?: string | null;
  mint_tx_hash?: string | null;
  payout_route?: string | null;
  batch_key?: string | null;
  batch_size?: number | null;
  batch_sent_at?: string | null;
  sent_wallet_id?: string | null;
}

export interface PaymentIntentStore {
  /** The source's one intent, created with attempt 1's key (`input.idempotencyKey`) when the source has none yet. */
  ensure(input: PaymentRequest & { idempotencyKey: string; provider: "circle" | "simulate" }): Promise<PaymentIntent>;
  get(idempotencyKey: string): Promise<PaymentIntent>;
  claim(idempotencyKey: string): Promise<PaymentIntent | null>;
  recordResult(idempotencyKey: string, result: TransferResult): Promise<PaymentIntent>;
  recordError(idempotencyKey: string, error: string): Promise<PaymentIntent>;
  /**
   * Moves the intent to its next attempt, under that attempt's key, when its
   * current attempt is still `intent`'s and Circle ended it in a terminal
   * failure; null when nothing matched (another request moved it first, or
   * it is not retryable).
   */
  beginRetry(intent: PaymentIntent): Promise<PaymentIntent | null>;
  /** Records the wallet a send under the current key goes from, before it is sent (payment safety R5). */
  markSending?(idempotencyKey: string, sentWalletId: string | null): Promise<void>;
  /** The source's intent, or null: a read that never creates one (payment safety R6). */
  findBySource?(sourceType: PaymentSourceType, sourceId: string): Promise<PaymentIntent | null>;
}

/** What a batch needs from the store beyond one intent (batch payouts R4, R5). */
export interface PaymentBatchStore {
  /**
   * Writes the batch on every member in one statement, each still claimed and never sent; how many it
   * reached. 0 before migration 0057, when there are no batch columns.
   */
  joinBatch(memberKeys: string[], batch: { key: string; size: number; sentAt: string }): Promise<number>;
  /** Takes the batch off every member Circle has no id for. */
  leaveBatch(batchKey: string): Promise<void>;
  batchMembers(batchKey: string): Promise<PaymentIntent[]>;
}

export interface PaymentRequest {
  sourceType: PaymentSourceType;
  sourceId: string;
  fromAccountId: string;
  destination: string;
  amount: number;
  memo: string;
  /** What the transfer moves: USDC unless the invoice is in EURC (EURC invoices design E5). */
  token?: Stablecoin;
  /** The payee's chain: another than Arc testnet is paid through CCTP (CCTP payouts X2). */
  destinationChain?: string;
  /** The most a bridged payment's CCTP fee may be, in USDC (review I4). */
  maxBridgeFeeUsdc?: number;
  /**
   * How a payment across chains goes, as chosen for its first attempt (Gateway
   * payouts G2). The intent keeps it: a later attempt uses the intent's route,
   * whatever a request says then.
   */
  route?: PayoutRoute;
  /** A milestone locked in escrow: the hold its payment releases, on the `escrow` route (milestone escrow E4). */
  escrow?: { contract: string; holdId: string };
  /**
   * An agent's payment while its spending limit is enforced on Arc (onchain spending limit R3): sent as `pay` on the
   * contract from the agent's wallet, never in a batch. Only the agent's own sends carry it; a person's never do (R6).
   */
  spendingLimit?: SpendingLimitPayment;
}

/** The terminally failed attempt a retry followed: ids and Circle's states only. */
export interface RetriedAfter {
  providerTxId: string;
  providerState: string;
  failureReason: string | null;
}

export interface PaymentExecution {
  idempotencyKey: string;
  providerTxId: string | null;
  txHash: string | null;
  txRef: string | null;
  status: "pending" | "confirmed" | "failed";
  attemptCount: number;
  error: string | null;
  reconciled: boolean;
  chain: string | null;
  providerMode: "live" | "simulate" | null;
  feeUsd: number | null;
  feeSource: TransferResult["feeSource"] | null;
  settledInMs: number | null;
  executedAt: string | null;
  /** The intent's transfer attempt this execution ended on. */
  attempt: number;
  /** Set only when this execution opened a new attempt after Circle ended the previous one in a terminal failure. */
  retriedAfter: RetriedAfter | null;
  /** A bridged payment's chain and its mint, once the Forwarding Service submitted it. */
  destinationChain?: string | null;
  mintTxHash?: string | null;
  /** The route the intent keeps: an escrow release is told from a transfer by it (milestone escrow, review I1). */
  route?: PayoutRoute | null;
  /** The batch this payment was sent in, shared with its other members (batch payouts §2); null when sent alone. */
  batch?: { key: string; size: number } | null;
}

/**
 * Whether Circle's `state` ends a transfer without moving money, so that the
 * payment "must be re-initiated": `CANCELLED`, `DENIED` or `FAILED`
 * (`FAILED_STATES`). `STUCK` is not one — the transaction was sent and can
 * still be mined — and neither is an unknown or missing state.
 */
export function isTerminalFailure(state: string | null | undefined): state is string {
  return typeof state === "string" && FAILED_STATES.includes(state);
}

function asUuid(bytes: Uint8Array): string {
  const value = Uint8Array.from(bytes.slice(0, 16));
  value[6] = (value[6] & 0x0f) | 0x50;
  value[8] = (value[8] & 0x3f) | 0x80;
  const hex = Buffer.from(value).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Stable UUID-shaped key accepted by Circle's SDK and safe to reuse forever.
 * Attempt 1's key is the one every intent has always been sent with, derived
 * from the source alone, so no key already sent to Circle changes identity.
 * A later attempt — a new transfer after Circle ended the previous one in a
 * terminal failure — hashes the attempt into the path, since Circle returns
 * the original transaction for any key it has already seen.
 */
export function paymentIdempotencyKey(sourceType: PaymentSourceType, sourceId: string, attempt = 1): string {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error(`A payment attempt is a positive integer, not ${attempt}`);
  const path = `vestiarion/payment/v1/${sourceType}/${sourceId}`;
  const hash = createHash("sha256").update(attempt === 1 ? path : `${path}/attempt/${attempt}`, "utf8").digest();
  return asUuid(hash);
}

/**
 * A batch's key (batch payouts R3): Circle's idempotency key for the batch and its transaction's refId,
 * from its members' keys sorted, so the same payments always make the same batch.
 */
export function batchIdempotencyKey(memberKeys: string[]): string {
  const path = `vestiarion/payment-batch/v1/${[...memberKeys].sort().join(",")}`;
  return asUuid(createHash("sha256").update(path, "utf8").digest());
}

function fromRow(row: PaymentIntentRow): PaymentIntent {
  return {
    id: row.id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    idempotencyKey: row.idempotency_key,
    provider: row.provider,
    providerTxId: row.provider_tx_id,
    txHash: row.tx_hash,
    amount: Number(row.amount),
    destination: row.destination,
    status: row.status,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
    confirmedAt: row.confirmed_at,
    chain: row.chain,
    providerMode: row.provider_mode,
    feeUsd: row.fee_usd == null ? null : Number(row.fee_usd),
    feeSource: row.fee_source,
    settledInMs: row.settled_in_ms == null ? null : Number(row.settled_in_ms),
    executedAt: row.executed_at,
    providerState: row.provider_state,
    failureReason: row.failure_reason,
    transferAttempt: row.transfer_attempt,
    previousAttempts: row.previous_attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    destinationChain: row.destination_chain ?? null,
    mintTxHash: row.mint_tx_hash ?? null,
    route: row.payout_route === "gateway" || row.payout_route === "cctp" || row.payout_route === "escrow" ? row.payout_route : null,
    batchKey: row.batch_key ?? null,
    batchSize: row.batch_size ?? null,
    batchSentAt: row.batch_sent_at ?? null,
    sentWalletId: row.sent_wallet_id ?? null,
  };
}

/** A column this database does not have yet: Postgres's own code, or PostgREST's for a write naming it. */
const missingColumn = (code: string | undefined) => code === "42703" || code === "PGRST204";

/**
 * `payment_intents` through the tenant client. The row is one per source
 * (`unique (source_type, source_id)`) and is found by its source; its key is
 * read from the row, since a retry moves it to a later attempt's key. Every
 * write after that names the current key, so a write about an attempt that
 * another request already moved on matches nothing.
 */
export class SupabasePaymentIntentStore implements PaymentIntentStore, PaymentBatchStore {
  async ensure(input: PaymentRequest & { idempotencyKey: string; provider: "circle" | "simulate" }): Promise<PaymentIntent> {
    const result = await db().from("payment_intents").upsert({
      source_type: input.sourceType,
      source_id: input.sourceId,
      idempotency_key: input.idempotencyKey,
      provider: input.provider,
      provider_mode: input.provider === "circle" ? "live" : "simulate",
      amount: input.amount,
      destination: input.destination,
      // USDC is the column's default (0040): only a EURC payment names its token,
      // so USDC payments do not depend on the column existing yet.
      ...(input.token && input.token !== "USDC" ? { token: input.token } : {}),
      // Written for a bridged payment only, like token: a payment on Arc does not need the column (0044).
      // The route is written with it, once: a duplicate insert is ignored, so the first attempt's route stays (0045).
      ...(paidAcrossChains(input.destinationChain) ? { destination_chain: input.destinationChain, payout_route: input.route ?? "cctp" } : {}),
      // A milestone locked in escrow keeps the escrow route from its first attempt: never a transfer after a release.
      ...(input.escrow ? { payout_route: "escrow" } : {}),
    }, { onConflict: "source_type,source_id", ignoreDuplicates: true });
    if (result.error) throw new Error(result.error.message);
    return this.getBySource(input.sourceType, input.sourceId);
  }

  async getBySource(sourceType: PaymentSourceType, sourceId: string): Promise<PaymentIntent> {
    const row = unwrap(
      await db()
        .from("payment_intents")
        .select("*")
        .eq("source_type", sourceType)
        .eq("source_id", sourceId)
        .single<PaymentIntentRow>()
    );
    return fromRow(row);
  }

  async get(idempotencyKey: string): Promise<PaymentIntent> {
    const row = unwrap(
      await db().from("payment_intents").select("*").eq("idempotency_key", idempotencyKey).single<PaymentIntentRow>()
    );
    return fromRow(row);
  }

  async claim(idempotencyKey: string): Promise<PaymentIntent | null> {
    const result = await db()
      .rpc("claim_payment_intent", { p_idempotency_key: idempotencyKey })
      .maybeSingle<PaymentIntentRow>();
    if (result.error) throw new Error(result.error.message);
    // The function returns its composite type even when the UPDATE matched
    // nothing, and PostgREST sends that as an object whose every field is
    // null. Only a row with an id is a claim; anything else means another
    // cycle holds it, and treating it as ours would transfer twice (R20).
    return result.data?.id ? fromRow(result.data) : null;
  }

  async recordResult(idempotencyKey: string, result: TransferResult): Promise<PaymentIntent> {
    const now = new Date().toISOString();
    const update = await db().from("payment_intents").update({
      provider_tx_id: result.providerTxId,
      tx_hash: result.txHash,
      status: result.status,
      last_error: null,
      confirmed_at: result.status === "confirmed" ? now : null,
      // A reconcile that cannot say which chain a payout is on leaves the chain it was recorded with (review M3).
      ...(result.chain ? { chain: result.chain } : {}),
      provider_mode: result.providerMode,
      fee_usd: result.feeUsd,
      fee_source: result.feeSource,
      settled_in_ms: result.settledInMs,
      provider_state: result.providerState,
      failure_reason: result.failureReason,
      executed_at: now,
      updated_at: now,
      // A bridged payment's mint and fee (CCTP payouts X8), only when there are any.
      ...(result.mintTxHash ? { mint_tx_hash: result.mintTxHash } : {}),
      ...(result.destinationChain ? { destination_chain: result.destinationChain } : {}),
      ...(result.bridgeFeeUsdc != null ? { bridge_fee: result.bridgeFeeUsdc } : {}),
    }).eq("idempotency_key", idempotencyKey);
    if (update.error) throw new Error(update.error.message);
    return this.get(idempotencyKey);
  }

  /** An error of ours — a read or a submission that did not complete. What Circle last said stays as it was. */
  async recordError(idempotencyKey: string, error: string): Promise<PaymentIntent> {
    const update = await db().from("payment_intents").update({
      status: "failed",
      last_error: error,
      updated_at: new Date().toISOString(),
    }).eq("idempotency_key", idempotencyKey);
    if (update.error) throw new Error(update.error.message);
    return this.get(idempotencyKey);
  }

  async markSending(idempotencyKey: string, sentWalletId: string | null): Promise<void> {
    const update = await db().from("payment_intents").update({ sent_wallet_id: sentWalletId }).eq("idempotency_key", idempotencyKey);
    if (update.error) throw new Error(update.error.message);
  }

  async findBySource(sourceType: PaymentSourceType, sourceId: string): Promise<PaymentIntent | null> {
    // An intent is found by its source, as `ensure` finds it, and never created here.
    const result = await db().from("payment_intents").select("*").eq("source_type", sourceType).eq("source_id", sourceId).maybeSingle<PaymentIntentRow>();
    if (result.error) throw new Error(result.error.message);
    return result.data ? fromRow(result.data) : null;
  }

  async beginRetry(intent: PaymentIntent): Promise<PaymentIntent | null> {
    const result = await db()
      .rpc("begin_payment_retry", {
        p_source_type: intent.sourceType,
        p_source_id: intent.sourceId,
        p_expected_key: intent.idempotencyKey,
        p_new_key: paymentIdempotencyKey(intent.sourceType, intent.sourceId, intent.transferAttempt + 1),
      })
      .maybeSingle<PaymentIntentRow>();
    if (result.error) throw new Error(result.error.message);
    // As with claim_payment_intent: a row of nulls is no match — another
    // request already opened the next attempt, or this one is not retryable.
    return result.data?.id ? fromRow(result.data) : null;
  }

  async joinBatch(memberKeys: string[], batch: { key: string; size: number; sentAt: string }): Promise<number> {
    const result = await db()
      .from("payment_intents")
      .update({ batch_key: batch.key, batch_size: batch.size, batch_sent_at: batch.sentAt, updated_at: batch.sentAt })
      .in("idempotency_key", memberKeys)
      .eq("status", "submitting")
      .is("provider_tx_id", null)
      .is("batch_key", null)
      .select("idempotency_key");
    // Before migration 0057 no member can join: each is paid alone, as before.
    if (missingColumn(result.error?.code)) return 0;
    if (result.error) throw new Error(result.error.message);
    return (result.data ?? []).length;
  }

  async leaveBatch(batchKey: string): Promise<void> {
    const result = await db()
      .from("payment_intents")
      .update({ batch_key: null, batch_size: null, batch_sent_at: null })
      .eq("batch_key", batchKey)
      .is("provider_tx_id", null);
    if (missingColumn(result.error?.code)) return;
    if (result.error) throw new Error(result.error.message);
  }

  async batchMembers(batchKey: string): Promise<PaymentIntent[]> {
    const rows = unwrap(await db().from("payment_intents").select("*").eq("batch_key", batchKey)) as PaymentIntentRow[];
    return rows.map(fromRow);
  }
}

/** A batch member Circle has no id for may have gone out with its batch: in flight until it is found, or known never sent (R5). */
const inLostBatch = (intent: PaymentIntent) => Boolean(intent.batchKey) && intent.transferAttempt === 1 && !intent.providerTxId && intent.status !== "confirmed";

/** How long Circle may take to list a transaction it took (payment safety R4): a send not listed after this was never taken. */
export const UNKNOWN_SEND_GRACE_MS = 15 * 60_000;

/** How long a claimed send may run before it is claimed again (claim_payment_intent, 0004): one older is unknown too. */
const STALE_SUBMISSION_MS = 2 * 60_000;

/**
 * Whether the intent's current attempt was sent and Circle never said what became of it (payment safety R1, R4): it
 * failed with no provider id and the provider's words for that, or its send has run longer than a claim may, so the
 * request may have reached Circle with its answer lost. Such a send may exist under the attempt's key: it is looked
 * for, never sent again blind, and nothing closes over it.
 */
export function unknownSend(intent: Pick<PaymentIntent, "status" | "providerTxId" | "lastError" | "updatedAt">, now: number = Date.now()): boolean {
  if (intent.providerTxId) return false;
  if (intent.status === "failed") return intent.lastError?.includes(MAY_HAVE_BEEN_ACCEPTED) ?? false;
  return intent.status === "submitting" && now - Date.parse(intent.updatedAt) > STALE_SUBMISSION_MS;
}

/** A payment's reference on Circle (its memo, and refId): unique to its source, the same on every attempt. */
export function paymentMemo(sourceType: PaymentSourceType, sourceId: string): string {
  return `${sourceType === "invoice" ? "Invoice" : "Milestone"} ${sourceId}`;
}

/** What an intent records once Circle has listed nothing for its unknown send after the grace period (R4). */
export const NO_EARLIER_SEND = "Circle has no transfer for this payment's earlier send; nothing was sent.";

function execution(intent: PaymentIntent, reconciled: boolean, retriedAfter: RetriedAfter | null = null): PaymentExecution {
  // A send Circle never answered may have moved money: it is in flight until it is found or known never taken (R4).
  const status =
    intent.status === "confirmed" ? "confirmed" : intent.status === "failed" && !inLostBatch(intent) && !unknownSend(intent) ? "failed" : "pending";
  return {
    idempotencyKey: intent.idempotencyKey,
    providerTxId: intent.providerTxId,
    txHash: intent.txHash,
    txRef: intent.txHash ?? intent.providerTxId,
    status,
    attemptCount: intent.attemptCount,
    error: intent.lastError,
    reconciled,
    chain: intent.chain,
    providerMode: intent.providerMode,
    feeUsd: intent.feeUsd,
    feeSource: intent.feeSource,
    settledInMs: intent.settledInMs,
    executedAt: intent.executedAt,
    attempt: intent.transferAttempt,
    retriedAfter,
    destinationChain: intent.destinationChain ?? null,
    mintTxHash: intent.mintTxHash ?? null,
    route: intent.route ?? null,
    // Only the first attempt was in a batch: a later one is a transfer of its own (R7).
    batch: intent.batchKey && intent.batchSize && intent.transferAttempt === 1 ? { key: intent.batchKey, size: intent.batchSize } : null,
  };
}

/** One member's part of a batch's transaction: the batch's fee shared equally (batch payouts R6). */
function shareOf(result: TransferResult, size: number): TransferResult {
  return { ...result, feeUsd: Number((result.feeUsd / size).toFixed(6)) };
}

function asBatchStore(store: PaymentIntentStore): PaymentIntentStore & PaymentBatchStore {
  const candidate = store as PaymentIntentStore & Partial<PaymentBatchStore>;
  if (!candidate.joinBatch || !candidate.leaveBatch || !candidate.batchMembers) throw new Error("This payment store cannot keep batches");
  return candidate as PaymentIntentStore & PaymentBatchStore;
}

/** How long a batch Circle does not list may still be its pipeline catching up, rather than never accepted (R5). */
export const BATCH_LOOKUP_GRACE_MS = 15 * 60_000;

/**
 * A first attempt sent in a batch whose answer was lost (batch payouts R5): looked for on Circle by the
 * batch's refId, never sent again alone, since Circle may have the batch. Found, every member still
 * without its id gets it, with its share of the fee, and this one's execution is returned. Not found
 * within the grace period, or not looked for in full, it stays in flight. Not found after it, Circle
 * never accepted the batch: it is taken off every member, and null says this one is an ordinary
 * payment never sent.
 */
async function resolveLostBatch(
  intent: PaymentIntent,
  request: PaymentRequest,
  provider: ChainProvider,
  store: PaymentIntentStore,
  now = Date.now()
): Promise<PaymentExecution | null> {
  const batches = asBatchStore(store);
  const key = intent.batchKey as string;
  const sentAt = Date.parse(intent.batchSentAt ?? "");
  let found: TransferResult | null;
  try {
    if (!provider.findTransferByRef || Number.isNaN(sentAt)) throw new Error("this provider cannot look a batch up");
    found = await provider.findTransferByRef(request.fromAccountId, key, {
      from: new Date(sentAt - 5 * 60_000).toISOString(),
      to: new Date(sentAt + 2 * BATCH_LOOKUP_GRACE_MS).toISOString(),
    });
  } catch (error) {
    // A lookup that did not complete says nothing about the batch: still in flight, looked for again.
    return { ...execution(intent, true), error: `Its batch could not be looked for on Circle: ${error instanceof Error ? error.message : "lookup failed"}` };
  }
  if (found) {
    for (const member of await batches.batchMembers(key)) {
      if (!member.providerTxId) await store.recordResult(member.idempotencyKey, shareOf(found, member.batchSize ?? intent.batchSize ?? 1));
    }
    return execution(await store.get(intent.idempotencyKey), true);
  }
  if (now - sentAt < BATCH_LOOKUP_GRACE_MS) {
    return { ...execution(intent, true), error: "Its batch is not on Circle yet; it is looked for again next cycle" };
  }
  await batches.leaveBatch(key);
  return null;
}

/** Whether a request asks for the transfer its intent's first attempt asked for: the same amount, payee and chain. */
function sameGatewayPayout(intent: PaymentIntent, request: PaymentRequest): boolean {
  return (
    Math.round(intent.amount * 1_000_000) === Math.round(request.amount * 1_000_000) &&
    intent.destination.toLowerCase() === request.destination.toLowerCase() &&
    (intent.destinationChain ?? null) === (request.destinationChain ?? null)
  );
}

/**
 * Pays a source at most once per attempt, and never while an earlier
 * transfer could still settle.
 *
 * Once Circle has returned a transaction id for the current attempt, that id
 * is only ever reconciled: this is the duplicate-payment boundary. The one
 * exception is `retryTerminalFailure`, which only a person's Approve and pay
 * passes (the agent's cycle and reconciliation never do): when Circle, read
 * right now, reports the transfer in a terminal failure state (`CANCELLED`,
 * `DENIED`, `FAILED`), the next attempt is opened with `begin_payment_retry`
 * and sent under its own key. A read that says pending (`STUCK` included) or
 * confirmed, or a read that fails, is recorded and nothing new is sent; so
 * is a retry another request opened first.
 */
export async function executePayment(
  request: PaymentRequest,
  dependencies: { provider: ChainProvider; store?: PaymentIntentStore; retryTerminalFailure?: boolean; now?: number }
): Promise<PaymentExecution> {
  const store = dependencies.store ?? new SupabasePaymentIntentStore();
  const now = dependencies.now ?? Date.now();
  let intent = await store.ensure({
    ...request,
    idempotencyKey: paymentIdempotencyKey(request.sourceType, request.sourceId),
    provider: dependencies.provider.mode === "live" ? "circle" : "simulate",
  });

  if (intent.status === "confirmed") return execution(intent, false);

  // A first attempt sent in a batch whose answer was lost is looked for, never sent again alone (batch payouts R5).
  if (intent.batchKey && !intent.providerTxId && intent.transferAttempt === 1) {
    const resolved = await resolveLostBatch(intent, request, dependencies.provider, store);
    if (resolved) return resolved;
    // Circle never had the batch: this is a payment never sent, sent alone below under its own key.
    intent = await store.get(intent.idempotencyKey);
  }

  let retriedAfter: RetriedAfter | null = null;

  // Provider identity means a transfer already exists. Reconcile it before
  // considering submission; this is the duplicate-payment boundary.
  if (intent.providerTxId) {
    let reported: TransferResult;
    try {
      reported = await dependencies.provider.reconcileTransfer(intent.providerTxId);
      // A batch's transaction is read whole: this payment records its share of the fee (batch payouts R6).
      if (intent.batchSize && intent.transferAttempt === 1) reported = shareOf(reported, intent.batchSize);
      intent = await store.recordResult(intent.idempotencyKey, reported);
    } catch (error) {
      // A read that did not complete says nothing about the transfer: record
      // it as our own error, and never treat it as a reason to send again.
      intent = await store.recordError(intent.idempotencyKey, error instanceof Error ? error.message : "Reconciliation failed");
      return execution(intent, true);
    }

    const state = reported.providerState;
    if (!dependencies.retryTerminalFailure || reported.status !== "failed" || !isTerminalFailure(state)) {
      return execution(intent, true);
    }

    // Circle ended this attempt without moving money. The RPC re-checks that
    // on the row itself — the expected key, `failed`, a provider id, and a
    // terminal state — so a request that lost a race to it sends nothing.
    const next = await store.beginRetry(intent);
    if (!next) return execution(intent, true);
    retriedAfter = { providerTxId: reported.providerTxId, providerState: state, failureReason: reported.failureReason };
    intent = next;
  }

  // A send Circle never answered is looked for before anything is sent again (payment safety R4): found, it is
  // recorded; still being listed, or not asked, nothing is sent; never taken, it goes below as a new payment. A route
  // Circle cannot look up this way keeps its own safety, and is sent again as before.
  let unknownBefore = unknownSend(intent, now);
  if (unknownBefore) {
    const looked = await lookForUnknownSend(intent, request, dependencies.provider, store, now);
    if (looked === NOT_SENT) {
      intent = await store.get(intent.idempotencyKey);
      unknownBefore = false;
    } else if (looked) {
      return looked;
    }
  }

  const idempotencyKey = intent.idempotencyKey;
  const claim = await store.claim(idempotencyKey);
  if (!claim) {
    // Another worker owns a fresh submission claim. Do not race it with a
    // second provider call; the next cycle will reconcile its recorded ID.
    return execution(await store.get(idempotencyKey), false, retriedAfter);
  }
  return sendClaimed(intent, request, dependencies.provider, store, retriedAfter, unknownBefore);
}

const NOT_SENT = "not_sent" as const;

/** HH:MM UTC, for when an unknown send is looked for again. */
function utcClock(at: number): string {
  return new Date(at).toISOString().slice(11, 16);
}

/**
 * Looks for a send Circle never answered, sending nothing (payment safety R4, R5): by the payment's reference, in the
 * wallet the send went from (the agent's for the spending limit contract, else the account's), around the send, leaving
 * out the transactions of earlier attempts.
 * - Found: recorded, and its execution returned.
 * - Not listed 15 minutes after the send: Circle never took it. Recorded as such, and `NOT_SENT` lets the caller send
 *   it as a new payment.
 * - Not listed yet, or Circle could not be asked: a pending execution saying when it is looked for again. Nothing is
 *   written, so the intent stays unknown.
 * - A route Circle cannot look up this way: null. Gateway's transfer is the same spec spent once; CCTP's steps are the
 *   same keys on the same wallet.
 */
async function lookForUnknownSend(
  intent: PaymentIntent,
  request: Pick<PaymentRequest, "fromAccountId" | "memo" | "destinationChain">,
  provider: ChainProvider,
  store: PaymentIntentStore,
  now: number
): Promise<PaymentExecution | typeof NOT_SENT | null> {
  if (intent.route === "gateway" || intent.route === "cctp" || paidAcrossChains(request.destinationChain)) return null;
  if (!provider.findTransferByRef) return null;
  const sentAt = Date.parse(intent.updatedAt);
  const undecided = (error: string): PaymentExecution => ({ ...execution(intent, true), status: "pending", error });
  let found: TransferResult | null;
  try {
    found = await provider.findTransferByRef(
      request.fromAccountId,
      request.memo,
      { from: new Date(sentAt - 10 * 60_000).toISOString(), to: new Date(sentAt + 2 * UNKNOWN_SEND_GRACE_MS).toISOString() },
      {
        ...(intent.sentWalletId ? { walletId: intent.sentWalletId } : {}),
        exclude: intent.previousAttempts.map((attempt) => attempt.providerTxId).filter((id): id is string => Boolean(id)),
      }
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message.replace(/\.$/, "") : "the lookup failed";
    return undecided(`Circle could not be asked about this payment's earlier send (${reason}); it is looked for again, and sent only if Circle has none.`);
  }
  if (found) return execution(await store.recordResult(intent.idempotencyKey, found), true);
  if (now - sentAt < UNKNOWN_SEND_GRACE_MS) {
    return undecided(
      `Circle has not listed this payment's earlier send yet; it is looked for again from ${utcClock(sentAt + UNKNOWN_SEND_GRACE_MS)} UTC, and sent only if Circle has none.`
    );
  }
  await store.recordError(intent.idempotencyKey, NO_EARLIER_SEND);
  return NOT_SENT;
}

/** What looking for a source's unknown send found (payment safety R6). */
export type UnknownSendAnswer =
  /** The source's send is not unknown: nothing was looked for. */
  | { answer: "known" }
  /** Circle has the transfer, now recorded. */
  | { answer: "found" }
  /** Circle never took it, now recorded: the payment was never sent. */
  | { answer: "not_sent" }
  /** Not listed yet (`retryAt`: when it can be told), Circle could not be asked, or this route cannot be looked up. */
  | { answer: "undecided"; retryAt: string | null };

/**
 * Looks for a source's send Circle never answered, sending nothing (payment safety R6): what Reject, Return, Add
 * details and Close ask before they act, so no unknown send is a dead end. Found and never-taken are recorded, as
 * `executePayment` records them.
 */
export async function settleUnknownSend(
  source: { type: PaymentSourceType; id: string },
  deps: { provider: ChainProvider; fromAccountId: string; store?: PaymentIntentStore; now?: number }
): Promise<UnknownSendAnswer> {
  const store = deps.store ?? new SupabasePaymentIntentStore();
  const now = deps.now ?? Date.now();
  if (!store.findBySource) throw new Error("this payment store cannot find an intent by its source");
  const intent = await store.findBySource(source.type, source.id);
  if (!intent || !unknownSend(intent, now)) return { answer: "known" };
  const looked = await lookForUnknownSend(
    intent,
    { fromAccountId: deps.fromAccountId, memo: paymentMemo(source.type, source.id), destinationChain: intent.destinationChain ?? undefined },
    deps.provider,
    store,
    now
  );
  if (looked === NOT_SENT) return { answer: "not_sent" };
  if (looked?.providerTxId) return { answer: "found" };
  const listedBy = Date.parse(intent.updatedAt) + UNKNOWN_SEND_GRACE_MS;
  return { answer: "undecided", retryAt: looked && looked.error?.startsWith("Circle has not listed") ? new Date(listedBy).toISOString() : null };
}

/** A claimed attempt, sent alone under its own key: `executePayment`'s send, and a batch member's when it cannot go in a batch. */
async function sendClaimed(
  intent: PaymentIntent,
  request: PaymentRequest,
  provider: ChainProvider,
  store: PaymentIntentStore,
  retriedAfter: RetriedAfter | null,
  unknownBefore = false
): Promise<PaymentExecution> {
  const idempotencyKey = intent.idempotencyKey;
  let result: TransferResult;
  try {
    // A Gateway transfer is refused again only when its whole spec repeats: the same
    // salt with another amount (a discount that lapsed), payee or chain would be a
    // second transfer. A later attempt is sent only as the first one asked (review C1).
    const route = intent.route === "escrow" ? "escrow" : paidAcrossChains(request.destinationChain) ? (intent.route ?? "cctp") : null;
    // A release from escrow and a transfer are never both sent for one payment (milestone escrow E4).
    if (route === "escrow" && !request.escrow) {
      throw new Error("This milestone's payment is a release from escrow; nothing was sent. Check its hold on Arc testnet before paying it another way.");
    }
    if (request.escrow && route !== "escrow") {
      throw new Error("This milestone is locked in escrow, but its payment was started as a transfer; nothing was sent. Check it before paying it.");
    }
    // The contract carries USDC paid on Arc only: not a release from escrow, not a payout to another chain (R3, R4).
    if (request.spendingLimit && route !== null) {
      throw new Error("This payment cannot go through the spending limit contract; nothing was sent.");
    }
    if (route === "gateway" && !sameGatewayPayout(intent, request)) {
      throw new Error(
        "This payout was first sent through Gateway with another amount, payee or chain; nothing was sent. Check with Circle whether the first transfer was made before paying it again."
      );
    }
    // The wallet the send goes from, recorded first, so a send whose answer is lost is looked for there (R5).
    const sentWalletId = request.spendingLimit?.agentWalletId ?? null;
    if (store.markSending && sentWalletId !== (intent.sentWalletId ?? null)) await store.markSending(idempotencyKey, sentWalletId);
    result = await provider.transfer({
      fromAccountId: request.fromAccountId,
      toAddress: request.destination,
      amount: request.amount,
      memo: request.memo,
      idempotencyKey,
      token: request.token ?? "USDC",
      ...(request.destinationChain ? { destinationChain: request.destinationChain } : {}),
      ...(request.maxBridgeFeeUsdc != null ? { maxBridgeFeeUsdc: request.maxBridgeFeeUsdc } : {}),
      // The intent's route, never the request's: an intent from before routes were kept went through CCTP.
      ...(route ? { route } : {}),
      ...(route === "escrow" && request.escrow ? { escrow: request.escrow } : {}),
      ...(request.spendingLimit ? { spendingLimit: request.spendingLimit } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Transfer failed";
    // An earlier send under this key that Circle never answered stays unknown until Circle says what became of it (R7).
    const kept = unknownBefore && !message.includes(MAY_HAVE_BEEN_ACCEPTED) ? `${message} (an earlier send under this key ${MAY_HAVE_BEEN_ACCEPTED})` : message;
    return execution(await store.recordError(idempotencyKey, kept), false, retriedAfter);
  }
  try {
    return execution(await store.recordResult(idempotencyKey, result), false, retriedAfter);
  } catch (error) {
    // Circle took it, but it could not be recorded: it is looked for and found, never closed over (R9).
    const reason = error instanceof Error ? error.message : "the write failed";
    return execution(
      await store.recordError(idempotencyKey, `Circle took this transfer (${result.providerTxId}), but it could not be recorded (${reason}); it ${MAY_HAVE_BEEN_ACCEPTED}`),
      false,
      retriedAfter
    );
  }
}

/** Whether a request may go in a batch at all (batch payouts R1): USDC on Arc, not a release from escrow. */
function batchable(request: PaymentRequest): boolean {
  return !request.escrow && !request.route && !request.spendingLimit && !paidAcrossChains(request.destinationChain) && (request.token ?? "USDC") === "USDC";
}

interface Claimed {
  index: number;
  request: PaymentRequest;
  intent: PaymentIntent;
}

/**
 * Pays several sources, sending together those that can share one transaction (batch payouts §2,
 * R1-R4). A request that may be batched and whose intent is new (a first attempt, never sent) is
 * claimed; the claimed ones from one account go out in batches of up to MAX_BATCH_SIZE, split evenly,
 * through the provider's `batchTransfer`. Everything else, and everything when the provider cannot
 * batch, goes through `executePayment` as before, as does a lone claimed one (sent alone under its
 * own key). Returns each request's execution, in the requests' order.
 */
export async function executePaymentBatch(
  requests: PaymentRequest[],
  dependencies: { provider: ChainProvider; store?: PaymentIntentStore & PaymentBatchStore }
): Promise<PaymentExecution[]> {
  const store = dependencies.store ?? new SupabasePaymentIntentStore();
  const provider = dependencies.provider;
  const results: PaymentExecution[] = new Array(requests.length);
  const claimed: Claimed[] = [];
  for (const [index, request] of requests.entries()) {
    if (!provider.batchTransfer || requests.length < 2 || !batchable(request)) {
      results[index] = await executePayment(request, { provider, store });
      continue;
    }
    const intent = await store.ensure({
      ...request,
      idempotencyKey: paymentIdempotencyKey(request.sourceType, request.sourceId),
      provider: provider.mode === "live" ? "circle" : "simulate",
    });
    // Only a payment never sent joins a batch (R1): anything else goes its usual way, reconciled or sent alone.
    if (intent.status !== "created" || intent.providerTxId || intent.batchKey || intent.transferAttempt !== 1 || intent.route) {
      results[index] = await executePayment(request, { provider, store });
      continue;
    }
    const claim = await store.claim(intent.idempotencyKey);
    if (!claim) {
      results[index] = execution(await store.get(intent.idempotencyKey), false);
      continue;
    }
    claimed.push({ index, request, intent: claim });
  }

  // One wallet's transaction: grouped by the account paid from, then split evenly into batches no larger than the most.
  const byAccount = new Map<string, Claimed[]>();
  for (const member of claimed) byAccount.set(member.request.fromAccountId, [...(byAccount.get(member.request.fromAccountId) ?? []), member]);
  for (const group of byAccount.values()) {
    const size = Math.ceil(group.length / Math.ceil(group.length / MAX_BATCH_SIZE));
    for (let start = 0; start < group.length; start += size) {
      const chunk = group.slice(start, start + size);
      if (chunk.length === 1) {
        results[chunk[0].index] = await sendClaimed(chunk[0].intent, chunk[0].request, provider, store, null);
        continue;
      }
      for (const [index, outcome] of await sendBatch(chunk, provider, store)) results[index] = outcome;
    }
  }
  return results;
}

/**
 * One batch of claimed payments (batch payouts R3-R6). The batch is written on every member in one
 * statement before Circle is called; when it does not reach every member it is undone and each is
 * sent alone. A send whose answer was lost leaves every member carrying the batch, looked for on
 * Circle next time (R5). Each member records the batch's transaction with its share of the fee.
 */
async function sendBatch(
  members: Claimed[],
  provider: ChainProvider,
  store: PaymentIntentStore & PaymentBatchStore
): Promise<Array<[number, PaymentExecution]>> {
  const sorted = [...members].sort((a, b) => (a.intent.idempotencyKey < b.intent.idempotencyKey ? -1 : a.intent.idempotencyKey > b.intent.idempotencyKey ? 1 : 0));
  const keys = sorted.map((member) => member.intent.idempotencyKey);
  const batch = { key: batchIdempotencyKey(keys), size: keys.length, sentAt: new Date().toISOString() };
  const each = async (fn: (member: Claimed) => Promise<PaymentExecution>) => {
    const out: Array<[number, PaymentExecution]> = [];
    for (const member of sorted) out.push([member.index, await fn(member)]);
    return out;
  };

  let joined: number | null;
  try {
    joined = await store.joinBatch(keys, batch);
  } catch (error) {
    console.error("payments: the batch was not recorded", error instanceof Error ? error.message : error);
    joined = null;
  }
  if (joined !== keys.length) {
    // Not every member carries the batch, so it is not sent (R4): undone, then each is paid alone under its own key.
    if (joined !== 0) {
      try {
        await store.leaveBatch(batch.key);
      } catch (error) {
        // Some may still carry it: they are looked for on Circle, which never had it, then paid alone (R5).
        const message = `The batch could not be recorded; nothing was sent: ${error instanceof Error ? error.message : "write failed"}`;
        return each(async (member) => execution(await store.recordError(member.intent.idempotencyKey, message), false));
      }
    }
    return each((member) => sendClaimed(member.intent, member.request, provider, store, null));
  }

  let result: TransferResult;
  try {
    result = await (provider.batchTransfer as NonNullable<ChainProvider["batchTransfer"]>)({
      fromAccountId: sorted[0].request.fromAccountId,
      transfers: sorted.map((member) => ({ toAddress: member.intent.destination, amount: member.intent.amount })),
      idempotencyKey: batch.key,
    });
  } catch (error) {
    // Nothing reached Circle: the batch is undone and each is sent alone at once, under its own key (R4).
    if (error instanceof BatchNotSentError) {
      try {
        await store.leaveBatch(batch.key);
      } catch {
        // Still carried: looked for on Circle, which never had it, and paid alone after (R5).
        return each(async (member) => execution(await store.recordError(member.intent.idempotencyKey, error.message), false));
      }
      return each((member) => sendClaimed(member.intent, member.request, provider, store, null));
    }
    // Circle may or may not have the batch: every member keeps it, and is looked for rather than sent again (R5).
    const message = error instanceof Error ? error.message : "Batch transfer failed";
    return each(async (member) => execution(await store.recordError(member.intent.idempotencyKey, message), false));
  }
  const share = shareOf(result, keys.length);
  return each(async (member) => {
    try {
      return execution(await store.recordResult(member.intent.idempotencyKey, share), false);
    } catch (error) {
      // Circle has the batch; this member's record of it did not land. It is found by the batch's refId next time (R5).
      console.error("payments: a batch member's result was not recorded", member.intent.idempotencyKey, error instanceof Error ? error.message : error);
      return { ...execution({ ...member.intent, batchKey: batch.key, batchSize: batch.size, batchSentAt: batch.sentAt }, false), txHash: result.txHash, txRef: result.txRef };
    }
  });
}
