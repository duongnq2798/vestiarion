import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import {
  ApprovalError,
  approveAndPay,
  listWaitingPayables,
  rejectInvoice,
  returnInvoice,
} from "@/lib/agent/approvals";
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

/** PostgREST as `approvals.ts` meets it: the invoice, the account, the claim RPC, and `append_ledger_entry`. */
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
} = {}) {
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
      const intents = options.intents ?? [];
      const one = request.params.get("source_id")?.match(/^eq\.(.+)$/)?.[1];
      if (one !== undefined) return { body: intents.find((intent) => intent.source_id === one) ?? null };
      return { body: intents };
    }
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

  it("claims, pays once, updates the invoice with the reasoning note, and appends approval_paid", async () => {
    payInvoiceMock.mockResolvedValue({ status: "paid", txRef: "0xhash", execution: null, note: "", operatingBalance: 350 });
    const { fake, run } = approvalsFake();

    const result = await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID }));

    expect(result).toEqual({ status: "paid", txRef: "0xhash", note: "" });

    const [claim] = rpcBodies(fake.requests, "claim_invoice_decision");
    expect(claim).toEqual({ p_org_id: ORG, p_invoice_id: INVOICE_ID, p_by: ACTOR, p_decision: "approve" });
    expect(payInvoiceMock).toHaveBeenCalledTimes(1);
    expect(payInvoiceMock).toHaveBeenCalledWith(
      { invoiceId: INVOICE_ID, counterpartyId: COUNTERPARTY_ID, address: "0xdead", amount: 150 },
      { provider: { mode: "simulate", earnMode: "simulate", estimatedFeeUsd: 0.01 }, operating: { id: ACCOUNT_ID } }
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
  ] as const)("refuses with payment_in_flight, before any claim, when the payment is %s", async (_label, intent) => {
    const { fake, run } = approvalsFake({ intents: [{ source_id: INVOICE_ID, ...intent }] });

    const attempt = run(() => rejectInvoice({ actorId: ACTOR, invoiceId: INVOICE_ID }));
    await expect(attempt).rejects.toBeInstanceOf(ApprovalError);
    await expect(attempt).rejects.toMatchObject({ code: "payment_in_flight" });
    await expect(attempt).rejects.toThrow("A payment for this invoice was already sent. Approve and pay records it.");
    expect(rpcBodies(fake.requests, "claim_invoice_decision")).toHaveLength(0);
    expect(patchBodies(fake.requests, "/rest/v1/invoices")).toHaveLength(0);
  });

  it("still rejects when the provider itself reported the transfer failed", async () => {
    const { fake, run } = approvalsFake({ intents: [{ source_id: INVOICE_ID, status: "failed", provider_tx_id: "circle-tx-1", last_error: null }] });

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

  it("maps self-approval from the claim to self_approval", async () => {
    const { run } = approvalsFake({
      claim: () => ({ status: 400, body: { code: "P0001", message: "self_approval: the person who created an invoice cannot approve it", details: null, hint: null } }),
    });
    await expect(run(() => returnInvoice({ actorId: ACTOR, invoiceId: INVOICE_ID }))).rejects.toThrow(
      "You created this invoice, so someone else must approve it."
    );
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
        decidedAt: null,
        createdBy: CREATOR,
        reviewedAt: null,
        reclaimable: false,
        paymentSent: false,
        address: "0xdead",
      },
    ]);
    const listing = fake.requests.find((r) => r.path === "/rest/v1/invoices" && r.method === "GET" && !r.params.get("id"));
    expect(listing?.params.get("direction")).toBe("eq.payable");
    expect(listing?.params.get("status")).toBe("in.(held,flagged,awaiting_info,processing)");
    expect(listing?.params.get("order")).toBe("due_date.asc");
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
    const rows = ["sent", "pending", "unreadable", "provider-failed", "none"].map((id) => invoiceRow({ id }));
    const { fake, run } = approvalsFake({
      invoice: (r) => (r.params.get("id") ? undefined : { body: rows }),
      intents: [
        { source_id: "sent", status: "confirmed", provider_tx_id: "tx-1", last_error: null },
        { source_id: "pending", status: "pending", provider_tx_id: "tx-2", last_error: null },
        { source_id: "unreadable", status: "failed", provider_tx_id: "tx-3", last_error: "provider unreachable" },
        { source_id: "provider-failed", status: "failed", provider_tx_id: "tx-4", last_error: null },
      ],
    });

    const listed = await run(() => listWaitingPayables());

    expect(Object.fromEntries(listed.map((row) => [row.id, row.paymentSent]))).toEqual({
      sent: true,
      pending: true,
      unreadable: true,
      "provider-failed": false,
      none: false,
    });
    const [lookup] = fake.requests.filter((r) => r.path === "/rest/v1/payment_intents");
    expect(lookup.params.get("source_type")).toBe("eq.invoice");
    expect(lookup.params.get("source_id")).toBe("in.(sent,pending,unreadable,provider-failed,none)");
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
