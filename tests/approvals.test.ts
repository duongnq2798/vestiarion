import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import {
  addInvoiceDetails,
  ApprovalError,
  approveAndPay,
  lastAttemptOf,
  listWaitingPayables,
  paymentWasSent,
  rejectInvoice,
  returnInvoice,
  transferExists,
  transferUnknown,
} from "@/lib/agent/approvals";
import type { BalanceSnapshot, ChainProvider, EarnResult, TransferParams, TransferResult } from "@/lib/circle";
import { paymentIdempotencyKey, type PaymentExecution } from "@/lib/payments";
import { UsycNotConfirmedError } from "@/lib/circle/usyc";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * `src/lib/agent/approvals.ts` against a real supabase-js client whose
 * network is a recorder — the same shape as `tests/members.test.ts` and
 * `tests/workspace.test.ts`: a real organization scope, over the recorded
 * fake, with a real ledger key, so `appendLedgerEntry` really signs. What
 * `payInvoice` does with a provider is `tests/pay.test.ts`'s job, not this
 * file's, so it and `getChainProvider` are mocked here.
 */

const { payInvoiceMock, syncOperatingBalanceMock } = vi.hoisted(() => ({
  payInvoiceMock: vi.fn(),
  syncOperatingBalanceMock: vi.fn(),
}));
vi.mock("@/lib/agent/pay", () => ({
  payInvoice: payInvoiceMock,
  syncOperatingBalance: syncOperatingBalanceMock,
}));

const { getChainProviderMock } = vi.hoisted(() => ({ getChainProviderMock: vi.fn() }));
vi.mock("@/lib/circle", () => ({ getChainProvider: getChainProviderMock }));

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000c0de";
const ACTOR = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000a1";
const CREATOR = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000b2";
const INVOICE_ID = "018f8ce0-1557-7b54-a931-4d777f6bcafe";
const COUNTERPARTY_ID = "018f8ce0-1557-7b54-a931-4d777f6bcaff";
const ACCOUNT_ID = "018f8ce0-1557-7b54-a931-4d777f6bca00";

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
  payInvoiceMock.mockReset();
  syncOperatingBalanceMock.mockReset();
  getChainProviderMock.mockReset();
  getChainProviderMock.mockReturnValue({ mode: "simulate", earnMode: "simulate", estimatedFeeUsd: 0.01 });
});
afterEach(() => {
  if (savedMasterKeys === undefined) delete process.env.VESTIARION_MASTER_KEYS;
  else process.env.VESTIARION_MASTER_KEYS = savedMasterKeys;
});

function orgRow() {
  return {
    id: ORG,
    slug: "northstar",
    name: "Northstar",
    mode: "sandbox",
    ledger_signing_key_enc: encryptSecret(LEDGER_PEM, { orgId: ORG, column: "ledger_signing_key_enc" }, parseMasterKeys(MASTER_KEYS)),
    circle_api_key_enc: null,
    circle_entity_secret_enc: null,
  };
}

function invoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID,
    amount: "150",
    due_date: "2026-10-05",
    status: "held",
    direction: "payable",
    agent_reasoning: "Held for manual review: over the daily limit.",
    decided_at: null,
    created_by: CREATOR,
    reviewed_at: null,
    counterparty_id: COUNTERPARTY_ID,
    counterparties: { name: "Acme Supplies", risk_level: "medium", address: "0xdead" },
    ...overrides,
  };
}

function accountRow(balance = "500") {
  return { id: ACCOUNT_ID, balance };
}

/** An invoice's full `payment_intents` row, for the tests that run the real payment step against the fake. */
function intentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "5a1d0c4e-2b7f-4e61-9d3a-00000000c1a1",
    org_id: ORG,
    source_type: "invoice",
    source_id: INVOICE_ID,
    idempotency_key: paymentIdempotencyKey("invoice", INVOICE_ID),
    provider: "circle",
    provider_tx_id: "circle-tx-1",
    tx_hash: null,
    amount: "150.000000",
    destination: "0xdead",
    status: "pending",
    attempt_count: 1,
    last_error: null,
    confirmed_at: null,
    chain: "ARC-TESTNET",
    provider_mode: "live",
    fee_usd: null,
    fee_source: null,
    settled_in_ms: null,
    executed_at: null,
    provider_state: "SENT",
    failure_reason: null,
    transfer_attempt: 1,
    previous_attempts: [],
    created_at: "2026-09-30T00:00:00+00:00",
    updated_at: "2026-09-30T00:00:00+00:00",
    ...overrides,
  };
}

/** What a `returns payment_intents` function sends when its UPDATE matched no row: every field null. */
const NO_INTENT = Object.fromEntries(Object.keys(intentRow()).map((column) => [column, null]));

/**
 * PostgREST as `approvals.ts` meets it: the invoice, the account, the claim RPC, and `append_ledger_entry`.
 *
 * `intents` is a table, not a canned reply: rows are found by source or by
 * their current key, written by key, claimed by `claim_payment_intent`, and
 * moved to their next attempt by `begin_payment_retry` under migration 0036's
 * condition — so a test can run the real payment step against it.
 */
function approvalsFake(options: {
  invoice?: (request: RecordedRequest) => FakeReply | undefined;
  account?: (request: RecordedRequest) => FakeReply | undefined;
  claim?: (request: RecordedRequest) => FakeReply | undefined;
  /** An invoice PATCH's reply; undefined falls through to success. */
  invoicePatch?: (request: RecordedRequest) => FakeReply | undefined;
  /** The invoice's payment intent, or none; for the listing, every row's intent. */
  intents?: Array<Record<string, unknown>>;
  ledgerFails?: boolean;
  /** The counterparty row the address confirmation reads; none by default. */
  counterparty?: Record<string, unknown>;
  /** The ledger entries about the listed invoices, as `ledger_entries_for_targets` returns them; none by default. */
  ledgerTargets?: Array<Record<string, unknown>>;
  /** `sole_approver`'s reply (migration 0061); unset falls through to the default `[]`, which is not `true`. */
  soleApprover?: FakeReply;
  /** The counterparty's entries that set or confirmed its address, newest first (new payee check N2); none by default. */
  addressEntries?: Array<Record<string, unknown>>;
  /** The workspace's figure above which a payment needs two approvals (two approvals T1); none by default. */
  twoApprovals?: number;
  /** The invoice's open approvals (two approvals T4); none by default. */
  approvals?: Array<Record<string, unknown>>;
  /** Who of those named may approve payments now (`approvers_among`); everyone named by default. */
  approversAmong?: (users: string[]) => string[];
  /** How many members may approve payments besides those named (`approvers_besides`): one figure, or one per set left out; 2 by default. */
  approversBesides?: number | ((excluded: string[]) => number);
  /** The reply to marking approvals used; success by default. */
  approvalsPatch?: FakeReply;
  /** The workspace's reserve account, `{ id, balance }` (approval cash R1); none by default. */
  reserve?: Record<string, unknown> | null;
} = {}) {
  const intents = options.intents ?? [];
  const eq = (request: RecordedRequest, column: string) => request.params.get(column)?.match(/^eq\.(.+)$/)?.[1];
  const fake = fakeSupabase((request) => {
    if (request.path === "/rest/v1/orgs") return { body: orgRow() };
    if (request.path === "/rest/v1/counterparties" && request.method === "GET") return { body: options.counterparty ?? null };
    if (request.path === "/rest/v1/counterparties" && request.method === "PATCH") return { body: [{ id: COUNTERPARTY_ID }] };

    if (request.path === "/rest/v1/invoices" && request.method === "GET") {
      const failure = options.invoice?.(request);
      if (failure) return failure;
      if (request.params.get("id")) return { body: invoiceRow() };
      return { body: [invoiceRow()] };
    }
    if (request.path === "/rest/v1/invoices" && request.method === "PATCH") {
      const failure = options.invoicePatch?.(request);
      if (failure) return failure;
      return { body: [] };
    }
    if (request.path === "/rest/v1/payment_intents" && request.method === "GET") {
      const key = eq(request, "idempotency_key");
      if (key !== undefined) return { body: intents.find((intent) => intent.idempotency_key === key) ?? null };
      const one = eq(request, "source_id");
      if (one !== undefined) return { body: intents.find((intent) => intent.source_id === one) ?? null };
      return { body: intents };
    }
    if (request.path === "/rest/v1/payment_intents" && request.method === "POST") {
      const body = (Array.isArray(request.body) ? request.body[0] : request.body) as Record<string, unknown>;
      // on_conflict=source_type,source_id with ignore-duplicates: a source keeps its one row.
      if (!intents.some((intent) => intent.source_id === body.source_id)) {
        intents.push(intentRow({ ...body, provider_tx_id: null, status: "created", attempt_count: 0, provider_state: null, chain: null }));
      }
      return { body: [] };
    }
    if (request.path === "/rest/v1/payment_intents" && request.method === "PATCH") {
      const row = intents.find((intent) => intent.idempotency_key === eq(request, "idempotency_key"));
      if (row) Object.assign(row, request.body as Record<string, unknown>);
      return { body: [] };
    }
    if (request.path === "/rest/v1/rpc/claim_payment_intent") {
      const row = intents.find((intent) => intent.idempotency_key === (request.body as Record<string, unknown>).p_idempotency_key);
      if (!row || !["created", "failed"].includes(row.status as string)) return { body: NO_INTENT };
      Object.assign(row, { status: "submitting", attempt_count: (row.attempt_count as number) + 1 });
      return { body: { ...row } };
    }
    if (request.path === "/rest/v1/rpc/begin_payment_retry") {
      const args = request.body as Record<string, unknown>;
      const row = intents.find((intent) => intent.source_type === args.p_source_type && intent.source_id === args.p_source_id);
      if (
        !row ||
        row.idempotency_key !== args.p_expected_key ||
        row.status !== "failed" ||
        row.provider_tx_id === null ||
        !["CANCELLED", "DENIED", "FAILED"].includes(row.provider_state as string)
      ) {
        return { body: NO_INTENT };
      }
      Object.assign(row, {
        previous_attempts: [...(row.previous_attempts as unknown[]), { attempt: row.transfer_attempt, providerTxId: row.provider_tx_id, providerState: row.provider_state }],
        idempotency_key: args.p_new_key,
        transfer_attempt: (row.transfer_attempt as number) + 1,
        provider_tx_id: null, tx_hash: null, provider_state: null, failure_reason: null,
        status: "created", last_error: null, confirmed_at: null, executed_at: null,
      });
      return { body: { ...row } };
    }
    if (request.path === "/rest/v1/accounts" && request.method === "GET" && request.params.get("kind") === "eq.reserve") return { body: options.reserve ?? null };
    if (request.path === "/rest/v1/accounts" && request.method === "GET") {
      const failure = options.account?.(request);
      if (failure) return failure;
      return { body: accountRow() };
    }
    if (request.path === "/rest/v1/rpc/claim_invoice_decision") {
      const failure = options.claim?.(request);
      if (failure) return failure;
      const body = request.body as Record<string, unknown>;
      return { body: { ...invoiceRow(), status: "processing", reviewed_by: body.p_by, reviewed_at: "2026-09-29T00:00:00Z" } };
    }
    if (request.path === "/rest/v1/rpc/ledger_entries_for_targets") return { body: options.ledgerTargets ?? [] };
    if (request.path === "/rest/v1/ledger_entries" && request.method === "GET" && request.params.has("detail->>counterpartyId")) {
      return { body: options.addressEntries ?? [] };
    }
    if (request.path === "/rest/v1/rpc/sole_approver" && options.soleApprover) return options.soleApprover;
    if (request.path === "/rest/v1/approval_policies") return { body: options.twoApprovals ? [{ two_approvals_above: String(options.twoApprovals) }] : [] };
    if (request.path === "/rest/v1/payment_approvals" && request.method === "GET") return { body: options.approvals ?? [] };
    if (request.path === "/rest/v1/payment_approvals" && request.method === "POST") {
      const body = request.body as Record<string, unknown>;
      return { status: 201, body: { id: "appr-new", approved_by: body.approved_by, approved_at: "2026-10-05T09:00:00.000Z", amount: String(body.amount), currency: body.currency, address: body.address } };
    }
    if (request.path === "/rest/v1/rpc/approvers_among") {
      const users = (request.body as { p_users: string[] }).p_users;
      return { body: options.approversAmong ? options.approversAmong(users) : users };
    }
    if (request.path === "/rest/v1/rpc/approvers_besides") {
      const excluded = (request.body as { p_excluded: string[] }).p_excluded;
      const count = options.approversBesides;
      return { body: typeof count === "function" ? count(excluded) : (count ?? 2) };
    }
    if (request.path === "/rest/v1/payment_approvals" && request.method === "PATCH" && options.approvalsPatch) return options.approvalsPatch;
    if (request.path === "/rest/v1/rpc/append_ledger_entry") {
      if (options.ledgerFails) return { status: 500, body: { message: "ledger unavailable" } };
      return {
        body: {
          seq: 1, id: "e1", ts: "2026-09-29T00:00:00Z", actor: "human", domain: "ap", action: "x",
          summary: "", detail: {}, body_hash: "00", signature: "00", prev_hash: null, hash: "00", signing_key_id: null,
        },
      };
    }
    return { body: [] };
  });
  return { fake, run: <T>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, fn)) };
}

/** What `executePayment` reported, as `payInvoice` hands it back. */
function execution(overrides: Partial<PaymentExecution> = {}): PaymentExecution {
  return {
    idempotencyKey: "key-1",
    providerTxId: "circle-tx-1",
    txHash: "0xhash",
    txRef: "0xhash",
    status: "confirmed",
    attemptCount: 1,
    error: null,
    reconciled: false,
    chain: "ARC-TESTNET",
    providerMode: "live",
    feeUsd: 0.003,
    feeSource: "chain_reported",
    settledInMs: 4000,
    executedAt: "2026-09-30T00:00:00Z",
    attempt: 1,
    retriedAfter: null,
    ...overrides,
  };
}

/** An invoice's intent whose current attempt Circle ended in a terminal failure. */
function terminallyFailed(overrides: Record<string, unknown> = {}) {
  return {
    source_id: INVOICE_ID,
    status: "failed",
    provider_tx_id: "circle-tx-1",
    last_error: null,
    provider_state: "FAILED",
    failure_reason: "INSUFFICIENT_NATIVE_TOKEN",
    ...overrides,
  };
}

function rpcBodies(requests: RecordedRequest[], name: string) {
  return requests.filter((r) => r.path === `/rest/v1/rpc/${name}`).map((r) => r.body as Record<string, unknown>);
}
function patchBodies(requests: RecordedRequest[], path: string) {
  return requests.filter((r) => r.path === path && r.method === "PATCH").map((r) => r.body as Record<string, unknown>);
}

describe("approveAndPay", () => {
  it("refuses self-approval before any claim", async () => {
    const { fake, run } = approvalsFake();

    const attempt = run(() => approveAndPay({ actorId: CREATOR, invoiceId: INVOICE_ID }));
    await expect(attempt).rejects.toBeInstanceOf(ApprovalError);
    await expect(attempt).rejects.toThrow("You created this invoice, so someone else must approve it.");
    expect(rpcBodies(fake.requests, "claim_invoice_decision")).toHaveLength(0);
    expect(payInvoiceMock).not.toHaveBeenCalled();
  });

  it("lets the workspace's sole approver approve and pay an invoice they entered, and the ledger says so", async () => {
    payInvoiceMock.mockResolvedValue({ status: "paid", txRef: "0xhash", execution: null, note: "", operatingBalance: 0 });
    const { fake, run } = approvalsFake({ soleApprover: { body: true } });

    const result = await run(() => approveAndPay({ actorId: CREATOR, invoiceId: INVOICE_ID }));

    expect(result.status).toBe("paid");
    expect(rpcBodies(fake.requests, "sole_approver")).toEqual([{ p_org_id: ORG, p_user_id: CREATOR }]);
    expect(rpcBodies(fake.requests, "claim_invoice_decision")).toEqual([{ p_org_id: ORG, p_invoice_id: INVOICE_ID, p_by: CREATOR, p_decision: "approve" }]);
    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(append).toMatchObject({
      p_action: "approval_paid",
      p_summary: "Approved and paid 150 USDC to Acme Supplies (entered and approved by the workspace's only approver)",
      p_detail: { by: CREATOR, soleApprover: true, status: "paid" },
    });
  });

  it("keeps the self-approval refusal when whether they are the sole approver cannot be read", async () => {
    const { fake, run } = approvalsFake({ soleApprover: { status: 404, body: { code: "PGRST202", message: "Could not find the function public.sole_approver" } } });

    await expect(run(() => approveAndPay({ actorId: CREATOR, invoiceId: INVOICE_ID }))).rejects.toThrow(
      "You created this invoice, so someone else must approve it."
    );
    expect(rpcBodies(fake.requests, "claim_invoice_decision")).toHaveLength(0);
    expect(payInvoiceMock).not.toHaveBeenCalled();
  });

  it("does not ask about a sole approver, nor record one, when someone else approves", async () => {
    payInvoiceMock.mockResolvedValue({ status: "paid", txRef: "0xhash", execution: null, note: "", operatingBalance: 0 });
    const { fake, run } = approvalsFake({ soleApprover: { body: true } });

    await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }));

    expect(rpcBodies(fake.requests, "sole_approver")).toHaveLength(0);
    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(append.p_summary).toBe("Approved and paid 150 USDC to Acme Supplies");
    expect(append.p_detail).not.toHaveProperty("soleApprover");
  });

  it("refuses a high-risk counterparty before any claim", async () => {
    const { fake, run } = approvalsFake({
      invoice: (r) => (r.params.get("id") ? { body: invoiceRow({ counterparties: { name: "Acme", risk_level: "high", address: null } }) } : undefined),
    });

    const attempt = run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }));
    await expect(attempt).rejects.toBeInstanceOf(ApprovalError);
    await expect(attempt).rejects.toThrow("This counterparty is screened high risk. Clear it in Compliance first.");
    expect(rpcBodies(fake.requests, "claim_invoice_decision")).toHaveLength(0);
    expect(payInvoiceMock).not.toHaveBeenCalled();
  });

  it("refuses with no_operating_account before any claim, when the workspace has no operating account", async () => {
    const { fake, run } = approvalsFake({ account: () => ({ body: null }) });

    const attempt = run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }));
    await expect(attempt).rejects.toBeInstanceOf(ApprovalError);
    await expect(attempt).rejects.toThrow("This workspace has no operating account.");
    expect(rpcBodies(fake.requests, "claim_invoice_decision")).toHaveLength(0);
    expect(payInvoiceMock).not.toHaveBeenCalled();
  });

  it("refuses with insufficient_funds, naming the stored balance, before any claim", async () => {
    const { fake, run } = approvalsFake({ account: () => ({ body: accountRow("40") }) });

    const attempt = run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }));
    await expect(attempt).rejects.toBeInstanceOf(ApprovalError);
    await expect(attempt).rejects.toThrow("The operating account holds 40 USDC, less than this invoice.");
    expect(rpcBodies(fake.requests, "claim_invoice_decision")).toHaveLength(0);
    expect(payInvoiceMock).not.toHaveBeenCalled();
  });

  it("skips the funds check, and reaches payInvoice, when this invoice's transfer is already confirmed", async () => {
    payInvoiceMock.mockResolvedValue({ status: "paid", txRef: "0xhash", execution: null, note: "", operatingBalance: 0 });
    const { fake, run } = approvalsFake({
      account: () => ({ body: accountRow("40") }),
      intents: [{ source_id: INVOICE_ID, status: "confirmed", provider_tx_id: "circle-tx-1", last_error: null }],
    });

    const result = await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }));

    expect(result.status).toBe("paid");
    expect(payInvoiceMock).toHaveBeenCalledTimes(1);
    const [lookup] = fake.requests.filter((r) => r.path === "/rest/v1/payment_intents");
    expect(lookup.params.get("source_type")).toBe("eq.invoice");
    expect(lookup.params.get("source_id")).toBe(`eq.${INVOICE_ID}`);
  });

  it("skips the funds check when a transfer exists with a provider id, still pending", async () => {
    payInvoiceMock.mockResolvedValue({ status: "matched", txRef: "circle-tx-1", execution: null, note: "", operatingBalance: null });
    const { run } = approvalsFake({
      account: () => ({ body: accountRow("40") }),
      intents: [{ source_id: INVOICE_ID, status: "pending", provider_tx_id: "circle-tx-1", last_error: null }],
    });

    await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }));

    expect(payInvoiceMock).toHaveBeenCalledTimes(1);
  });

  it("still refuses insufficient funds when the only intent is a provider-reported failure", async () => {
    const { run } = approvalsFake({
      account: () => ({ body: accountRow("40") }),
      intents: [{ source_id: INVOICE_ID, status: "failed", provider_tx_id: null, last_error: null }],
    });

    await expect(run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }))).rejects.toThrow(
      "The operating account holds 40 USDC, less than this invoice."
    );
    expect(payInvoiceMock).not.toHaveBeenCalled();
  });

  it("keeps the self-approval refusal even when the transfer already moved", async () => {
    const { run } = approvalsFake({ intents: [{ source_id: INVOICE_ID, status: "confirmed", provider_tx_id: "circle-tx-1", last_error: null }] });

    await expect(run(() => approveAndPay({ actorId: CREATOR, invoiceId: INVOICE_ID }))).rejects.toThrow(
      "You created this invoice, so someone else must approve it."
    );
    expect(payInvoiceMock).not.toHaveBeenCalled();
  });

  it("reads the live balance from syncOperatingBalance rather than the stored value, in live mode", async () => {
    getChainProviderMock.mockReturnValue({ mode: "live", earnMode: "simulate", estimatedFeeUsd: 0.003 });
    syncOperatingBalanceMock.mockResolvedValue(30);
    const { run } = approvalsFake({ account: () => ({ body: accountRow("999") }) });

    const attempt = run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }));
    await expect(attempt).rejects.toThrow("The operating account holds 30 USDC, less than this invoice.");
    expect(syncOperatingBalanceMock).toHaveBeenCalledWith(ACCOUNT_ID);
  });

  it("raises invoice_not_found for an invoice that is missing or not waiting", async () => {
    const { run } = approvalsFake({ invoice: (r) => (r.params.get("id") ? { body: null } : undefined) });
    await expect(run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }))).rejects.toThrow(
      "That invoice is not waiting for a decision."
    );
  });

  it("raises invoice_not_found for an invoice already settled", async () => {
    const { run } = approvalsFake({ invoice: (r) => (r.params.get("id") ? { body: invoiceRow({ status: "paid" }) } : undefined) });
    await expect(run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }))).rejects.toThrow(
      "That invoice is not waiting for a decision."
    );
  });

  it("gives already_decided, with no payment, when the claim loses the race", async () => {
    const { fake, run } = approvalsFake({
      claim: () => ({ status: 400, body: { code: "P0001", message: "already_decided: the invoice is rejected now", details: null, hint: null } }),
    });

    const attempt = run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }));
    await expect(attempt).rejects.toBeInstanceOf(ApprovalError);
    await expect(attempt).rejects.toThrow("Someone else decided this invoice a moment ago.");
    expect(payInvoiceMock).not.toHaveBeenCalled();
    expect(patchBodies(fake.requests, "/rest/v1/invoices")).toHaveLength(0);
  });

  describe("a payee on another chain (CCTP payouts, review I2)", () => {
    const onBase = (r: RecordedRequest) =>
      r.params.get("id") ? { body: invoiceRow({ counterparties: { name: "Acme Supplies", risk_level: "medium", address: "0xdead", chain: "BASE-SEPOLIA" } }) } : undefined;

    it("sends the payment to the payee's chain, and lets its fee be at most the invoice", async () => {
      payInvoiceMock.mockResolvedValue({ status: "matched", txRef: "0xburn", execution: null, note: "", operatingBalance: null, amountPaid: 150, discountTaken: 0 });
      const { run } = approvalsFake({ invoice: onBase });
      // The fees it records are read from stand-ins: no test reads Circle.
      const quotes = { bridgeFee: vi.fn(async () => ({ feeUsdc: 0.054597, maxFeeUnits: BigInt(54597), domain: 6 })), gatewayQuote: vi.fn(async () => null) };
      await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }, quotes));
      expect(payInvoiceMock.mock.calls[0][0]).toMatchObject({ destinationChain: "BASE-SEPOLIA", maxBridgeFeeUsdc: 150 });
    });

    describe("records both routes' fees with the route the approval takes (route evidence)", () => {
      const onArb = (r: RecordedRequest) =>
        r.params.get("id") ? { body: invoiceRow({ counterparties: { name: "STM", risk_level: "medium", address: "0xdead", chain: "ARB-SEPOLIA" } }) } : undefined;
      const paid = () => payInvoiceMock.mockResolvedValue({ status: "matched", txRef: "0xburn", execution: null, note: "", operatingBalance: null, amountPaid: 150, discountTaken: 0 });
      const approvalEntry = (requests: RecordedRequest[]) => rpcBodies(requests, "append_ledger_entry").find((body) => body.p_action === "approval_paid")?.p_detail as Record<string, unknown>;
      const cctpFee = () => vi.fn(async () => ({ feeUsdc: 0.135342, maxFeeUnits: BigInt(135342), domain: 3 }));
      const gatewayQuote = () => vi.fn(async () => ({ feeUsdc: 0.105944, balanceUsdc: 5 }));

      it("a new payout goes through CCTP, and its entry sets that fee against Gateway's", async () => {
        paid();
        const { fake, run } = approvalsFake({ invoice: onArb });
        await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }, { bridgeFee: cctpFee(), gatewayQuote: gatewayQuote() }));
        expect(approvalEntry(fake.requests).payout).toEqual({
          chain: "ARB-SEPOLIA",
          route: "cctp",
          domain: 3,
          feeUsdc: 0.135342,
          quotes: { cctpFeeUsdc: 0.135342, gatewayFeeUsdc: 0.105944 },
        });
      });

      it("a payout an earlier attempt sent through Gateway records Gateway, its fee and its balance", async () => {
        paid();
        const { fake, run } = approvalsFake({
          invoice: onArb,
          intents: [intentRow({ status: "failed", provider_tx_id: "gateway:tr-1", provider_state: "FAILED", payout_route: "gateway", destination_chain: "ARB-SEPOLIA" })],
        });
        await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }, { bridgeFee: cctpFee(), gatewayQuote: vi.fn(async () => ({ feeUsdc: 0.105944, balanceUsdc: 500 })) }));
        expect(approvalEntry(fake.requests).payout).toEqual({
          chain: "ARB-SEPOLIA",
          route: "gateway",
          domain: 3,
          feeUsdc: 0.105944,
          gatewayBalanceUsdc: 500,
          quotes: { cctpFeeUsdc: 0.135342, gatewayFeeUsdc: 0.105944 },
        });
      });

      it("a fee that cannot be read is null, and never stops the approval", async () => {
        paid();
        const { fake, run } = approvalsFake({ invoice: onArb });
        await run(() =>
          approveAndPay(
            { actorId: ACTOR, invoiceId: INVOICE_ID },
            { bridgeFee: vi.fn(async () => { throw new Error("Iris did not answer"); }), gatewayQuote: vi.fn(async () => { throw new Error("Gateway did not answer"); }) }
          )
        );
        expect(payInvoiceMock).toHaveBeenCalledTimes(1);
        expect(approvalEntry(fake.requests).payout).toEqual({ chain: "ARB-SEPOLIA", route: "cctp", domain: 3, feeUsdc: null, quotes: { cctpFeeUsdc: null, gatewayFeeUsdc: null } });
      });

      it("reads no fee for a transfer already sent, which is only reconciled, and for a payee on Arc", async () => {
        paid();
        const bridgeFee = cctpFee();
        const sent = approvalsFake({ invoice: onArb, intents: [intentRow({ status: "pending", provider_tx_id: "cctp:burn-1", provider_state: "COMPLETE", payout_route: "cctp" })] });
        await sent.run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }, { bridgeFee, gatewayQuote: gatewayQuote() }));
        expect(bridgeFee).not.toHaveBeenCalled();
        expect(approvalEntry(sent.fake.requests)).not.toHaveProperty("payout");

        const onArc = approvalsFake({});
        await onArc.run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }, { bridgeFee, gatewayQuote: gatewayQuote() }));
        expect(bridgeFee).not.toHaveBeenCalled();
        expect(approvalEntry(onArc.fake.requests)).not.toHaveProperty("payout");
      });
    });

    describe("takes the agent's route, and counts what leaves from where it leaves (approval payout route P1, P2)", () => {
      const onArb = (r: RecordedRequest) =>
        r.params.get("id") ? { body: invoiceRow({ counterparties: { name: "STM", risk_level: "medium", address: "0xdead", chain: "ARB-SEPOLIA" } }) } : undefined;
      const cctpFee = () => vi.fn(async () => ({ feeUsdc: 0.135342, maxFeeUnits: BigInt(135342), domain: 3 }));
      const approvalEntry = (requests: RecordedRequest[]) => rpcBodies(requests, "append_ledger_entry").find((body) => body.p_action === "approval_paid")?.p_detail as Record<string, unknown>;

      it("sends a new payout through Gateway when its balance covers it and it costs no more, whatever the operating wallet holds", async () => {
        payInvoiceMock.mockResolvedValue({ status: "matched", txRef: "gateway:tr-2", execution: null, note: "", operatingBalance: null, amountPaid: 150, discountTaken: 0 });
        const { fake, run } = approvalsFake({ invoice: onArb, account: () => ({ body: accountRow("100") }) });

        await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }, { bridgeFee: cctpFee(), gatewayQuote: vi.fn(async () => ({ feeUsdc: 0.105944, balanceUsdc: 500 })) }));

        expect(payInvoiceMock.mock.calls[0][0]).toMatchObject({ destinationChain: "ARB-SEPOLIA", route: "gateway", maxBridgeFeeUsdc: 150 });
        expect(approvalEntry(fake.requests).payout).toMatchObject({ route: "gateway", feeUsdc: 0.105944, gatewayBalanceUsdc: 500 });
      });

      it("counts CCTP's fee against the operating wallet, which pays it on top", async () => {
        const { fake, run } = approvalsFake({ invoice: onArb, account: () => ({ body: accountRow("150.1") }) });

        const attempt = run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }, { bridgeFee: cctpFee(), gatewayQuote: vi.fn(async () => null) }));
        await expect(attempt).rejects.toMatchObject({ code: "insufficient_funds" });
        await expect(attempt).rejects.toThrow("The operating account holds 150.1 USDC, less than this invoice and its 0.135342 USDC CCTP fee.");
        expect(rpcBodies(fake.requests, "claim_invoice_decision")).toHaveLength(0);
        expect(payInvoiceMock).not.toHaveBeenCalled();
      });

      it("refuses a payout pinned to Gateway that the Gateway balance no longer covers, before any claim", async () => {
        const { fake, run } = approvalsFake({
          invoice: onArb,
          intents: [intentRow({ status: "failed", provider_tx_id: "gateway:tr-1", provider_state: "FAILED", payout_route: "gateway", destination_chain: "ARB-SEPOLIA" })],
        });

        const attempt = run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }, { bridgeFee: cctpFee(), gatewayQuote: vi.fn(async () => ({ feeUsdc: 0.105944, balanceUsdc: 100 })) }));
        await expect(attempt).rejects.toThrow("The Gateway balance, 100 USDC, does not cover this payout and its 0.105944 USDC fee. Fund Gateway on Treasury first.");
        expect(rpcBodies(fake.requests, "claim_invoice_decision")).toHaveLength(0);
      });
    });

    it("refuses an EURC invoice to such a payee before any claim: only USDC crosses (review M11)", async () => {
      const { fake, run } = approvalsFake({
        invoice: (r) => (r.params.get("id") ? { body: invoiceRow({ currency: "EURC", counterparties: { name: "Acme Supplies", risk_level: "medium", address: "0xdead", chain: "BASE-SEPOLIA" } }) } : undefined),
      });
      const attempt = run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }));
      await expect(attempt).rejects.toThrow("Only USDC crosses chains");
      expect(rpcBodies(fake.requests, "claim_invoice_decision")).toHaveLength(0);
    });

    it("lists the payee's chain and the fee to it, read now, so the person sees what leaves", async () => {
      const bridgeFee = vi.fn(async () => ({ feeUsdc: 1.854162, maxFeeUnits: BigInt(1854162), domain: 0 }));
      const { run } = approvalsFake({
        invoice: (r) =>
          r.params.get("id") ? undefined : { body: [invoiceRow({ counterparties: { name: "Acme Supplies", risk_level: "medium", address: "0xdead", chain: "ETH-SEPOLIA" } })] },
      });
      const [listed] = await run(() => listWaitingPayables({ bridgeFee, gatewayQuote: vi.fn(async () => null) }));
      expect(listed).toMatchObject({ payeeChain: "ETH-SEPOLIA", payoutRoute: "cctp", bridgeFeeUsdc: 1.854162 });
      expect(bridgeFee).toHaveBeenCalledWith("ETH-SEPOLIA", 150);
    });

    it("lists the route Approve and pay would take, by the agent's rule, and that route's fee (approval payout route P4)", async () => {
      const bridgeFee = vi.fn(async () => ({ feeUsdc: 0.227, maxFeeUnits: BigInt(227000), domain: 3 }));
      const onArb = (r: RecordedRequest) =>
        r.params.get("id") ? undefined : { body: [invoiceRow({ counterparties: { name: "CME", risk_level: "medium", address: "0xdead", chain: "ARB-SEPOLIA" } })] };

      const covered = approvalsFake({ invoice: onArb });
      const [gateway] = await covered.run(() => listWaitingPayables({ bridgeFee, gatewayQuote: vi.fn(async () => ({ feeUsdc: 0.163, balanceUsdc: 500 })) }));
      expect(gateway).toMatchObject({ payoutRoute: "gateway", bridgeFeeUsdc: 0.163 });

      // A route an earlier attempt took is kept, as the payment keeps it.
      const pinned = approvalsFake({ invoice: onArb, intents: [intentRow({ status: "failed", provider_state: "FAILED", payout_route: "cctp" })] });
      const [cctp] = await pinned.run(() => listWaitingPayables({ bridgeFee, gatewayQuote: vi.fn(async () => ({ feeUsdc: 0.163, balanceUsdc: 500 })) }));
      expect(cctp).toMatchObject({ payoutRoute: "cctp", bridgeFeeUsdc: 0.227 });
    });
  });

  describe("a EURC payable (EURC invoices design E5)", () => {
    const eurcInvoice = (r: RecordedRequest) => (r.params.get("id") ? { body: invoiceRow({ currency: "EURC" }) } : undefined);

    it("is paid in EURC, and the entry says so", async () => {
      payInvoiceMock.mockResolvedValue({ status: "paid", txRef: "0xhash", execution: null, note: "", operatingBalance: null, amountPaid: 150, discountTaken: 0 });
      const { fake, run } = approvalsFake({ invoice: eurcInvoice });

      await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }));

      expect(payInvoiceMock.mock.calls[0][0]).toMatchObject({ amount: 150, currency: "EURC" });
      const [append] = rpcBodies(fake.requests, "append_ledger_entry");
      expect(append).toMatchObject({ p_summary: "Approved and paid 150 EURC to Acme Supplies", p_detail: { amount: 150, currency: "EURC" } });
    });

    it("in live mode, checks the wallet's EURC, not its USDC, and refuses a short one before any claim", async () => {
      const getTokenBalance = vi.fn(async () => ({ accountId: ACCOUNT_ID, chain: "ARC-TESTNET", token: "EURC", balance: 100 }));
      getChainProviderMock.mockReturnValue({ mode: "live", earnMode: "simulate", estimatedFeeUsd: 0.003, getTokenBalance });
      const { fake, run } = approvalsFake({ invoice: eurcInvoice, account: () => ({ body: accountRow("999") }) });

      const attempt = run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }));
      await expect(attempt).rejects.toMatchObject({ code: "insufficient_funds" });
      await expect(attempt).rejects.toThrow("The operating wallet holds 100 EURC, less than this invoice.");
      expect(getTokenBalance).toHaveBeenCalledWith(ACCOUNT_ID, "EURC");
      expect(syncOperatingBalanceMock).not.toHaveBeenCalled();
      expect(rpcBodies(fake.requests, "claim_invoice_decision")).toHaveLength(0);
    });

    it("in a sandbox, is not held back by the USDC balance, and has no EURC balance to check", async () => {
      payInvoiceMock.mockResolvedValue({ status: "paid", txRef: "sim_1", execution: null, note: "", operatingBalance: null, amountPaid: 150, discountTaken: 0 });
      const { run } = approvalsFake({ invoice: eurcInvoice, account: () => ({ body: accountRow("40") }) });

      await expect(run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }))).resolves.toMatchObject({ status: "paid" });
    });
  });

  it("claims, pays once, updates the invoice with the reasoning note, and appends approval_paid", async () => {
    payInvoiceMock.mockResolvedValue({ status: "paid", txRef: "0xhash", execution: null, note: "", operatingBalance: 350 });
    const { fake, run } = approvalsFake();

    const result = await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }));

    expect(result).toEqual({ status: "paid", txRef: "0xhash", note: "" });

    const [claim] = rpcBodies(fake.requests, "claim_invoice_decision");
    expect(claim).toEqual({ p_org_id: ORG, p_invoice_id: INVOICE_ID, p_by: ACTOR, p_decision: "approve" });
    expect(payInvoiceMock).toHaveBeenCalledTimes(1);
    // A person's approval is the one caller that may send a terminally failed payment again.
    expect(payInvoiceMock).toHaveBeenCalledWith(
      { invoiceId: INVOICE_ID, counterpartyId: COUNTERPARTY_ID, address: "0xdead", amount: 150, discount: null, currency: "USDC" },
      { provider: { mode: "simulate", earnMode: "simulate", estimatedFeeUsd: 0.01 }, operating: { id: ACCOUNT_ID }, retryTerminalFailure: true }
    );

    const [update] = patchBodies(fake.requests, "/rest/v1/invoices");
    expect(update.status).toBe("paid");
    expect(update.agent_reasoning).toBe("Held for manual review: over the daily limit. [approved and paid by a person]");
    expect(update.tx_ref).toBe("0xhash");
    expect(typeof update.decided_at).toBe("string");
    expect(update.settled_at).toBe(update.decided_at);

    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(append).toMatchObject({
      p_org_id: ORG,
      p_actor: "human",
      p_domain: "ap",
      p_action: "approval_paid",
      p_summary: "Approved and paid 150 USDC to Acme Supplies",
      p_detail: {
        by: ACTOR,
        invoiceId: INVOICE_ID,
        counterpartyId: COUNTERPARTY_ID,
        amount: 150,
        overrode: "held",
        txRef: "0xhash",
        status: "paid",
      },
    });

    // claim, then pay, then the invoice update, then the ledger append — in that order.
    const order = fake.requests
      .filter(
        (r) =>
          r.path === "/rest/v1/rpc/claim_invoice_decision" ||
          (r.path === "/rest/v1/invoices" && r.method === "PATCH") ||
          r.path === "/rest/v1/rpc/append_ledger_entry"
      )
      .map((r) => r.path);
    expect(order).toEqual(["/rest/v1/rpc/claim_invoice_decision", "/rest/v1/invoices", "/rest/v1/rpc/append_ledger_entry"]);
  });

  it("names the surface and its link in approval_paid when the approval did not come from the console", async () => {
    payInvoiceMock.mockResolvedValue({ status: "paid", txRef: "0xhash", execution: null, note: "", operatingBalance: 350 });
    const { fake, run } = approvalsFake();

    await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID, provenance: { via: "slack", linkId: "link-1" } }));

    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(append.p_action).toBe("approval_paid");
    expect(append.p_detail).toMatchObject({ by: ACTOR, invoiceId: INVOICE_ID, status: "paid", via: "slack", linkId: "link-1" });
  });

  it("holds on a failed transfer, and the ledger entry records status: held", async () => {
    payInvoiceMock.mockResolvedValue({
      status: "held", txRef: "circle-tx-1", execution: null, note: " [transfer failed: provider reported failure]", operatingBalance: null,
    });
    const { fake, run } = approvalsFake();

    const result = await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }));

    expect(result.status).toBe("held");
    const [update] = patchBodies(fake.requests, "/rest/v1/invoices");
    expect(update.status).toBe("held");
    expect(update.settled_at).toBeNull();
    expect(update.agent_reasoning).toBe(
      "Held for manual review: over the daily limit. [approved and paid by a person] [transfer failed: provider reported failure]"
    );

    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect((append.p_detail as Record<string, unknown>).status).toBe("held");
  });

  it("resets the invoice to held with an interrupted note, and rethrows, when payInvoice itself throws", async () => {
    payInvoiceMock.mockRejectedValue(new Error("provider unreachable"));
    const { fake, run } = approvalsFake();

    await expect(run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }))).rejects.toThrow("provider unreachable");

    const [update] = patchBodies(fake.requests, "/rest/v1/invoices");
    expect(update).toEqual({
      status: "held",
      agent_reasoning: "Held for manual review: over the daily limit. [approval interrupted: provider unreachable]",
    });
    expect(rpcBodies(fake.requests, "append_ledger_entry")).toHaveLength(0);
  });

  it("logs by invoice id, and still rethrows the payment's error, when the rollback to held also fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    payInvoiceMock.mockRejectedValue(new Error("provider unreachable"));
    const { run } = approvalsFake({ invoicePatch: () => ({ status: 500, body: { message: "invoices update failed: connection reset" } }) });

    await expect(run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }))).rejects.toThrow("provider unreachable");

    expect(error).toHaveBeenCalledWith("approval: rollback to held failed after the claim", INVOICE_ID, "invoices update failed: connection reset");
    error.mockRestore();
  });

  it("logs by invoice id and outcome, and rethrows, when the invoice update after the payment fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    payInvoiceMock.mockResolvedValue({ status: "paid", txRef: "0xhash", execution: null, note: "", operatingBalance: 350 });
    const { fake, run } = approvalsFake({ invoicePatch: () => ({ status: 500, body: { message: "invoices update failed: connection reset" } }) });

    await expect(run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }))).rejects.toThrow("invoices update failed: connection reset");

    // The transfer may already have moved: the log is what lets someone find the invoice.
    expect(error).toHaveBeenCalledWith("approval: invoice update failed after the claim", INVOICE_ID, "paid");
    expect(rpcBodies(fake.requests, "append_ledger_entry")).toHaveLength(0);
    error.mockRestore();
  });

  it.each([
    ["paid", "0xhash", "Approved and paid 150 USDC to Acme Supplies"],
    ["matched", "circle-tx-1", "Approved; payment of 150 USDC to Acme Supplies submitted"],
    ["held", "circle-tx-1", "Approved; payment of 150 USDC to Acme Supplies failed"],
  ] as const)("summarises a %s outcome truthfully in the approval_paid entry", async (status, txRef, summary) => {
    payInvoiceMock.mockResolvedValue({ status, txRef, execution: null, note: "", operatingBalance: null });
    const { fake, run } = approvalsFake();

    await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }));

    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(append.p_action).toBe("approval_paid");
    expect(append.p_summary).toBe(summary);
  });

  it("still returns the payment result, and logs by id, when the ledger append fails after a paid invoice", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    payInvoiceMock.mockResolvedValue({ status: "paid", txRef: "0xhash", execution: null, note: "", operatingBalance: 350 });
    const { run } = approvalsFake({ ledgerFails: true });

    const result = await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }));

    expect(result.status).toBe("paid");
    expect(error).toHaveBeenCalledWith("ledger entry not recorded", "approval_paid", ORG);
    error.mockRestore();
  });

  it("records attempt 1, and no retriedAfter, in the approval_paid entry of a first payment", async () => {
    payInvoiceMock.mockResolvedValue({ status: "paid", txRef: "0xhash", execution: execution(), note: "", operatingBalance: 350 });
    const { fake, run } = approvalsFake();

    await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }));

    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    const detail = append.p_detail as Record<string, unknown>;
    expect(detail.attempt).toBe(1);
    expect(detail).not.toHaveProperty("retriedAfter");
  });
});

describe("approveAndPay while payments are switched off (payment safety S4)", () => {
  it("refuses a new payment before any claim", async () => {
    const { fake } = approvalsFake();

    const attempt = runWith({ config: { ...config, paymentsDisabled: true }, db: fake.client, fetch: fake.fetch }, () =>
      withOrg(ORG, () => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }))
    );
    await expect(attempt).rejects.toMatchObject({ code: "payments_off" });
    await expect(attempt).rejects.toThrow("Payments are switched off for every workspace right now.");
    expect(rpcBodies(fake.requests, "claim_invoice_decision")).toHaveLength(0);
    expect(payInvoiceMock).not.toHaveBeenCalled();
  });

  it("still records a transfer already sent, which only reads Circle (payment safety S8)", async () => {
    payInvoiceMock.mockResolvedValue({ status: "paid", txRef: "0xhash", execution: execution(), note: "", operatingBalance: 100 });
    const { fake } = approvalsFake({ intents: [{ source_id: INVOICE_ID, status: "pending", provider_tx_id: "circle-tx-1", last_error: null, provider_state: "SENT" }] });

    const result = await runWith({ config: { ...config, paymentsDisabled: true }, db: fake.client, fetch: fake.fetch }, () =>
      withOrg(ORG, () => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }))
    );

    expect(result.status).toBe("paid");
    expect(payInvoiceMock.mock.calls[0][1]).toMatchObject({ retryTerminalFailure: false });
  });
});

describe("approveAndPay after Circle ended the last attempt in a terminal failure", () => {
  const retried = () =>
    payInvoiceMock.mockResolvedValue({
      status: "paid",
      txRef: "0xhash2",
      execution: execution({
        idempotencyKey: "key-2",
        providerTxId: "circle-tx-2",
        txHash: "0xhash2",
        txRef: "0xhash2",
        attempt: 2,
        retriedAfter: { providerTxId: "circle-tx-1", providerState: "FAILED", failureReason: "INSUFFICIENT_NATIVE_TOKEN" },
      }),
      note: "",
      operatingBalance: 350,
    });

  it("pays the held invoice on attempt 2, and approval_paid records the attempt and the one it followed", async () => {
    retried();
    const { fake, run } = approvalsFake({ intents: [terminallyFailed()] });

    const result = await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }));

    expect(result).toEqual({ status: "paid", txRef: "0xhash2", note: "" });
    expect(payInvoiceMock).toHaveBeenCalledTimes(1);
    expect(payInvoiceMock.mock.calls[0][1]).toMatchObject({ retryTerminalFailure: true });
    const [lookup] = fake.requests.filter((r) => r.path === "/rest/v1/payment_intents");
    expect(lookup.params.get("select")).toContain("provider_state");

    const [update] = patchBodies(fake.requests, "/rest/v1/invoices");
    expect(update).toMatchObject({ status: "paid", tx_ref: "0xhash2" });

    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(append.p_action).toBe("approval_paid");
    expect(append.p_summary).toBe("Approved and paid 150 USDC to Acme Supplies");
    expect(append.p_detail).toEqual({
      by: ACTOR,
      invoiceId: INVOICE_ID,
      counterpartyId: COUNTERPARTY_ID,
      amount: 150,
      currency: "USDC",
      overrode: "held",
      txRef: "0xhash2",
      status: "paid",
      attempt: 2,
      retriedAfter: { providerTxId: "circle-tx-1", providerState: "FAILED", failureReason: "INSUFFICIENT_NATIVE_TOKEN" },
    });
  });

  it.each(["CANCELLED", "DENIED", "FAILED"])("runs the balance check on a retry after %s, refusing before any claim", async (state) => {
    const { fake, run } = approvalsFake({ account: () => ({ body: accountRow("40") }), intents: [terminallyFailed({ provider_state: state })] });

    const attempt = run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }));

    await expect(attempt).rejects.toMatchObject({ code: "insufficient_funds" });
    await expect(attempt).rejects.toThrow("The operating account holds 40 USDC, less than this invoice.");
    expect(rpcBodies(fake.requests, "claim_invoice_decision")).toHaveLength(0);
    expect(payInvoiceMock).not.toHaveBeenCalled();
  });

  it("reads the live balance for a retry in live mode", async () => {
    getChainProviderMock.mockReturnValue({ mode: "live", earnMode: "simulate", estimatedFeeUsd: 0.003 });
    syncOperatingBalanceMock.mockResolvedValue(30);
    const { run } = approvalsFake({ account: () => ({ body: accountRow("999") }), intents: [terminallyFailed()] });

    await expect(run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }))).rejects.toThrow(
      "The operating account holds 30 USDC, less than this invoice."
    );
    expect(syncOperatingBalanceMock).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(payInvoiceMock).not.toHaveBeenCalled();
  });

  it("confirms the shown address a retry now pays to", async () => {
    retried();
    const { fake, run } = approvalsFake({
      intents: [terminallyFailed()],
      counterparty: { id: COUNTERPARTY_ID, name: "Acme Supplies", address: "0xdead", address_changed_at: "2026-09-30T12:00:00+00:00", address_confirmed_at: null },
    });

    await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID, shownAddress: "0xdead" }));

    expect(fake.requests.filter((r) => r.path === "/rest/v1/counterparties" && r.method === "PATCH")).toHaveLength(1);
  });

  it.each([
    ["STUCK at Circle", { status: "pending", provider_tx_id: "circle-tx-1", last_error: null, provider_state: "STUCK", failure_reason: null }],
    ["recorded failed before Circle's state was kept", { status: "failed", provider_tx_id: "circle-tx-1", last_error: null, provider_state: null, failure_reason: null }],
  ] as const)("skips the balance check, as for any transfer that may still move, when the transfer is %s", async (_label, intent) => {
    // Approve and pay reads Circle before anything else: a transfer still in
    // flight is recorded, never sent again, so the balance — possibly already
    // lower by this very payment — is not the question.
    payInvoiceMock.mockResolvedValue({ status: "matched", txRef: "circle-tx-1", execution: execution({ status: "pending" }), note: "", operatingBalance: null });
    const { run } = approvalsFake({ account: () => ({ body: accountRow("40") }), intents: [{ source_id: INVOICE_ID, ...intent }] });

    await expect(run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }))).resolves.toMatchObject({ status: "matched" });
    expect(payInvoiceMock).toHaveBeenCalledTimes(1);
    // It skipped the balance check, so it may only record what Circle says, never send again.
    expect(payInvoiceMock.mock.calls[0][1]).toMatchObject({ retryTerminalFailure: false });
  });
});

/**
 * Approve and pay with the real payment step — `payInvoice`, `executePayment`
 * and the store — over the fake. A transfer the card showed as sent or in
 * flight is only reconciled by the Approve that finds it failed: that Approve
 * skipped the balance check and showed no failure. Only an Approve that
 * already knew of the terminal failure, and so checked the balance, sends a
 * new transfer.
 */
describe("approveAndPay on a transfer Circle is found to have failed", () => {
  class Circle implements ChainProvider {
    readonly mode = "live" as const;
    readonly earnMode = "simulate" as const;
    readonly estimatedFeeUsd = 0.003;
    transfers: TransferParams[] = [];
    reconciliations: string[] = [];
    reconcileResults: TransferResult[] = [];
    transferResults: TransferResult[] = [];

    async transfer(params: TransferParams): Promise<TransferResult> {
      this.transfers.push(params);
      const next = this.transferResults.shift();
      if (!next) throw new Error("missing fake transfer result");
      return next;
    }

    async reconcileTransfer(providerTxId: string): Promise<TransferResult> {
      this.reconciliations.push(providerTxId);
      const next = this.reconcileResults.shift();
      if (!next) throw new Error("missing fake reconciliation result");
      return next;
    }

    async getBalance(accountId: string): Promise<BalanceSnapshot> {
      return { accountId, chain: "ARC-TESTNET", token: "USDC", balance: 900 };
    }
    async depositToEarn(): Promise<EarnResult> { throw new Error("not used"); }
    async withdrawFromEarn(): Promise<EarnResult> { throw new Error("not used"); }
  }

  function reported(status: TransferResult["status"], providerTxId: string, state: string, reason: string | null = null): TransferResult {
    const hash = status === "confirmed" ? "0xhash2" : null;
    return {
      providerTxId, txHash: hash, txRef: hash ?? providerTxId, chain: "ARC-TESTNET", status,
      feeUsd: 0.003, feeSource: "chain_reported", providerMode: "live", settledInMs: 4000,
      providerState: state, failureReason: reason,
    };
  }

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("@/lib/agent/pay")>("@/lib/agent/pay");
    payInvoiceMock.mockImplementation(actual.payInvoice);
    syncOperatingBalanceMock.mockResolvedValue(500);
  });

  it.each([
    ["in flight (SENT)", { status: "pending", provider_state: "SENT", last_error: null }],
    [
      "recorded failed by a read of ours, Circle's last word STUCK",
      { status: "failed", provider_state: "STUCK", last_error: "no answer from Circle getTransaction during reconciliation within 15000 ms" },
    ],
  ] as const)("records it without sending when it was %s; the next Approve checks the balance and sends attempt 2", async (_label, before) => {
    const circle = new Circle();
    getChainProviderMock.mockReturnValue(circle);
    const intents = [intentRow(before)];
    const { fake, run } = approvalsFake({ intents });
    const key1 = paymentIdempotencyKey("invoice", INVOICE_ID);
    const key2 = paymentIdempotencyKey("invoice", INVOICE_ID, 2);

    // The card said Approve and pay records the payment; Circle now reports FAILED.
    circle.reconcileResults.push(reported("failed", "circle-tx-1", "FAILED", "FAILED_ON_CHAIN"));
    const first = await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }));

    expect(first.status).toBe("held");
    expect(payInvoiceMock.mock.calls[0][1]).toMatchObject({ retryTerminalFailure: false });
    expect(syncOperatingBalanceMock).not.toHaveBeenCalled();
    expect(circle.reconciliations).toEqual(["circle-tx-1"]);
    expect(rpcBodies(fake.requests, "begin_payment_retry")).toHaveLength(0);
    expect(circle.transfers).toHaveLength(0);
    expect(intents[0]).toMatchObject({
      idempotency_key: key1, transfer_attempt: 1, status: "failed", provider_state: "FAILED", failure_reason: "FAILED_ON_CHAIN", last_error: null,
    });
    expect(patchBodies(fake.requests, "/rest/v1/invoices")[0].status).toBe("held");

    // The failure is now known: the balance is checked, and a new transfer goes out under attempt 2's key.
    circle.reconcileResults.push(reported("failed", "circle-tx-1", "FAILED", "FAILED_ON_CHAIN"));
    circle.transferResults.push(reported("confirmed", "circle-tx-2", "COMPLETE"));
    const second = await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }));

    expect(second).toMatchObject({ status: "paid", txRef: "0xhash2" });
    expect(payInvoiceMock.mock.calls[1][1]).toMatchObject({ retryTerminalFailure: true });
    expect(syncOperatingBalanceMock).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(rpcBodies(fake.requests, "begin_payment_retry")).toEqual([
      { p_org_id: ORG, p_source_type: "invoice", p_source_id: INVOICE_ID, p_expected_key: key1, p_new_key: key2 },
    ]);
    expect(circle.transfers.map((sent) => sent.idempotencyKey)).toEqual([key2]);
    expect(intents[0]).toMatchObject({ idempotency_key: key2, transfer_attempt: 2, status: "confirmed", provider_tx_id: "circle-tx-2" });

    const paid = rpcBodies(fake.requests, "append_ledger_entry").filter((body) => body.p_action === "approval_paid");
    expect(paid.map((body) => (body.p_detail as Record<string, unknown>).attempt)).toEqual([1, 2]);
    expect((paid[0].p_detail as Record<string, unknown>)).not.toHaveProperty("retriedAfter");
    expect((paid[1].p_detail as Record<string, unknown>).retriedAfter).toEqual({
      providerTxId: "circle-tx-1", providerState: "FAILED", failureReason: "FAILED_ON_CHAIN",
    });
  });

  it("refuses the second Approve for funds before any claim, once the failure it found is known", async () => {
    const circle = new Circle();
    getChainProviderMock.mockReturnValue(circle);
    const intents = [intentRow({ status: "pending", provider_state: "SENT" })];
    const { fake, run } = approvalsFake({ intents });

    circle.reconcileResults.push(reported("failed", "circle-tx-1", "FAILED", "INSUFFICIENT_NATIVE_TOKEN"));
    await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }));
    const claimsAfterFirst = rpcBodies(fake.requests, "claim_invoice_decision").length;

    syncOperatingBalanceMock.mockResolvedValue(40);
    await expect(run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }))).rejects.toMatchObject({ code: "insufficient_funds" });
    expect(rpcBodies(fake.requests, "claim_invoice_decision")).toHaveLength(claimsAfterFirst);
    expect(rpcBodies(fake.requests, "begin_payment_retry")).toHaveLength(0);
    expect(circle.transfers).toHaveLength(0);
  });
});

/**
 * A person's Approve and pay applies the invoice's early-payment discount
 * exactly as the agent does, because it goes through the same `payInvoice`
 * (spec 2026-09-30-payment-timing §1): discounted through the end of the
 * deadline's UTC day, the full amount after it. The funds check stays on the
 * full amount (P5: never less).
 */
describe("approveAndPay with an early-payment discount", () => {
  const TERMS = { early_pay_discount_pct: "2.00", discount_due_date: "2026-10-11T12:00:00+00:00" };
  const withTerms = (r: RecordedRequest) => (r.params.get("id") ? { body: invoiceRow(TERMS) } : undefined);

  class Circle implements ChainProvider {
    readonly mode = "live" as const;
    readonly earnMode = "simulate" as const;
    readonly estimatedFeeUsd = 0.003;
    transfers: TransferParams[] = [];
    async transfer(params: TransferParams): Promise<TransferResult> {
      this.transfers.push(params);
      return {
        providerTxId: "circle-tx-9", txHash: "0xhash9", txRef: "0xhash9", chain: "ARC-TESTNET", status: "confirmed",
        feeUsd: 0.003, feeSource: "chain_reported", providerMode: "live", settledInMs: 4000, providerState: "COMPLETE", failureReason: null,
      };
    }
    async reconcileTransfer(): Promise<TransferResult> { throw new Error("not used"); }
    async getBalance(accountId: string): Promise<BalanceSnapshot> {
      return { accountId, chain: "ARC-TESTNET", token: "USDC", balance: 500 };
    }
    async depositToEarn(): Promise<EarnResult> { throw new Error("not used"); }
    async withdrawFromEarn(): Promise<EarnResult> { throw new Error("not used"); }
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the terms with the invoice, passes the discount to payInvoice, and records what it took", async () => {
    payInvoiceMock.mockResolvedValue({ status: "paid", txRef: "0xhash", execution: null, note: "", operatingBalance: 353, amountPaid: 147, discountTaken: 3 });
    const { fake, run } = approvalsFake({ invoice: withTerms });

    await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }));

    const [load] = fake.requests.filter((r) => r.path === "/rest/v1/invoices" && r.method === "GET");
    expect(load.params.get("select")).toContain("early_pay_discount_pct");
    expect(load.params.get("select")).toContain("discount_due_date");
    expect(payInvoiceMock.mock.calls[0][0]).toEqual({
      invoiceId: INVOICE_ID, counterpartyId: COUNTERPARTY_ID, address: "0xdead", amount: 150,
      discount: { pct: 2, deadline: "2026-10-11T12:00:00+00:00" }, currency: "USDC",
    });

    const [update] = patchBodies(fake.requests, "/rest/v1/invoices");
    expect(update.status).toBe("paid");
    expect(update.paid_amount).toBe(147);

    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(append.p_action).toBe("approval_paid");
    expect(append.p_summary).toBe("Approved and paid 147 USDC to Acme Supplies (150 USDC less a 3 USDC early-payment discount)");
    expect(append.p_detail).toMatchObject({ amount: 150, amountPaid: 147, discountTaken: 3, status: "paid" });
  });

  it("records no paid amount when the transfer failed", async () => {
    payInvoiceMock.mockResolvedValue({
      status: "held", txRef: "circle-tx-1", execution: null, note: " [transfer failed: provider reported failure]", operatingBalance: null, amountPaid: 147, discountTaken: 3,
    });
    const { fake, run } = approvalsFake({ invoice: withTerms });

    await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }));

    const [update] = patchBodies(fake.requests, "/rest/v1/invoices");
    expect(update.status).toBe("held");
    expect(update.paid_amount).toBeNull();
    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(append.p_detail).toMatchObject({ amountPaid: null, discountTaken: null, status: "held" });
  });

  it("still checks the funds against the full amount, never the discounted one", async () => {
    // 148 USDC covers the 147 USDC that would leave, but not the invoice.
    const { fake, run } = approvalsFake({ invoice: withTerms, account: () => ({ body: accountRow("148") }) });

    await expect(run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }))).rejects.toMatchObject({ code: "insufficient_funds" });
    expect(rpcBodies(fake.requests, "claim_invoice_decision")).toHaveLength(0);
    expect(payInvoiceMock).not.toHaveBeenCalled();
  });

  it("transfers the discounted amount through the real payment step within the deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-11T18:00:00.000Z"));
    const actual = await vi.importActual<typeof import("@/lib/agent/pay")>("@/lib/agent/pay");
    payInvoiceMock.mockImplementation(actual.payInvoice);
    syncOperatingBalanceMock.mockResolvedValue(500);
    const circle = new Circle();
    getChainProviderMock.mockReturnValue(circle);
    const { fake, run } = approvalsFake({ invoice: withTerms });

    const result = await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }));

    expect(result.status).toBe("paid");
    expect(circle.transfers).toHaveLength(1);
    expect(circle.transfers[0].amount).toBe(147);
    const [update] = patchBodies(fake.requests, "/rest/v1/invoices");
    expect(update.paid_amount).toBe(147);
    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(append.p_detail).toMatchObject({ amount: 150, amountPaid: 147, discountTaken: 3 });
  });

  it("transfers the full amount through the real payment step after the deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-12T00:00:01.000Z"));
    const actual = await vi.importActual<typeof import("@/lib/agent/pay")>("@/lib/agent/pay");
    payInvoiceMock.mockImplementation(actual.payInvoice);
    syncOperatingBalanceMock.mockResolvedValue(500);
    const circle = new Circle();
    getChainProviderMock.mockReturnValue(circle);
    const { fake, run } = approvalsFake({ invoice: withTerms });

    await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }));

    expect(circle.transfers[0].amount).toBe(150);
    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(append.p_summary).toBe("Approved and paid 150 USDC to Acme Supplies");
    expect(append.p_detail).toMatchObject({ amount: 150, amountPaid: 150, discountTaken: 0 });
  });
});

describe("rejectInvoice", () => {
  it("claims with reject, sets rejected, and appends approval_rejected with the trimmed reason", async () => {
    const { fake, run } = approvalsFake();

    await run(() => rejectInvoice({ actorId: ACTOR, invoiceId: INVOICE_ID, reason: `  ${"x".repeat(300)}  ` }));

    const [claim] = rpcBodies(fake.requests, "claim_invoice_decision");
    expect(claim).toEqual({ p_org_id: ORG, p_invoice_id: INVOICE_ID, p_by: ACTOR, p_decision: "reject" });

    const [update] = patchBodies(fake.requests, "/rest/v1/invoices");
    expect(update.status).toBe("rejected");
    expect(typeof update.decided_at).toBe("string");

    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(append.p_action).toBe("approval_rejected");
    const detail = append.p_detail as Record<string, unknown>;
    expect(detail).toEqual({ by: ACTOR, invoiceId: INVOICE_ID, reason: "x".repeat(280) });
  });

  it("omits reason from the ledger detail when none is given", async () => {
    const { fake, run } = approvalsFake();

    await run(() => rejectInvoice({ actorId: ACTOR, invoiceId: INVOICE_ID }));

    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(append.p_detail).toEqual({ by: ACTOR, invoiceId: INVOICE_ID });
  });

  it("names the surface and its link when the decision did not come from the console", async () => {
    const { fake, run } = approvalsFake();

    await run(() => rejectInvoice({ actorId: ACTOR, invoiceId: INVOICE_ID, provenance: { via: "slack", linkId: "link-1" } }));

    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(append.p_detail).toEqual({ by: ACTOR, invoiceId: INVOICE_ID, via: "slack", linkId: "link-1" });
  });

  it("maps a claim race to already_decided and writes nothing", async () => {
    const { fake, run } = approvalsFake({
      claim: () => ({ status: 400, body: { code: "P0001", message: "already_decided: the invoice is paid now", details: null, hint: null } }),
    });

    await expect(run(() => rejectInvoice({ actorId: ACTOR, invoiceId: INVOICE_ID }))).rejects.toThrow(
      "Someone else decided this invoice a moment ago."
    );
    expect(patchBodies(fake.requests, "/rest/v1/invoices")).toHaveLength(0);
    expect(rpcBodies(fake.requests, "append_ledger_entry")).toHaveLength(0);
  });

  it.each([
    ["confirmed", { status: "confirmed", provider_tx_id: "circle-tx-1", last_error: null }],
    ["pending", { status: "pending", provider_tx_id: "circle-tx-1", last_error: null }],
    ["submitting", { status: "submitting", provider_tx_id: null, last_error: null }],
    ["unreadable at the provider", { status: "failed", provider_tx_id: "circle-tx-1", last_error: "provider unreachable" }],
    ["STUCK at Circle", { status: "pending", provider_tx_id: "circle-tx-1", last_error: null, provider_state: "STUCK" }],
    ["recorded failed while Circle's last word was STUCK", { status: "failed", provider_tx_id: "circle-tx-1", last_error: null, provider_state: "STUCK" }],
    ["recorded failed before Circle's state was kept", { status: "failed", provider_tx_id: "circle-tx-1", last_error: null, provider_state: null }],
  ] as const)("refuses with payment_in_flight, before any claim, when the payment is %s", async (_label, intent) => {
    const { fake, run } = approvalsFake({ intents: [{ source_id: INVOICE_ID, ...intent }] });

    const attempt = run(() => rejectInvoice({ actorId: ACTOR, invoiceId: INVOICE_ID }));
    await expect(attempt).rejects.toBeInstanceOf(ApprovalError);
    await expect(attempt).rejects.toMatchObject({ code: "payment_in_flight" });
    await expect(attempt).rejects.toThrow("A payment for this invoice was already sent. Approve and pay records it.");
    expect(rpcBodies(fake.requests, "claim_invoice_decision")).toHaveLength(0);
    expect(patchBodies(fake.requests, "/rest/v1/invoices")).toHaveLength(0);
  });

  it.each(["CANCELLED", "DENIED", "FAILED"])("still rejects when Circle ended the transfer %s", async (state) => {
    const { fake, run } = approvalsFake({ intents: [terminallyFailed({ provider_state: state })] });

    await run(() => rejectInvoice({ actorId: ACTOR, invoiceId: INVOICE_ID }));

    expect(rpcBodies(fake.requests, "claim_invoice_decision")).toHaveLength(1);
    expect(patchBodies(fake.requests, "/rest/v1/invoices")[0].status).toBe("rejected");
  });

  it("logs by invoice id and action, and rethrows, when the update after the claim fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { fake, run } = approvalsFake({ invoicePatch: () => ({ status: 500, body: { message: "invoices update failed: connection reset" } }) });

    await expect(run(() => rejectInvoice({ actorId: ACTOR, invoiceId: INVOICE_ID }))).rejects.toThrow("invoices update failed: connection reset");

    expect(error).toHaveBeenCalledWith("approval: invoice update failed after the claim", INVOICE_ID, "reject");
    expect(rpcBodies(fake.requests, "append_ledger_entry")).toHaveLength(0);
    error.mockRestore();
  });
});

describe("returnInvoice", () => {
  it("refuses with payment_in_flight, before any claim, when the transfer is confirmed", async () => {
    const { fake, run } = approvalsFake({ intents: [{ source_id: INVOICE_ID, status: "confirmed", provider_tx_id: "circle-tx-1", last_error: null }] });

    await expect(run(() => returnInvoice({ actorId: ACTOR, invoiceId: INVOICE_ID }))).rejects.toMatchObject({ code: "payment_in_flight" });
    expect(rpcBodies(fake.requests, "claim_invoice_decision")).toHaveLength(0);
    expect(patchBodies(fake.requests, "/rest/v1/invoices")).toHaveLength(0);
  });

  it.each([
    ["STUCK at Circle", { status: "pending", provider_tx_id: "circle-tx-1", last_error: null, provider_state: "STUCK" }],
    ["recorded failed while Circle's last word was STUCK", { status: "failed", provider_tx_id: "circle-tx-1", last_error: null, provider_state: "STUCK" }],
    ["recorded failed before Circle's state was kept", { status: "failed", provider_tx_id: "circle-tx-1", last_error: null, provider_state: null }],
  ] as const)("refuses with payment_in_flight, before any claim, when the transfer is %s", async (_label, intent) => {
    const { fake, run } = approvalsFake({ intents: [{ source_id: INVOICE_ID, ...intent }] });

    await expect(run(() => returnInvoice({ actorId: ACTOR, invoiceId: INVOICE_ID }))).rejects.toMatchObject({ code: "payment_in_flight" });
    expect(rpcBodies(fake.requests, "claim_invoice_decision")).toHaveLength(0);
    expect(patchBodies(fake.requests, "/rest/v1/invoices")).toHaveLength(0);
  });

  it("still returns an invoice whose transfer Circle ended FAILED", async () => {
    const { fake, run } = approvalsFake({ intents: [terminallyFailed()] });

    await run(() => returnInvoice({ actorId: ACTOR, invoiceId: INVOICE_ID }));

    expect(patchBodies(fake.requests, "/rest/v1/invoices")[0].status).toBe("pending");
  });

  it("still returns an invoice with no payment intent", async () => {
    const { fake, run } = approvalsFake();

    await run(() => returnInvoice({ actorId: ACTOR, invoiceId: INVOICE_ID }));

    expect(patchBodies(fake.requests, "/rest/v1/invoices")[0].status).toBe("pending");
  });

  it("logs by invoice id and action, and rethrows, when the update after the claim fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { fake, run } = approvalsFake({ invoicePatch: () => ({ status: 500, body: { message: "invoices update failed: connection reset" } }) });

    await expect(run(() => returnInvoice({ actorId: ACTOR, invoiceId: INVOICE_ID }))).rejects.toThrow("invoices update failed: connection reset");

    expect(error).toHaveBeenCalledWith("approval: invoice update failed after the claim", INVOICE_ID, "return");
    expect(rpcBodies(fake.requests, "append_ledger_entry")).toHaveLength(0);
    error.mockRestore();
  });

  it("claims with return, resets the invoice to pending, and appends approval_returned", async () => {
    const { fake, run } = approvalsFake();

    await run(() => returnInvoice({ actorId: ACTOR, invoiceId: INVOICE_ID }));

    const [claim] = rpcBodies(fake.requests, "claim_invoice_decision");
    expect(claim).toEqual({ p_org_id: ORG, p_invoice_id: INVOICE_ID, p_by: ACTOR, p_decision: "return" });

    const [update] = patchBodies(fake.requests, "/rest/v1/invoices");
    expect(update).toEqual({ status: "pending", decided_at: null, escalated_at: null, notified_at: null });

    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(append.p_action).toBe("approval_returned");
    expect(append.p_detail).toEqual({ by: ACTOR, invoiceId: INVOICE_ID });
  });

  it("clears notified_at, so a returned payable is news again if the agent re-holds it", async () => {
    const { fake, run } = approvalsFake();

    await run(() => returnInvoice({ actorId: ACTOR, invoiceId: INVOICE_ID }));

    const [update] = patchBodies(fake.requests, "/rest/v1/invoices");
    expect(update).toMatchObject({ notified_at: null });
  });

  it("names the surface and its link when the return did not come from the console", async () => {
    const { fake, run } = approvalsFake();

    await run(() => returnInvoice({ actorId: ACTOR, invoiceId: INVOICE_ID, provenance: { via: "slack", linkId: "link-1" } }));

    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(append.p_detail).toEqual({ by: ACTOR, invoiceId: INVOICE_ID, via: "slack", linkId: "link-1" });
  });

  it("maps self-approval from the claim to self_approval", async () => {
    const { run } = approvalsFake({
      claim: () => ({ status: 400, body: { code: "P0001", message: "self_approval: the person who created an invoice cannot approve it", details: null, hint: null } }),
    });
    await expect(run(() => returnInvoice({ actorId: ACTOR, invoiceId: INVOICE_ID }))).rejects.toThrow(
      "You created this invoice, so someone else must approve it."
    );
  });
});

/** An invoice's intent whose send Circle never answered: no provider id, and the provider's own words for it (payment safety R1). */
function unanswered(overrides: Record<string, unknown> = {}) {
  return intentRow({
    status: "failed",
    provider_tx_id: null,
    last_error: "Circle did not answer createTransaction within 20000 ms; the transfer may or may not have been accepted",
    provider_state: null,
    failure_reason: null,
    updated_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    ...overrides,
  });
}

/** A live provider that can look a send up (payment safety R4): `found` is what Circle lists for it. */
function lookingProvider(found: TransferResult | null) {
  const findTransferByRef = vi.fn(async () => found);
  getChainProviderMock.mockReturnValue({ mode: "live", earnMode: "simulate", estimatedFeeUsd: 0.003, findTransferByRef });
  return findTransferByRef;
}

describe("a payment Circle never answered (payment safety R1)", () => {
  it("may exist under its key, so it is possibly sent, with its own last attempt; but sending it again may be a new payment", () => {
    const intent = unanswered();

    expect(transferUnknown(intent)).toBe(true);
    expect(paymentWasSent(intent)).toBe(true);
    // Not a transfer that exists: sent again under its key, it is a new payment when Circle never had it, and is
    // checked as one, all but the balance it may already have lowered.
    expect(transferExists(intent)).toBe(false);
    expect(lastAttemptOf(intent)).toEqual({ state: "unanswered" });
  });

  it.each([
    ["failed before Circle took it", "Counterparty has no on-chain address (sim:acme). Add this counterparty's Arc address on the Counterparties page."],
    ["refused by Circle with a reason", "the asset amount owned by the wallet is insufficient for the transaction"],
    ["failed with no error recorded", null],
  ])("is an ordinary failure, nothing sent, when the send %s", (_label, last_error) => {
    const intent = unanswered({ last_error });

    expect(transferUnknown(intent)).toBe(false);
    expect(paymentWasSent(intent)).toBe(false);
    expect(transferExists(intent)).toBe(false);
    expect(lastAttemptOf(intent)).toBeNull();
  });

  it("is known once Circle gave the attempt an id", () => {
    expect(transferUnknown(unanswered({ provider_tx_id: "circle-tx-1", provider_state: "FAILED" }))).toBe(false);
    expect(transferUnknown(unanswered({ status: "submitting" }))).toBe(false);
    expect(transferUnknown(null)).toBe(false);
  });

  it("looks for it on Circle first, and refuses Reject, saying when to try again, while Circle has not listed it (R6)", async () => {
    const findTransferByRef = lookingProvider(null);
    const sentAt = new Date(Date.now() - 5 * 60_000);
    const { fake, run } = approvalsFake({ intents: [unanswered({ updated_at: sentAt.toISOString() })] });

    const attempt = run(() => rejectInvoice({ actorId: ACTOR, invoiceId: INVOICE_ID }));
    await expect(attempt).rejects.toBeInstanceOf(ApprovalError);
    await expect(attempt).rejects.toMatchObject({ code: "payment_unknown" });
    const at = new Date(sentAt.getTime() + 15 * 60_000).toISOString().slice(11, 16);
    await expect(attempt).rejects.toThrow(
      `Circle did not answer when this invoice's payment was sent, and has not listed it yet. Try again from ${at} UTC: by then Vestiarion can tell whether Circle took it.`
    );
    expect(findTransferByRef).toHaveBeenCalledWith(ACCOUNT_ID, `Invoice ${INVOICE_ID}`, expect.anything(), expect.anything());
    expect(rpcBodies(fake.requests, "claim_invoice_decision")).toHaveLength(0);
    expect(patchBodies(fake.requests, "/rest/v1/invoices")).toHaveLength(0);
  });

  it("rejects once Circle has listed nothing 15 minutes after the send, recording that nothing was sent (R6)", async () => {
    lookingProvider(null);
    const { fake, run } = approvalsFake({ intents: [unanswered({ updated_at: new Date(Date.now() - 20 * 60_000).toISOString() })] });

    await run(() => rejectInvoice({ actorId: ACTOR, invoiceId: INVOICE_ID }));

    expect(patchBodies(fake.requests, "/rest/v1/payment_intents")[0]).toMatchObject({
      status: "failed",
      last_error: "Circle has no transfer for this payment's earlier send; nothing was sent.",
    });
    expect(patchBodies(fake.requests, "/rest/v1/invoices")[0].status).toBe("rejected");
  });

  it("records the transfer Circle has, and refuses Reject as a payment already sent (R6)", async () => {
    lookingProvider({
      providerTxId: "circle-tx-7", txHash: null, txRef: "circle-tx-7", chain: "ARC-TESTNET", status: "pending", feeUsd: 0.003,
      feeSource: "provider_estimate", providerMode: "live", settledInMs: null, providerState: "SENT", failureReason: null,
    });
    const { fake, run } = approvalsFake({ intents: [unanswered()] });

    await expect(run(() => rejectInvoice({ actorId: ACTOR, invoiceId: INVOICE_ID }))).rejects.toMatchObject({ code: "payment_in_flight" });
    expect(patchBodies(fake.requests, "/rest/v1/payment_intents")[0]).toMatchObject({ provider_tx_id: "circle-tx-7", status: "pending" });
    expect(rpcBodies(fake.requests, "claim_invoice_decision")).toHaveLength(0);
  });

  it("refuses Return with payment_unknown, before any claim", async () => {
    const { fake, run } = approvalsFake({ intents: [unanswered()] });

    await expect(run(() => returnInvoice({ actorId: ACTOR, invoiceId: INVOICE_ID }))).rejects.toMatchObject({ code: "payment_unknown" });
    expect(rpcBodies(fake.requests, "claim_invoice_decision")).toHaveLength(0);
    expect(patchBodies(fake.requests, "/rest/v1/invoices")).toHaveLength(0);
  });

  it("refuses added details with payment_unknown, writing nothing", async () => {
    const { fake, run } = approvalsFake({ intents: [unanswered()] });

    await expect(run(() => addInvoiceDetails({ actorId: ACTOR, invoiceId: INVOICE_ID, poReference: "PO-100", goodsReceived: true }))).rejects.toMatchObject({
      code: "payment_unknown",
    });
    expect(patchBodies(fake.requests, "/rest/v1/invoices")).toHaveLength(0);
  });

  it("still rejects an invoice whose send failed before Circle took it", async () => {
    const { fake, run } = approvalsFake({ intents: [unanswered({ last_error: "Counterparty has no on-chain address (sim:acme)." })] });

    await run(() => rejectInvoice({ actorId: ACTOR, invoiceId: INVOICE_ID }));

    expect(patchBodies(fake.requests, "/rest/v1/invoices")[0].status).toBe("rejected");
  });

  it("confirms the shown address it pays to, since sending it again may be a new payment", async () => {
    payInvoiceMock.mockResolvedValue({ status: "paid", txRef: "0xhash", execution: execution(), note: "", operatingBalance: 0 });
    const { fake, run } = approvalsFake({
      intents: [unanswered()],
      counterparty: { id: COUNTERPARTY_ID, name: "Acme Supplies", address: "0xdead", address_changed_at: "2026-09-30T12:00:00+00:00", address_confirmed_at: null },
    });

    await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID, shownAddress: "0xdead" }));

    expect(fake.requests.filter((r) => r.path === "/rest/v1/counterparties" && r.method === "PATCH")).toHaveLength(1);
  });

  it("approves it without the balance check, which the transfer may already have lowered, and never as a retry of a failure", async () => {
    payInvoiceMock.mockResolvedValue({ status: "paid", txRef: "0xhash", execution: execution(), note: "", operatingBalance: 0 });
    const { run } = approvalsFake({ account: () => ({ body: accountRow("40") }), intents: [unanswered()] });

    await expect(run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }))).resolves.toMatchObject({ status: "paid" });
    expect(payInvoiceMock).toHaveBeenCalledTimes(1);
    expect(payInvoiceMock.mock.calls[0][1]).toMatchObject({ retryTerminalFailure: false });
  });

  it("lists it as possibly sent, its last attempt unanswered", async () => {
    const { run } = approvalsFake({ intents: [unanswered()] });

    const [row] = await run(() => listWaitingPayables());

    expect(row).toMatchObject({ paymentSent: true, lastAttempt: { state: "unanswered" } });
  });
});

describe("addInvoiceDetails", () => {
  /** The compare-and-set matched the payable. */
  const WRITTEN = { invoicePatch: () => ({ body: [{ id: INVOICE_ID }] }) };
  const loaded = (row: Record<string, unknown>) => (request: RecordedRequest) =>
    request.params.get("id") ? { body: invoiceRow(row) } : undefined;
  const invoicePatch = (requests: RecordedRequest[]) => requests.find((r) => r.path === "/rest/v1/invoices" && r.method === "PATCH");

  it("adds the missing purchase order and goods receipt while the payable still waits, and records what it added", async () => {
    const { fake, run } = approvalsFake(WRITTEN);

    const added = await run(() => addInvoiceDetails({ actorId: ACTOR, invoiceId: INVOICE_ID, poReference: "PO-100", goodsReceived: true }));

    expect(added).toEqual({ poReference: "PO-100", goodsReceived: true });
    const patch = invoicePatch(fake.requests)!;
    // reviewed_by marks a person's hand on it, so /open never counts its payment as untouched (R5).
    expect(patch.body).toEqual({ po_reference: "PO-100", goods_received: true, reviewed_by: ACTOR, reviewed_at: expect.any(String) });
    expect(patch.params.get("id")).toBe(`eq.${INVOICE_ID}`);
    expect(patch.params.get("status")).toBe("in.(held,flagged,awaiting_info)");
    // Only an empty purchase order is filled, and only goods not received are marked received (R2, R3).
    expect(patch.params.get("po_reference")).toBe("is.null");
    expect(patch.params.get("goods_received")).toBe("eq.false");
    // Adding details decides nothing: no claim, no status. The agent's follow-up reopens it on the changed facts (R4).
    expect(patch.body).not.toHaveProperty("status");
    expect(rpcBodies(fake.requests, "claim_invoice_decision")).toHaveLength(0);

    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(append).toMatchObject({ p_actor: "human", p_domain: "ap", p_action: "invoice_details_added" });
    expect(append.p_summary).toBe("Added purchase order PO-100 and goods received to an invoice from Acme Supplies for 150 USDC");
    // No `observed`: the follow-up and the card read the decision's facts from the decision's own entry (R5).
    expect(append.p_detail).toEqual({
      by: ACTOR,
      invoiceId: INVOICE_ID,
      counterpartyId: COUNTERPARTY_ID,
      added: { poReference: "PO-100", goodsReceived: true },
    });
  });

  it("adds only what is missing: a purchase order on file stays as it is", async () => {
    const { fake, run } = approvalsFake({ ...WRITTEN, invoice: loaded({ po_reference: "PO-7", goods_received: false }) });

    const added = await run(() => addInvoiceDetails({ actorId: ACTOR, invoiceId: INVOICE_ID, poReference: "PO-9", goodsReceived: true }));

    expect(added).toEqual({ goodsReceived: true });
    const patch = invoicePatch(fake.requests)!;
    expect(patch.body).toEqual({ goods_received: true, reviewed_by: ACTOR, reviewed_at: expect.any(String) });
    expect(patch.params.get("po_reference")).toBeNull();
    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(append.p_summary).toBe("Added goods received to an invoice from Acme Supplies for 150 USDC");
    expect(append.p_detail).toMatchObject({ added: { goodsReceived: true } });
  });

  it("adds a purchase order alone, trimmed, and leaves goods not received", async () => {
    const { fake, run } = approvalsFake(WRITTEN);

    const added = await run(() => addInvoiceDetails({ actorId: ACTOR, invoiceId: INVOICE_ID, poReference: "  PO-100 ", goodsReceived: false }));

    expect(added).toEqual({ poReference: "PO-100" });
    const patch = invoicePatch(fake.requests)!;
    expect(patch.body).toEqual({ po_reference: "PO-100", reviewed_by: ACTOR, reviewed_at: expect.any(String) });
    expect(patch.params.get("goods_received")).toBeNull();
    expect(rpcBodies(fake.requests, "append_ledger_entry")[0].p_summary).toBe("Added purchase order PO-100 to an invoice from Acme Supplies for 150 USDC");
  });

  it("names the invoice's own currency", async () => {
    const { fake, run } = approvalsFake({ ...WRITTEN, invoice: loaded({ currency: "EURC" }) });

    await run(() => addInvoiceDetails({ actorId: ACTOR, invoiceId: INVOICE_ID, poReference: null, goodsReceived: true }));

    expect(rpcBodies(fake.requests, "append_ledger_entry")[0].p_summary).toBe("Added goods received to an invoice from Acme Supplies for 150 EURC");
  });

  it.each([
    ["nothing was given", {}, { poReference: null, goodsReceived: false }],
    ["only a blank purchase order was given", {}, { poReference: "   ", goodsReceived: false }],
    ["both are already on file", { po_reference: "PO-7", goods_received: true }, { poReference: "PO-9", goodsReceived: true }],
  ] as const)("refuses with nothing_to_add, writing nothing, when %s", async (_label, row, input) => {
    const { fake, run } = approvalsFake({ ...WRITTEN, invoice: loaded(row) });

    await expect(run(() => addInvoiceDetails({ actorId: ACTOR, invoiceId: INVOICE_ID, ...input }))).rejects.toMatchObject({
      code: "nothing_to_add",
      message: "Enter a PO reference or tick Goods or services received.",
    });
    expect(patchBodies(fake.requests, "/rest/v1/invoices")).toHaveLength(0);
    expect(rpcBodies(fake.requests, "append_ledger_entry")).toHaveLength(0);
  });

  it("refuses with payment_in_flight, writing nothing, when a payment was sent", async () => {
    const { fake, run } = approvalsFake({ ...WRITTEN, intents: [{ source_id: INVOICE_ID, status: "confirmed", provider_tx_id: "circle-tx-1", last_error: null }] });

    await expect(run(() => addInvoiceDetails({ actorId: ACTOR, invoiceId: INVOICE_ID, poReference: "PO-100", goodsReceived: true }))).rejects.toMatchObject({
      code: "payment_in_flight",
    });
    expect(patchBodies(fake.requests, "/rest/v1/invoices")).toHaveLength(0);
  });

  it("refuses with invoice_changed while someone is deciding it", async () => {
    const { fake, run } = approvalsFake({ ...WRITTEN, invoice: loaded({ status: "processing", reviewed_at: new Date().toISOString() }) });

    await expect(run(() => addInvoiceDetails({ actorId: ACTOR, invoiceId: INVOICE_ID, poReference: "PO-100", goodsReceived: true }))).rejects.toMatchObject({
      code: "invoice_changed",
    });
    expect(patchBodies(fake.requests, "/rest/v1/invoices")).toHaveLength(0);
  });

  it("refuses with invoice_not_found for a payable that no longer waits", async () => {
    const { fake, run } = approvalsFake({ ...WRITTEN, invoice: loaded({ status: "paid" }) });

    await expect(run(() => addInvoiceDetails({ actorId: ACTOR, invoiceId: INVOICE_ID, poReference: "PO-100", goodsReceived: true }))).rejects.toMatchObject({
      code: "invoice_not_found",
    });
    expect(patchBodies(fake.requests, "/rest/v1/invoices")).toHaveLength(0);
  });

  it("refuses with invoice_changed, recording nothing, when the payable changed before the write", async () => {
    // The default PATCH reply is no row: someone decided it, or added the same detail, in between.
    const { fake, run } = approvalsFake();

    await expect(run(() => addInvoiceDetails({ actorId: ACTOR, invoiceId: INVOICE_ID, poReference: "PO-100", goodsReceived: true }))).rejects.toMatchObject({
      code: "invoice_changed",
      message: "This invoice changed a moment ago. Reload the page to see it.",
    });
    expect(rpcBodies(fake.requests, "append_ledger_entry")).toHaveLength(0);
  });

  it("rethrows a failed write, recording nothing", async () => {
    const { fake, run } = approvalsFake({ invoicePatch: () => ({ status: 500, body: { message: "invoices update failed: connection reset" } }) });

    await expect(run(() => addInvoiceDetails({ actorId: ACTOR, invoiceId: INVOICE_ID, poReference: "PO-100", goodsReceived: true }))).rejects.toThrow(
      "invoices update failed: connection reset"
    );
    expect(rpcBodies(fake.requests, "append_ledger_entry")).toHaveLength(0);
  });

  it("still reports what it added when the ledger append fails afterwards", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { run } = approvalsFake({ ...WRITTEN, ledgerFails: true });

    await expect(run(() => addInvoiceDetails({ actorId: ACTOR, invoiceId: INVOICE_ID, poReference: "PO-100", goodsReceived: false }))).resolves.toEqual({
      poReference: "PO-100",
    });
    error.mockRestore();
  });
});

describe("listWaitingPayables", () => {
  it("lists payables in a waiting status, ordered by due date, with the counterparty joined in", async () => {
    const { fake, run } = approvalsFake();

    const rows = await run(() => listWaitingPayables());

    expect(rows).toEqual([
      {
        id: INVOICE_ID,
        counterpartyId: COUNTERPARTY_ID,
        counterpartyName: "Acme Supplies",
        riskLevel: "medium",
        amount: 150,
        dueDate: "2026-10-05",
        status: "held",
        reasoning: "Held for manual review: over the daily limit.",
        explanation: "Held for manual review: over the daily limit.",
        decidedAt: null,
        createdBy: CREATOR,
        reviewedAt: null,
        reclaimable: false,
        paymentSent: false,
        address: "0xdead",
        lastAttempt: null,
        discount: null,
        currency: "USDC",
        payeeChain: "ARC-TESTNET",
        bridgeFeeUsdc: null,
        poReference: null,
        goodsReceived: false,
        addedSinceDecision: null,
        guardrailRule: null,
      },
    ]);
    const listing = fake.requests.find((r) => r.path === "/rest/v1/invoices" && r.method === "GET" && !r.params.get("id"));
    expect(listing?.params.get("select")).toContain("currency");
    expect(listing?.params.get("direction")).toBe("eq.payable");
    expect(listing?.params.get("status")).toBe("in.(held,flagged,awaiting_info,processing)");
    expect(listing?.params.get("order")).toBe("due_date.asc");
  });

  it("explains reasoning that reads as a log from the facts its decision recorded, as a person reads it (plain reasoning R2)", async () => {
    const technical = "Counterparty is riskLevel 'clear'; goodsReceived is true and duplicateMatchesTotal 0. [guardrail override: counterparty is high risk — pay refused before execution]";
    const entry = {
      seq: 9, id: "e9", ts: "2026-10-05T08:00:00Z", actor: "agent", domain: "ap", action: "ap_pay", summary: "",
      detail: { invoiceId: INVOICE_ID, decision: { action: "pay" }, observed: { riskLevel: "medium", paymentLimit: 200, operatingBalance: 500, duplicateCheck: { matchesTotal: 0 } } },
      body_hash: "00", signature: "00", prev_hash: null, hash: "00", signing_key_id: null,
    };
    const { run } = approvalsFake({
      invoice: (r) => (r.params.get("id") ? undefined : { body: [invoiceRow({ agent_reasoning: technical, po_reference: "PO-7", goods_received: true })] }),
      ledgerTargets: [entry],
    });
    const listed = await run(() => listWaitingPayables());
    // What was stored stays as it was; only what a person reads changes.
    expect(listed[0].reasoning).toBe(technical);
    expect(listed[0].explanation).toBe(
      "This invoice was due on the day the agent decided it. Acme Supplies has a screening match to review, and 150.00 USDC is within its 200.00 USDC limit. " +
        "The purchase order PO-7 is on file and the goods were received. The operating wallet holds enough USDC to pay it. " +
        "No duplicate or high-risk signals were found. The agent decided to pay it. Not paid: the counterparty is high risk."
    );
  });

  it("carries the facts on file, and what a person added since the agent stopped it (complete held invoice R6)", async () => {
    const decision = {
      seq: 9, id: "e9", ts: "2026-10-03T08:00:00Z", actor: "agent", domain: "ap", action: "ap_request_info", summary: "",
      detail: {
        invoiceId: INVOICE_ID,
        decision: { action: "request_info" },
        observed: { riskLevel: "clear", paymentLimit: 200, poReference: null, goodsReceived: false },
      },
      body_hash: "00", signature: "00", prev_hash: null, hash: "00", signing_key_id: null,
    };
    const added = {
      ...decision,
      seq: 10, id: "e10", actor: "human", action: "invoice_details_added",
      detail: { by: ACTOR, invoiceId: INVOICE_ID, counterpartyId: COUNTERPARTY_ID, added: { poReference: "PO-100", goodsReceived: true } },
    };
    const technical = "Cannot complete a three-way match: purchase order missing, goods received false. poReference is null.";
    const { run } = approvalsFake({
      invoice: (r) =>
        r.params.get("id") ? undefined : { body: [invoiceRow({ status: "awaiting_info", agent_reasoning: technical, po_reference: "PO-100", goods_received: true })] },
      // Newest first, as ledger_entries_for_targets returns them.
      ledgerTargets: [added, decision],
    });

    const [row] = await run(() => listWaitingPayables());

    expect(row.poReference).toBe("PO-100");
    expect(row.goodsReceived).toBe(true);
    expect(row.addedSinceDecision).toEqual({ poReference: "PO-100", goodsReceived: true });
    // The explanation describes the decision, from the facts it recorded: not a held payable whose match was complete.
    expect(row.explanation).toContain("No purchase order is on file.");
    expect(row.explanation).not.toContain("PO-100");
  });

  it("carries the rule that refused the agent's payment, and none for a stop the model chose", async () => {
    const decided = (invoiceId: string, detail: Record<string, unknown>) => ({
      seq: 9, id: `e-${invoiceId}`, ts: "2026-10-03T08:00:00Z", actor: "agent", domain: "ap", action: "ap_pay", summary: "",
      detail: { invoiceId, decision: { action: "pay" }, observed: { riskLevel: "clear" }, ...detail },
      body_hash: "00", signature: "00", prev_hash: null, hash: "00", signing_key_id: null,
    });
    const rows = [invoiceRow({ id: "budget" }), invoiceRow({ id: "model" })];
    const { run } = approvalsFake({
      invoice: (r) => (r.params.get("id") ? undefined : { body: rows }),
      ledgerTargets: [
        decided("budget", { guardrailBlocked: true, guardrailRule: "workspace.outflow_budget" }),
        decided("model", { guardrailBlocked: false, guardrailRule: null }),
      ],
    });

    const listed = await run(() => listWaitingPayables());

    expect(Object.fromEntries(listed.map((row) => [row.id, row.guardrailRule]))).toEqual({ budget: "workspace.outflow_budget", model: null });
  });

  it("says nothing was added when the facts are those the decision recorded, or it recorded none", async () => {
    const entry = (invoiceId: string, observed: Record<string, unknown>) => ({
      seq: 9, id: `e-${invoiceId}`, ts: "2026-10-03T08:00:00Z", actor: "agent", domain: "ap", action: "ap_hold", summary: "",
      detail: { invoiceId, decision: { action: "hold" }, observed },
      body_hash: "00", signature: "00", prev_hash: null, hash: "00", signing_key_id: null,
    });
    const rows = [
      invoiceRow({ id: "same", po_reference: "PO-7", goods_received: true }),
      invoiceRow({ id: "unrecorded", po_reference: "PO-7", goods_received: true }),
      invoiceRow({ id: "no-entry", po_reference: "PO-7", goods_received: true }),
    ];
    const { run } = approvalsFake({
      invoice: (r) => (r.params.get("id") ? undefined : { body: rows }),
      ledgerTargets: [entry("same", { riskLevel: "clear", poReference: "PO-7", goodsReceived: true }), entry("unrecorded", { riskLevel: "clear" })],
    });

    const listed = await run(() => listWaitingPayables());

    expect(Object.fromEntries(listed.map((row) => [row.id, row.addedSinceDecision]))).toEqual({ same: null, unrecorded: null, "no-entry": null });
  });

  it("reads each row's early-payment discount the way payInvoice applies it, so the approval dialog can say what will leave", async () => {
    const rows = [
      invoiceRow({ id: "terms", early_pay_discount_pct: "2.00", discount_due_date: "2026-10-11T12:00:00+00:00" }),
      invoiceRow({ id: "no-terms", early_pay_discount_pct: null, discount_due_date: null }),
      invoiceRow({ id: "unreadable", early_pay_discount_pct: "0", discount_due_date: "2026-10-11T12:00:00+00:00" }),
    ];
    const { fake, run } = approvalsFake({ invoice: (r) => (r.params.get("id") ? undefined : { body: rows }) });

    const listed = await run(() => listWaitingPayables());

    expect(Object.fromEntries(listed.map((row) => [row.id, row.discount]))).toEqual({
      terms: { pct: 2, deadline: "2026-10-11T12:00:00+00:00" },
      "no-terms": null,
      unreadable: null,
    });
    const listing = fake.requests.find((r) => r.path === "/rest/v1/invoices" && r.method === "GET" && !r.params.get("id"));
    expect(listing?.params.get("select")).toContain("early_pay_discount_pct");
    expect(listing?.params.get("select")).toContain("discount_due_date");
  });

  it("marks a processing row reclaimable once its claim is over 10 minutes old or has no reviewed_at, as the claim does", async () => {
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    const rows = [
      invoiceRow({ id: "stale", status: "processing", reviewed_at: minutesAgo(11) }),
      invoiceRow({ id: "untimed", status: "processing", reviewed_at: null }),
      invoiceRow({ id: "fresh", status: "processing", reviewed_at: minutesAgo(2) }),
      invoiceRow({ id: "held-old", status: "held", reviewed_at: minutesAgo(60) }),
    ];
    const { run } = approvalsFake({ invoice: (r) => (r.params.get("id") ? undefined : { body: rows }) });

    const listed = await run(() => listWaitingPayables());

    expect(Object.fromEntries(listed.map((row) => [row.id, row.reclaimable]))).toEqual({
      stale: true,
      untimed: true,
      fresh: false,
      "held-old": false,
    });
  });

  it("marks a row paymentSent under the same rule Reject and Return refuse by", async () => {
    const rows = ["sent", "pending", "unreadable", "provider-failed", "stuck", "legacy-failed", "none"].map((id) => invoiceRow({ id }));
    const { fake, run } = approvalsFake({
      invoice: (r) => (r.params.get("id") ? undefined : { body: rows }),
      intents: [
        { source_id: "sent", status: "confirmed", provider_tx_id: "tx-1", last_error: null, provider_state: "COMPLETE" },
        { source_id: "pending", status: "pending", provider_tx_id: "tx-2", last_error: null, provider_state: "SENT" },
        { source_id: "unreadable", status: "failed", provider_tx_id: "tx-3", last_error: "provider unreachable", provider_state: "SENT" },
        { source_id: "provider-failed", status: "failed", provider_tx_id: "tx-4", last_error: null, provider_state: "FAILED" },
        { source_id: "stuck", status: "pending", provider_tx_id: "tx-5", last_error: null, provider_state: "STUCK" },
        { source_id: "legacy-failed", status: "failed", provider_tx_id: "tx-6", last_error: null, provider_state: null },
      ],
    });

    const listed = await run(() => listWaitingPayables());

    expect(Object.fromEntries(listed.map((row) => [row.id, row.paymentSent]))).toEqual({
      sent: true,
      pending: true,
      unreadable: true,
      "provider-failed": false,
      stuck: true,
      "legacy-failed": true,
      none: false,
    });
    const [lookup] = fake.requests.filter((r) => r.path === "/rest/v1/payment_intents");
    expect(lookup.params.get("source_type")).toBe("eq.invoice");
    expect(lookup.params.get("source_id")).toBe("in.(sent,pending,unreadable,provider-failed,stuck,legacy-failed,none)");
  });

  it("lets a Gateway payout that failed be rejected or returned, says approving sends nothing new, and pays an expired one again (Gateway review I2)", async () => {
    const { run } = approvalsFake({
      invoice: (r) => (r.params.get("id") ? undefined : { body: ["gw-failed", "gw-expired"].map((id) => invoiceRow({ id })) }),
      intents: [
        { source_id: "gw-failed", status: "failed", provider_tx_id: "gateway:tr-1", last_error: null, provider_state: "GATEWAY_FAILED", failure_reason: "out of gas" },
        { source_id: "gw-expired", status: "failed", provider_tx_id: "gateway:tr-2", last_error: null, provider_state: "FAILED", failure_reason: "Gateway's attestation expired before the mint" },
      ],
    });

    const listed = await run(() => listWaitingPayables());

    expect(Object.fromEntries(listed.map((row) => [row.id, { paymentSent: row.paymentSent, lastAttempt: row.lastAttempt }]))).toEqual({
      "gw-failed": { paymentSent: false, lastAttempt: { state: "failed", reason: "Gateway could not mint it (out of gas)", resend: false } },
      "gw-expired": { paymentSent: false, lastAttempt: { state: "failed", reason: "Gateway's attestation expired before the mint" } },
    });
  });

  it("names the invoice's own token when Circle says the wallet does not hold enough of it (review I2)", async () => {
    const { run } = approvalsFake({
      invoice: (r) => (r.params.get("id") ? undefined : { body: [invoiceRow({ id: "eurc", currency: "EURC" })] }),
      intents: [terminallyFailed({ source_id: "eurc", failure_reason: "INSUFFICIENT_TOKEN" })],
    });
    const [listed] = await run(() => listWaitingPayables());
    expect(listed.lastAttempt).toEqual({ state: "failed", reason: "the operating wallet does not hold enough EURC (Circle: INSUFFICIENT_TOKEN)" });
  });

  it("says what the last payment attempt did: failed with Circle's reason in plain words, or still in flight", async () => {
    const ids = [
      "failed-reason", "failed-insufficient-token", "failed-on-chain", "failed-unmapped-code",
      "failed-no-reason", "stuck", "sent", "confirmed", "unreadable", "unreadable-sent", "legacy-failed", "failed-before-id", "none",
    ];
    const { fake, run } = approvalsFake({
      invoice: (r) => (r.params.get("id") ? undefined : { body: ids.map((id) => invoiceRow({ id })) }),
      intents: [
        terminallyFailed({ source_id: "failed-reason", failure_reason: "INSUFFICIENT_NATIVE_TOKEN" }),
        terminallyFailed({ source_id: "failed-insufficient-token", failure_reason: "INSUFFICIENT_TOKEN" }),
        terminallyFailed({ source_id: "failed-on-chain", failure_reason: "FAILED_ON_CHAIN" }),
        terminallyFailed({ source_id: "failed-unmapped-code", failure_reason: "SOME_OTHER_CIRCLE_CODE" }),
        terminallyFailed({ source_id: "failed-no-reason", provider_state: "CANCELLED", failure_reason: null }),
        { source_id: "stuck", status: "pending", provider_tx_id: "tx-3", last_error: null, provider_state: "STUCK", failure_reason: null },
        { source_id: "sent", status: "pending", provider_tx_id: "tx-4", last_error: null, provider_state: "SENT", failure_reason: null },
        { source_id: "confirmed", status: "confirmed", provider_tx_id: "tx-5", last_error: null, provider_state: "COMPLETE", failure_reason: null },
        // Our own read failed after Circle last said the transfer was still moving: it is still in flight as far as anyone knows.
        { source_id: "unreadable", status: "failed", provider_tx_id: "tx-6", last_error: "provider unreachable", provider_state: "STUCK", failure_reason: null },
        { source_id: "unreadable-sent", status: "failed", provider_tx_id: "tx-8", last_error: "provider unreachable", provider_state: "SENT", failure_reason: null },
        { source_id: "legacy-failed", status: "failed", provider_tx_id: "tx-7", last_error: null, provider_state: null, failure_reason: null },
        { source_id: "failed-before-id", status: "failed", provider_tx_id: null, last_error: "connection reset", provider_state: null, failure_reason: null },
      ],
    });

    const listed = await run(() => listWaitingPayables());

    expect(Object.fromEntries(listed.map((row) => [row.id, row.lastAttempt]))).toEqual({
      "failed-reason": {
        state: "failed",
        reason: "the operating wallet does not hold enough USDC for the network fee (Circle: INSUFFICIENT_NATIVE_TOKEN)",
      },
      "failed-insufficient-token": {
        state: "failed",
        reason: "the operating wallet does not hold enough USDC (Circle: INSUFFICIENT_TOKEN)",
      },
      "failed-on-chain": { state: "failed", reason: "the transfer failed on chain (Circle: FAILED_ON_CHAIN)" },
      "failed-unmapped-code": { state: "failed", reason: "SOME_OTHER_CIRCLE_CODE" },
      "failed-no-reason": { state: "failed", reason: "Circle reported CANCELLED" },
      stuck: { state: "in_flight" },
      sent: { state: "in_flight" },
      confirmed: null,
      unreadable: { state: "in_flight" },
      "unreadable-sent": { state: "in_flight" },
      "legacy-failed": null,
      "failed-before-id": null,
      none: null,
    });
    const [lookup] = fake.requests.filter((r) => r.path === "/rest/v1/payment_intents");
    expect(lookup.params.get("select")).toContain("provider_state");
    expect(lookup.params.get("select")).toContain("failure_reason");
  });

  it("asks for no payment intents when nothing is waiting", async () => {
    const { fake, run } = approvalsFake({ invoice: (r) => (r.params.get("id") ? undefined : { body: [] }) });

    await expect(run(() => listWaitingPayables())).resolves.toEqual([]);
    expect(fake.requests.some((r) => r.path === "/rest/v1/payment_intents")).toBe(false);
  });
});

describe("no ledger body ever contains an email address", () => {
  it("across approve, reject and return", async () => {
    payInvoiceMock.mockResolvedValue({ status: "paid", txRef: "0xhash", execution: null, note: "", operatingBalance: 350 });
    const { fake, run } = approvalsFake();

    await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }));
    const { fake: fake2, run: run2 } = approvalsFake();
    await run2(() => rejectInvoice({ actorId: ACTOR, invoiceId: INVOICE_ID, reason: "duplicate of another bill" }));
    const { fake: fake3, run: run3 } = approvalsFake();
    await run3(() => returnInvoice({ actorId: ACTOR, invoiceId: INVOICE_ID }));

    const appends = [
      ...rpcBodies(fake.requests, "append_ledger_entry"),
      ...rpcBodies(fake2.requests, "append_ledger_entry"),
      ...rpcBodies(fake3.requests, "append_ledger_entry"),
    ];
    expect(JSON.stringify(appends)).not.toMatch(/[^\s"]+@[^\s"]+\.[^\s"]+/);
  });
});

describe("approveAndPay and the address the person was shown", () => {
  const CHANGED_AT = "2026-09-30T12:00:00+00:00";
  const unconfirmed = { id: COUNTERPARTY_ID, name: "Acme Supplies", address: "0xdead", address_changed_at: CHANGED_AT, address_confirmed_at: null };
  const paid = () => payInvoiceMock.mockResolvedValue({ status: "paid", txRef: "0xhash", execution: null, note: "", operatingBalance: 350 });
  const counterpartyPatches = (requests: RecordedRequest[]) =>
    requests.filter((r) => r.path === "/rest/v1/counterparties" && r.method === "PATCH");

  it("refuses before any claim when the counterparty's address is no longer the one shown", async () => {
    const { fake, run } = approvalsFake({ counterparty: unconfirmed });

    const attempt = run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID, shownAddress: "0xbeef" }));

    await expect(attempt).rejects.toBeInstanceOf(ApprovalError);
    await expect(attempt).rejects.toThrow("This counterparty's address changed after this page loaded. Check the new address and try again.");
    expect(rpcBodies(fake.requests, "claim_invoice_decision")).toHaveLength(0);
    expect(payInvoiceMock).not.toHaveBeenCalled();
  });

  it("compares addresses without regard to letter case", async () => {
    paid();
    const { run } = approvalsFake({ counterparty: unconfirmed });

    await expect(run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID, shownAddress: "0xDEAD" }))).resolves.toMatchObject({ status: "paid" });
  });

  it("confirms an unconfirmed address it paid to, and records who confirmed it", async () => {
    paid();
    const { fake, run } = approvalsFake({ counterparty: unconfirmed });

    await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID, shownAddress: "0xdead" }));

    const [patch] = counterpartyPatches(fake.requests);
    expect(Object.keys(patch.body as object)).toEqual(["address_confirmed_at"]);
    const confirmed = rpcBodies(fake.requests, "append_ledger_entry").find((body) => body.p_action === "counterparty_address_confirmed");
    expect(confirmed?.p_detail).toEqual({ by: ACTOR, counterpartyId: COUNTERPARTY_ID, address: "0xdead", via: "approval" });
  });

  it("does not confirm the address when the approval only records a transfer that was already sent", async () => {
    paid();
    const { fake, run } = approvalsFake({
      counterparty: unconfirmed,
      intents: [{ source_id: INVOICE_ID, status: "confirmed", provider_tx_id: "circle-tx-1", last_error: null }],
    });

    await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID, shownAddress: "0xdead" }));

    expect(counterpartyPatches(fake.requests)).toHaveLength(0);
  });

  it("pays even when the confirmation cannot be written", async () => {
    paid();
    const { run } = approvalsFake();

    await expect(run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID, shownAddress: "0xdead" }))).resolves.toMatchObject({ status: "paid" });
    expect(payInvoiceMock).toHaveBeenCalledTimes(1);
  });

  it("accepts nothing shown for a counterparty with no address", async () => {
    paid();
    const { run } = approvalsFake({
      invoice: (r) => (r.params.get("id") ? { body: invoiceRow({ counterparties: { name: "Acme", risk_level: "medium", address: null } }) } : undefined),
    });

    await expect(run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID, shownAddress: "" }))).resolves.toMatchObject({ status: "paid" });
  });
});

describe("approveAndPay and the first payment to an address (new payee check N4)", () => {
  const gaveAddress = (by: string) => [{ action: "create_counterparty", detail: { by, counterpartyId: COUNTERPARTY_ID, address: "0xdead" } }];
  // A live workspace whose operating wallet, read from the chain, holds enough for the bill.
  const live = () => {
    getChainProviderMock.mockReturnValue({ mode: "live", earnMode: "simulate", estimatedFeeUsd: 0.003 });
    syncOperatingBalanceMock.mockResolvedValue(500);
  };

  it("refuses the person who gave the payee's address, before any claim, unless they are the only approver", async () => {
    live();
    const { fake, run } = approvalsFake({ addressEntries: gaveAddress(ACTOR) });

    await expect(run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }))).rejects.toThrow(
      "You gave this payee's address, so someone else must approve its first payment."
    );
    expect(rpcBodies(fake.requests, "claim_invoice_decision")).toHaveLength(0);
    expect(payInvoiceMock).not.toHaveBeenCalled();
    const read = fake.requests.find((request) => request.path === "/rest/v1/ledger_entries" && request.params.has("detail->>counterpartyId"));
    expect(read?.params.get("detail->>counterpartyId")).toBe(`in.(${COUNTERPARTY_ID})`);
  });

  it("lets the workspace's only approver pay it, and records that it was the address's first payment", async () => {
    live();
    payInvoiceMock.mockResolvedValue({ status: "paid", txRef: "0xhash", execution: null, note: "", operatingBalance: 0 });
    const { fake, run } = approvalsFake({ addressEntries: gaveAddress(ACTOR), soleApprover: { body: true } });

    expect((await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }))).status).toBe("paid");
    expect(rpcBodies(fake.requests, "append_ledger_entry")[0].p_detail).toMatchObject({ firstPayment: true });
  });

  it("lets someone other than whoever gave the address pay it", async () => {
    live();
    payInvoiceMock.mockResolvedValue({ status: "paid", txRef: "0xhash", execution: null, note: "", operatingBalance: 0 });
    const { fake, run } = approvalsFake({ addressEntries: gaveAddress("0b6c1c9e-4a4f-4a7e-9b1e-0000000000c3") });

    expect((await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }))).status).toBe("paid");
    expect(rpcBodies(fake.requests, "sole_approver")).toHaveLength(0);
    expect(rpcBodies(fake.requests, "append_ledger_entry")[0].p_detail).toMatchObject({ firstPayment: true });
  });

  it("asks nothing where payments are simulated", async () => {
    payInvoiceMock.mockResolvedValue({ status: "paid", txRef: "0xhash", execution: null, note: "", operatingBalance: 0 });
    const { fake, run } = approvalsFake({ addressEntries: gaveAddress(ACTOR) });

    await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }));
    const addressRead = (request: RecordedRequest) => request.path === "/rest/v1/ledger_entries" && request.params.has("detail->>counterpartyId");
    expect(fake.requests.some(addressRead)).toBe(false);
    expect(rpcBodies(fake.requests, "append_ledger_entry")[0].p_detail).not.toHaveProperty("firstPayment");
  });
});

describe("listWaitingPayables and the first payment to an address (new payee check N4)", () => {
  it("says who gave the address of a payable whose payment would be its first, where payments are real", async () => {
    getChainProviderMock.mockReturnValue({ mode: "live", earnMode: "simulate", estimatedFeeUsd: 0.003 });
    const { run } = approvalsFake({ addressEntries: [{ action: "create_counterparty", detail: { by: ACTOR, counterpartyId: COUNTERPARTY_ID, address: "0xdead" } }] });

    const [row] = await run(() => listWaitingPayables());
    expect(row.firstPaymentAddressBy).toBe(ACTOR);
  });

  it("says nothing of the kind for an address paid before, or where payments are simulated", async () => {
    getChainProviderMock.mockReturnValue({ mode: "live", earnMode: "simulate", estimatedFeeUsd: 0.003 });
    const paid = approvalsFake({
      intents: [intentRow({ status: "confirmed", destination: "0xdead" })],
      addressEntries: [{ action: "create_counterparty", detail: { by: ACTOR, counterpartyId: COUNTERPARTY_ID, address: "0xdead" } }],
    });
    expect((await paid.run(() => listWaitingPayables()))[0]).not.toHaveProperty("firstPaymentAddressBy");

    getChainProviderMock.mockReturnValue({ mode: "simulate", earnMode: "simulate", estimatedFeeUsd: 0.01 });
    const simulated = approvalsFake({ addressEntries: [{ action: "create_counterparty", detail: { by: ACTOR, counterpartyId: COUNTERPARTY_ID, address: "0xdead" } }] });
    expect((await simulated.run(() => listWaitingPayables()))[0]).not.toHaveProperty("firstPaymentAddressBy");
  });
});


describe("approveAndPay above the workspace's figure for two approvals (two approvals T4–T7)", () => {
  const OTHER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c3";
  const paid = () => payInvoiceMock.mockResolvedValue({ status: "paid", txRef: "0xhash", execution: null, note: "", amountPaid: 150, discountTaken: 0, operatingBalance: 0 });
  const approval = (by: string, over: Record<string, unknown> = {}) => ({
    id: `appr-${by.slice(-2)}`, approved_by: by, approved_at: "2026-10-05T08:00:00.000Z", amount: "150.000000", currency: "USDC", address: "0xDEAD", ...over,
  });
  const approvalRequests = (requests: RecordedRequest[], method: string) => requests.filter((r) => r.path === "/rest/v1/payment_approvals" && r.method === method);

  it("records the first approval, bound to the payment, and sends nothing", async () => {
    const { fake, run } = approvalsFake({ twoApprovals: 100 });

    const result = await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }));

    expect(result).toEqual({ status: "approved", txRef: null, note: "" });
    expect(approvalRequests(fake.requests, "POST")[0].body).toMatchObject({
      org_id: ORG, source_type: "invoice", source_id: INVOICE_ID, approved_by: ACTOR, amount: 150, currency: "USDC", address: "0xdead",
    });
    expect(rpcBodies(fake.requests, "claim_invoice_decision")).toHaveLength(0);
    expect(payInvoiceMock).not.toHaveBeenCalled();
    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(append).toMatchObject({
      p_actor: "human",
      p_domain: "ap",
      p_action: "approval_given",
      p_summary: "Approved 150 USDC to Acme Supplies; one more approval pays it (payments above 100 USDC need two)",
      p_detail: { by: ACTOR, invoiceId: INVOICE_ID, counterpartyId: COUNTERPARTY_ID, amount: 150, currency: "USDC", address: "0xdead", twoApprovalsAbove: 100 },
    });
    expect(append.p_detail).not.toHaveProperty("fewApprovers");
  });

  it("pays on the second approval, by another person, and uses both", async () => {
    paid();
    const { fake, run } = approvalsFake({ twoApprovals: 100, approvals: [approval(OTHER)] });

    const result = await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }));

    expect(result.status).toBe("paid");
    // The approval that pays is never stored before the claim (review finding 2): the entry is its record.
    expect(approvalRequests(fake.requests, "POST")).toHaveLength(0);
    expect(rpcBodies(fake.requests, "claim_invoice_decision")).toEqual([{ p_org_id: ORG, p_invoice_id: INVOICE_ID, p_by: ACTOR, p_decision: "approve" }]);
    expect(payInvoiceMock).toHaveBeenCalledTimes(1);
    const used = approvalRequests(fake.requests, "PATCH");
    expect(used).toHaveLength(1);
    expect(used[0].params.get("source_id")).toBe(`eq.${INVOICE_ID}`);
    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(append).toMatchObject({
      p_action: "approval_paid",
      p_summary: "Approved and paid 150 USDC to Acme Supplies (the second of two approvals)",
      p_detail: {
        by: ACTOR,
        twoApprovalsAbove: 100,
        approvals: [
          { by: OTHER, at: "2026-10-05T08:00:00.000Z" },
          { by: ACTOR, at: expect.any(String) },
        ],
      },
    });
  });

  it("refuses a second approval by the same person, before any claim", async () => {
    const { fake, run } = approvalsFake({ twoApprovals: 100, approvals: [approval(ACTOR)] });

    const attempt = run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }));
    await expect(attempt).rejects.toBeInstanceOf(ApprovalError);
    await expect(attempt).rejects.toThrow("You approved this already. Another person who can approve payments must approve it to pay.");
    expect(approvalRequests(fake.requests, "POST")).toHaveLength(0);
    expect(rpcBodies(fake.requests, "claim_invoice_decision")).toHaveLength(0);
  });

  it("counts for nothing an approval of another amount, or by someone who may no longer approve: this one is the first", async () => {
    const changed = approvalsFake({ twoApprovals: 100, approvals: [approval(OTHER, { amount: "120" })] });
    expect((await changed.run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }))).status).toBe("approved");
    expect(payInvoiceMock).not.toHaveBeenCalled();

    const gone = approvalsFake({ twoApprovals: 100, approvals: [approval(OTHER)], approversAmong: () => [] });
    expect((await gone.run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }))).status).toBe("approved");
    expect(payInvoiceMock).not.toHaveBeenCalled();
  });

  it("refuses whoever entered it while two others can approve", async () => {
    const { fake, run } = approvalsFake({ twoApprovals: 100, approversBesides: 2 });

    await expect(run(() => approveAndPay({ actorId: CREATOR, invoiceId: INVOICE_ID }))).rejects.toThrow("You created this invoice, so someone else must approve it.");
    // First how many can approve at all, then how many besides whoever entered it.
    expect(rpcBodies(fake.requests, "approvers_besides")).toEqual([
      { p_org_id: ORG, p_excluded: [] },
      { p_org_id: ORG, p_excluded: [CREATOR] },
    ]);
    expect(approvalRequests(fake.requests, "POST")).toHaveLength(0);
  });

  it("lets whoever entered it give one of the two when fewer than two others can, and says so", async () => {
    const first = approvalsFake({ twoApprovals: 100, approversBesides: (excluded) => (excluded.length === 0 ? 2 : 1) });
    expect((await first.run(() => approveAndPay({ actorId: CREATOR, invoiceId: INVOICE_ID }))).status).toBe("approved");
    expect(rpcBodies(first.fake.requests, "append_ledger_entry")[0].p_detail).toMatchObject({ fewApprovers: true });

    paid();
    const second = approvalsFake({ twoApprovals: 100, approversBesides: (excluded) => (excluded.length === 0 ? 2 : 1), approvals: [approval(OTHER)] });
    expect((await second.run(() => approveAndPay({ actorId: CREATOR, invoiceId: INVOICE_ID }))).status).toBe("paid");
    expect(rpcBodies(second.fake.requests, "claim_invoice_decision")[0]).toMatchObject({ p_by: CREATOR });
    expect(rpcBodies(second.fake.requests, "append_ledger_entry")[0].p_detail).toMatchObject({ fewApprovers: true });
  });

  it("records a transfer already sent on one approval, sending nothing new", async () => {
    payInvoiceMock.mockResolvedValue({ status: "paid", txRef: "0xhash", execution: null, note: "", amountPaid: 150, discountTaken: 0, operatingBalance: 0 });
    const { fake, run } = approvalsFake({ twoApprovals: 100, intents: [intentRow({ status: "confirmed", provider_state: "COMPLETE" })] });

    expect((await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }))).status).toBe("paid");
    expect(fake.requests.some((r) => r.path === "/rest/v1/approval_policies")).toBe(false);
    expect(approvalRequests(fake.requests, "POST")).toHaveLength(0);
  });

  it("pays at or under the figure on one approval, as before", async () => {
    paid();
    const { fake, run } = approvalsFake({ twoApprovals: 150 });

    expect((await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }))).status).toBe("paid");
    expect(fake.requests.some((r) => r.path === "/rest/v1/payment_approvals")).toBe(false);
    expect(rpcBodies(fake.requests, "append_ledger_entry")[0].p_detail).not.toHaveProperty("approvals");
  });

  it("weighs a EURC payable at the USDC value its decision recorded", async () => {
    const eurc = (usdcValue: number | null) =>
      approvalsFake({
        twoApprovals: 100,
        invoice: (request) => (request.params.get("id") ? { body: invoiceRow({ currency: "EURC", amount: "95" }) } : undefined),
        ledgerTargets: [{ seq: 7, ts: "2026-10-05T07:00:00Z", action: "ap_hold", actor: "agent", domain: "ap", summary: "", detail: { invoiceId: INVOICE_ID, usdcValue, observed: { amount: 95 } } }],
      });
    expect((await eurc(103).run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }))).status).toBe("approved");
    expect((await eurc(null).run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }))).status).toBe("approved");
    paid();
    expect((await eurc(99).run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }))).status).toBe("paid");
  });
});

describe("Reject and Return end the approvals given (two approvals T6)", () => {
  it("clears a payable's open approvals once it is rejected or returned", async () => {
    for (const decide of [
      () => rejectInvoice({ actorId: ACTOR, invoiceId: INVOICE_ID, reason: "Not ours" }),
      () => returnInvoice({ actorId: ACTOR, invoiceId: INVOICE_ID }),
    ]) {
      const { fake, run } = approvalsFake();
      await run(decide);
      const cleared = fake.requests.filter((r) => r.path === "/rest/v1/payment_approvals" && r.method === "DELETE");
      expect(cleared).toHaveLength(1);
      expect(cleared[0].params.get("source_id")).toBe(`eq.${INVOICE_ID}`);
      expect(cleared[0].params.get("used_at")).toBe("is.null");
    }
  });
});

describe("listWaitingPayables above the figure for two approvals (two approvals T8)", () => {
  const OTHER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c3";

  it("gives a payable above the figure its approvals, and whether whoever entered it may give one", async () => {
    const { fake, run } = approvalsFake({
      twoApprovals: 100,
      approversBesides: 1,
      approvals: [{ source_id: INVOICE_ID, id: "appr-c3", approved_by: OTHER, approved_at: "2026-10-05T08:00:00.000Z", amount: "150", currency: "USDC", address: "0xdead" }],
    });

    const [row] = await run(() => listWaitingPayables());

    expect(row.twoApprovals).toEqual({ above: 100, approvals: [{ by: OTHER, at: "2026-10-05T08:00:00.000Z" }], excluded: [CREATOR], excludedSlots: 1, approvers: 1 });
    expect(rpcBodies(fake.requests, "approvers_besides")).toEqual([
      { p_org_id: ORG, p_excluded: [] },
      { p_org_id: ORG, p_excluded: [CREATOR] },
    ]);
  });

  it("gives none at or under the figure, or with none set", async () => {
    const under = approvalsFake({ twoApprovals: 150 });
    expect((await under.run(() => listWaitingPayables()))[0]).not.toHaveProperty("twoApprovals");
    const none = approvalsFake();
    expect((await none.run(() => listWaitingPayables()))[0]).not.toHaveProperty("twoApprovals");
  });
});

describe("approveAndPay above the figure, after review (two approvals T4–T6)", () => {
  const OTHER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c3";
  const GAVE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000d4";
  const approval = (by: string) => ({
    id: `appr-${by.slice(-2)}`, approved_by: by, approved_at: "2026-10-05T08:00:00.000Z", amount: "150.000000", currency: "USDC", address: "0xdead",
  });
  const approvalRequests = (requests: RecordedRequest[], method: string) => requests.filter((r) => r.path === "/rest/v1/payment_approvals" && r.method === method);
  /** A live workspace where the payable would be the first payment to an address GAVE gave. */
  const live = () => {
    getChainProviderMock.mockReturnValue({ mode: "live", earnMode: "simulate", estimatedFeeUsd: 0.003 });
    syncOperatingBalanceMock.mockResolvedValue(500);
    return { addressEntries: [{ action: "create_counterparty", detail: { by: GAVE, counterpartyId: COUNTERPARTY_ID, address: "0xdead" } }] };
  };

  it("keeps whoever entered it and whoever gave its address from being its two approvers while someone else can approve", async () => {
    const { fake, run } = approvalsFake({
      ...live(),
      twoApprovals: 100,
      approvals: [approval(GAVE)],
      approversBesides: (excluded) => (excluded.length === 0 ? 3 : 1),
    });

    await expect(run(() => approveAndPay({ actorId: CREATOR, invoiceId: INVOICE_ID }))).rejects.toThrow("You created this invoice, so someone else must approve it.");
    expect(rpcBodies(fake.requests, "claim_invoice_decision")).toHaveLength(0);
    expect(payInvoiceMock).not.toHaveBeenCalled();
  });

  it("lets them be its two approvers when no one else can approve", async () => {
    payInvoiceMock.mockResolvedValue({ status: "paid", txRef: "0xhash", execution: null, note: "", amountPaid: 150, discountTaken: 0, operatingBalance: 0 });
    const { run } = approvalsFake({
      ...live(),
      twoApprovals: 100,
      approvals: [approval(GAVE)],
      approversBesides: (excluded) => (excluded.length === 0 ? 2 : 0),
    });

    expect((await run(() => approveAndPay({ actorId: CREATOR, invoiceId: INVOICE_ID }))).status).toBe("paid");
  });

  it("keeps no approval when the payment it would have made is refused", async () => {
    const { fake, run } = approvalsFake({ twoApprovals: 100, approvals: [approval(OTHER)], account: () => ({ body: accountRow("100") }) });

    await expect(run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }))).rejects.toThrow(/less than this invoice/);
    expect(approvalRequests(fake.requests, "POST")).toHaveLength(0);
    expect(approvalRequests(fake.requests, "PATCH")).toHaveLength(0);
  });

  it("sends nothing when the approvals it uses cannot be marked used, and gives the payable back", async () => {
    const { fake, run } = approvalsFake({ twoApprovals: 100, approvals: [approval(OTHER)], approvalsPatch: { status: 500, body: { message: "write failed" } } });

    await expect(run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }))).rejects.toThrow();
    expect(payInvoiceMock).not.toHaveBeenCalled();
    expect(patchBodies(fake.requests, "/rest/v1/invoices")).toEqual([expect.objectContaining({ status: "held" })]);
  });

  it("takes no approval while another person's payment of it is being decided", async () => {
    const { fake, run } = approvalsFake({
      twoApprovals: 100,
      invoice: (request) => (request.params.get("id") ? { body: invoiceRow({ status: "processing", reviewed_at: new Date().toISOString() }) } : undefined),
    });

    await expect(run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }))).rejects.toThrow("Someone else decided this invoice a moment ago.");
    expect(approvalRequests(fake.requests, "POST")).toHaveLength(0);
  });

  it("takes no approval where fewer than two people can approve payments: it could never be paid", async () => {
    const { fake, run } = approvalsFake({ twoApprovals: 100, approversBesides: (excluded) => (excluded.length === 0 ? 1 : 0) });

    const attempt = run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }));
    await expect(attempt).rejects.toMatchObject({ code: "needs_second_approver" });
    await expect(attempt).rejects.toThrow(
      "Payments above 100 USDC need two approvals, and only one person in this workspace can approve payments. Raise the figure in Settings, or add an approver on Members."
    );
    expect(approvalRequests(fake.requests, "POST")).toHaveLength(0);
  });
});

describe("approveAndPay when the operating wallet falls short and the reserve covers it (approval cash R1–R5)", () => {
  // testnet-2, 2026-10-05 09:08 UTC: the approver chose Approve and pay on a 0.40 USDC Centronex bill with 0.184239 USDC in
  // the operating wallet and 151.8501 USDC in the reserve, and was refused.
  const OTHER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c3";
  const RESERVE = { id: "018f8ce0-1557-7b54-a931-4d777f6bca01", balance: "151.850100" };
  const CENTRONEX = { name: "Centronex", risk_level: "medium", address: "0xdead" };
  const ON_ARB = { ...CENTRONEX, chain: "ARB-SEPOLIA" };
  const withdrawFromEarn = vi.fn();
  const bill = (over: Record<string, unknown> = {}) => (r: RecordedRequest) =>
    r.params.get("id") ? { body: invoiceRow({ amount: "0.4", counterparties: CENTRONEX, ...over }) } : undefined;
  const short = (options: Parameters<typeof approvalsFake>[0] = {}) =>
    approvalsFake({ invoice: bill(), account: () => ({ body: accountRow("0.184239") }), reserve: RESERVE, ...options });
  const approval = (by: string) => ({ id: `appr-${by.slice(-2)}`, approved_by: by, approved_at: "2026-10-05T08:00:00.000Z", amount: "0.400000", currency: "USDC", address: "0xdead" });
  const cctpFee = () => vi.fn(async () => ({ feeUsdc: 0.135342, maxFeeUnits: BigInt(135342), domain: 3 }));

  beforeEach(() => {
    withdrawFromEarn.mockReset().mockResolvedValue({ txRef: "sim_redeem_1", positionValue: 151.634339, apy: 0 });
    getChainProviderMock.mockReturnValue({ mode: "simulate", earnMode: "simulate", estimatedFeeUsd: 0.01, withdrawFromEarn });
    payInvoiceMock.mockResolvedValue({ status: "paid", txRef: "0xhash", execution: null, note: "", amountPaid: 0.4, discountTaken: 0, operatingBalance: 0 });
  });

  it("brings back what the payment lacks once the decision is claimed, then pays, and records both", async () => {
    const { fake, run } = short();

    const result = await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }));

    expect(result).toEqual({ status: "paid", txRef: "0xhash", note: "", fromReserveUsdc: 0.215761 });
    expect(withdrawFromEarn).toHaveBeenCalledTimes(1);
    expect(withdrawFromEarn.mock.calls[0][0]).toMatchObject({ accountId: ACCOUNT_ID, reserveAccountId: RESERVE.id, amount: 0.215761 });
    // Claimed first, so a second click never brings cash back twice; paid after.
    const claimedAt = fake.requests.findIndex((r) => r.path === "/rest/v1/rpc/claim_invoice_decision");
    const movedAt = fake.requests.findIndex((r) => r.path === "/rest/v1/treasury_actions");
    expect(claimedAt).toBeGreaterThanOrEqual(0);
    expect(movedAt).toBeGreaterThan(claimedAt);
    expect(withdrawFromEarn.mock.invocationCallOrder[0]).toBeLessThan(payInvoiceMock.mock.invocationCallOrder[0]);
    const [brought, paid] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(brought).toMatchObject({
      p_actor: "human",
      p_domain: "treasury",
      p_action: "cash_brought_back",
      p_summary: "Brought 0.215761 USDC back from the reserve to pay Centronex",
      p_detail: { by: ACTOR, reason: "approval", invoiceId: INVOICE_ID, amount: 0.215761, neededUsdc: 0.4, operatingBalance: 0.184239, reserveBalance: 151.8501, earnMode: "simulate" },
    });
    expect(paid).toMatchObject({ p_action: "approval_paid", p_detail: { fromReserveUsdc: 0.215761 } });
  });

  it("brings back a CCTP payout's fee with it, and a fifth more of the fee, which is read again before the burn", async () => {
    const { fake, run } = short({ invoice: bill({ counterparties: ON_ARB }) });

    await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }, { bridgeFee: cctpFee(), gatewayQuote: vi.fn(async () => null) }));

    // 0.4 + 0.135342 + 0.027069 - 0.184239 (review finding 2).
    expect(withdrawFromEarn.mock.calls[0][0].amount).toBe(0.378172);
    expect(payInvoiceMock.mock.calls[0][0]).toMatchObject({ route: "cctp" });
    const [brought] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(brought.p_detail).toMatchObject({ neededUsdc: 0.535342, feeCushionUsdc: 0.027069, amount: 0.378172 });
  });

  it("covers no CCTP payout whose fee CCTP did not give: what it needs is not known", async () => {
    const { run } = short({ invoice: bill({ counterparties: ON_ARB }) });
    const noFee = vi.fn(async () => {
      throw new Error("Iris did not answer");
    });

    await expect(run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }, { bridgeFee: noFee, gatewayQuote: vi.fn(async () => null) }))).rejects.toThrow(
      "The operating account holds 0.184239 USDC, less than this invoice."
    );
    expect(withdrawFromEarn).not.toHaveBeenCalled();
  });

  it("brings nothing back for a EURC payable, which is paid from EURC", async () => {
    const { run } = short({ invoice: bill({ currency: "EURC" }) });

    await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }));

    expect(withdrawFromEarn).not.toHaveBeenCalled();
    expect(payInvoiceMock).toHaveBeenCalledTimes(1);
  });

  it("brings nothing back for a transfer already sent, which is only recorded", async () => {
    const { run } = short({ intents: [{ source_id: INVOICE_ID, status: "confirmed", provider_tx_id: "circle-tx-1", last_error: null }] });

    await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }));

    expect(withdrawFromEarn).not.toHaveBeenCalled();
  });

  it("gives a flagged payable back as flagged when nothing came back, not as held", async () => {
    withdrawFromEarn.mockRejectedValue(new Error("redeem failed (FAILED) on Arc testnet"));
    const { fake, run } = short({ invoice: bill({ status: "flagged" }) });

    await expect(run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }))).rejects.toMatchObject({ code: "insufficient_funds" });
    expect(patchBodies(fake.requests, "/rest/v1/invoices")).toEqual([expect.objectContaining({ status: "flagged" })]);
  });

  it("says a redemption Arc testnet has not confirmed yet may still land, sending nothing", async () => {
    withdrawFromEarn.mockRejectedValue(new UsycNotConfirmedError("redeem did not confirm in time on Arc testnet"));
    const { fake, run } = short();

    const attempt = run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }));
    await expect(attempt).rejects.toMatchObject({ code: "insufficient_funds" });
    await expect(attempt).rejects.toThrow(
      "The reserve's redemption has not confirmed on Arc testnet yet, so nothing was paid. Try again in a minute: once it lands, the cash is in the operating wallet."
    );
    expect(payInvoiceMock).not.toHaveBeenCalled();
    expect(patchBodies(fake.requests, "/rest/v1/invoices")).toEqual([expect.objectContaining({ status: "held" })]);
  });

  it("brings nothing back for a Gateway payout, which the Gateway balance pays", async () => {
    const { run } = short({ invoice: bill({ counterparties: ON_ARB }) });

    await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }, { bridgeFee: cctpFee(), gatewayQuote: vi.fn(async () => ({ feeUsdc: 0.105944, balanceUsdc: 50 })) }));

    expect(withdrawFromEarn).not.toHaveBeenCalled();
    expect(payInvoiceMock.mock.calls[0][0]).toMatchObject({ route: "gateway" });
  });

  it("brings nothing back when the operating wallet covers the payment", async () => {
    const { run } = short({ account: () => ({ body: accountRow("5") }) });

    expect(await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }))).toEqual({ status: "paid", txRef: "0xhash", note: "" });
    expect(withdrawFromEarn).not.toHaveBeenCalled();
  });

  it("refuses before any claim when the wallet and the reserve together fall short, naming both", async () => {
    const { fake, run } = short({ reserve: { ...RESERVE, balance: "0.1" } });

    const attempt = run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }));
    await expect(attempt).rejects.toMatchObject({ code: "insufficient_funds" });
    await expect(attempt).rejects.toThrow("The operating account holds 0.184239 USDC and the USYC reserve 0.1 USDC, less than this invoice.");
    expect(rpcBodies(fake.requests, "claim_invoice_decision")).toHaveLength(0);
    expect(withdrawFromEarn).not.toHaveBeenCalled();
  });

  it("names the CCTP fee too when the two fall short of a payout to another chain", async () => {
    const { run } = short({ invoice: bill({ counterparties: ON_ARB }), reserve: { ...RESERVE, balance: "0.1" } });

    await expect(run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }, { bridgeFee: cctpFee(), gatewayQuote: vi.fn(async () => null) }))).rejects.toThrow(
      "The operating account holds 0.184239 USDC and the USYC reserve 0.1 USDC, less than this invoice and its 0.135342 USDC CCTP fee."
    );
  });

  it("gives the payable back, sending nothing, when nothing came back, and leaves both approvals standing", async () => {
    withdrawFromEarn.mockRejectedValue(new Error("redeem failed (FAILED) on Arc testnet"));
    const { fake, run } = short({ twoApprovals: 0.1, approvals: [approval(OTHER)] });

    const attempt = run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }));
    await expect(attempt).rejects.toMatchObject({ code: "insufficient_funds" });
    await expect(attempt).rejects.toThrow(
      "Nothing came back from the reserve: execution failed: redeem failed (FAILED) on Arc testnet. The operating account holds 0.184239 USDC, less than this invoice."
    );
    expect(payInvoiceMock).not.toHaveBeenCalled();
    expect(patchBodies(fake.requests, "/rest/v1/invoices")).toEqual([expect.objectContaining({ status: "held" })]);
    expect(fake.requests.filter((r) => r.path === "/rest/v1/payment_approvals" && r.method === "PATCH")).toHaveLength(0);
    // Only the attempt is recorded: nothing was paid.
    expect(rpcBodies(fake.requests, "append_ledger_entry").map((body) => body.p_action)).toEqual(["cash_brought_back"]);
    expect(rpcBodies(fake.requests, "append_ledger_entry")[0].p_detail).toMatchObject({ executed: false });
  });

  it("brings nothing back on the first of two approvals, which sends nothing", async () => {
    const { run } = short({ twoApprovals: 0.1 });

    expect((await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }))).status).toBe("approved");
    expect(withdrawFromEarn).not.toHaveBeenCalled();
  });

  it("tells the card what would come back first, from the stored balances (R5)", async () => {
    const SMALL = "018f8ce0-1557-7b54-a931-4d777f6bcb01";
    const listed = (rows: Array<Record<string, unknown>>) => (r: RecordedRequest) => (r.params.get("id") ? undefined : { body: rows });
    const rows = [invoiceRow({ amount: "0.4", counterparties: CENTRONEX }), invoiceRow({ id: SMALL, amount: "0.1", counterparties: CENTRONEX })];

    const [lacking, covered] = await short({ invoice: listed(rows) }).run(() => listWaitingPayables());
    expect(lacking.fromReserve).toEqual({ operatingUsdc: 0.184239, amountUsdc: 0.215761 });
    expect(covered).not.toHaveProperty("fromReserve");

    // A CCTP payout's figure counts the fee and its cushion; one whose fee CCTP did not give has none.
    const onArb = [invoiceRow({ amount: "0.4", counterparties: ON_ARB })];
    const [cctp] = await short({ invoice: listed(onArb) }).run(() => listWaitingPayables({ bridgeFee: cctpFee(), gatewayQuote: vi.fn(async () => null) }));
    expect(cctp.fromReserve).toEqual({ operatingUsdc: 0.184239, amountUsdc: 0.378172 });
    const noFee = vi.fn(async () => {
      throw new Error("Iris did not answer");
    });
    const [unknownFee] = await short({ invoice: listed(onArb) }).run(() => listWaitingPayables({ bridgeFee: noFee, gatewayQuote: vi.fn(async () => null) }));
    expect(unknownFee).not.toHaveProperty("fromReserve");

    // Nothing to say when the reserve could not cover it either, or there is none.
    const [uncovered] = await short({ invoice: listed(rows.slice(0, 1)), reserve: { ...RESERVE, balance: "0.1" } }).run(() => listWaitingPayables());
    expect(uncovered).not.toHaveProperty("fromReserve");
    const [noReserve] = await short({ invoice: listed(rows.slice(0, 1)), reserve: null }).run(() => listWaitingPayables());
    expect(noReserve).not.toHaveProperty("fromReserve");
  });
});
