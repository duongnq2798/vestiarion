import { describe, expect, it } from "vitest";
import { decodeFunctionData, parseAbi, type Hex } from "viem";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { batchCalls, BatchNotSentError, MAX_BATCH_SIZE, SCA_EXECUTE_BATCH } from "@/lib/circle/batch";
import {
  BATCH_LOOKUP_GRACE_MS,
  batchIdempotencyKey,
  executePayment,
  executePaymentBatch,
  paymentIdempotencyKey,
  type PaymentBatchStore,
  type PaymentIntent,
  type PaymentIntentStore,
  type PaymentRequest,
  SupabasePaymentIntentStore,
} from "@/lib/payments";
import type { BalanceSnapshot, BatchTransferParams, ChainProvider, EarnResult, TransferParams, TransferResult } from "@/lib/circle";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";
import { ARC_TESTNET } from "@/lib/network";

/**
 * Batch payouts (docs/superpowers/specs/2026-10-02-batch-payouts-design.md): payments never sent go out
 * together in one transaction under a key derived from theirs, each recording its share of the fee; a
 * batch is recorded on every member before it is sent; a batch whose answer was lost is looked for on
 * Circle, never sent again alone, and released only once Circle is known never to have had it.
 */

const HASH = `0x${"b".repeat(64)}`;

function transferResult(over: Partial<TransferResult> = {}): TransferResult {
  return {
    providerTxId: "circle-batch-1",
    txHash: HASH,
    txRef: HASH,
    chain: "ARC-TESTNET",
    status: "confirmed",
    feeUsd: 0.009,
    feeSource: "chain_reported",
    providerMode: "live",
    settledInMs: 2000,
    providerState: "COMPLETE",
    failureReason: null,
    ...over,
  };
}

class Chain implements ChainProvider {
  readonly network = ARC_TESTNET;
  readonly mode = "live" as const;
  readonly earnMode = "simulate" as const;
  readonly estimatedFeeUsd = 0.003;
  transfers: TransferParams[] = [];
  batches: BatchTransferParams[] = [];
  lookups: Array<{ refId: string; window: { from: string; to: string } }> = [];
  batchFails: Error | null = null;
  found: TransferResult | null | Error = null;
  async transfer(params: TransferParams): Promise<TransferResult> {
    this.transfers.push(params);
    return transferResult({ providerTxId: `circle-${params.idempotencyKey}`, feeUsd: 0.004 });
  }
  async batchTransfer(params: BatchTransferParams): Promise<TransferResult> {
    this.batches.push(params);
    if (this.batchFails) throw this.batchFails;
    return transferResult();
  }
  async findTransferByRef(_from: string, refId: string, window: { from: string; to: string }): Promise<TransferResult | null> {
    this.lookups.push({ refId, window });
    if (this.found instanceof Error) throw this.found;
    return this.found;
  }
  async reconcileTransfer(providerTxId: string): Promise<TransferResult> {
    return transferResult({ providerTxId });
  }
  async getBalance(): Promise<BalanceSnapshot> {
    return { accountId: "acct-1", balance: 100, chain: "ARC-TESTNET", token: "USDC" };
  }
  async depositToEarn(): Promise<EarnResult> {
    throw new Error("not used");
  }
  async withdrawFromEarn(): Promise<EarnResult> {
    throw new Error("not used");
  }
}

/** Intents in memory, one per source, following the real store's rules for claims and batches. */
class Store implements PaymentIntentStore, PaymentBatchStore {
  intents = new Map<string, PaymentIntent>();
  /** When set, joinBatch reaches only this many members, as a write that did not reach every row. */
  joinReaches: number | null = null;

  byKey(key: string): PaymentIntent {
    const found = [...this.intents.values()].find((intent) => intent.idempotencyKey === key);
    if (!found) throw new Error(`no intent with key ${key}`);
    return found;
  }
  private put(intent: PaymentIntent) {
    this.intents.set(intent.sourceId, intent);
    return { ...intent };
  }
  async ensure(input: PaymentRequest & { idempotencyKey: string; provider: "circle" | "simulate" }): Promise<PaymentIntent> {
    const existing = this.intents.get(input.sourceId);
    if (existing) return { ...existing };
    return this.put({
      id: `intent-${this.intents.size + 1}`, sourceType: input.sourceType, sourceId: input.sourceId, idempotencyKey: input.idempotencyKey,
      provider: input.provider, providerTxId: null, txHash: null, amount: input.amount, destination: input.destination, status: "created",
      attemptCount: 0, lastError: null, confirmedAt: null, chain: null, providerMode: "live", feeUsd: null, feeSource: null, settledInMs: null,
      executedAt: null, providerState: null, failureReason: null, transferAttempt: 1, previousAttempts: [], createdAt: "2026-10-02T00:00:00Z",
      updatedAt: "2026-10-02T00:00:00Z", route: input.escrow ? "escrow" : null, batchKey: null, batchSize: null, batchSentAt: null,
    });
  }
  async get(key: string) {
    return { ...this.byKey(key) };
  }
  async claim(key: string) {
    const intent = this.byKey(key);
    if (!["created", "failed"].includes(intent.status)) return null;
    return this.put({ ...intent, status: "submitting", attemptCount: intent.attemptCount + 1 });
  }
  async recordResult(key: string, result: TransferResult) {
    return this.put({ ...this.byKey(key), providerTxId: result.providerTxId, txHash: result.txHash, status: result.status, feeUsd: result.feeUsd, providerState: result.providerState, lastError: null });
  }
  async recordError(key: string, error: string) {
    return this.put({ ...this.byKey(key), status: "failed", lastError: error });
  }
  async beginRetry() {
    return null;
  }
  async joinBatch(keys: string[], batch: { key: string; size: number; sentAt: string }) {
    let reached = 0;
    for (const key of keys) {
      if (this.joinReaches !== null && reached >= this.joinReaches) break;
      const intent = this.byKey(key);
      if (intent.status !== "submitting" || intent.providerTxId || intent.batchKey) continue;
      this.put({ ...intent, batchKey: batch.key, batchSize: batch.size, batchSentAt: batch.sentAt });
      reached += 1;
    }
    return reached;
  }
  async leaveBatch(batchKey: string) {
    for (const intent of this.intents.values()) {
      if (intent.batchKey === batchKey && !intent.providerTxId) this.put({ ...intent, batchKey: null, batchSize: null, batchSentAt: null });
    }
  }
  async batchMembers(batchKey: string) {
    return [...this.intents.values()].filter((intent) => intent.batchKey === batchKey).map((intent) => ({ ...intent }));
  }
}

const request = (n: number, over: Partial<PaymentRequest> = {}): PaymentRequest => ({
  sourceType: "milestone",
  sourceId: `00000000-0000-4000-8000-00000000000${n}`,
  fromAccountId: "acct-1",
  destination: `0x${String(n).repeat(40)}`,
  amount: n,
  memo: `Milestone ${n}`,
  ...over,
});
const keyOf = (n: number) => paymentIdempotencyKey("milestone", request(n).sourceId);

describe("batchIdempotencyKey", () => {
  it("is the same for the same payments, in any order, and differs for another set", () => {
    expect(batchIdempotencyKey(["b", "a", "c"])).toBe(batchIdempotencyKey(["c", "b", "a"]));
    expect(batchIdempotencyKey(["a", "b"])).not.toBe(batchIdempotencyKey(["a", "b", "c"]));
    expect(batchIdempotencyKey(["a", "b"])).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("batchCalls", () => {
  const erc20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);

  it("is one USDC transfer per payment for the wallet's executeBatch, in 6-decimal units, sending no native value", () => {
    const calls = batchCalls([
      { toAddress: "0x67C8000000000000000000000000000000000504", amount: 1.5 },
      { toAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd", amount: 0.000001 },
    ], ARC_TESTNET.tokens.USDC);
    expect(SCA_EXECUTE_BATCH).toBe("executeBatch((address,uint256,bytes)[])");
    expect(calls).toHaveLength(2);
    for (const [target, value] of calls) {
      expect(target).toBe(ARC_TESTNET.tokens.USDC);
      expect(value).toBe("0");
    }
    const [to, units] = decodeFunctionData({ abi: erc20, data: calls[0][2] as Hex }).args;
    expect([to.toLowerCase(), units]).toEqual(["0x67c8000000000000000000000000000000000504", 1_500_000n]);
    expect(decodeFunctionData({ abi: erc20, data: calls[1][2] as Hex }).args[1]).toBe(1n);
  });

  it("refuses fewer than two, more than the most, an address not on Arc, and nothing to send, before anything is sent", () => {
    const one = { toAddress: `0x${"1".repeat(40)}`, amount: 1 };
    expect(() => batchCalls([one], ARC_TESTNET.tokens.USDC)).toThrow(BatchNotSentError);
    expect(() => batchCalls([one], ARC_TESTNET.tokens.USDC)).toThrow(/2 to 20/);
    expect(() => batchCalls(Array.from({ length: MAX_BATCH_SIZE + 1 }, () => one), ARC_TESTNET.tokens.USDC)).toThrow(/2 to 20/);
    expect(() => batchCalls([one, { toAddress: "sim:cp-1", amount: 1 }], ARC_TESTNET.tokens.USDC)).toThrow(/Arc address/);
    expect(() => batchCalls([one, { ...one, amount: 0 }], ARC_TESTNET.tokens.USDC)).toThrow(/more than 0.*nothing was sent/);
  });
});

describe("executePaymentBatch", () => {
  it("sends payments never sent as one batch under their batch key, each recording the batch's transaction and its share of the fee", async () => {
    const chain = new Chain();
    const store = new Store();
    const results = await executePaymentBatch([request(1), request(2), request(3)], { provider: chain, store });

    expect(chain.transfers).toEqual([]);
    expect(chain.batches).toHaveLength(1);
    const keys = [keyOf(1), keyOf(2), keyOf(3)].sort();
    const batchKey = batchIdempotencyKey(keys);
    expect(chain.batches[0].idempotencyKey).toBe(batchKey);
    // In the members' key order, from the amounts and payees their intents recorded.
    expect(chain.batches[0].transfers).toEqual(keys.map((key) => ({ toAddress: store.byKey(key).destination, amount: store.byKey(key).amount })));
    expect(results.map((result) => result.status)).toEqual(["confirmed", "confirmed", "confirmed"]);
    expect(results.map((result) => result.txHash)).toEqual([HASH, HASH, HASH]);
    expect(results.every((result) => result.batch?.key === batchKey && result.batch.size === 3)).toBe(true);
    expect([...store.intents.values()].map((intent) => intent.feeUsd)).toEqual([0.003, 0.003, 0.003]);
  });

  it("sends a release from escrow and one already in flight their usual way, and a lone payment alone", async () => {
    const chain = new Chain();
    const store = new Store();
    await store.ensure({ ...request(2), idempotencyKey: keyOf(2), provider: "circle" });
    await store.recordResult(keyOf(2), transferResult({ providerTxId: "circle-earlier", status: "pending" }));
    const results = await executePaymentBatch([request(1), request(2), request(3, { escrow: { contract: "0xE5c", holdId: "0x01" } })], { provider: chain, store });

    expect(chain.batches).toEqual([]);
    expect(chain.transfers.map((transfer) => transfer.idempotencyKey).sort()).toEqual([keyOf(1), keyOf(3)].sort());
    expect(results[1]).toMatchObject({ providerTxId: "circle-earlier", reconciled: true });
    expect(results[0].batch).toBeNull();
  });

  it("splits more than the most into even batches", async () => {
    const chain = new Chain();
    const many = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, i) => request(1, { sourceId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` }));
    await executePaymentBatch(many, { provider: chain, store: new Store() });
    expect(chain.batches.map((batch) => batch.transfers.length)).toEqual([11, 10]);
  });

  it("sends each alone when the batch did not reach every member, after undoing it", async () => {
    const chain = new Chain();
    const store = new Store();
    store.joinReaches = 1;
    const results = await executePaymentBatch([request(1), request(2)], { provider: chain, store });
    expect(chain.batches).toEqual([]);
    expect(chain.transfers.map((transfer) => transfer.idempotencyKey).sort()).toEqual([keyOf(1), keyOf(2)].sort());
    expect([...store.intents.values()].every((intent) => intent.batchKey === null)).toBe(true);
    expect(results.every((result) => result.batch === null)).toBe(true);
  });

  it("sends each alone at once when the batch could not be built, since nothing reached Circle", async () => {
    const chain = new Chain();
    chain.batchFails = new BatchNotSentError("The operating wallet's address is not known");
    const store = new Store();
    const results = await executePaymentBatch([request(1), request(2)], { provider: chain, store });
    expect(chain.batches).toHaveLength(1);
    expect(chain.transfers.map((transfer) => transfer.idempotencyKey).sort()).toEqual([keyOf(1), keyOf(2)].sort());
    expect(results.map((result) => [result.status, result.batch])).toEqual([["confirmed", null], ["confirmed", null]]);
    expect([...store.intents.values()].every((intent) => intent.batchKey === null)).toBe(true);
  });

  it("keeps a batch whose answer was lost on every member, in flight, and sends nothing alone", async () => {
    const chain = new Chain();
    chain.batchFails = new Error("Circle did not answer the batch within 20000 ms; it may or may not have been accepted");
    const store = new Store();
    const results = await executePaymentBatch([request(1), request(2)], { provider: chain, store });
    expect(chain.transfers).toEqual([]);
    expect(results.map((result) => result.status)).toEqual(["pending", "pending"]);
    expect(results[0].error).toMatch(/may or may not have been accepted/);
    expect([...store.intents.values()].every((intent) => intent.batchKey && intent.status === "failed" && !intent.providerTxId)).toBe(true);
  });
});

describe("a batch whose answer was lost, paid again (R5)", () => {
  async function lostBatch(sentAgoMs: number) {
    const chain = new Chain();
    chain.batchFails = new Error("no answer");
    const store = new Store();
    await executePaymentBatch([request(1), request(2)], { provider: chain, store });
    const sentAt = new Date(Date.now() - sentAgoMs).toISOString();
    for (const intent of store.intents.values()) store.intents.set(intent.sourceId, { ...intent, batchSentAt: sentAt });
    chain.batchFails = null;
    return { chain, store, batchKey: batchIdempotencyKey([keyOf(1), keyOf(2)]) };
  }

  it("is found on Circle by its key, and every member records it with its share of the fee", async () => {
    const { chain, store, batchKey } = await lostBatch(60_000);
    chain.found = transferResult({ providerTxId: "circle-found" });
    const result = await executePayment(request(1), { provider: chain, store });
    expect(chain.lookups[0].refId).toBe(batchKey);
    expect(result).toMatchObject({ status: "confirmed", providerTxId: "circle-found", batch: { key: batchKey, size: 2 } });
    expect([...store.intents.values()].map((intent) => [intent.providerTxId, intent.feeUsd])).toEqual([["circle-found", 0.0045], ["circle-found", 0.0045]]);
    expect(chain.transfers).toEqual([]);
    expect(chain.batches).toHaveLength(1);
  });

  it("stays in flight while Circle does not list it yet, or cannot be asked, and nothing is sent", async () => {
    const { chain, store } = await lostBatch(60_000);
    expect(await executePayment(request(1), { provider: chain, store })).toMatchObject({ status: "pending", error: expect.stringMatching(/not on Circle yet/) });
    chain.found = new Error("Circle listed 50 transactions around the batch without it");
    expect(await executePayment(request(1), { provider: chain, store })).toMatchObject({ status: "pending", error: expect.stringMatching(/could not be looked for/) });
    expect(chain.transfers).toEqual([]);
  });

  it("is released once Circle is known never to have had it, and the payment is then sent alone under its own key", async () => {
    const { chain, store } = await lostBatch(BATCH_LOOKUP_GRACE_MS + 60_000);
    const result = await executePayment(request(1), { provider: chain, store });
    expect(chain.transfers.map((transfer) => transfer.idempotencyKey)).toEqual([keyOf(1)]);
    expect(result).toMatchObject({ status: "confirmed", batch: null });
    // The other member left the batch too: it is a payment never sent, sent alone when it comes up.
    expect(store.byKey(keyOf(2))).toMatchObject({ batchKey: null, status: "failed", providerTxId: null });
  });

  it("reconciles a batch member's transaction with its share of the fee", async () => {
    const chain = new Chain();
    const store = new Store();
    await executePaymentBatch([request(1), request(2)], { provider: chain, store });
    store.intents.set(request(1).sourceId, { ...store.byKey(keyOf(1)), status: "pending" });
    await executePayment(request(1), { provider: chain, store });
    expect(store.byKey(keyOf(1)).feeUsd).toBe(0.0045);
  });
});

describe("SupabasePaymentIntentStore batches (R4)", () => {
  const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
  const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-0000000ba7c4";
  const within = <T,>(respond: (sent: RecordedRequest) => FakeReply, fn: () => Promise<T>) => {
    const fake = fakeSupabase(respond);
    return { fake, result: runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn) };
  };

  it("joins only members still claimed, never sent and in no batch, in one write, and counts them", async () => {
    const { fake, result } = within(() => ({ body: [{ idempotency_key: "a" }, { idempotency_key: "b" }] }), () =>
      new SupabasePaymentIntentStore().joinBatch(["a", "b"], { key: "batch-1", size: 2, sentAt: "2026-10-02T10:00:00.000Z" })
    );
    expect(await result).toBe(2);
    expect(fake.requests).toHaveLength(1);
    const [write] = fake.requests;
    expect(write.method).toBe("PATCH");
    expect(write.body).toMatchObject({ batch_key: "batch-1", batch_size: 2, batch_sent_at: "2026-10-02T10:00:00.000Z" });
    expect(Object.fromEntries(["idempotency_key", "status", "provider_tx_id", "batch_key"].map((column) => [column, write.params.get(column)]))).toEqual({
      idempotency_key: "in.(a,b)",
      status: "eq.submitting",
      provider_tx_id: "is.null",
      batch_key: "is.null",
    });
  });

  it("joins none before migration 0057, so each is paid alone", async () => {
    const missing = () => ({ status: 400, body: { code: "PGRST204", message: "Could not find the 'batch_key' column of 'payment_intents' in the schema cache" } });
    expect(await within(missing, () => new SupabasePaymentIntentStore().joinBatch(["a", "b"], { key: "batch-1", size: 2, sentAt: "2026-10-02T10:00:00.000Z" })).result).toBe(0);
    await expect(within(missing, () => new SupabasePaymentIntentStore().leaveBatch("batch-1")).result).resolves.toBeUndefined();
  });

  it("leaves a batch only on members Circle has no id for", async () => {
    const { fake, result } = within(() => ({ body: [] }), () => new SupabasePaymentIntentStore().leaveBatch("batch-1"));
    await result;
    expect(fake.requests[0].body).toEqual({ batch_key: null, batch_size: null, batch_sent_at: null });
    expect(fake.requests[0].params.get("batch_key")).toBe("eq.batch-1");
    expect(fake.requests[0].params.get("provider_tx_id")).toBe("is.null");
  });
});
