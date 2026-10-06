import { describe, expect, it, vi } from "vitest";
import type { ChainProvider, TransferParams, TransferResult } from "@/lib/circle";
import { ARC_TESTNET } from "@/lib/network";
import { executePayment, executePaymentBatch, type PaymentBatchStore, type PaymentIntent, type PaymentIntentStore, type PaymentRequest } from "@/lib/payments";
import { spendingLimitRef } from "@/lib/spending-limit/onchain";

/**
 * A payment request carrying the spending limit contract (docs/superpowers/specs/2026-10-03-onchain-spending-limit-design.md
 * R3): the provider is told to pay through it, it is never put in a batch, and one that cannot go through it (a
 * release from escrow) sends nothing.
 */

function result(over: Partial<TransferResult> = {}): TransferResult {
  return {
    providerTxId: "circle-pay-1",
    txHash: `0x${"4".repeat(64)}`,
    txRef: `0x${"4".repeat(64)}`,
    chain: "ARC-TESTNET",
    status: "confirmed",
    feeUsd: 0.003,
    feeSource: "chain_reported",
    providerMode: "live",
    settledInMs: 3000,
    providerState: "COMPLETE",
    failureReason: null,
    ...over,
  };
}

class Store implements PaymentIntentStore, PaymentBatchStore {
  intents = new Map<string, PaymentIntent>();
  private byKey(key: string): PaymentIntent {
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
      executedAt: null, providerState: null, failureReason: null, transferAttempt: 1, previousAttempts: [], createdAt: "2026-10-03T00:00:00Z",
      updatedAt: "2026-10-03T00:00:00Z", route: input.escrow ? "escrow" : null, batchKey: null, batchSize: null, batchSentAt: null,
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
  async recordResult(key: string, transfer: TransferResult) {
    return this.put({ ...this.byKey(key), providerTxId: transfer.providerTxId, txHash: transfer.txHash, status: transfer.status, providerState: transfer.providerState, lastError: null });
  }
  async recordError(key: string, error: string) {
    return this.put({ ...this.byKey(key), status: "failed", lastError: error });
  }
  async beginRetry() {
    return null;
  }
  async joinBatch() {
    return 0;
  }
  async leaveBatch() {}
  async batchMembers() {
    return [];
  }
}

function provider() {
  const transfers: TransferParams[] = [];
  const batchTransfer = vi.fn(async () => result({ providerTxId: "circle-batch" }));
  const chain = {
    mode: "live",
    earnMode: "simulate",
    estimatedFeeUsd: 0.003,
    network: ARC_TESTNET,
    transfer: vi.fn(async (params: TransferParams) => {
      transfers.push(params);
      return result({ providerTxId: `circle-${transfers.length}` });
    }),
    reconcileTransfer: vi.fn(),
    batchTransfer,
  };
  return { provider: chain as unknown as ChainProvider, transfers, batchTransfer };
}

const LIMIT = { contract: "0x11a1700000000000000000000000000000001111", agentWalletId: "wallet-agent" };
const request = (n: number, over: Partial<PaymentRequest> = {}): PaymentRequest => {
  const sourceId = `00000000-0000-4000-8000-00000000000${n}`;
  return {
    sourceType: "milestone",
    sourceId,
    fromAccountId: "acct-1",
    destination: `0x${String(n).repeat(40)}`,
    amount: n,
    memo: `Milestone ${n}`,
    spendingLimit: { ...LIMIT, ref: spendingLimitRef("milestone", sourceId) },
    ...over,
  };
};

describe("a payment through the spending limit contract", () => {
  it("tells the provider to pay through the contract, with the payment's ref", async () => {
    const { provider: chain, transfers } = provider();
    const execution = await executePayment(request(1), { provider: chain, store: new Store() });
    expect(execution.status).toBe("confirmed");
    expect(transfers).toHaveLength(1);
    expect(transfers[0].spendingLimit).toEqual(request(1).spendingLimit);
  });

  it("is never put in a batch: each goes through the contract alone", async () => {
    const { provider: chain, transfers, batchTransfer } = provider();
    const executions = await executePaymentBatch([request(1), request(2), request(3)], { provider: chain, store: new Store() });
    expect(executions.map((execution) => execution.status)).toEqual(["confirmed", "confirmed", "confirmed"]);
    expect(batchTransfer).not.toHaveBeenCalled();
    expect(transfers.map((transfer) => transfer.spendingLimit?.ref)).toEqual([1, 2, 3].map((n) => request(n).spendingLimit?.ref));
  });

  it("sends nothing for a release from escrow that names the contract", async () => {
    const { provider: chain, transfers } = provider();
    const execution = await executePayment(request(4, { escrow: { contract: `0x${"e5".repeat(20)}`, holdId: `0x${"1".repeat(64)}` } }), {
      provider: chain,
      store: new Store(),
    });
    expect(execution.status).toBe("failed");
    expect(execution.error).toMatch(/nothing was sent/);
    expect(transfers).toEqual([]);
  });
});
