import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { payInvoice, payInvoices, type PayInvoiceInput } from "@/lib/agent/pay";
import type { PaymentExecution, PaymentRequest } from "@/lib/payments";
import type { BalanceSnapshot, ChainProvider, EarnResult, TransferResult } from "@/lib/circle";
import { fakeSupabase, orgTestContext, type RecordedRequest } from "./support/fake-supabase";
import { ARC_MAINNET, ARC_TESTNET } from "@/lib/network";

/**
 * `payInvoices` (docs/superpowers/specs/2026-10-30-approve-many-design.md AM6): several bills approved together, each
 * with exactly the request `payInvoice` builds for it, sent at once through `executePaymentBatch`, which is mocked here as
 * tests/release-milestones.test.ts mocks it (its own rules are tests/payment-batch.test.ts's). Each execution maps to the
 * result `payInvoice` returns, in order, with one balance sync after a confirmed payment, read over the fake network as
 * tests/pay.test.ts reads it.
 */

const { batchMock, payMock } = vi.hoisted(() => ({ batchMock: vi.fn(), payMock: vi.fn() }));
vi.mock("@/lib/payments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/payments")>()),
  executePaymentBatch: batchMock,
  executePayment: payMock,
}));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a1b";
const ACCOUNT = "account-1";
const HASH = `0x${"c".repeat(64)}`;
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

const BILLS: PayInvoiceInput[] = [
  { invoiceId: "018f8ce0-1557-7b54-a931-4d777f6b0001", counterpartyId: "018f8ce0-1557-7b54-a931-4d777f6b00c1", address: "0x1111", amount: 40 },
  // A 2% early-payment discount whose deadline has not passed: 98 leaves, as it would alone.
  {
    invoiceId: "018f8ce0-1557-7b54-a931-4d777f6b0002",
    counterpartyId: "018f8ce0-1557-7b54-a931-4d777f6b00c2",
    address: "0x2222",
    amount: 100,
    discount: { pct: 2, deadline: "2999-12-31" },
  },
  { invoiceId: "018f8ce0-1557-7b54-a931-4d777f6b0003", counterpartyId: "018f8ce0-1557-7b54-a931-4d777f6b00c3", address: null, amount: 7.5 },
];

const provider: ChainProvider = {
  mode: "live",
  network: ARC_TESTNET,
  earnMode: "simulate",
  estimatedFeeUsd: 0.003,
  transfer: async (): Promise<TransferResult> => {
    throw new Error("sent through executePaymentBatch");
  },
  batchTransfer: async (): Promise<TransferResult> => {
    throw new Error("sent through executePaymentBatch");
  },
  reconcileTransfer: async (): Promise<TransferResult> => {
    throw new Error("unused");
  },
  getBalance: async (): Promise<BalanceSnapshot> => ({ accountId: ACCOUNT, balance: 50, chain: "ARC-TESTNET", token: "USDC" }),
  depositToEarn: async (): Promise<EarnResult> => {
    throw new Error("unused");
  },
  withdrawFromEarn: async (): Promise<EarnResult> => {
    throw new Error("unused");
  },
};

function executed(over: Partial<PaymentExecution> = {}): PaymentExecution {
  return {
    idempotencyKey: "k", providerTxId: "tx-batch", txHash: HASH, txRef: HASH, status: "confirmed", attemptCount: 1, error: null, reconciled: false,
    chain: "ARC-TESTNET", providerMode: "live", feeUsd: 0.001, feeSource: "chain_reported", settledInMs: 2000, executedAt: "2026-10-30T10:00:00Z",
    attempt: 1, retriedAfter: null, route: null, batch: { key: "batch-1", size: 3 }, ...over,
  };
}

/**
 * The organization's scope over a fake whose operating account holds `balance`, as the balance sync reads it, and whose
 * payment intents are `intents`, by `source_id`; none by default.
 */
function run<T>(fn: () => Promise<T>, accounts: { balance?: string; fails?: true; intents?: Array<Record<string, unknown>> } = {}) {
  const requests: RecordedRequest[] = [];
  const fake = fakeSupabase((sent) => {
    requests.push(sent);
    if (sent.path === "/rest/v1/accounts" && sent.method === "GET") {
      if (accounts.fails) return { status: 500, body: { message: "accounts read failed: connection reset" } };
      return { body: { id: ACCOUNT, chain: "ARC-TESTNET", token: "USDC", balance: accounts.balance ?? "52.5", apy: "0" } };
    }
    if (sent.path === "/rest/v1/payment_intents" && sent.method === "GET") {
      const source = sent.params.get("source_id")?.replace(/^eq\./, "");
      return { body: (accounts.intents ?? []).filter((row) => row.source_id === source) };
    }
    return { body: [] };
  });
  return { requests, result: runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn) };
}

beforeEach(() => {
  batchMock.mockReset().mockImplementation(async (requests: PaymentRequest[]) => requests.map(() => executed()));
  payMock.mockReset().mockImplementation(async () => executed({ batch: null }));
});

describe("payInvoices (approve many AM6)", () => {
  it("sends every bill in one call, each with exactly the request payInvoice builds for it, in order", async () => {
    await run(() => payInvoices(BILLS, { provider, operating: { id: ACCOUNT } })).result;
    expect(batchMock).toHaveBeenCalledTimes(1);
    const sent = batchMock.mock.calls[0][0] as PaymentRequest[];
    expect(batchMock.mock.calls[0][1]).toEqual({ provider });

    // payInvoice's own request for each bill, through executePayment.
    for (const bill of BILLS) await run(() => payInvoice(bill, { provider, operating: { id: ACCOUNT } })).result;
    expect(sent).toEqual(payMock.mock.calls.map((call) => call[0]));
    expect(sent.map((request) => request.sourceId)).toEqual(BILLS.map((bill) => bill.invoiceId));
  });

  it("takes the early-payment discount off the transfer as payInvoice does, and no more", async () => {
    const results = await run(() => payInvoices(BILLS, { provider, operating: { id: ACCOUNT } })).result;
    const sent = batchMock.mock.calls[0][0] as PaymentRequest[];
    expect(sent.map((request) => request.amount)).toEqual([40, 98, 7.5]);
    expect(sent[1]).toMatchObject({ sourceType: "invoice", fromAccountId: ACCOUNT, destination: "0x2222", memo: `Invoice ${BILLS[1].invoiceId}`, token: "USDC" });
    // A bill with no address yet goes to its sandbox payee, as payInvoice sends it.
    expect(sent[2].destination).toBe(`sim:${BILLS[2].counterpartyId}`);
    expect(results.map((result) => [result.amountPaid, result.discountTaken])).toEqual([
      [40, 0],
      [98, 2],
      [7.5, 0],
    ]);
  });

  it("maps each execution to payInvoice's result, in order, and syncs the balance once for every confirmed payment", async () => {
    batchMock.mockResolvedValueOnce([
      executed(),
      // A batch whose answer was lost: in flight, looked for by its refId (batch payouts R5).
      executed({ status: "pending", providerTxId: null, txHash: null, txRef: null, error: "socket hang up" }),
      executed(),
    ]);
    const { requests, result } = run(() => payInvoices(BILLS, { provider, operating: { id: ACCOUNT } }));
    const results = await result;

    expect(results.map((paid) => paid.status)).toEqual(["paid", "matched", "paid"]);
    expect(results[0]).toMatchObject({ txRef: HASH, note: "", operatingBalance: 52.5 });
    expect(results[1]).toMatchObject({ txRef: null, note: " [socket hang up]", operatingBalance: null });
    expect(results[2]).toMatchObject({ note: "", operatingBalance: 52.5 });
    expect(results[0].execution?.batch).toEqual({ key: "batch-1", size: 3 });
    // One read and one write of the stored balance, not one per payment.
    expect(requests.filter((sent) => sent.path === "/rest/v1/accounts" && sent.method === "PATCH")).toHaveLength(1);
  });

  it("holds every member of a batch Circle ended in a terminal failure, with Circle's reason, and syncs nothing (AM8)", async () => {
    batchMock.mockResolvedValueOnce(BILLS.map(() => executed({ status: "failed", txHash: null, txRef: "tx-batch", error: "Circle reported FAILED" })));
    const { requests, result } = run(() => payInvoices(BILLS, { provider, operating: { id: ACCOUNT } }));
    const results = await result;
    expect(results.map((paid) => [paid.status, paid.note])).toEqual(BILLS.map(() => ["held", " [transfer failed: Circle reported FAILED]"]));
    expect(requests.some((sent) => sent.path === "/rest/v1/accounts")).toBe(false);
  });

  it("stays paid when the one sync fails, with the failure noted on each confirmed payment", async () => {
    const results = await run(() => payInvoices(BILLS.slice(0, 2), { provider, operating: { id: ACCOUNT } }), { fails: true }).result;
    expect(results.map((paid) => [paid.status, paid.note, paid.operatingBalance])).toEqual([
      ["paid", " [balance sync failed: accounts read failed: connection reset]", null],
      ["paid", " [balance sync failed: accounts read failed: connection reset]", null],
    ]);
  });

  it("holds every bill when the batch throws, as payInvoice holds a thrown transfer", async () => {
    batchMock.mockRejectedValueOnce(new Error("connection reset"));
    const results = await run(() => payInvoices(BILLS, { provider, operating: { id: ACCOUNT } })).result;
    expect(results.map((paid) => [paid.status, paid.execution, paid.note])).toEqual(BILLS.map(() => ["held", null, " [execution failed: connection reset]"]));
    expect(results[1]).toMatchObject({ amountPaid: 98, discountTaken: 2 });
    // Nothing had Circle's id, so nothing is read through executePayment, let alone sent again.
    expect(payMock).not.toHaveBeenCalled();
  });

  it("records a bill the batch sent before it threw as sent, never held, and sends nothing again (approve many review money-1)", async () => {
    batchMock.mockRejectedValueOnce(new Error("connection reset"));
    // The first bill's transfer went out and was confirmed before the throw; the others have no transfer.
    const intents = [{ source_type: "invoice", source_id: BILLS[0].invoiceId, idempotency_key: "invoice:1", status: "confirmed", provider_tx_id: "tx-batch", tx_hash: HASH, transfer_attempt: 1 }];
    payMock.mockResolvedValueOnce(executed({ reconciled: true }));
    const { requests, result } = run(() => payInvoices(BILLS, { provider, operating: { id: ACCOUNT } }), { intents });
    const results = await result;

    expect(results.map((paid) => [paid.status, paid.txRef, paid.note])).toEqual([
      ["paid", HASH, ""],
      ["held", null, " [execution failed: connection reset]"],
      ["held", null, " [execution failed: connection reset]"],
    ]);
    // Read under its own key, which only reads a transfer that exists, and recorded as this approval's own send.
    expect(payMock.mock.calls.map((call) => (call[0] as PaymentRequest).sourceId)).toEqual([BILLS[0].invoiceId]);
    expect(results[0].execution?.reconciled).toBe(false);
    expect(results[0].operatingBalance).toBe(52.5);
    expect(requests.filter((sent) => sent.path === "/rest/v1/accounts" && sent.method === "PATCH")).toHaveLength(1);
  });

  it("sends each bill alone, each with its own catch, where the wallets are EOAs: one bill's throw never hides another's transfer (approve many review money-1)", async () => {
    const eoa: ChainProvider = { ...provider, network: ARC_MAINNET };
    payMock
      .mockResolvedValueOnce(executed({ batch: null }))
      .mockResolvedValueOnce(executed({ batch: null }))
      .mockRejectedValueOnce(new Error("connection reset"));
    const { requests, result } = run(() => payInvoices(BILLS, { provider: eoa, operating: { id: ACCOUNT } }));
    const results = await result;

    expect(batchMock).not.toHaveBeenCalled();
    expect(payMock.mock.calls.map((call) => [(call[0] as PaymentRequest).sourceId, call[1]])).toEqual(BILLS.map((bill) => [bill.invoiceId, { provider: eoa }]));
    expect(results.map((paid) => [paid.status, paid.txRef, paid.note])).toEqual([
      ["paid", HASH, ""],
      ["paid", HASH, ""],
      ["held", null, " [execution failed: connection reset]"],
    ]);
    // Still one sync for both confirmed payments.
    expect(requests.filter((sent) => sent.path === "/rest/v1/accounts" && sent.method === "PATCH")).toHaveLength(1);
  });

  it("sends a lone bill, or bills through a provider that cannot batch, alone too", async () => {
    await run(() => payInvoices(BILLS.slice(0, 1), { provider, operating: { id: ACCOUNT } })).result;
    const unbatched: ChainProvider = { ...provider, batchTransfer: undefined };
    await run(() => payInvoices(BILLS.slice(0, 2), { provider: unbatched, operating: { id: ACCOUNT } })).result;
    expect(batchMock).not.toHaveBeenCalled();
    expect(payMock).toHaveBeenCalledTimes(3);
  });

  it("holds every bill, with no provider call, when there is no operating account", async () => {
    const results = await run(() => payInvoices(BILLS, { provider, operating: null })).result;
    expect(results.map((paid) => paid.note)).toEqual(BILLS.map(() => " [no operating account configured]"));
    expect(batchMock).not.toHaveBeenCalled();
  });
});
