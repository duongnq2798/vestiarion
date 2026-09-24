import { createHash } from "node:crypto";
import type { ChainProvider, TransferResult } from "./circle";
import { supabase, unwrap } from "./supabase";

export type PaymentSourceType = "invoice" | "milestone";
export type PaymentIntentStatus = "created" | "submitting" | "pending" | "confirmed" | "failed";

export interface PaymentIntent {
  id: string;
  sourceType: PaymentSourceType;
  sourceId: string;
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
  created_at: string;
  updated_at: string;
}

export interface PaymentIntentStore {
  ensure(input: PaymentRequest & { idempotencyKey: string; provider: "circle" | "simulate" }): Promise<PaymentIntent>;
  get(idempotencyKey: string): Promise<PaymentIntent>;
  claim(idempotencyKey: string): Promise<PaymentIntent | null>;
  recordResult(idempotencyKey: string, result: TransferResult): Promise<PaymentIntent>;
  recordError(idempotencyKey: string, error: string): Promise<PaymentIntent>;
}

export interface PaymentRequest {
  sourceType: PaymentSourceType;
  sourceId: string;
  fromAccountId: string;
  destination: string;
  amount: number;
  memo: string;
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
}

function asUuid(bytes: Uint8Array): string {
  const value = Uint8Array.from(bytes.slice(0, 16));
  value[6] = (value[6] & 0x0f) | 0x50;
  value[8] = (value[8] & 0x3f) | 0x80;
  const hex = Buffer.from(value).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Stable UUID-shaped key accepted by Circle's SDK and safe to reuse forever. */
export function paymentIdempotencyKey(sourceType: PaymentSourceType, sourceId: string): string {
  const hash = createHash("sha256").update(`vestiarion/payment/v1/${sourceType}/${sourceId}`, "utf8").digest();
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SupabasePaymentIntentStore implements PaymentIntentStore {
  async ensure(input: PaymentRequest & { idempotencyKey: string; provider: "circle" | "simulate" }): Promise<PaymentIntent> {
    const result = await supabase().from("payment_intents").upsert({
      source_type: input.sourceType,
      source_id: input.sourceId,
      idempotency_key: input.idempotencyKey,
      provider: input.provider,
      amount: input.amount,
      destination: input.destination,
    }, { onConflict: "idempotency_key", ignoreDuplicates: true });
    if (result.error) throw new Error(result.error.message);
    return this.get(input.idempotencyKey);
  }

  async get(idempotencyKey: string): Promise<PaymentIntent> {
    const row = unwrap(
      await supabase().from("payment_intents").select("*").eq("idempotency_key", idempotencyKey).single<PaymentIntentRow>()
    );
    return fromRow(row);
  }

  async claim(idempotencyKey: string): Promise<PaymentIntent | null> {
    const result = await supabase()
      .rpc("claim_payment_intent", { p_idempotency_key: idempotencyKey })
      .maybeSingle<PaymentIntentRow>();
    if (result.error) throw new Error(result.error.message);
    return result.data ? fromRow(result.data) : null;
  }

  async recordResult(idempotencyKey: string, result: TransferResult): Promise<PaymentIntent> {
    const now = new Date().toISOString();
    const update = await supabase().from("payment_intents").update({
      provider_tx_id: result.providerTxId,
      tx_hash: result.txHash,
      status: result.status,
      last_error: null,
      confirmed_at: result.status === "confirmed" ? now : null,
      updated_at: now,
    }).eq("idempotency_key", idempotencyKey);
    if (update.error) throw new Error(update.error.message);
    return this.get(idempotencyKey);
  }

  async recordError(idempotencyKey: string, error: string): Promise<PaymentIntent> {
    const update = await supabase().from("payment_intents").update({
      status: "failed",
      last_error: error,
      updated_at: new Date().toISOString(),
    }).eq("idempotency_key", idempotencyKey);
    if (update.error) throw new Error(update.error.message);
    return this.get(idempotencyKey);
  }
}

function execution(intent: PaymentIntent, reconciled: boolean): PaymentExecution {
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
  };
}

export async function executePayment(
  request: PaymentRequest,
  dependencies: { provider: ChainProvider; store?: PaymentIntentStore }
): Promise<PaymentExecution> {
  const store = dependencies.store ?? new SupabasePaymentIntentStore();
  const idempotencyKey = paymentIdempotencyKey(request.sourceType, request.sourceId);
  let intent = await store.ensure({
    ...request,
    idempotencyKey,
    provider: dependencies.provider.mode === "live" ? "circle" : "simulate",
  });

  if (intent.status === "confirmed") return execution(intent, false);

  // Provider identity means a transfer already exists. Reconcile it before
  // considering submission; this is the duplicate-payment boundary.
  if (intent.providerTxId) {
    try {
      const result = await dependencies.provider.reconcileTransfer(intent.providerTxId);
      intent = await store.recordResult(idempotencyKey, result);
      return execution(intent, true);
    } catch (error) {
      intent = await store.recordError(idempotencyKey, error instanceof Error ? error.message : "Reconciliation failed");
      return execution(intent, true);
    }
  }

  const claim = await store.claim(idempotencyKey);
  if (!claim) {
    // Another worker owns a fresh submission claim. Do not race it with a
    // second provider call; the next cycle will reconcile its recorded ID.
    return execution(await store.get(idempotencyKey), false);
  }

  try {
    const result = await dependencies.provider.transfer({
      fromAccountId: request.fromAccountId,
      toAddress: request.destination,
      amount: request.amount,
      memo: request.memo,
      idempotencyKey,
    });
    intent = await store.recordResult(idempotencyKey, result);
    return execution(intent, false);
  } catch (error) {
    intent = await store.recordError(idempotencyKey, error instanceof Error ? error.message : "Transfer failed");
    return execution(intent, false);
  }
}
