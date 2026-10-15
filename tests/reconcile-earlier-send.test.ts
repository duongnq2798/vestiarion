import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { withOrg } from "@/lib/dal/scope";
import { reconcileApInvoice, reconcileMilestone } from "@/lib/agent/orchestrator";
import type { BalanceSnapshot, ChainProvider, EarnResult, TransferParams, TransferResult } from "@/lib/circle";
import { MAY_HAVE_BEEN_ACCEPTED } from "@/lib/circle/settlement";
import { NO_EARLIER_SEND, paymentIdempotencyKey } from "@/lib/payments";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { ARC_TESTNET } from "@/lib/network";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";
import { paymentIntentsBackend } from "./support/payment-intents";

/**
 * The AP reconcile's lookup over the real payment step (payment safety R4): `settleUnknownSend`, `payInvoice` and
 * `executePayment` run as the cycle runs them, over the shared `payment_intents` table (tests/support/payment-intents.ts),
 * so the lookup is shown to read and write the intent the payment step then reconciles. The unit tests of each outcome
 * are in tests/control-cycle.test.ts.
 */

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000c3c3";
const INVOICE_ID = "018f8ce0-1557-7b54-a931-4d777f6be001";
const COUNTERPARTY_ID = "018f8ce0-1557-7b54-a931-4d777f6be002";
const ACCOUNT_ID = "018f8ce0-1557-7b54-a931-4d777f6be003";

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

const MASTER_KEYS = `t1:${crypto.randomBytes(32).toString("base64")}`;
const LEDGER_PEM = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const savedMasterKeys = process.env.VESTIARION_MASTER_KEYS;
beforeEach(() => {
  process.env.VESTIARION_MASTER_KEYS = MASTER_KEYS;
});
afterEach(() => {
  if (savedMasterKeys === undefined) delete process.env.VESTIARION_MASTER_KEYS;
  else process.env.VESTIARION_MASTER_KEYS = savedMasterKeys;
});

const ORG_ROW = {
  id: ORG,
  slug: "northstar",
  name: "Northstar",
  mode: "live",
  ledger_signing_key_enc: encryptSecret(LEDGER_PEM, { orgId: ORG, column: "ledger_signing_key_enc" }, parseMasterKeys(MASTER_KEYS)),
  circle_api_key_enc: null,
  circle_entity_secret_enc: null,
};
const LEDGER_ROW = {
  seq: 1, id: "e1", ts: "2026-10-15T00:00:00Z", actor: "agent", domain: "ap", action: "x",
  summary: "", detail: {}, body_hash: "00", signature: "00", prev_hash: null, hash: "00", signing_key_id: null,
};

function confirmed(providerTxId: string): TransferResult {
  return {
    providerTxId, txHash: "0xhash", txRef: "0xhash", chain: "ARC-TESTNET", status: "confirmed", feeUsd: 0.003,
    feeSource: "chain_reported", providerMode: "live", settledInMs: 4000, providerState: "COMPLETE", failureReason: null,
  };
}

/** Circle as the lookup finds it: `listed` is what it has under the payment's reference. */
class FakeProvider implements ChainProvider {
  readonly network = ARC_TESTNET;
  readonly mode = "live" as const;
  readonly earnMode = "simulate" as const;
  readonly estimatedFeeUsd = 0.003;
  transfers: TransferParams[] = [];
  lookups: Array<{ refId: string; options: unknown }> = [];
  constructor(private readonly listed: TransferResult | null) {}
  async transfer(params: TransferParams): Promise<TransferResult> {
    this.transfers.push(params);
    return confirmed("circle-tx-sent-again");
  }
  async findTransferByRef(_from: string, refId: string, _window: unknown, options?: unknown): Promise<TransferResult | null> {
    this.lookups.push({ refId, options });
    return this.listed;
  }
  async reconcileTransfer(providerTxId: string): Promise<TransferResult> {
    return confirmed(providerTxId);
  }
  async getBalance(): Promise<BalanceSnapshot> { throw new Error("not used"); }
  async depositToEarn(): Promise<EarnResult> { throw new Error("not used"); }
  async withdrawFromEarn(): Promise<EarnResult> { throw new Error("not used"); }
}

/**
 * A workspace whose payment was sent half an hour ago and never answered, for a counterparty now high risk: by default
 * an invoice's claim that went stale; `failed` with Circle's "may or may not have been accepted" for a send that timed out.
 */
function workspace(source: { type: "invoice" | "milestone"; id: string; failed?: true } = { type: "invoice", id: INVOICE_ID }) {
  const intents = paymentIntentsBackend(ORG);
  const row = intents.insert({
    source_type: source.type, source_id: source.id, idempotency_key: paymentIdempotencyKey(source.type, source.id),
    provider: "circle", provider_mode: "live", amount: 150, destination: "0xdead",
  });
  Object.assign(row, {
    status: source.failed ? "failed" : "submitting",
    attempt_count: 1,
    updated_at: new Date(Date.now() - 30 * 60_000).toISOString(),
    ...(source.failed ? { last_error: `no answer within 20000 ms; the transfer ${MAY_HAVE_BEEN_ACCEPTED}` } : {}),
  });
  const fake = fakeSupabase((request: RecordedRequest) => {
    if (request.path === "/rest/v1/orgs") return { body: ORG_ROW };
    if (request.path === "/rest/v1/rpc/append_ledger_entry") return { body: LEDGER_ROW };
    if (request.path === "/rest/v1/counterparties" && request.method === "GET") return { body: { risk_level: "high" } };
    if (request.path === "/rest/v1/rpc/agent_paused") return { body: false };
    if (request.path === "/rest/v1/payment_intents" || request.path.startsWith("/rest/v1/rpc/")) return intents.respond(request);
    return { body: [] };
  });
  const run = <T>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, fn));
  const invoicePatch = () => fake.requests.find((r) => r.path === "/rest/v1/invoices" && r.method === "PATCH")?.body as Record<string, unknown> | undefined;
  const milestonePatch = () => fake.requests.find((r) => r.path === "/rest/v1/milestones" && r.method === "PATCH")?.body as Record<string, unknown> | undefined;
  return { row, fake, run, invoicePatch, milestonePatch };
}

const invoice = {
  id: INVOICE_ID,
  amount: 150,
  counterpartyId: COUNTERPARTY_ID,
  counterpartyName: "Acme Supplies",
  address: "0xdead",
  reasoning: "Paid 150 USDC to Acme Supplies.",
  txRef: null,
};
const neverRecorded = { providerTxId: null, status: "submitting" };

describe("reconcileApInvoice over the real payment step — a send never recorded (payment safety R4)", () => {
  it("records the transfer Circle took as paid, sending nothing again, though the counterparty is now high risk", async () => {
    const provider = new FakeProvider(confirmed("circle-tx-found"));
    const { row, fake, run, invoicePatch } = workspace();

    const outcome = await run(() => reconcileApInvoice(invoice, neverRecorded, { db: db(), provider, operating: { id: ACCOUNT_ID } }));

    expect(provider.lookups.map((lookup) => lookup.refId)).toEqual([`Invoice ${INVOICE_ID}`]);
    expect(provider.transfers).toHaveLength(0);
    expect(fake.requests.some((r) => r.path === "/rest/v1/counterparties")).toBe(false);
    expect(row).toMatchObject({ status: "confirmed", provider_tx_id: "circle-tx-found" });
    expect(outcome.status).toBe("paid");
    expect(invoicePatch()).toMatchObject({ status: "paid", tx_ref: "0xhash" });
  });

  it("records a send Circle never took as never sent, then holds it for the counterparty's risk, sending nothing", async () => {
    const provider = new FakeProvider(null);
    const { row, run, invoicePatch } = workspace();

    const outcome = await run(() => reconcileApInvoice(invoice, neverRecorded, { db: db(), provider, operating: { id: ACCOUNT_ID } }));

    expect(provider.lookups).toHaveLength(1);
    expect(provider.transfers).toHaveLength(0);
    expect(row).toMatchObject({ status: "failed", provider_tx_id: null, last_error: NO_EARLIER_SEND });
    expect(outcome.status).toBe("held");
    expect(invoicePatch()).toMatchObject({ status: "held" });
  });
});

/**
 * A send that timed out is recorded `failed` with "may or may not have been accepted", and the stage hands it to the
 * reconcile (`unanswered`) rather than deciding it again: looked up first, recorded when Circle took it, and handed back
 * to be decided only when Circle never did.
 */
describe("reconcileMilestone over the real payment step — a release that timed out (payment safety R4)", () => {
  const MILESTONE_ID = "018f8ce0-1557-7b54-a931-4d777f6be009";
  const milestone = {
    id: MILESTONE_ID, title: "Checkout redesign", amount: 150, contractorId: COUNTERPARTY_ID, contractorName: "Lena Ortiz",
    address: "0xdead", reasoning: "Verified via github.", txRef: null,
  };
  const timedOut = { providerTxId: null, status: "failed", unanswered: true as const };

  it("records the release Circle took as paid, sending nothing again, though the contractor is now high risk", async () => {
    const provider = new FakeProvider(confirmed("circle-tx-found"));
    const { row, fake, run, milestonePatch } = workspace({ type: "milestone", id: MILESTONE_ID, failed: true });

    const outcome = await run(() => reconcileMilestone(milestone, timedOut, { db: db(), provider, operating: { id: ACCOUNT_ID } }));

    expect(provider.lookups.map((lookup) => lookup.refId)).toEqual([`Milestone ${MILESTONE_ID}`]);
    expect(provider.transfers).toHaveLength(0);
    expect(fake.requests.some((r) => r.path === "/rest/v1/counterparties")).toBe(false);
    expect(row).toMatchObject({ status: "confirmed", provider_tx_id: "circle-tx-found" });
    expect(outcome.status).toBe("paid");
    expect(milestonePatch()).toMatchObject({ status: "paid", tx_ref: "0xhash" });
  });

  it("hands a release Circle never took back to be decided, writing nothing to the milestone", async () => {
    const provider = new FakeProvider(null);
    const { row, fake, run, milestonePatch } = workspace({ type: "milestone", id: MILESTONE_ID, failed: true });

    const outcome = await run(() => reconcileMilestone(milestone, timedOut, { db: db(), provider, operating: { id: ACCOUNT_ID } }));

    expect(outcome.decideAgain).toBe(true);
    expect(provider.transfers).toHaveLength(0);
    expect(row).toMatchObject({ status: "failed", last_error: NO_EARLIER_SEND });
    expect(milestonePatch()).toBeUndefined();
    expect(fake.requests.some((r) => r.path === "/rest/v1/counterparties")).toBe(false);
    expect(fake.requests.some((r) => r.path === "/rest/v1/rpc/append_ledger_entry")).toBe(false);
  });
});
