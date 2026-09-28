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

class MemoryStore implements PaymentIntentStore {
  intent?: PaymentIntent;

  async ensure(input: PaymentRequest & { idempotencyKey: string; provider: "circle" | "simulate" }): Promise<PaymentIntent> {
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
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    return { ...this.intent };
  }

  async get(): Promise<PaymentIntent> {
    if (!this.intent) throw new Error("missing intent");
    return { ...this.intent };
  }

  async claim(): Promise<PaymentIntent | null> {
    if (!this.intent || !["created", "failed"].includes(this.intent.status)) return null;
    this.intent = { ...this.intent, status: "submitting", attemptCount: this.intent.attemptCount + 1 };
    return { ...this.intent };
  }

  async recordResult(_key: string, transfer: TransferResult): Promise<PaymentIntent> {
    if (!this.intent) throw new Error("missing intent");
    this.intent = {
      ...this.intent,
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
      executedAt: "2026-01-01T00:01:00.000Z",
    };
    return { ...this.intent };
  }

  async recordError(_key: string, error: string): Promise<PaymentIntent> {
    if (!this.intent) throw new Error("missing intent");
    this.intent = { ...this.intent, status: "failed", lastError: error };
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
  reconcileResults: TransferResult[] = [];

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
    if (!next) throw new Error("missing fake reconciliation result");
    return next;
  }

  async getBalance(): Promise<BalanceSnapshot> { throw new Error("not used"); }
  async depositToEarn(): Promise<EarnResult> { throw new Error("not used"); }
  async withdrawFromEarn(): Promise<EarnResult> { throw new Error("not used"); }
}

function transferResult(status: TransferResult["status"], providerTxId = "circle-tx-1"): TransferResult {
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
  };
}

describe("payment idempotency", () => {
  it("derives a stable UUID and separates source types", () => {
    const first = paymentIdempotencyKey("invoice", request.sourceId);
    expect(first).toBe(paymentIdempotencyKey("invoice", request.sourceId));
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first).not.toBe(paymentIdempotencyKey("milestone", request.sourceId));
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
});

/**
 * The store against a real supabase-js client whose network is a recorder.
 * `claim_payment_intent` is declared `returns payment_intents`, so when its
 * UPDATE matches nothing — another cycle holds a fresh claim, or the intent
 * already settled — it still returns one composite value with every field
 * null, and PostgREST sends that as an object, not as an empty result.
 */
describe("SupabasePaymentIntentStore.claim (R20)", () => {
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
      created_at: "2026-09-28T00:00:00+00:00",
      updated_at: "2026-09-28T00:00:00+00:00",
      ...overrides,
    };
  }

  /** What the function returns when its UPDATE matched no row. */
  const NOTHING_CLAIMED = Object.fromEntries(Object.keys(intentRow()).map((column) => [column, null]));

  function inOrganization<T>(respond: (request: RecordedRequest) => { body: unknown }, fn: () => Promise<T>) {
    const fake = fakeSupabase(respond);
    return { fake, result: runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn) };
  }

  it("is not a claim when the update matched nothing", async () => {
    const { fake, result } = inOrganization(
      (sent) => ({ body: sent.path === "/rest/v1/rpc/claim_payment_intent" ? NOTHING_CLAIMED : [] }),
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
      if (sent.path === "/rest/v1/rpc/claim_payment_intent") return { body: NOTHING_CLAIMED };
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
