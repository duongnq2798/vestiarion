import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import { ApprovalError, approveAndPayMany } from "@/lib/agent/approvals";
import type { PayInvoiceInput, PayInvoiceResult } from "@/lib/agent/pay";
import type { PaymentExecution } from "@/lib/payments";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";
import { ARC_TESTNET } from "@/lib/network";

/**
 * Approving several bills with one confirmation (docs/superpowers/specs/2026-10-30-approve-many-design.md AM2-AM8):
 * `approveAndPayMany` over a real organization scope and a recorded network, with a real ledger key, the shape of
 * tests/approvals.test.ts, whose fake this one follows for several bills at once. What the transfers do is
 * tests/pay-invoices.test.ts's, so `payInvoice`, `payInvoices` and the balance sync are stand-ins here.
 */

const { payInvoiceMock, payInvoicesMock, syncOperatingBalanceMock } = vi.hoisted(() => ({
  payInvoiceMock: vi.fn(),
  payInvoicesMock: vi.fn(),
  syncOperatingBalanceMock: vi.fn(),
}));
vi.mock("@/lib/agent/pay", () => ({ payInvoice: payInvoiceMock, payInvoices: payInvoicesMock, syncOperatingBalance: syncOperatingBalanceMock }));

const { verdictMock } = vi.hoisted(() => ({ verdictMock: vi.fn() }));
vi.mock("@/lib/spending-limit/onchain", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/spending-limit/onchain")>()),
  spendingLimitVerdict: verdictMock,
}));

const { getChainProviderMock } = vi.hoisted(() => ({ getChainProviderMock: vi.fn() }));
vi.mock("@/lib/circle", () => ({
  getChainProvider: getChainProviderMock,
  chainModes: () => {
    const provider = getChainProviderMock() as { mode: "live" | "simulate"; earnMode: "live" | "simulate" };
    return { mode: provider.mode, earnMode: provider.earnMode };
  },
}));

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000a3a3";
const ACTOR = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000a1";
const CREATOR = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000b2";
const ACCOUNT_ID = "018f8ce0-1557-7b54-a931-4d777f6bca00";
const HASH = `0x${"e".repeat(64)}`;

/** Bills by letter: their ids, and their payees' counterparty ids beside them. */
const ID = (n: number) => `018f8ce0-1557-7b54-a931-4d777f6ba00${n}`;
const PAYEE = (n: number) => `018f8ce0-1557-7b54-a931-4d777f6bc00${n}`;
const [A, B, C, D, E, F, G] = [1, 2, 3, 4, 5, 6, 7].map(ID);

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
  for (const mock of [payInvoiceMock, payInvoicesMock, syncOperatingBalanceMock, verdictMock, getChainProviderMock]) mock.mockReset();
  getChainProviderMock.mockReturnValue({ mode: "simulate", network: ARC_TESTNET, earnMode: "simulate", estimatedFeeUsd: 0.01 });
});
afterEach(() => {
  if (savedMasterKeys === undefined) delete process.env.VESTIARION_MASTER_KEYS;
  else process.env.VESTIARION_MASTER_KEYS = savedMasterKeys;
});

function orgRow(fields: Record<string, unknown> = {}) {
  return {
    id: ORG,
    slug: "northstar",
    name: "Northstar",
    mode: "sandbox",
    ledger_signing_key_enc: encryptSecret(LEDGER_PEM, { orgId: ORG, column: "ledger_signing_key_enc" }, parseMasterKeys(MASTER_KEYS)),
    circle_api_key_enc: null,
    circle_entity_secret_enc: null,
    ...fields,
  };
}

const NAMES = ["Acme Supplies", "Bolt Freight", "Cobalt Studio", "Delta Print", "Echo Media", "Foxglove Ltd", "Garnet Labs"];

/** Bill `n` (1 for A), held for a person, entered by someone other than the actor. */
function bill(n: number, overrides: Record<string, unknown> = {}, payee: Record<string, unknown> = {}) {
  return {
    id: ID(n),
    amount: "100",
    currency: "USDC",
    due_date: `2026-11-0${n}`,
    status: "held",
    direction: "payable",
    agent_reasoning: "Held for manual review: over the daily limit.",
    decided_at: null,
    created_by: CREATOR,
    reviewed_at: null,
    counterparty_id: PAYEE(n),
    early_pay_discount_pct: null,
    discount_due_date: null,
    counterparties: { name: NAMES[n - 1], risk_level: "medium", address: `0x${String(n).repeat(40)}`, chain: null, ...payee },
    ...overrides,
  };
}

/** PostgREST as a selection meets it: `approvals.ts`'s reads and writes for each bill, and the ledger. */
function selectionFake(
  options: {
    bills?: Array<ReturnType<typeof bill>>;
    /** Payment intents, by `source_id`; none by default. */
    intents?: Array<Record<string, unknown>>;
    /** Vendors paid to their bank account (bank payouts B4), as `counterparty_bank_accounts` rows; none by default. */
    bankAccounts?: Array<Record<string, unknown>>;
    /** The operating account's stored balance; 500 by default; null for a workspace with none. */
    balance?: string | null;
    /** The agent's newest decision about a bill, by its id, as the verdict gate reads it (shadow mode S4); none by default. */
    decisions?: Record<string, Record<string, unknown>>;
    /** The workspace's `shadow_modes` row while shadow mode is on; off by default. */
    shadow?: Record<string, unknown>;
    twoApprovals?: number;
    ledgerTargets?: Array<Record<string, unknown>>;
    org?: Record<string, unknown>;
    platform?: ReturnType<typeof configFromEnv>;
    spendingLimit?: Record<string, unknown> | null;
    /** A bill's fields from its second read on, by its id: as `prepareApproval` reloads it after the selection read it. */
    reloaded?: Record<string, Record<string, unknown>>;
    /** Answers a request before the rest, for one test's own case; undefined leaves it to the rest. */
    extra?: (request: RecordedRequest) => FakeReply | undefined;
  } = {}
) {
  const bills = options.bills ?? [bill(1, { amount: "150" }), bill(2, { amount: "60" })];
  const intents = options.intents ?? [];
  const eq = (request: RecordedRequest, column: string) => request.params.get(column)?.match(/^eq\.(.+)$/)?.[1];
  const reads = new Map<string, number>();
  const fake = fakeSupabase((request): FakeReply => {
    const answered = options.extra?.(request);
    if (answered) return answered;
    if (request.path === "/rest/v1/orgs") return { body: orgRow(options.org) };
    if (request.path === "/rest/v1/spending_limit_contracts") return { body: options.spendingLimit ?? null };
    if (request.path === "/rest/v1/counterparties" && request.method === "GET") return { body: null };
    if (request.path === "/rest/v1/counterparties" && request.method === "PATCH") return { body: [] };
    if (request.path === "/rest/v1/invoices" && request.method === "GET" && request.params.get("select") === "id,counterparty_id") {
      const ids = request.params.get("id") ?? "";
      return { body: bills.filter((row) => ids.includes(row.id)) };
    }
    if (request.path === "/rest/v1/invoices" && request.method === "GET") {
      const id = eq(request, "id") ?? "";
      const row = bills.find((candidate) => candidate.id === id);
      reads.set(id, (reads.get(id) ?? 0) + 1);
      return { body: row ? { ...row, ...((reads.get(id) ?? 0) > 1 ? options.reloaded?.[id] : {}) } : null };
    }
    if (request.path === "/rest/v1/invoices" && request.method === "PATCH") return { body: [] };
    if (request.path === "/rest/v1/payment_intents" && request.method === "GET") {
      const one = eq(request, "source_id");
      return { body: one !== undefined ? (intents.find((intent) => intent.source_id === one) ?? null) : intents };
    }
    if (request.path === "/rest/v1/counterparty_bank_accounts") {
      const ids = request.params.get("counterparty_id") ?? "";
      return { body: (options.bankAccounts ?? []).filter((row) => ids.includes(String(row.counterparty_id))) };
    }
    if (request.path === "/rest/v1/accounts" && request.method === "GET" && request.params.get("kind") === "eq.reserve") return { body: null };
    if (request.path === "/rest/v1/accounts" && request.method === "GET") {
      return { body: options.balance === null ? null : { id: ACCOUNT_ID, balance: options.balance ?? "500" } };
    }
    if (request.path === "/rest/v1/rpc/claim_invoice_decision") {
      const body = request.body as Record<string, unknown>;
      return { body: { ...bills.find((row) => row.id === body.p_invoice_id), status: "processing", reviewed_by: body.p_by, reviewed_at: "2026-10-30T00:00:00Z" } };
    }
    if (request.path === "/rest/v1/rpc/ledger_entries_for_targets") return { body: options.ledgerTargets ?? [] };
    if (request.path === "/rest/v1/ledger_entries" && request.method === "GET") {
      const decision = options.decisions?.[eq(request, "detail->>invoiceId") ?? ""];
      return { body: decision ? [decision] : [] };
    }
    if (request.path === "/rest/v1/shadow_modes" && request.method === "GET") return { body: options.shadow ? [options.shadow] : [] };
    if (request.path === "/rest/v1/approval_policies") {
      return { body: options.twoApprovals ? [{ two_approvals_above: String(options.twoApprovals), payee_lock: false, payee_lock_cooling_hours: 0 }] : [] };
    }
    if (request.path === "/rest/v1/payment_approvals" && request.method === "GET") return { body: [] };
    if (request.path === "/rest/v1/payment_approvals" && request.method === "POST") {
      const body = request.body as Record<string, unknown>;
      return { status: 201, body: { id: "appr-new", approved_by: body.approved_by, approved_at: "2026-10-30T09:00:00.000Z", amount: String(body.amount), currency: body.currency, address: body.address } };
    }
    if (request.path === "/rest/v1/rpc/approvers_among") return { body: (request.body as { p_users: string[] }).p_users };
    if (request.path === "/rest/v1/rpc/approvers_besides") return { body: 2 };
    if (request.path === "/rest/v1/rpc/append_ledger_entry") {
      return {
        body: {
          seq: 1, id: "e1", ts: "2026-10-30T00:00:00Z", actor: "human", domain: "ap", action: "x",
          summary: "", detail: {}, body_hash: "00", signature: "00", prev_hash: null, hash: "00", signing_key_id: null,
        },
      };
    }
    return { body: [] };
  });
  return { fake, run: <T>(fn: () => Promise<T>) => runWith({ config: options.platform ?? config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, fn)) };
}

function rpcBodies(requests: RecordedRequest[], name: string) {
  return requests.filter((r) => r.path === `/rest/v1/rpc/${name}`).map((r) => r.body as Record<string, unknown>);
}
/** Each invoice write, by the invoice it names. */
function invoicePatches(requests: RecordedRequest[]): Array<Record<string, unknown>> {
  return requests
    .filter((r) => r.path === "/rest/v1/invoices" && r.method === "PATCH")
    .map((r) => ({ id: r.params.get("id")?.replace(/^eq\./, ""), ...(r.body as Record<string, unknown>) }));
}
const claimed = (requests: RecordedRequest[]) => rpcBodies(requests, "claim_invoice_decision").map((body) => body.p_invoice_id);
const entries = (requests: RecordedRequest[], action: string) => rpcBodies(requests, "append_ledger_entry").filter((body) => body.p_action === action);

function executed(over: Partial<PaymentExecution> = {}): PaymentExecution {
  return {
    idempotencyKey: "k", providerTxId: "tx-batch", txHash: HASH, txRef: HASH, status: "confirmed", attemptCount: 1, error: null, reconciled: false,
    chain: "ARC-TESTNET", providerMode: "live", feeUsd: 0.002, feeSource: "chain_reported", settledInMs: 2000, executedAt: "2026-10-30T10:00:00Z",
    attempt: 1, retriedAfter: null, route: null, batch: { key: "batch-1", size: 2 }, ...over,
  };
}

/** What `payInvoices` answers for each bill: paid in one batch by default. */
function paidTogether(over: Partial<PaymentExecution> = {}, result: Partial<PayInvoiceResult> = {}) {
  return async (inputs: PayInvoiceInput[]): Promise<PayInvoiceResult[]> =>
    inputs.map((input) => ({
      status: "paid",
      txRef: HASH,
      execution: executed({ batch: { key: "batch-1", size: inputs.length }, ...over }),
      note: "",
      operatingBalance: 290,
      amountPaid: input.amount,
      discountTaken: 0,
      ...result,
    }));
}

const items = (...ids: string[]) => ids.map((invoiceId) => ({ invoiceId }));

describe("approveAndPayMany: the selection (approve many AM3)", () => {
  it("refuses one bill, more than 20, or a bill named twice, whole, before anything is read", async () => {
    for (const selection of [items(A), Array.from({ length: 21 }, (_, n) => ({ invoiceId: `018f8ce0-1557-7b54-a931-4d777f6b${String(n).padStart(4, "0")}` })), items(A, B, A)]) {
      const { fake, run } = selectionFake();
      const attempt = run(() => approveAndPayMany({ actorId: ACTOR, items: selection }));
      await expect(attempt).rejects.toBeInstanceOf(ApprovalError);
      await expect(attempt).rejects.toMatchObject({ code: "selection_size", message: "Select from 2 to 20 bills to approve together, each once." });
      expect(fake.requests.filter((r) => r.path !== "/rest/v1/orgs")).toEqual([]);
    }
  });
});

describe("approveAndPayMany: paying together (approve many AM6, AM7)", () => {
  it("pays two bills in one execution, each claimed and recorded as alone, with the batch and how many were chosen together", async () => {
    payInvoicesMock.mockImplementation(paidTogether());
    const { fake, run } = selectionFake();

    const decisions = await run(() => approveAndPayMany({ actorId: ACTOR, items: [{ invoiceId: A, shownAddress: `0x${"1".repeat(40)}` }, { invoiceId: B }] }));

    // Decided in the order sent, each through its own claim.
    expect(claimed(fake.requests)).toEqual([A, B]);
    // Both transfers in one call, each the request Approve and pay builds for it alone.
    expect(payInvoicesMock).toHaveBeenCalledTimes(1);
    expect(payInvoicesMock.mock.calls[0][0]).toEqual([
      { invoiceId: A, counterpartyId: PAYEE(1), address: `0x${"1".repeat(40)}`, amount: 150, discount: null, currency: "USDC" },
      { invoiceId: B, counterpartyId: PAYEE(2), address: `0x${"2".repeat(40)}`, amount: 60, discount: null, currency: "USDC" },
    ]);
    expect(payInvoicesMock.mock.calls[0][1]).toMatchObject({ operating: { id: ACCOUNT_ID } });
    expect(payInvoiceMock).not.toHaveBeenCalled();

    const patches = invoicePatches(fake.requests);
    expect(patches.map((patch) => [patch.id, patch.status, patch.tx_ref])).toEqual([
      [A, "paid", HASH],
      [B, "paid", HASH],
    ]);
    expect(patches[0].agent_reasoning).toBe("Held for manual review: over the daily limit. [approved and paid by a person] [paid in one Arc transaction with 1 other bill]");

    const paid = entries(fake.requests, "approval_paid");
    expect(paid.map((entry) => entry.p_summary)).toEqual(["Approved and paid 150 USDC to Acme Supplies", "Approved and paid 60 USDC to Bolt Freight"]);
    for (const [index, id] of [A, B].entries()) {
      expect(paid[index].p_detail).toMatchObject({ by: ACTOR, invoiceId: id, status: "paid", txRef: HASH, batch: { key: "batch-1", size: 2 }, approvedTogether: 2 });
    }

    expect(decisions.map((decision) => [decision.invoiceId, decision.outcome?.status, decision.outcome?.batch, decision.error])).toEqual([
      [A, "paid", { key: "batch-1", size: 2 }, undefined],
      [B, "paid", { key: "batch-1", size: 2 }, undefined],
    ]);
    expect(decisions[0].bill).toEqual({ payee: "Acme Supplies", amount: 150, currency: "USDC" });
    expect(decisions[0].outcome?.paid).toEqual({ amount: 150, currency: "USDC", payee: "Acme Supplies", simulated: true });
  });

  it("names no batch in the reasoning of a bill whose transfer went alone, and still says how many were chosen together", async () => {
    payInvoicesMock.mockImplementation(paidTogether({ batch: null }));
    const { fake, run } = selectionFake();
    await run(() => approveAndPayMany({ actorId: ACTOR, items: items(A, B) }));
    expect(invoicePatches(fake.requests)[0].agent_reasoning).toBe("Held for manual review: over the daily limit. [approved and paid by a person]");
    const [first] = entries(fake.requests, "approval_paid");
    expect(first.p_detail).toMatchObject({ approvedTogether: 2 });
    expect(first.p_detail).not.toHaveProperty("batch");
  });

  it("pays each bill alone through payInvoice where the workspace pays from its owner's wallet contract (wallet treasury W11)", async () => {
    const mainnet = configFromEnv({
      NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
      SUPABASE_SERVICE_ROLE_KEY: "k",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
      SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
      MAINNET_ENABLED: "1",
    });
    verdictMock.mockResolvedValue({ state: "allowed" });
    payInvoiceMock.mockResolvedValue({ status: "paid", txRef: HASH, execution: executed({ batch: null }), note: "", operatingBalance: 0, amountPaid: 30, discountTaken: 0 });
    const { fake, run } = selectionFake({
      platform: mainnet,
      org: { network: "arc-mainnet", wallet_host: "external", mode: "live" },
      spendingLimit: { id: "slc-1", address: `0x${"5".repeat(40)}`, agent_wallet_id: "agent-wallet", agent_address: `0x${"a".repeat(40)}`, enforced: true },
      // Under the 100 USDC above which a workspace on Arc mainnet needs two approvals from the start.
      bills: [bill(1, { amount: "30" }), bill(2, { amount: "20" })],
    });

    await run(() => approveAndPayMany({ actorId: ACTOR, items: items(A, B) }));

    expect(payInvoicesMock).not.toHaveBeenCalled();
    expect(payInvoiceMock.mock.calls.map((call) => [call[0].invoiceId, call[0].spendingLimit?.agentWalletId, call[1].retryTerminalFailure])).toEqual([
      [A, "agent-wallet", true],
      [B, "agent-wallet", true],
    ]);
    expect(entries(fake.requests, "approval_paid")).toHaveLength(2);
  });

  it("pays a bill through the owner's wallet contract as soon as it is decided, so the contract checks the next with it counted (approve many review money-3)", async () => {
    const mainnet = configFromEnv({
      NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
      SUPABASE_SERVICE_ROLE_KEY: "k",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
      SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
      MAINNET_ENABLED: "1",
    });
    // The contract's daily limit is 100 USDC: it counts what it paid, as its simulated pay reads it on Arc.
    const order: string[] = [];
    let spent = 0;
    verdictMock.mockImplementation(async (asked: { to: string; amount: number }) => {
      order.push(`check ${asked.to.slice(2, 3)} with ${spent} paid`);
      return spent + asked.amount > 100 ? { state: "refused", error: "OverDailyLimit", spent, amount: asked.amount, limit: 100 } : { state: "allowed" };
    });
    payInvoiceMock.mockImplementation(async (payment: PayInvoiceInput) => {
      order.push(`send ${String(payment.address).slice(2, 3)}`);
      spent += payment.amount;
      return { status: "paid", txRef: HASH, execution: executed({ batch: null }), note: "", operatingBalance: 0, amountPaid: payment.amount, discountTaken: 0 };
    });
    const { fake, run } = selectionFake({
      platform: mainnet,
      org: { network: "arc-mainnet", wallet_host: "external", mode: "live" },
      spendingLimit: { id: "slc-1", address: `0x${"5".repeat(40)}`, agent_wallet_id: "agent-wallet", agent_address: `0x${"a".repeat(40)}`, enforced: true },
      bills: [bill(1, { amount: "60" }), bill(2, { amount: "60" })],
    });

    const decisions = await run(() => approveAndPayMany({ actorId: ACTOR, items: items(A, B) }));

    // As approved one after the other: B is checked with A's 60 USDC counted, and refused by name before its claim.
    expect(order).toEqual(["check 1 with 0 paid", "send 1", "check 2 with 60 paid"]);
    expect(decisions[0].outcome?.status).toBe("paid");
    expect(decisions[1].error).toMatchObject({ code: "payments_off", message: "Paying 60 USDC would pass the contract's daily limit of 100 USDC: 60 USDC paid so far." });
    expect(claimed(fake.requests)).toEqual([A]);
    expect(payInvoiceMock).toHaveBeenCalledTimes(1);
    expect(payInvoicesMock).not.toHaveBeenCalled();
  });
});

describe("approveAndPayMany: which bills a selection takes (approve many AM2)", () => {
  it("refuses by name, and never claims, a bill it does not take, and decides the others", async () => {
    payInvoicesMock.mockImplementation(paidTogether({ batch: null }));
    const { fake, run } = selectionFake({
      bills: [
        bill(1),
        bill(2, { currency: "EURC" }),
        bill(3),
        bill(4),
        bill(5, {}, { chain: "BASE-SEPOLIA" }),
        // Claimed by someone else a moment ago.
        bill(6, { status: "processing", reviewed_at: new Date().toISOString() }),
        bill(7, {}, { risk_level: "high" }),
      ],
      // A payment was tried for C: a retry, or a transfer to record, is approved on its own.
      intents: [{ source_id: C, status: "failed", provider_tx_id: "circle-tx-1", last_error: null, provider_state: "FAILED", transfer_attempt: 1 }],
      bankAccounts: [{ id: "row-1", counterparty_id: PAYEE(4), external_id: "ba_TestAccount01", bank_code: "012", last4: "9716", beneficiary_name: "Ana Lopez", status: "approved", added_at: "2026-10-16T08:00:00Z" }],
    });
    const unknown = "018f8ce0-1557-7b54-a931-4d777f6ba0ff";

    const decisions = await run(() => approveAndPayMany({ actorId: ACTOR, items: items(A, B, C, D, E, F, G, unknown) }));

    expect(decisions.map((decision) => [decision.invoiceId, (decision.error as ApprovalError | undefined)?.code ?? decision.outcome?.status, decision.error?.message])).toEqual([
      [A, "paid", undefined],
      [B, "approve_alone", "Approve it on its own: it is in EURC."],
      [C, "approve_alone", "Approve it on its own: a payment was already tried for it."],
      [D, "approve_alone", "Approve it on its own: its vendor is paid to a bank account."],
      [E, "approve_alone", "Approve it on its own: its payee is paid on another chain."],
      [F, "already_decided", "Someone else decided this invoice a moment ago."],
      [G, "high_risk", "This counterparty is screened high risk. Clear it in Compliance first."],
      [unknown, "invoice_not_found", "That invoice is not waiting for a decision."],
    ]);
    expect(claimed(fake.requests)).toEqual([A]);
    expect(payInvoicesMock.mock.calls[0][0].map((input: PayInvoiceInput) => input.invoiceId)).toEqual([A]);
    expect(decisions[1].bill).toEqual({ payee: "Bolt Freight", amount: 100, currency: "EURC" });
    expect(decisions[7].bill).toBeNull();
  });

  it("refuses a bill held for a shadow verdict, which a verdict decides, and never counts or claims it", async () => {
    payInvoicesMock.mockImplementation(paidTogether({ batch: null }));
    // B's newest decision waits for a person to agree in shadow mode, on since before it (shadow mode S4).
    const shadowHold = {
      seq: 41, ts: "2026-10-29T08:00:00Z", actor: "agent", action: "ap_pay", summary: "Pay Bolt Freight 60 USDC",
      detail: { invoiceId: B, execution: { resultingStatus: "held", heldBecause: "shadow_verdict" } },
    };
    // A alone is covered: B, refused, is not counted (AM4).
    const { fake, run } = selectionFake({ balance: "150", decisions: { [B]: shadowHold }, shadow: { currency: "USD", started_at: "2026-10-29T07:00:00Z", started_by: ACTOR } });

    const decisions = await run(() => approveAndPayMany({ actorId: ACTOR, items: items(A, B) }));

    expect(decisions[0].outcome?.status).toBe("paid");
    expect(decisions[1].error).toMatchObject({ code: "verdict_needed", message: "This decision waits for a verdict in shadow mode. Agree or disagree with it in Approvals first." });
    expect(claimed(fake.requests)).toEqual([A]);
  });
});

describe("approveAndPayMany: funds, before anything is claimed (approve many AM4)", () => {
  it("refuses the whole selection when the operating wallet does not cover the bills together, and never reads the reserve", async () => {
    const { fake, run } = selectionFake({ balance: "200" });
    const attempt = run(() => approveAndPayMany({ actorId: ACTOR, items: items(A, B) }));
    await expect(attempt).rejects.toMatchObject({
      code: "insufficient_funds",
      message: "These 2 bills come to 210 USDC; the operating wallet holds 200 USDC. Select fewer, or approve them one at a time, which can bring cash back from the reserve.",
    });
    expect(claimed(fake.requests)).toEqual([]);
    expect(fake.requests.some((r) => r.path === "/rest/v1/accounts" && r.params.get("kind") === "eq.reserve")).toBe(false);
    expect(payInvoicesMock).not.toHaveBeenCalled();
  });

  it("counts only the bills the selection takes", async () => {
    payInvoicesMock.mockImplementation(paidTogether({ batch: null }));
    // 210 USDC with B, which is in EURC and refused by name; A alone is covered.
    const { fake, run } = selectionFake({ balance: "200", bills: [bill(1, { amount: "150" }), bill(2, { amount: "60", currency: "EURC" })] });
    const decisions = await run(() => approveAndPayMany({ actorId: ACTOR, items: items(A, B) }));
    expect(decisions[0].outcome?.status).toBe("paid");
    expect(claimed(fake.requests)).toEqual([A]);
  });

  it("reads the balance once on a live provider, synced as Approve and pay reads it", async () => {
    getChainProviderMock.mockReturnValue({ mode: "live", network: ARC_TESTNET, earnMode: "simulate", estimatedFeeUsd: 0.01 });
    // The stored balance would cover them; the wallet, synced now, does not.
    syncOperatingBalanceMock.mockResolvedValue(100);
    const { fake, run } = selectionFake({ balance: "500" });
    await expect(run(() => approveAndPayMany({ actorId: ACTOR, items: items(A, B) }))).rejects.toMatchObject({ code: "insufficient_funds" });
    expect(syncOperatingBalanceMock).toHaveBeenCalledTimes(1);
    expect(syncOperatingBalanceMock).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(claimed(fake.requests)).toEqual([]);
  });

  it("decides each bill on a live provider against the one balance the selection read, never syncing it again (AM4)", async () => {
    getChainProviderMock.mockReturnValue({ mode: "live", network: ARC_TESTNET, earnMode: "simulate", estimatedFeeUsd: 0.01 });
    syncOperatingBalanceMock.mockResolvedValue(250);
    payInvoicesMock.mockImplementation(paidTogether());
    const { fake, run } = selectionFake();

    const decisions = await run(() => approveAndPayMany({ actorId: ACTOR, items: items(A, B) }));

    expect(decisions.map((decision) => decision.outcome?.status)).toEqual(["paid", "paid"]);
    // One read for the selection, before any claim; each bill's own funds check takes it, as Approve and pay would sync.
    expect(syncOperatingBalanceMock).toHaveBeenCalledTimes(1);
    expect(syncOperatingBalanceMock.mock.invocationCallOrder[0]).toBeLessThan(payInvoicesMock.mock.invocationCallOrder[0]);
    expect(fake.requests.some((r) => r.path === "/rest/v1/accounts" && r.params.get("kind") === "eq.reserve")).toBe(false);
  });

  it("refuses a bill whose amount rose past the selection's balance by the time it is decided, and never brings cash back from the reserve for it (AM4)", async () => {
    getChainProviderMock.mockReturnValue({ mode: "live", network: ARC_TESTNET, earnMode: "simulate", estimatedFeeUsd: 0.01 });
    syncOperatingBalanceMock.mockResolvedValue(250);
    payInvoicesMock.mockImplementation(paidTogether({ batch: null }));
    // A and B come to 210 when the selection reads them; B reads 300 when it is decided.
    const { fake, run } = selectionFake({ reloaded: { [B]: { amount: "300" } } });

    const decisions = await run(() => approveAndPayMany({ actorId: ACTOR, items: items(A, B) }));

    expect(decisions[0].outcome?.status).toBe("paid");
    expect(decisions[1].error).toMatchObject({ code: "insufficient_funds" });
    expect(claimed(fake.requests)).toEqual([A]);
    expect(syncOperatingBalanceMock).toHaveBeenCalledTimes(1);
    expect(fake.requests.some((r) => r.path === "/rest/v1/accounts" && r.params.get("kind") === "eq.reserve")).toBe(false);
    expect(entries(fake.requests, "cash_brought_back")).toEqual([]);
  });

  it("refuses the whole selection where the workspace has no operating account", async () => {
    const { fake, run } = selectionFake({ balance: null });
    await expect(run(() => approveAndPayMany({ actorId: ACTOR, items: items(A, B) }))).rejects.toMatchObject({ code: "no_operating_account" });
    expect(claimed(fake.requests)).toEqual([]);
  });
});

describe("approveAndPayMany: each bill on its own (approve many AM5)", () => {
  it("reports one bill's refusal and decides the next", async () => {
    payInvoicesMock.mockImplementation(paidTogether({ batch: null }));
    // A was entered by the person approving, who is not the workspace's only approver.
    const { fake, run } = selectionFake({ bills: [bill(1, { created_by: ACTOR }), bill(2), bill(3)] });
    const decisions = await run(() => approveAndPayMany({ actorId: ACTOR, items: items(A, B, C) }));
    expect(decisions[0].error).toMatchObject({ code: "self_approval", message: "You created this invoice, so someone else must approve it." });
    expect(decisions.slice(1).map((decision) => decision.outcome?.status)).toEqual(["paid", "paid"]);
    expect(claimed(fake.requests)).toEqual([B, C]);
    expect(payInvoicesMock.mock.calls[0][0].map((input: PayInvoiceInput) => input.invoiceId)).toEqual([B, C]);
  });

  it("refuses a bill whose address changed since the page loaded, by its own shown address", async () => {
    payInvoicesMock.mockImplementation(paidTogether({ batch: null }));
    const { fake, run } = selectionFake();
    const decisions = await run(() =>
      approveAndPayMany({ actorId: ACTOR, items: [{ invoiceId: A, shownAddress: "0xold" }, { invoiceId: B, shownAddress: `0x${"2".repeat(40)}` }] })
    );
    expect(decisions[0].error).toMatchObject({ code: "address_changed" });
    expect(decisions[1].outcome?.status).toBe("paid");
    expect(claimed(fake.requests)).toEqual([B]);
  });

  it("keeps an unexpected error to the bill it stopped, and still pays a bill prepared before it with the approvals it used (approve many review money-4)", async () => {
    payInvoicesMock.mockImplementation(paidTogether({ batch: null }));
    const other = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c3";
    // A is above the figure and another person's approval stands, so this one pays it; B's claim meets a database error.
    const { fake, run } = selectionFake({
      twoApprovals: 100,
      extra: (request) => {
        if (request.path === "/rest/v1/payment_approvals" && request.method === "GET" && request.params.get("source_id")?.includes(A)) {
          return { body: [{ id: "appr-other", approved_by: other, approved_at: "2026-10-29T09:00:00.000Z", amount: "150", currency: "USDC", address: `0x${"1".repeat(40)}` }] };
        }
        if (request.path === "/rest/v1/rpc/claim_invoice_decision" && (request.body as Record<string, unknown>).p_invoice_id === B) {
          return { status: 500, body: { message: "connection reset" } };
        }
        return undefined;
      },
    });

    const decisions = await run(() => approveAndPayMany({ actorId: ACTOR, items: items(A, B) }));

    expect(decisions[0].outcome?.status).toBe("paid");
    expect(decisions[1].outcome).toBeUndefined();
    expect(decisions[1].error?.message).toBe("connection reset");
    expect(decisions[1].error).not.toBeInstanceOf(ApprovalError);
    expect(payInvoicesMock.mock.calls[0][0].map((input: PayInvoiceInput) => input.invoiceId)).toEqual([A]);
    // A is recorded paid on its two approvals, never given back for B's failure.
    expect(invoicePatches(fake.requests).map((patch) => [patch.id, patch.status])).toEqual([[A, "paid"]]);
    const [paid] = entries(fake.requests, "approval_paid");
    expect((paid.p_detail as Record<string, unknown>).approvals).toEqual([
      { by: other, at: "2026-10-29T09:00:00.000Z" },
      { by: ACTOR, at: expect.any(String) },
    ]);
  });

  it("records the first of two approvals for a bill above the figure, sending nothing for it, and pays the other (two approvals T4)", async () => {
    payInvoicesMock.mockImplementation(paidTogether({ batch: null }));
    const { fake, run } = selectionFake({ twoApprovals: 100 });
    const decisions = await run(() => approveAndPayMany({ actorId: ACTOR, items: items(A, B) }));

    expect(decisions.map((decision) => decision.outcome?.status)).toEqual(["approved", "paid"]);
    expect(entries(fake.requests, "approval_given").map((entry) => (entry.p_detail as Record<string, unknown>).invoiceId)).toEqual([A]);
    expect(claimed(fake.requests)).toEqual([B]);
    expect(payInvoicesMock.mock.calls[0][0].map((input: PayInvoiceInput) => input.invoiceId)).toEqual([B]);
  });
});

describe("approveAndPayMany: failure (approve many AM6, AM8)", () => {
  it("holds both bills of a batch Circle ended in a terminal failure, each with Circle's reason", async () => {
    payInvoicesMock.mockImplementation(
      paidTogether({ status: "failed", txHash: null, txRef: "tx-batch", error: "Circle reported FAILED" }, { status: "held", txRef: "tx-batch", note: " [transfer failed: Circle reported FAILED]", operatingBalance: null })
    );
    const { fake, run } = selectionFake();
    const decisions = await run(() => approveAndPayMany({ actorId: ACTOR, items: items(A, B) }));

    expect(decisions.map((decision) => decision.outcome?.status)).toEqual(["held", "held"]);
    const patches = invoicePatches(fake.requests);
    expect(patches.map((patch) => [patch.id, patch.status, patch.paid_amount])).toEqual([
      [A, "held", null],
      [B, "held", null],
    ]);
    expect(patches[0].agent_reasoning).toBe(
      "Held for manual review: over the daily limit. [approved by a person; payment not confirmed] [transfer failed: Circle reported FAILED]"
    );
    const failed = entries(fake.requests, "approval_paid");
    expect(failed.map((entry) => entry.p_summary)).toEqual(["Approved; payment of 150 USDC to Acme Supplies failed", "Approved; payment of 60 USDC to Bolt Freight failed"]);
    expect(failed[1].p_detail).toMatchObject({ status: "held", batch: { key: "batch-1", size: 2 }, approvedTogether: 2 });
  });

  it("leaves both bills of a batch whose answer was lost submitted, saying so", async () => {
    payInvoicesMock.mockImplementation(
      paidTogether(
        { status: "pending", providerTxId: null, txHash: null, txRef: null, error: "socket hang up" },
        { status: "matched", txRef: null, note: " [socket hang up]", operatingBalance: null }
      )
    );
    const { fake, run } = selectionFake();
    const decisions = await run(() => approveAndPayMany({ actorId: ACTOR, items: items(A, B) }));
    expect(decisions.map((decision) => [decision.outcome?.status, decision.outcome?.batch])).toEqual([
      ["matched", { key: "batch-1", size: 2 }],
      ["matched", { key: "batch-1", size: 2 }],
    ]);
    expect(invoicePatches(fake.requests).map((patch) => [patch.status, patch.agent_reasoning])).toEqual([
      ["matched", "Held for manual review: over the daily limit. [approved by a person; payment submitted] [socket hang up]"],
      ["matched", "Held for manual review: over the daily limit. [approved by a person; payment submitted] [socket hang up]"],
    ]);
  });

  it("gives back every prepared bill when sending throws, and reports the error for each", async () => {
    payInvoicesMock.mockRejectedValue(new Error("connection reset"));
    const { fake, run } = selectionFake();
    const decisions = await run(() => approveAndPayMany({ actorId: ACTOR, items: items(A, B) }));

    expect(decisions.map((decision) => [decision.outcome, decision.error?.message])).toEqual([
      [undefined, "connection reset"],
      [undefined, "connection reset"],
    ]);
    expect(invoicePatches(fake.requests).map((patch) => [patch.id, patch.status, patch.agent_reasoning])).toEqual([
      [A, "held", "Held for manual review: over the daily limit. [approval interrupted: connection reset]"],
      [B, "held", "Held for manual review: over the daily limit. [approval interrupted: connection reset]"],
    ]);
    expect(entries(fake.requests, "approval_paid")).toEqual([]);
  });
});

describe("approveAndPayMany: the reason (approve many AM9)", () => {
  const decided = (invoiceId: string, seq: number, detail: Record<string, unknown>) => ({
    seq, id: `e-${seq}`, ts: "2026-10-29T08:00:00Z", actor: "agent", domain: "ap", action: "ap_pay", summary: "",
    detail: { invoiceId, decision: { action: "pay" }, observed: { riskLevel: "clear" }, guardrailBlocked: false, guardrailRule: null, ...detail },
    body_hash: "00", signature: "00", prev_hash: null, hash: "00", signing_key_id: null,
  });

  it("marks the bills paid against the agent's hold: flagged, or held on a rule; not held for cash or its vendor's document", async () => {
    payInvoicesMock.mockImplementation(paidTogether({ batch: null }));
    const { run } = selectionFake({
      bills: [bill(1, { status: "flagged" }), bill(2), bill(3), bill(4)],
      ledgerTargets: [
        decided(B, 2, { guardrailBlocked: true, guardrailRule: "payment.daily_limit", execution: { resultingStatus: "held" } }),
        decided(C, 3, { execution: { resultingStatus: "held", heldBecause: "cash_shortfall" } }),
        decided(D, 4, { guardrailBlocked: true, guardrailRule: "invoice.vendor_document", execution: { resultingStatus: "held" } }),
      ],
    });
    const decisions = await run(() => approveAndPayMany({ actorId: ACTOR, items: items(A, B, C, D) }));
    expect(decisions.map((decision) => decision.overridesHold)).toEqual([true, true, false, false]);
  });
});
