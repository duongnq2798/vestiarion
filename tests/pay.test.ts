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

  async transfer(params: TransferParams): Promise<TransferResult> {
    this.transfers.push(params);
    const next = this.transferResults.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("missing fake transfer result");
    return next;
  }

  async reconcileTransfer(): Promise<TransferResult> { throw new Error("not used"); }
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
    providerState: status === "confirmed" ? "COMPLETE" : null,
    failureReason: null,
  };
}

/**
 * A minimal `payment_intents` table behind the fake REST wire — enough to
 * drive `executePayment`'s ensure → claim → transfer → recordResult path the
 * way the real table would, without a real database. Modelled on the
 * `SupabasePaymentIntentStore.claim` tests in `tests/payments.test.ts`, but
 * stateful across the whole flow rather than a single canned response.
 */
function paymentIntentsBackend() {
  const rows = new Map<string, Record<string, unknown>>();

  const respond = (sent: RecordedRequest): FakeReply => {
    if (sent.path === "/rest/v1/payment_intents") {
      if (sent.method === "POST") {
        const body = (Array.isArray(sent.body) ? sent.body[0] : sent.body) as Record<string, unknown>;
        const key = body.idempotency_key as string;
        if (!rows.has(key)) {
          rows.set(key, {
            id: `intent-${rows.size + 1}`,
            org_id: ORG,
            source_type: body.source_type,
            source_id: body.source_id,
            idempotency_key: key,
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
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
          });
        }
        return { body: [] };
      }
      if (sent.method === "GET") {
        const key = sent.params.get("idempotency_key")?.replace(/^eq\./, "");
        return { body: (key ? rows.get(key) : undefined) ?? null };
      }
      if (sent.method === "PATCH") {
        const key = sent.params.get("idempotency_key")?.replace(/^eq\./, "");
        const row = key ? rows.get(key) : undefined;
        if (row) Object.assign(row, sent.body as Record<string, unknown>);
        return { body: [] };
      }
    }
    if (sent.path === "/rest/v1/rpc/claim_payment_intent") {
      const key = (sent.body as Record<string, unknown> | undefined)?.p_idempotency_key as string | undefined;
      const row = key ? rows.get(key) : undefined;
      if (row && ["created", "failed"].includes(row.status as string)) {
        row.status = "submitting";
        row.attempt_count = (row.attempt_count as number) + 1;
        return { body: { ...row } };
      }
      // No claimable row: every field null, the same shape PostgREST sends
      // when `claim_payment_intent`'s UPDATE matched nothing.
      return {
        body: Object.fromEntries(
          [
            "id", "org_id", "source_type", "source_id", "idempotency_key", "provider", "provider_tx_id", "tx_hash",
            "amount", "destination", "status", "attempt_count", "last_error", "confirmed_at", "chain",
            "provider_mode", "fee_usd", "fee_source", "settled_in_ms", "executed_at", "created_at", "updated_at",
          ].map((column) => [column, null])
        ),
      };
    }
    return { body: [] };
  };

  return { rows, respond };
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
