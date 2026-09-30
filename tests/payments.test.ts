import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import {
  executePayment,
  paymentIdempotencyKey,
  SupabasePaymentIntentStore,
  type PaymentIntent,
  type PaymentIntentStore,
  type PaymentRequest,
} from "@/lib/payments";
import type {
  BalanceSnapshot,
  ChainProvider,
  EarnResult,
  TransferParams,
  TransferResult,
} from "@/lib/circle";
import { fakeSupabase, orgTestContext, type RecordedRequest } from "./support/fake-supabase";

const request: PaymentRequest = {
  sourceType: "invoice",
  sourceId: "018f8ce0-1557-7b54-a931-4d777f6bcafe",
  fromAccountId: "account-1",
  destination: "0x1234",
  amount: 12.5,
  memo: "Invoice test",
};

/** Circle's terminal failure states, as `begin_payment_retry` (migration 0036) reads them. */
const TERMINAL = ["CANCELLED", "DENIED", "FAILED"];

/**
 * One source's intent in memory, following the real store's rules: rows are
 * found by source, every write names the intent's current key (a stale key
 * matches nothing, as the real `.eq("idempotency_key", …)` would), and
 * `beginRetry` applies `begin_payment_retry`'s own condition. `calls`
 * records what reached the store, in order, with the key each call named.
 */
class MemoryStore implements PaymentIntentStore {
  intent?: PaymentIntent;
  calls: string[] = [];
  /** When set, `begin_payment_retry` matches no row — another request already moved this attempt on. */
  refuseRetry = false;

  private current(key: string): PaymentIntent {
    if (!this.intent || this.intent.idempotencyKey !== key) throw new Error(`no intent with key ${key}`);
    return this.intent;
  }

  async ensure(input: PaymentRequest & { idempotencyKey: string; provider: "circle" | "simulate" }): Promise<PaymentIntent> {
    this.calls.push("ensure");
    this.intent ??= {
      id: "intent-1",
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      idempotencyKey: input.idempotencyKey,
      provider: input.provider,
      providerTxId: null,
      txHash: null,
      amount: input.amount,
      destination: input.destination,
      status: "created",
      attemptCount: 0,
      lastError: null,
      confirmedAt: null,
      chain: null,
      providerMode: input.provider === "circle" ? "live" : "simulate",
      feeUsd: null,
      feeSource: null,
      settledInMs: null,
      executedAt: null,
      providerState: null,
      failureReason: null,
      transferAttempt: 1,
      previousAttempts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    return { ...this.intent };
  }

  async get(key: string): Promise<PaymentIntent> {
    this.calls.push(`get:${key}`);
    return { ...this.current(key) };
  }

  async claim(key: string): Promise<PaymentIntent | null> {
    this.calls.push(`claim:${key}`);
    if (!this.intent || this.intent.idempotencyKey !== key || !["created", "failed"].includes(this.intent.status)) return null;
    this.intent = { ...this.intent, status: "submitting", attemptCount: this.intent.attemptCount + 1 };
    return { ...this.intent };
  }

  async recordResult(key: string, transfer: TransferResult): Promise<PaymentIntent> {
    this.calls.push(`recordResult:${key}`);
    this.intent = {
      ...this.current(key),
      providerTxId: transfer.providerTxId,
      txHash: transfer.txHash,
      status: transfer.status,
      lastError: null,
      confirmedAt: transfer.status === "confirmed" ? "2026-01-01T00:01:00.000Z" : null,
      chain: transfer.chain,
      providerMode: transfer.providerMode,
      feeUsd: transfer.feeUsd,
      feeSource: transfer.feeSource,
      settledInMs: transfer.settledInMs,
      providerState: transfer.providerState,
      failureReason: transfer.failureReason,
      executedAt: "2026-01-01T00:01:00.000Z",
    };
    return { ...this.intent };
  }

  async recordError(key: string, error: string): Promise<PaymentIntent> {
    this.calls.push(`recordError:${key}`);
    this.intent = { ...this.current(key), status: "failed", lastError: error };
    return { ...this.intent };
  }

  async beginRetry(intent: PaymentIntent): Promise<PaymentIntent | null> {
    const next = paymentIdempotencyKey(intent.sourceType, intent.sourceId, intent.transferAttempt + 1);
    this.calls.push(`beginRetry:${intent.idempotencyKey}->${next}`);
    const row = this.intent;
    if (
      this.refuseRetry ||
      !row ||
      row.idempotencyKey !== intent.idempotencyKey ||
      row.status !== "failed" ||
      row.providerTxId === null ||
      !TERMINAL.includes(row.providerState ?? "")
    ) {
      return null;
    }
    this.intent = {
      ...row,
      previousAttempts: [
        ...row.previousAttempts,
        {
          attempt: row.transferAttempt,
          idempotencyKey: row.idempotencyKey,
          providerTxId: row.providerTxId,
          providerState: row.providerState,
          failureReason: row.failureReason,
          failedAt: row.updatedAt,
        },
      ],
      idempotencyKey: next,
      transferAttempt: row.transferAttempt + 1,
      providerTxId: null,
      txHash: null,
      providerState: null,
      failureReason: null,
      feeUsd: null,
      feeSource: null,
      settledInMs: null,
      status: "created",
      lastError: null,
      confirmedAt: null,
      executedAt: null,
    };
    return { ...this.intent };
  }
}

class FakeProvider implements ChainProvider {
  readonly mode = "live" as const;
  readonly earnMode = "simulate" as const;
  readonly estimatedFeeUsd = 0.01;
  transfers: TransferParams[] = [];
  reconciliations: string[] = [];
  transferResults: Array<TransferResult | Error> = [];
  reconcileResults: Array<TransferResult | Error> = [];

  async transfer(params: TransferParams): Promise<TransferResult> {
    this.transfers.push(params);
    const next = this.transferResults.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("missing fake transfer result");
    return next;
  }

  async reconcileTransfer(providerTxId: string): Promise<TransferResult> {
    this.reconciliations.push(providerTxId);
    const next = this.reconcileResults.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("missing fake reconciliation result");
    return next;
  }

  async getBalance(): Promise<BalanceSnapshot> { throw new Error("not used"); }
  async depositToEarn(): Promise<EarnResult> { throw new Error("not used"); }
  async withdrawFromEarn(): Promise<EarnResult> { throw new Error("not used"); }
}

/**
 * A transfer as the provider reports it. `circle` overrides what Circle said
 * — its `state` and `errorReason` — which otherwise follow the status the
 * way LiveProvider sets them for a confirmed transfer.
 */
function transferResult(
  status: TransferResult["status"],
  providerTxId = "circle-tx-1",
  circle: { state?: string | null; reason?: string | null } = {}
): TransferResult {
  return {
    providerTxId,
    txHash: status === "confirmed" ? "0xhash" : null,
    txRef: status === "confirmed" ? "0xhash" : providerTxId,
    chain: "ARC-TESTNET",
    status,
    feeUsd: 0.01,
    feeSource: "chain_reported",
    providerMode: "live",
    settledInMs: 5,
    providerState: circle.state !== undefined ? circle.state : status === "confirmed" ? "COMPLETE" : null,
    failureReason: circle.reason ?? null,
  };
}

/** The attempt-path derivation, computed here from its definition rather than through the code under test. */
function attemptKey(sourceType: string, sourceId: string, attempt: number): string {
  const value = Uint8Array.from(
    createHash("sha256").update(`vestiarion/payment/v1/${sourceType}/${sourceId}/attempt/${attempt}`, "utf8").digest().subarray(0, 16)
  );
  value[6] = (value[6] & 0x0f) | 0x50;
  value[8] = (value[8] & 0x3f) | 0x80;
  const hex = Buffer.from(value).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("payment idempotency", () => {
  it("derives a stable UUID and separates source types", () => {
    const first = paymentIdempotencyKey("invoice", request.sourceId);
    expect(first).toBe(paymentIdempotencyKey("invoice", request.sourceId));
    expect(first).toMatch(UUID_SHAPE);
    expect(first).not.toBe(paymentIdempotencyKey("milestone", request.sourceId));
  });

  it("keeps attempt 1's key byte-identical to the key every existing intent was sent with", () => {
    // Computed from `paymentIdempotencyKey(sourceType, sourceId)` as it stood
    // before attempts existed (commit 1f5786f). Every key already sent to
    // Circle is one of these; none may change identity (R4).
    expect(paymentIdempotencyKey("invoice", request.sourceId)).toBe("5115a85a-286b-58f2-a592-f98baf9127d5");
    expect(paymentIdempotencyKey("invoice", request.sourceId, 1)).toBe("5115a85a-286b-58f2-a592-f98baf9127d5");
    expect(paymentIdempotencyKey("milestone", request.sourceId)).toBe("909475ff-e3b5-5558-8769-3682b6dd7f10");
    expect(paymentIdempotencyKey("milestone", request.sourceId, 1)).toBe("909475ff-e3b5-5558-8769-3682b6dd7f10");
  });

  it("derives a later attempt's key from the attempt path, shaped the same way, distinct from every other attempt's", () => {
    const keys = [1, 2, 3].map((attempt) => paymentIdempotencyKey("invoice", request.sourceId, attempt));

    expect(keys[1]).toBe(attemptKey("invoice", request.sourceId, 2));
    expect(keys[2]).toBe(attemptKey("invoice", request.sourceId, 3));
    for (const key of keys) expect(key).toMatch(UUID_SHAPE);
    expect(new Set(keys).size).toBe(3);
    expect(paymentIdempotencyKey("milestone", request.sourceId, 2)).toBe(attemptKey("milestone", request.sourceId, 2));
    expect(paymentIdempotencyKey("milestone", request.sourceId, 2)).not.toBe(keys[1]);
  });

  it("retries a failed request with the same provider idempotency key", async () => {
    const store = new MemoryStore();
    const provider = new FakeProvider();
    provider.transferResults.push(new Error("connection reset after submit"), transferResult("confirmed"));

    expect((await executePayment(request, { provider, store })).status).toBe("failed");
    expect((await executePayment(request, { provider, store })).status).toBe("confirmed");
    expect(provider.transfers).toHaveLength(2);
    expect(provider.transfers[0].idempotencyKey).toBe(provider.transfers[1].idempotencyKey);
  });

  it("reconciles a pending provider transaction without creating a second transfer", async () => {
    const store = new MemoryStore();
    const provider = new FakeProvider();
    provider.transferResults.push(transferResult("pending"));
    provider.reconcileResults.push(transferResult("confirmed"));

    expect((await executePayment(request, { provider, store })).status).toBe("pending");
    const settled = await executePayment(request, { provider, store });
    expect(settled).toMatchObject({
      status: "confirmed",
      reconciled: true,
      txHash: "0xhash",
      feeUsd: 0.01,
      feeSource: "chain_reported",
      providerMode: "live",
      settledInMs: 5,
      attempt: 1,
      retriedAfter: null,
    });
    expect(provider.transfers).toHaveLength(1);
    expect(provider.reconciliations).toEqual(["circle-tx-1"]);
  });

  it("skips provider calls for an already confirmed intent", async () => {
    const store = new MemoryStore();
    const provider = new FakeProvider();
    provider.transferResults.push(transferResult("confirmed"));

    expect((await executePayment(request, { provider, store })).status).toBe("confirmed");
    expect((await executePayment(request, { provider, store })).status).toBe("confirmed");
    expect(provider.transfers).toHaveLength(1);
    expect(provider.reconciliations).toHaveLength(0);
  });

  it("records Circle's state and failure reason on the intent", async () => {
    const store = new MemoryStore();
    const provider = new FakeProvider();
    provider.transferResults.push(transferResult("failed", "circle-tx-1", { state: "FAILED", reason: "INSUFFICIENT_NATIVE_TOKEN" }));

    const failed = await executePayment(request, { provider, store });

    expect(failed).toMatchObject({ status: "failed", error: null, attempt: 1, retriedAfter: null });
    expect(store.intent).toMatchObject({ status: "failed", providerState: "FAILED", failureReason: "INSUFFICIENT_NATIVE_TOKEN", lastError: null });
  });
});

describe("executePayment after a terminal failure (retryTerminalFailure)", () => {
  const KEY_1 = paymentIdempotencyKey("invoice", request.sourceId);
  const KEY_2 = attemptKey("invoice", request.sourceId, 2);
  const KEY_3 = attemptKey("invoice", request.sourceId, 3);

  /** A store and provider whose attempt 1 was sent and reported back with Circle's `state` and `reason`. */
  async function afterFirstAttempt(circle: { state: string | null; reason?: string | null }) {
    const store = new MemoryStore();
    const provider = new FakeProvider();
    provider.transferResults.push(transferResult("failed", "circle-tx-1", circle));
    await executePayment(request, { provider, store });
    store.calls = [];
    return { store, provider };
  }

  it("without the flag, reconciles a terminally failed transfer and never sends another", async () => {
    const { store, provider } = await afterFirstAttempt({ state: "FAILED", reason: "INSUFFICIENT_NATIVE_TOKEN" });
    provider.reconcileResults.push(transferResult("failed", "circle-tx-1", { state: "FAILED", reason: "INSUFFICIENT_NATIVE_TOKEN" }));

    const execution = await executePayment(request, { provider, store });

    expect(execution).toMatchObject({ status: "failed", reconciled: true, attempt: 1, retriedAfter: null, idempotencyKey: KEY_1 });
    expect(provider.reconciliations).toEqual(["circle-tx-1"]);
    expect(provider.transfers).toHaveLength(1);
    expect(store.calls).toEqual(["ensure", `recordResult:${KEY_1}`]);
  });

  it.each(TERMINAL)("with the flag and Circle reporting %s, opens attempt 2, claims it, and transfers under attempt 2's key", async (state) => {
    const { store, provider } = await afterFirstAttempt({ state, reason: "INSUFFICIENT_NATIVE_TOKEN" });
    provider.reconcileResults.push(transferResult("failed", "circle-tx-1", { state, reason: "INSUFFICIENT_NATIVE_TOKEN" }));
    provider.transferResults.push(transferResult("confirmed", "circle-tx-2"));

    const execution = await executePayment(request, { provider, store, retryTerminalFailure: true });

    // Circle is read first; only its answer opens the attempt, and only the
    // opened attempt's key reaches the claim and the transfer.
    expect(store.calls).toEqual([
      "ensure",
      `recordResult:${KEY_1}`,
      `beginRetry:${KEY_1}->${KEY_2}`,
      `claim:${KEY_2}`,
      `recordResult:${KEY_2}`,
    ]);
    expect(provider.reconciliations).toEqual(["circle-tx-1"]);
    expect(provider.transfers).toHaveLength(2);
    expect(provider.transfers[1]).toEqual({
      fromAccountId: request.fromAccountId,
      toAddress: request.destination,
      amount: request.amount,
      memo: request.memo,
      idempotencyKey: KEY_2,
    });
    expect(execution).toMatchObject({
      status: "confirmed",
      reconciled: false,
      idempotencyKey: KEY_2,
      providerTxId: "circle-tx-2",
      txRef: "0xhash",
      attempt: 2,
      retriedAfter: { providerTxId: "circle-tx-1", providerState: state, failureReason: "INSUFFICIENT_NATIVE_TOKEN" },
    });
    expect(store.intent?.previousAttempts).toEqual([
      expect.objectContaining({ attempt: 1, idempotencyKey: KEY_1, providerTxId: "circle-tx-1", providerState: state }),
    ]);
  });

  it.each([
    ["STUCK (sent, still minable)", transferResult("pending", "circle-tx-1", { state: "STUCK" })],
    ["pending", transferResult("pending", "circle-tx-1", { state: "SENT" })],
    ["confirmed", transferResult("confirmed", "circle-tx-1")],
    ["failed without a terminal state", transferResult("failed", "circle-tx-1", { state: null })],
  ] as const)("with the flag, a transfer Circle now reports as %s is recorded, never followed by a second", async (_label, now) => {
    // Recorded failed before Circle's state was kept: the stored status is
    // not evidence that nothing moved, so only Circle's answer now counts (R1).
    const { store, provider } = await afterFirstAttempt({ state: null });
    provider.reconcileResults.push(now);

    const execution = await executePayment(request, { provider, store, retryTerminalFailure: true });

    expect(execution).toMatchObject({ status: now.status, reconciled: true, attempt: 1, retriedAfter: null, idempotencyKey: KEY_1 });
    expect(store.calls).toEqual(["ensure", `recordResult:${KEY_1}`]);
    expect(provider.transfers).toHaveLength(1);
    expect(store.intent).toMatchObject({ providerState: now.providerState, transferAttempt: 1, idempotencyKey: KEY_1 });
  });

  it("with the flag, a reconcile that throws is recorded as our own error and sends nothing", async () => {
    const { store, provider } = await afterFirstAttempt({ state: "FAILED" });
    provider.reconcileResults.push(new Error("Circle returned no transaction for circle-tx-1"));

    const execution = await executePayment(request, { provider, store, retryTerminalFailure: true });

    expect(execution).toMatchObject({ status: "failed", error: "Circle returned no transaction for circle-tx-1", attempt: 1, retriedAfter: null });
    expect(store.calls).toEqual(["ensure", `recordError:${KEY_1}`]);
    expect(provider.transfers).toHaveLength(1);
    // recordError keeps what Circle last said: it is our read that failed, not the transfer.
    expect(store.intent).toMatchObject({ providerState: "FAILED", lastError: "Circle returned no transaction for circle-tx-1" });
  });

  it("with the flag, sends nothing when another request already moved the attempt on", async () => {
    const { store, provider } = await afterFirstAttempt({ state: "FAILED" });
    provider.reconcileResults.push(transferResult("failed", "circle-tx-1", { state: "FAILED" }));
    store.refuseRetry = true;

    const execution = await executePayment(request, { provider, store, retryTerminalFailure: true });

    expect(store.calls).toEqual(["ensure", `recordResult:${KEY_1}`, `beginRetry:${KEY_1}->${KEY_2}`]);
    expect(provider.transfers).toHaveLength(1);
    expect(execution).toMatchObject({ status: "failed", reconciled: true, attempt: 1, retriedAfter: null, idempotencyKey: KEY_1 });
  });

  it("records a retry that fails again with Circle's new reason, and the next retry opens attempt 3", async () => {
    const { store, provider } = await afterFirstAttempt({ state: "FAILED", reason: "INSUFFICIENT_NATIVE_TOKEN" });
    provider.reconcileResults.push(transferResult("failed", "circle-tx-1", { state: "FAILED", reason: "INSUFFICIENT_NATIVE_TOKEN" }));
    provider.transferResults.push(transferResult("failed", "circle-tx-2", { state: "FAILED", reason: "FAILED_ON_CHAIN" }));

    const second = await executePayment(request, { provider, store, retryTerminalFailure: true });

    expect(second).toMatchObject({ status: "failed", attempt: 2, idempotencyKey: KEY_2, providerTxId: "circle-tx-2" });
    expect(store.intent).toMatchObject({ status: "failed", transferAttempt: 2, providerState: "FAILED", failureReason: "FAILED_ON_CHAIN", lastError: null });

    store.calls = [];
    provider.reconcileResults.push(transferResult("failed", "circle-tx-2", { state: "FAILED", reason: "FAILED_ON_CHAIN" }));
    provider.transferResults.push(transferResult("confirmed", "circle-tx-3"));

    const third = await executePayment(request, { provider, store, retryTerminalFailure: true });

    expect(provider.reconciliations).toEqual(["circle-tx-1", "circle-tx-2"]);
    expect(store.calls).toEqual(["ensure", `recordResult:${KEY_2}`, `beginRetry:${KEY_2}->${KEY_3}`, `claim:${KEY_3}`, `recordResult:${KEY_3}`]);
    expect(provider.transfers.map((sent) => sent.idempotencyKey)).toEqual([KEY_1, KEY_2, KEY_3]);
    expect(third).toMatchObject({
      status: "confirmed",
      attempt: 3,
      idempotencyKey: KEY_3,
      retriedAfter: { providerTxId: "circle-tx-2", providerState: "FAILED", failureReason: "FAILED_ON_CHAIN" },
    });
    expect(store.intent?.previousAttempts.map((attempt) => [attempt.attempt, attempt.providerTxId, attempt.failureReason])).toEqual([
      [1, "circle-tx-1", "INSUFFICIENT_NATIVE_TOKEN"],
      [2, "circle-tx-2", "FAILED_ON_CHAIN"],
    ]);
  });

  it("without the flag, an intent already on attempt 2 is reconciled under attempt 2's key", async () => {
    const { store, provider } = await afterFirstAttempt({ state: "FAILED" });
    provider.reconcileResults.push(transferResult("failed", "circle-tx-1", { state: "FAILED" }));
    provider.transferResults.push(transferResult("pending", "circle-tx-2", { state: "SENT" }));
    await executePayment(request, { provider, store, retryTerminalFailure: true });
    store.calls = [];
    provider.reconcileResults.push(transferResult("confirmed", "circle-tx-2"));

    const execution = await executePayment(request, { provider, store });

    expect(provider.reconciliations).toEqual(["circle-tx-1", "circle-tx-2"]);
    expect(store.calls).toEqual(["ensure", `recordResult:${KEY_2}`]);
    expect(execution).toMatchObject({ status: "confirmed", reconciled: true, attempt: 2, idempotencyKey: KEY_2, retriedAfter: null });
  });
});

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const KEY = paymentIdempotencyKey(request.sourceType, request.sourceId);

/** A payment_intents row as PostgREST returns it. */
function intentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "5a1d0c4e-2b7f-4e61-9d3a-00000000c1a1",
    org_id: ORG,
    source_type: request.sourceType,
    source_id: request.sourceId,
    idempotency_key: KEY,
    provider: "circle",
    provider_tx_id: null,
    tx_hash: null,
    amount: "12.500000",
    destination: request.destination,
    status: "submitting",
    attempt_count: 1,
    last_error: null,
    confirmed_at: null,
    chain: null,
    provider_mode: "live",
    fee_usd: null,
    fee_source: null,
    settled_in_ms: null,
    executed_at: null,
    provider_state: null,
    failure_reason: null,
    transfer_attempt: 1,
    previous_attempts: [],
    created_at: "2026-09-28T00:00:00+00:00",
    updated_at: "2026-09-28T00:00:00+00:00",
    ...overrides,
  };
}

/**
 * What `claim_payment_intent` or `begin_payment_retry` returns when its
 * UPDATE matched no row: both are declared `returns payment_intents`, so
 * PostgREST sends one composite value with every field null.
 */
const NOTHING_MATCHED = Object.fromEntries(Object.keys(intentRow()).map((column) => [column, null]));

function inOrganization<T>(respond: (request: RecordedRequest) => { body: unknown }, fn: () => Promise<T>) {
  const fake = fakeSupabase(respond);
  return { fake, result: runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn) };
}

/**
 * The store against a real supabase-js client whose network is a recorder.
 * `claim_payment_intent` is declared `returns payment_intents`, so when its
 * UPDATE matches nothing — another cycle holds a fresh claim, or the intent
 * already settled — it still returns one composite value with every field
 * null, and PostgREST sends that as an object, not as an empty result.
 */
describe("SupabasePaymentIntentStore.claim (R20)", () => {
  it("is not a claim when the update matched nothing", async () => {
    const { fake, result } = inOrganization(
      (sent) => ({ body: sent.path === "/rest/v1/rpc/claim_payment_intent" ? NOTHING_MATCHED : [] }),
      () => new SupabasePaymentIntentStore().claim(KEY)
    );
    expect(await result).toBeNull();
    expect(fake.requests.map((sent) => [sent.path, sent.body])).toEqual([
      ["/rest/v1/rpc/claim_payment_intent", { p_idempotency_key: KEY, p_org_id: ORG }],
    ]);
  });

  it("is the claimed intent when the update matched a row", async () => {
    const { result } = inOrganization(
      (sent) => ({ body: sent.path === "/rest/v1/rpc/claim_payment_intent" ? intentRow({ attempt_count: 2 }) : [] }),
      () => new SupabasePaymentIntentStore().claim(KEY)
    );
    expect(await result).toMatchObject({ idempotencyKey: KEY, status: "submitting", attemptCount: 2, amount: 12.5 });
  });

  it("keeps a cycle that lost the claim from transferring a second time", async () => {
    // Another cycle claimed this intent moments ago and is mid-transfer: the
    // row is `submitting` with no provider id yet. This cycle must leave it
    // to that one rather than send the money again.
    const { result } = inOrganization((sent) => {
      if (sent.path === "/rest/v1/rpc/claim_payment_intent") return { body: NOTHING_MATCHED };
      if (sent.path === "/rest/v1/payment_intents" && sent.method === "GET") return { body: intentRow() };
      return { body: [] };
    }, async () => {
      const provider = new FakeProvider();
      provider.transferResults.push(transferResult("confirmed"));
      const execution = await executePayment(request, { provider });
      return { execution, transfers: provider.transfers };
    });
    const { execution, transfers } = await result;
    expect(transfers).toEqual([]);
    expect(execution).toMatchObject({ status: "pending", providerTxId: null, attemptCount: 1 });
  });
});

describe("SupabasePaymentIntentStore by source, and its attempts", () => {
  const KEY_2 = attemptKey("invoice", request.sourceId, 2);
  const input = { ...request, idempotencyKey: KEY, provider: "circle" as const };

  it("ensures the row by its source, inserting attempt 1's key only when the source has no row, then reads it by source", async () => {
    const { fake, result } = inOrganization(
      (sent) => ({ body: sent.path === "/rest/v1/payment_intents" && sent.method === "GET" ? intentRow({ status: "created" }) : [] }),
      () => new SupabasePaymentIntentStore().ensure(input)
    );

    expect(await result).toMatchObject({ idempotencyKey: KEY, transferAttempt: 1, previousAttempts: [], providerState: null, failureReason: null });
    const [insert, read] = fake.requests;
    expect(insert.method).toBe("POST");
    expect(insert.params.get("on_conflict")).toBe("source_type,source_id");
    expect(insert.headers.get("prefer")).toContain("resolution=ignore-duplicates");
    expect(Array.isArray(insert.body) ? insert.body[0] : insert.body).toMatchObject({
      source_type: "invoice", source_id: request.sourceId, idempotency_key: KEY, org_id: ORG,
    });
    expect(read.method).toBe("GET");
    expect(read.params.get("source_type")).toBe("eq.invoice");
    expect(read.params.get("source_id")).toBe(`eq.${request.sourceId}`);
    expect(read.params.get("idempotency_key")).toBeNull();
  });

  it("returns a source's later attempt with that attempt's key, from the row rather than from the source", async () => {
    const history = [{ attempt: 1, idempotencyKey: KEY, providerTxId: "circle-tx-1", providerState: "FAILED", failureReason: "FAILED_ON_CHAIN", failedAt: "2026-09-30T00:00:00+00:00" }];
    const { result } = inOrganization(
      (sent) => ({
        body: sent.path === "/rest/v1/payment_intents" && sent.method === "GET"
          ? intentRow({ status: "created", idempotency_key: KEY_2, transfer_attempt: 2, previous_attempts: history })
          : [],
      }),
      () => new SupabasePaymentIntentStore().ensure(input)
    );

    expect(await result).toMatchObject({ idempotencyKey: KEY_2, transferAttempt: 2, previousAttempts: history });
  });

  it("records Circle's state and failure reason with a result, keyed by the intent's current key", async () => {
    const { fake, result } = inOrganization(
      (sent) => ({ body: sent.path === "/rest/v1/payment_intents" && sent.method === "GET" ? intentRow({ status: "failed" }) : [] }),
      () => new SupabasePaymentIntentStore().recordResult(KEY_2, transferResult("failed", "circle-tx-2", { state: "FAILED", reason: "FAILED_ON_CHAIN" }))
    );
    await result;

    const [patch] = fake.requests.filter((sent) => sent.method === "PATCH");
    expect(patch.params.get("idempotency_key")).toBe(`eq.${KEY_2}`);
    expect(patch.body).toMatchObject({ status: "failed", provider_tx_id: "circle-tx-2", provider_state: "FAILED", failure_reason: "FAILED_ON_CHAIN", last_error: null });
  });

  it("leaves Circle's state and reason as they were when recording an error of ours", async () => {
    const { fake, result } = inOrganization(
      (sent) => ({ body: sent.path === "/rest/v1/payment_intents" && sent.method === "GET" ? intentRow({ status: "failed" }) : [] }),
      () => new SupabasePaymentIntentStore().recordError(KEY, "Circle returned no transaction for circle-tx-1")
    );
    await result;

    const [patch] = fake.requests.filter((sent) => sent.method === "PATCH");
    expect(patch.body).not.toHaveProperty("provider_state");
    expect(patch.body).not.toHaveProperty("failure_reason");
    expect(patch.body).toMatchObject({ status: "failed", last_error: "Circle returned no transaction for circle-tx-1" });
  });

  it("opens the next attempt with begin_payment_retry, naming the current key and the next attempt's", async () => {
    const failed = intentRow({ status: "failed", provider_tx_id: "circle-tx-1", provider_state: "FAILED", failure_reason: "FAILED_ON_CHAIN" });
    const { fake, result } = inOrganization((sent) => {
      if (sent.path === "/rest/v1/rpc/begin_payment_retry") {
        return { body: intentRow({ status: "created", idempotency_key: KEY_2, transfer_attempt: 2, previous_attempts: [{ attempt: 1 }] }) };
      }
      return { body: failed };
    }, async () => {
      const store = new SupabasePaymentIntentStore();
      return store.beginRetry(await store.ensure(input));
    });

    expect(await result).toMatchObject({ idempotencyKey: KEY_2, transferAttempt: 2, status: "created", providerTxId: null });
    const [call] = fake.requests.filter((sent) => sent.path === "/rest/v1/rpc/begin_payment_retry");
    expect(call.body).toEqual({
      p_org_id: ORG,
      p_source_type: "invoice",
      p_source_id: request.sourceId,
      p_expected_key: KEY,
      p_new_key: KEY_2,
    });
  });

  it("is no retry when begin_payment_retry matched no row", async () => {
    const failed = intentRow({ status: "failed", provider_tx_id: "circle-tx-1", provider_state: "FAILED" });
    const { result } = inOrganization(
      (sent) => ({ body: sent.path === "/rest/v1/rpc/begin_payment_retry" ? NOTHING_MATCHED : failed }),
      async () => {
        const store = new SupabasePaymentIntentStore();
        return store.beginRetry(await store.ensure(input));
      }
    );

    expect(await result).toBeNull();
  });
});
