import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { payInvoice, syncOperatingBalance, payoutAddress, type PayInvoiceInput } from "@/lib/agent/pay";
import { paymentIdempotencyKey } from "@/lib/payments";
import type { BalanceSnapshot, ChainProvider, EarnResult, TransferParams, TransferResult } from "@/lib/circle";
import { fakeSupabase, orgTestContext, type RecordedRequest, type FakeReply } from "./support/fake-supabase";

/**
 * `payInvoice` is the AP stage's pay branch, moved verbatim so a person
 * paying a held payable (a later task) takes exactly the same step the agent
 * does. These tests drive it the way `runAgentCycle` does — a real
 * `executePayment` over a recorded fake client — rather than mocking
 * `executePayment` itself, so a regression in how the two are wired together
 * would show up here too.
 */

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

const INVOICE_ID = "018f8ce0-1557-7b54-a931-4d777f6bcafe";
const COUNTERPARTY_ID = "018f8ce0-1557-7b54-a931-4d777f6bcaff";
const OPERATING_ACCOUNT_ID = "account-1";

const input: PayInvoiceInput = {
  invoiceId: INVOICE_ID,
  counterpartyId: COUNTERPARTY_ID,
  address: "0xdead",
  amount: 12.5,
};

class FakeProvider implements ChainProvider {
  readonly mode = "live" as const;
  readonly earnMode = "simulate" as const;
  readonly estimatedFeeUsd = 0.01;
  transfers: TransferParams[] = [];
  transferResults: Array<TransferResult | Error> = [];
  reconciliations: string[] = [];
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

/**
 * A minimal `payment_intents` table behind the fake REST wire — enough to
 * drive `executePayment`'s ensure → claim → transfer → recordResult path the
 * way the real table would, without a real database. Modelled on the
 * `SupabasePaymentIntentStore.claim` tests in `tests/payments.test.ts`, but
 * stateful across the whole flow rather than a single canned response.
 *
 * Rows are one per source (`unique (source_type, source_id)`), found by
 * source or by their current key, and `begin_payment_retry` moves a row to
 * its next attempt under the same condition migration 0036 applies.
 */
function paymentIntentsBackend() {
  const rows: Array<Record<string, unknown>> = [];
  const retries: Array<Record<string, unknown>> = [];
  const eq = (value: string | null) => value?.replace(/^eq\./, "");
  const byKey = (key: unknown) => rows.find((row) => row.idempotency_key === key);
  const bySource = (type: unknown, id: unknown) => rows.find((row) => row.source_type === type && row.source_id === id);

  const COLUMNS = [
    "id", "org_id", "source_type", "source_id", "idempotency_key", "provider", "provider_tx_id", "tx_hash",
    "amount", "destination", "status", "attempt_count", "last_error", "confirmed_at", "chain",
    "provider_mode", "fee_usd", "fee_source", "settled_in_ms", "executed_at", "provider_state", "failure_reason",
    "transfer_attempt", "previous_attempts", "created_at", "updated_at",
  ];
  // No matching row: every field null, the same shape PostgREST sends when a
  // `returns payment_intents` function's UPDATE matched nothing.
  const nothing = (): FakeReply => ({ body: Object.fromEntries(COLUMNS.map((column) => [column, null])) });

  const insert = (body: Record<string, unknown>) => {
    const row: Record<string, unknown> = {
      id: `intent-${rows.length + 1}`,
      org_id: ORG,
      source_type: body.source_type,
      source_id: body.source_id,
      idempotency_key: body.idempotency_key,
      provider: body.provider,
      provider_tx_id: null,
      tx_hash: null,
      amount: String(body.amount),
      destination: body.destination,
      status: "created",
      attempt_count: 0,
      last_error: null,
      confirmed_at: null,
      chain: null,
      provider_mode: body.provider_mode,
      fee_usd: null,
      fee_source: null,
      settled_in_ms: null,
      executed_at: null,
      provider_state: null,
      failure_reason: null,
      transfer_attempt: 1,
      previous_attempts: [],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    rows.push(row);
    return row;
  };

  const respond = (sent: RecordedRequest): FakeReply => {
    if (sent.path === "/rest/v1/payment_intents") {
      if (sent.method === "POST") {
        const body = (Array.isArray(sent.body) ? sent.body[0] : sent.body) as Record<string, unknown>;
        // on_conflict=source_type,source_id with ignore-duplicates: a source keeps its one row.
        if (!bySource(body.source_type, body.source_id)) insert(body);
        return { body: [] };
      }
      if (sent.method === "GET") {
        const key = eq(sent.params.get("idempotency_key"));
        const row = key ? byKey(key) : bySource(eq(sent.params.get("source_type")), eq(sent.params.get("source_id")));
        return { body: row ?? null };
      }
      if (sent.method === "PATCH") {
        const row = byKey(eq(sent.params.get("idempotency_key")));
        if (row) Object.assign(row, sent.body as Record<string, unknown>);
        return { body: [] };
      }
    }
    if (sent.path === "/rest/v1/rpc/claim_payment_intent") {
      const row = byKey((sent.body as Record<string, unknown> | undefined)?.p_idempotency_key);
      if (row && ["created", "failed"].includes(row.status as string)) {
        row.status = "submitting";
        row.attempt_count = (row.attempt_count as number) + 1;
        return { body: { ...row } };
      }
      return nothing();
    }
    if (sent.path === "/rest/v1/rpc/begin_payment_retry") {
      const args = sent.body as Record<string, unknown>;
      retries.push(args);
      const row = bySource(args.p_source_type, args.p_source_id);
      if (
        !row ||
        row.idempotency_key !== args.p_expected_key ||
        row.status !== "failed" ||
        row.provider_tx_id === null ||
        !["CANCELLED", "DENIED", "FAILED"].includes(row.provider_state as string)
      ) {
        return nothing();
      }
      Object.assign(row, {
        previous_attempts: [
          ...(row.previous_attempts as unknown[]),
          {
            attempt: row.transfer_attempt, idempotencyKey: row.idempotency_key, providerTxId: row.provider_tx_id,
            providerState: row.provider_state, failureReason: row.failure_reason, failedAt: row.updated_at,
          },
        ],
        idempotency_key: args.p_new_key,
        transfer_attempt: (row.transfer_attempt as number) + 1,
        provider_tx_id: null, tx_hash: null, provider_state: null, failure_reason: null,
        fee_usd: null, fee_source: null, settled_in_ms: null,
        status: "created", last_error: null, confirmed_at: null, executed_at: null,
      });
      return { body: { ...row } };
    }
    return { body: [] };
  };

  /** The invoice's row as an earlier attempt left it. */
  const seed = (overrides: Record<string, unknown>) => {
    const row = insert({
      source_type: "invoice", source_id: INVOICE_ID, idempotency_key: paymentIdempotencyKey("invoice", INVOICE_ID),
      provider: "circle", provider_mode: "live", amount: input.amount, destination: "0xdead",
    });
    Object.assign(row, overrides);
    return row;
  };

  return { rows, retries, respond, seed };
}

function inOrg<T>(respond: (request: RecordedRequest) => FakeReply, fn: () => Promise<T>) {
  const fake = fakeSupabase(respond);
  return runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn);
}

describe("payInvoice", () => {
  it("holds, with no provider call, when there is no operating account", async () => {
    const provider = new FakeProvider();

    const result = await payInvoice(input, { provider, operating: null });

    expect(result).toEqual({
      status: "held",
      txRef: null,
      execution: null,
      note: " [no operating account configured]",
      operatingBalance: null,
    });
    expect(provider.transfers).toHaveLength(0);
  });

  it("pays and syncs the operating balance, on a confirmed transfer", async () => {
    const provider = new FakeProvider();
    provider.transferResults.push(transferResult("confirmed"));
    const backend = paymentIntentsBackend();

    const result = await inOrg((sent) => {
      if (sent.path === "/rest/v1/accounts" && sent.method === "GET") {
        return { body: { id: OPERATING_ACCOUNT_ID, chain: "ARC-TESTNET", token: "USDC", balance: "87.5", apy: "0" } };
      }
      if (sent.path === "/rest/v1/accounts" && sent.method === "PATCH") return { body: [] };
      return backend.respond(sent);
    }, () => payInvoice(input, { provider, operating: { id: OPERATING_ACCOUNT_ID } }));

    expect(result.status).toBe("paid");
    expect(result.txRef).toBe("0xhash");
    expect(result.note).toBe("");
    expect(result.operatingBalance).toBe(87.5);
    expect(result.execution?.status).toBe("confirmed");

    // The same idempotent source `executePayment` always used for this
    // invoice — `invoice` plus the invoice id — reaches the provider
    // untouched by the move.
    expect(provider.transfers).toHaveLength(1);
    expect(provider.transfers[0].idempotencyKey).toBe(paymentIdempotencyKey("invoice", INVOICE_ID));
  });

  it("stays paid, with its txRef and execution, when the balance sync fails after a confirmed transfer", async () => {
    const provider = new FakeProvider();
    provider.transferResults.push(transferResult("confirmed"));
    const backend = paymentIntentsBackend();

    const result = await inOrg((sent) => {
      if (sent.path === "/rest/v1/accounts" && sent.method === "GET") {
        return { status: 500, body: { message: "accounts read failed: connection reset" } };
      }
      return backend.respond(sent);
    }, () => payInvoice(input, { provider, operating: { id: OPERATING_ACCOUNT_ID } }));

    // The transfer is real and confirmed — a failure to sync the stored
    // balance afterward must not understate that as "held": the money moved.
    expect(result.status).toBe("paid");
    expect(result.txRef).toBe("0xhash");
    expect(result.execution?.status).toBe("confirmed");
    expect(result.note).toBe(" [balance sync failed: accounts read failed: connection reset]");
    expect(result.operatingBalance).toBeNull();
  });

  it("reports matched, awaiting confirmation, on a pending transfer — without syncing a balance", async () => {
    const provider = new FakeProvider();
    provider.transferResults.push(transferResult("pending"));
    const backend = paymentIntentsBackend();

    const result = await inOrg(backend.respond, () =>
      payInvoice(input, { provider, operating: { id: OPERATING_ACCOUNT_ID } })
    );

    expect(result.status).toBe("matched");
    expect(result.txRef).toBe("circle-tx-1");
    expect(result.note).toBe(" [transfer submitted; awaiting provider confirmation]");
    expect(result.operatingBalance).toBeNull();
    expect(result.execution?.status).toBe("pending");
  });

  it("holds, with the provider's failure note, on a failed transfer", async () => {
    const provider = new FakeProvider();
    provider.transferResults.push(transferResult("failed"));
    const backend = paymentIntentsBackend();

    const result = await inOrg(backend.respond, () =>
      payInvoice(input, { provider, operating: { id: OPERATING_ACCOUNT_ID } })
    );

    expect(result.status).toBe("held");
    expect(result.txRef).toBe("circle-tx-1");
    expect(result.note).toBe(" [transfer failed: provider reported failure]");
    expect(result.operatingBalance).toBeNull();
    expect(result.execution?.status).toBe("failed");
  });

  it("holds, with the execution failure's message, when the payment step itself throws", async () => {
    const provider = new FakeProvider();

    const result = await inOrg(
      (sent) => {
        if (sent.path === "/rest/v1/payment_intents" && sent.method === "POST") {
          return { status: 500, body: { message: "payment_intents insert failed: connection reset" } };
        }
        return { body: [] };
      },
      () => payInvoice(input, { provider, operating: { id: OPERATING_ACCOUNT_ID } })
    );

    expect(result).toEqual({
      status: "held",
      txRef: null,
      execution: null,
      note: " [execution failed: payment_intents insert failed: connection reset]",
      operatingBalance: null,
    });
    // The failure happened before the provider was ever asked to move money.
    expect(provider.transfers).toHaveLength(0);
  });
});

describe("payInvoice after a terminal failure", () => {
  const withAccounts = (backend: ReturnType<typeof paymentIntentsBackend>) => (sent: RecordedRequest): FakeReply => {
    if (sent.path === "/rest/v1/accounts" && sent.method === "GET") {
      return { body: { id: OPERATING_ACCOUNT_ID, chain: "ARC-TESTNET", token: "USDC", balance: "75", apy: "0" } };
    }
    if (sent.path === "/rest/v1/accounts" && sent.method === "PATCH") return { body: [] };
    return backend.respond(sent);
  };
  const failedAttempt = {
    status: "failed", provider_tx_id: "circle-tx-1", provider_state: "FAILED", failure_reason: "INSUFFICIENT_NATIVE_TOKEN", attempt_count: 1,
  };

  it("holds, and sends nothing, when called the agent's way", async () => {
    const provider = new FakeProvider();
    provider.reconcileResults.push(transferResult("failed", "circle-tx-1", { state: "FAILED", reason: "INSUFFICIENT_NATIVE_TOKEN" }));
    const backend = paymentIntentsBackend();
    backend.seed(failedAttempt);

    const result = await inOrg(withAccounts(backend), () => payInvoice(input, { provider, operating: { id: OPERATING_ACCOUNT_ID } }));

    expect(result.status).toBe("held");
    expect(result.execution).toMatchObject({ status: "failed", attempt: 1, retriedAfter: null });
    expect(provider.reconciliations).toEqual(["circle-tx-1"]);
    expect(provider.transfers).toHaveLength(0);
    expect(backend.retries).toHaveLength(0);
  });

  it("sends the payment again under attempt 2's key when a person's approval asks it to", async () => {
    const provider = new FakeProvider();
    provider.reconcileResults.push(transferResult("failed", "circle-tx-1", { state: "FAILED", reason: "INSUFFICIENT_NATIVE_TOKEN" }));
    provider.transferResults.push(transferResult("confirmed", "circle-tx-2"));
    const backend = paymentIntentsBackend();
    backend.seed(failedAttempt);

    const result = await inOrg(withAccounts(backend), () =>
      payInvoice(input, { provider, operating: { id: OPERATING_ACCOUNT_ID }, retryTerminalFailure: true })
    );

    const attempt2 = paymentIdempotencyKey("invoice", INVOICE_ID, 2);
    expect(result.status).toBe("paid");
    expect(result.execution).toMatchObject({
      status: "confirmed",
      attempt: 2,
      idempotencyKey: attempt2,
      retriedAfter: { providerTxId: "circle-tx-1", providerState: "FAILED", failureReason: "INSUFFICIENT_NATIVE_TOKEN" },
    });
    expect(backend.retries).toEqual([{
      p_org_id: ORG,
      p_source_type: "invoice",
      p_source_id: INVOICE_ID,
      p_expected_key: paymentIdempotencyKey("invoice", INVOICE_ID),
      p_new_key: attempt2,
    }]);
    expect(provider.transfers.map((sent) => sent.idempotencyKey)).toEqual([attempt2]);
    expect(backend.rows).toHaveLength(1);
    expect(backend.rows[0]).toMatchObject({
      idempotency_key: attempt2, transfer_attempt: 2, status: "confirmed", provider_tx_id: "circle-tx-2", provider_state: "COMPLETE",
    });
    expect(backend.rows[0].previous_attempts).toEqual([
      expect.objectContaining({ attempt: 1, providerTxId: "circle-tx-1", providerState: "FAILED", failureReason: "INSUFFICIENT_NATIVE_TOKEN" }),
    ]);
  });

  it("sends nothing, and writes nothing under the stale key, when another request opened attempt 2 between the read and the retry", async () => {
    const provider = new FakeProvider();
    provider.reconcileResults.push(transferResult("failed", "circle-tx-1", { state: "FAILED", reason: "INSUFFICIENT_NATIVE_TOKEN" }));
    provider.transferResults.push(transferResult("confirmed", "circle-tx-2"));
    const backend = paymentIntentsBackend();
    backend.seed(failedAttempt);
    const key1 = paymentIdempotencyKey("invoice", INVOICE_ID);
    const key2 = paymentIdempotencyKey("invoice", INVOICE_ID, 2);

    const sent: RecordedRequest[] = [];
    let raced = false;
    const result = await inOrg((request) => {
      sent.push(request);
      if (request.path === "/rest/v1/rpc/begin_payment_retry" && !raced) {
        // Another request's identical retry lands first and moves the row from key 1 to key 2.
        raced = true;
        backend.respond(request);
      }
      return withAccounts(backend)(request);
    }, () => payInvoice(input, { provider, operating: { id: OPERATING_ACCOUNT_ID }, retryTerminalFailure: true }));

    expect(result.status).toBe("held");
    expect(result.execution).toMatchObject({ status: "failed", attempt: 1, idempotencyKey: key1, retriedAfter: null });
    expect(provider.transfers).toHaveLength(0);
    // Nothing follows this call's refused retry: no claim, no write under either key.
    const retryAt = sent.findIndex((request) => request.path === "/rest/v1/rpc/begin_payment_retry");
    expect(sent.slice(retryAt + 1).filter((request) => request.path.includes("payment_intents"))).toEqual([]);
    expect(sent.some((request) => request.path === "/rest/v1/rpc/claim_payment_intent")).toBe(false);
    // The row is exactly as the other request left it.
    expect(backend.rows).toHaveLength(1);
    expect(backend.rows[0]).toMatchObject({ idempotency_key: key2, transfer_attempt: 2, status: "created", provider_tx_id: null, provider_state: null });
  });

  it("does not send again, even when asked, while Circle reports the transfer STUCK", async () => {
    const provider = new FakeProvider();
    provider.reconcileResults.push(transferResult("pending", "circle-tx-1", { state: "STUCK" }));
    const backend = paymentIntentsBackend();
    // Recorded failed before Circle's state was kept: the stored status says nothing about what Circle holds now.
    backend.seed({ status: "failed", provider_tx_id: "circle-tx-1", provider_state: null, attempt_count: 1 });

    const result = await inOrg(withAccounts(backend), () =>
      payInvoice(input, { provider, operating: { id: OPERATING_ACCOUNT_ID }, retryTerminalFailure: true })
    );

    expect(result.status).toBe("matched");
    expect(provider.transfers).toHaveLength(0);
    expect(backend.retries).toHaveLength(0);
    expect(backend.rows[0]).toMatchObject({
      idempotency_key: paymentIdempotencyKey("invoice", INVOICE_ID), transfer_attempt: 1, status: "pending", provider_state: "STUCK",
    });
  });
});

describe("payoutAddress", () => {
  it("uses the counterparty's own address when it has one", () => {
    expect(payoutAddress("0xdead", COUNTERPARTY_ID)).toBe("0xdead");
  });

  it("falls back to a simulated address keyed on the counterparty when there is none", () => {
    expect(payoutAddress(null, COUNTERPARTY_ID)).toBe(`sim:${COUNTERPARTY_ID}`);
  });
});

describe("syncOperatingBalance", () => {
  it("writes back the provider's balance for the account", async () => {
    const fake = fakeSupabase((sent) => {
      if (sent.path === "/rest/v1/accounts" && sent.method === "GET") {
        return { body: { id: OPERATING_ACCOUNT_ID, chain: "ARC-TESTNET", token: "USDC", balance: "42", apy: "0" } };
      }
      return { body: [] };
    });

    const balance = await runWith(
      orgTestContext({ config, client: fake.client, orgId: ORG }),
      () => syncOperatingBalance(OPERATING_ACCOUNT_ID)
    );

    expect(balance).toBe(42);
  });
});
