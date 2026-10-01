import { createHash } from "node:crypto";
import type { ChainProvider, Stablecoin, TransferResult } from "./circle";
import { FAILED_STATES } from "./circle/settlement";
import { db, unwrap } from "./dal";

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
  };
}

/**
 * `payment_intents` through the tenant client. The row is one per source
 * (`unique (source_type, source_id)`) and is found by its source; its key is
 * read from the row, since a retry moves it to a later attempt's key. Every
 * write after that names the current key, so a write about an attempt that
 * another request already moved on matches nothing.
 */
export class SupabasePaymentIntentStore implements PaymentIntentStore {
  async ensure(input: PaymentRequest & { idempotencyKey: string; provider: "circle" | "simulate" }): Promise<PaymentIntent> {
    const result = await db().from("payment_intents").upsert({
      source_type: input.sourceType,
      source_id: input.sourceId,
      idempotency_key: input.idempotencyKey,
      provider: input.provider,
      provider_mode: input.provider === "circle" ? "live" : "simulate",
      amount: input.amount,
      destination: input.destination,
      token: input.token ?? "USDC",
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
      chain: result.chain,
      provider_mode: result.providerMode,
      fee_usd: result.feeUsd,
      fee_source: result.feeSource,
      settled_in_ms: result.settledInMs,
      provider_state: result.providerState,
      failure_reason: result.failureReason,
      executed_at: now,
      updated_at: now,
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
}

function execution(intent: PaymentIntent, reconciled: boolean, retriedAfter: RetriedAfter | null = null): PaymentExecution {
  const status = intent.status === "confirmed" ? "confirmed" : intent.status === "failed" ? "failed" : "pending";
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
  };
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
  dependencies: { provider: ChainProvider; store?: PaymentIntentStore; retryTerminalFailure?: boolean }
): Promise<PaymentExecution> {
  const store = dependencies.store ?? new SupabasePaymentIntentStore();
  let intent = await store.ensure({
    ...request,
    idempotencyKey: paymentIdempotencyKey(request.sourceType, request.sourceId),
    provider: dependencies.provider.mode === "live" ? "circle" : "simulate",
  });

  if (intent.status === "confirmed") return execution(intent, false);

  let retriedAfter: RetriedAfter | null = null;

  // Provider identity means a transfer already exists. Reconcile it before
  // considering submission; this is the duplicate-payment boundary.
  if (intent.providerTxId) {
    let reported: TransferResult;
    try {
      reported = await dependencies.provider.reconcileTransfer(intent.providerTxId);
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

  const idempotencyKey = intent.idempotencyKey;
  const claim = await store.claim(idempotencyKey);
  if (!claim) {
    // Another worker owns a fresh submission claim. Do not race it with a
    // second provider call; the next cycle will reconcile its recorded ID.
    return execution(await store.get(idempotencyKey), false, retriedAfter);
  }

  try {
    const result = await dependencies.provider.transfer({
      fromAccountId: request.fromAccountId,
      toAddress: request.destination,
      amount: request.amount,
      memo: request.memo,
      idempotencyKey,
      token: request.token ?? "USDC",
    });
    intent = await store.recordResult(idempotencyKey, result);
    return execution(intent, false, retriedAfter);
  } catch (error) {
    intent = await store.recordError(idempotencyKey, error instanceof Error ? error.message : "Transfer failed");
    return execution(intent, false, retriedAfter);
  }
}
