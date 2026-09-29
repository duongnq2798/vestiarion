import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv, type FollowUpConfig } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { withOrg } from "@/lib/dal/scope";
import { applyFollowUp, existingPaymentIntents, reconcileApInvoice } from "@/lib/agent/orchestrator";
import type { ChainProvider } from "@/lib/circle";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * Two cycle seams the control work leans on, each tested directly rather
 * than through a full `runAgentCycle()` (see `tests/pause-cycle.test.ts` for
 * why a full cycle is out of proportion):
 *
 * - the follow-up stage's reopen or escalation, which must be a
 *   compare-and-set on the status it read, so it never overwrites a row a
 *   person has claimed meanwhile;
 * - the AP stage's reconciliation of a `matched` payable whose payment is
 *   already in flight, which must go to `payInvoice` — whose idempotency key
 *   makes it reconcile, not pay again — and never back through the model and
 *   the guardrails that could turn a person's approval into a hold.
 *
 * Both write the ledger, so the scope is a real organization with a real
 * ledger key over the recorded fake, as in `tests/approvals.test.ts`.
 */

const { payInvoiceMock, decideMock, guardrailsMock } = vi.hoisted(() => ({
  payInvoiceMock: vi.fn(),
  decideMock: vi.fn(),
  guardrailsMock: vi.fn(),
}));
vi.mock("@/lib/agent/pay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/pay")>()),
  payInvoice: payInvoiceMock,
}));
vi.mock("@/lib/agent/decide", () => ({ decide: decideMock }));
vi.mock("@/lib/agent/guardrails", () => ({ enforceApGuardrails: guardrailsMock }));

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000c1c1";
const INVOICE_ID = "018f8ce0-1557-7b54-a931-4d777f6bc001";
const COUNTERPARTY_ID = "018f8ce0-1557-7b54-a931-4d777f6bc002";
const ACCOUNT_ID = "018f8ce0-1557-7b54-a931-4d777f6bc003";

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
  decideMock.mockReset();
  guardrailsMock.mockReset();
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
    mode: "live",
    ledger_signing_key_enc: encryptSecret(LEDGER_PEM, { orgId: ORG, column: "ledger_signing_key_enc" }, parseMasterKeys(MASTER_KEYS)),
    circle_api_key_enc: null,
    circle_entity_secret_enc: null,
  };
}

const LEDGER_ROW = {
  seq: 1, id: "e1", ts: "2026-09-29T00:00:00Z", actor: "agent", domain: "ap", action: "x",
  summary: "", detail: {}, body_hash: "00", signature: "00", prev_hash: null, hash: "00", signing_key_id: null,
};

/** PostgREST for these seams: the org row for the scope, the ledger append, and whatever `respond` answers. */
function cycleFake(respond: (request: RecordedRequest) => FakeReply | undefined = () => undefined) {
  const fake = fakeSupabase((request) => {
    if (request.path === "/rest/v1/orgs") return { body: orgRow() };
    if (request.path === "/rest/v1/rpc/append_ledger_entry") return { body: LEDGER_ROW };
    return respond(request) ?? { body: [] };
  });
  return { fake, run: <T>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, fn)) };
}

function rpcBodies(requests: RecordedRequest[], name: string) {
  return requests.filter((r) => r.path === `/rest/v1/rpc/${name}`).map((r) => r.body as Record<string, unknown>);
}
function invoicePatches(requests: RecordedRequest[]) {
  return requests.filter((r) => r.path === "/rest/v1/invoices" && r.method === "PATCH");
}

const FOLLOW_UP_CONFIG: FollowUpConfig = { staleAfterDays: 7, reEscalateAfterDays: 3 };

describe("applyFollowUp — the follow-up stage's write is a compare-and-set", () => {
  const reopen = { action: "reopen" as const, reason: "The purchase order arrived.", changes: ["PO added"], ageDays: 2, pastDue: false };
  const escalate = { action: "escalate" as const, reason: "Stale.", changes: [], ageDays: 9, pastDue: true };

  it("reopens only while the invoice still has the status it was read with", async () => {
    const { fake, run } = cycleFake((r) => (r.path === "/rest/v1/invoices" && r.method === "PATCH" ? { body: [{ id: INVOICE_ID }] } : undefined));

    const line = await run(() => applyFollowUp(db(), { id: INVOICE_ID, status: "held", amount: 150 }, reopen, FOLLOW_UP_CONFIG, Date.now()));

    const [patch] = invoicePatches(fake.requests);
    expect(patch.body).toEqual({ status: "pending" });
    expect(patch.params.get("id")).toBe(`eq.${INVOICE_ID}`);
    expect(patch.params.get("status")).toBe("eq.held");
    expect(patch.params.get("select")).toBe("id");
    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(append.p_action).toBe("invoice_reopened");
    expect(line).toEqual({ domain: "ap", message: "Reopened 150 USDC invoice: PO added" });
  });

  it("writes no ledger entry and no cycle line when a person claimed the invoice meanwhile", async () => {
    // The PATCH matched no row: the invoice is `processing` now, not `held`.
    const { fake, run } = cycleFake((r) => (r.path === "/rest/v1/invoices" && r.method === "PATCH" ? { body: [] } : undefined));

    const line = await run(() => applyFollowUp(db(), { id: INVOICE_ID, status: "held", amount: 150 }, reopen, FOLLOW_UP_CONFIG, Date.now()));

    expect(line).toBeNull();
    expect(invoicePatches(fake.requests)).toHaveLength(1);
    expect(rpcBodies(fake.requests, "append_ledger_entry")).toHaveLength(0);
  });

  it("guards an escalation the same way", async () => {
    const { fake, run } = cycleFake((r) => (r.path === "/rest/v1/invoices" && r.method === "PATCH" ? { body: [] } : undefined));

    const line = await run(() => applyFollowUp(db(), { id: INVOICE_ID, status: "awaiting_info", amount: 150 }, escalate, FOLLOW_UP_CONFIG, Date.now()));

    const [patch] = invoicePatches(fake.requests);
    expect(Object.keys(patch.body as object)).toEqual(["escalated_at"]);
    expect(patch.params.get("status")).toBe("eq.awaiting_info");
    expect(line).toBeNull();
    expect(rpcBodies(fake.requests, "append_ledger_entry")).toHaveLength(0);
  });

  it("throws the database's own error when the write fails", async () => {
    const { run } = cycleFake((r) =>
      r.path === "/rest/v1/invoices" && r.method === "PATCH" ? { status: 500, body: { message: "invoices update failed: connection reset" } } : undefined
    );

    await expect(
      run(() => applyFollowUp(db(), { id: INVOICE_ID, status: "held", amount: 150 }, reopen, FOLLOW_UP_CONFIG, Date.now()))
    ).rejects.toThrow("invoices update failed: connection reset");
  });
});

describe("existingPaymentIntents — which payables the AP stage reconciles instead of deciding", () => {
  it("looks up intents for matched payables only, keyed by invoice id", async () => {
    const { fake, run } = cycleFake((r) =>
      r.path === "/rest/v1/payment_intents" ? { body: [{ source_id: "matched-1", provider_tx_id: "circle-tx-1", status: "pending" }] } : undefined
    );

    const intents = await run(() =>
      existingPaymentIntents(db(), [
        { id: "pending-1", status: "pending" },
        { id: "matched-1", status: "matched" },
        { id: "matched-2", status: "matched" },
      ])
    );

    expect([...intents.entries()]).toEqual([["matched-1", { providerTxId: "circle-tx-1", status: "pending" }]]);
    const [lookup] = fake.requests.filter((r) => r.path === "/rest/v1/payment_intents");
    expect(lookup.params.get("source_type")).toBe("eq.invoice");
    expect(lookup.params.get("source_id")).toBe("in.(matched-1,matched-2)");
  });

  it("leaves out a submission that failed before the provider returned an id, so the invoice is decided again", async () => {
    const { run } = cycleFake((r) =>
      r.path === "/rest/v1/payment_intents"
        ? {
            body: [
              { source_id: "failed-no-id", provider_tx_id: null, status: "failed" },
              { source_id: "failed-by-provider", provider_tx_id: "circle-tx-2", status: "failed" },
              { source_id: "submitting", provider_tx_id: null, status: "submitting" },
            ],
          }
        : undefined
    );

    const intents = await run(() =>
      existingPaymentIntents(db(), [
        { id: "failed-no-id", status: "matched" },
        { id: "failed-by-provider", status: "matched" },
        { id: "submitting", status: "matched" },
      ])
    );

    // Nothing moved for failed-no-id: it goes back through the model and the guardrails.
    expect(intents.has("failed-no-id")).toBe(false);
    // A transfer Circle reported failed is a real transfer, still reconciled by its id.
    expect(intents.get("failed-by-provider")).toEqual({ providerTxId: "circle-tx-2", status: "failed" });
    expect(intents.get("submitting")).toEqual({ providerTxId: null, status: "submitting" });
  });

  it("asks nothing when no payable is matched", async () => {
    const { fake, run } = cycleFake();

    const intents = await run(() => existingPaymentIntents(db(), [{ id: "pending-1", status: "pending" }]));

    expect(intents.size).toBe(0);
    expect(fake.requests.some((r) => r.path === "/rest/v1/payment_intents")).toBe(false);
  });
});

describe("reconcileApInvoice — a matched payable with a payment in flight", () => {
  const provider = { mode: "live", earnMode: "simulate", estimatedFeeUsd: 0.003 } as unknown as ChainProvider;
  const invoice = {
    id: INVOICE_ID,
    amount: 150,
    counterpartyId: COUNTERPARTY_ID,
    counterpartyName: "Acme Supplies",
    address: "0xdead",
    reasoning: "Held for manual review. [approved and paid by a person] [transfer submitted; awaiting provider confirmation]",
    txRef: "circle-tx-1",
  };

  it("goes to payInvoice without the model or the guardrails, and records paid with the txRef", async () => {
    payInvoiceMock.mockResolvedValue({
      status: "paid", txRef: "0xhash", note: "", operatingBalance: 350,
      execution: { providerMode: "live", feeUsd: 0.003, feeSource: "chain_reported", settledInMs: 4000, executedAt: "2026-09-29T00:00:00Z", reconciled: true },
    });
    const { fake, run } = cycleFake();

    const outcome = await run(() =>
      reconcileApInvoice(invoice, { providerTxId: "circle-tx-1", status: "pending" }, { db: db(), provider, operating: { id: ACCOUNT_ID } })
    );

    expect(decideMock).not.toHaveBeenCalled();
    expect(guardrailsMock).not.toHaveBeenCalled();
    expect(payInvoiceMock).toHaveBeenCalledTimes(1);
    expect(payInvoiceMock).toHaveBeenCalledWith(
      { invoiceId: INVOICE_ID, counterpartyId: COUNTERPARTY_ID, address: "0xdead", amount: 150 },
      { provider, operating: { id: ACCOUNT_ID } }
    );
    // A transfer already exists, so nothing new can move: the pause is not consulted.
    expect(rpcBodies(fake.requests, "agent_paused")).toHaveLength(0);

    const [patch] = invoicePatches(fake.requests);
    expect(patch.params.get("id")).toBe(`eq.${INVOICE_ID}`);
    const body = patch.body as Record<string, unknown>;
    expect(body.status).toBe("paid");
    expect(body.tx_ref).toBe("0xhash");
    expect(typeof body.settled_at).toBe("string");
    expect(body.agent_reasoning).toBe(invoice.reasoning);

    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(append.p_action).toBe("ap_reconcile");
    expect(append.p_summary).toBe("RECONCILE invoice from Acme Supplies for 150 USDC: paid");
    expect(append.p_detail).toMatchObject({
      invoiceId: INVOICE_ID,
      counterpartyId: COUNTERPARTY_ID,
      reconciled: true,
      previousStatus: "matched",
      execution: { txRef: "0xhash", resultingStatus: "paid", reconciled: true },
    });
    // No `observed` facts: the follow-up stage keeps comparing against the decision itself.
    expect(append.p_detail).not.toHaveProperty("observed");

    expect(outcome).toEqual({
      status: "paid",
      operatingBalance: 350,
      line: { domain: "ap", message: "Acme Supplies: reconciled an in-flight payment, now paid (150 USDC)" },
    });
  });

  it("leaves a still-pending payment matched, keeps its txRef, and does not repeat the note", async () => {
    payInvoiceMock.mockResolvedValue({
      status: "matched", txRef: "circle-tx-1", note: " [transfer submitted; awaiting provider confirmation]", operatingBalance: null,
      execution: { providerMode: "live", feeUsd: null, feeSource: null, settledInMs: null, executedAt: null, reconciled: true },
    });
    const { fake, run } = cycleFake();

    await run(() => reconcileApInvoice(invoice, { providerTxId: "circle-tx-1", status: "pending" }, { db: db(), provider, operating: { id: ACCOUNT_ID } }));

    const body = invoicePatches(fake.requests)[0].body as Record<string, unknown>;
    expect(body.status).toBe("matched");
    expect(body.tx_ref).toBe("circle-tx-1");
    expect(body.settled_at).toBeNull();
    expect(body.agent_reasoning).toBe(invoice.reasoning);
  });

  it("records a provider-reported failure as held, keeping the txRef and noting why", async () => {
    payInvoiceMock.mockResolvedValue({
      status: "held", txRef: "circle-tx-1", note: " [transfer failed: provider reported failure]", operatingBalance: null,
      execution: { status: "failed", error: null, providerTxId: "circle-tx-1", providerMode: "live", reconciled: true },
    });
    const { fake, run } = cycleFake();

    const outcome = await run(() =>
      reconcileApInvoice(invoice, { providerTxId: "circle-tx-1", status: "pending" }, { db: db(), provider, operating: { id: ACCOUNT_ID } })
    );

    expect(outcome.status).toBe("held");
    const body = invoicePatches(fake.requests)[0].body as Record<string, unknown>;
    expect(body.status).toBe("held");
    expect(body.tx_ref).toBe("circle-tx-1");
    expect(body.agent_reasoning).toBe(`${invoice.reasoning} [transfer failed: provider reported failure]`);
  });

  it("does not append a note the reasoning already ends with", async () => {
    payInvoiceMock.mockResolvedValue({
      status: "held", txRef: "circle-tx-1", note: " [transfer failed: provider reported failure]", operatingBalance: null,
      execution: { status: "failed", error: null, providerTxId: "circle-tx-1", providerMode: "live", reconciled: true },
    });
    const { fake, run } = cycleFake();
    const reasoning = `${invoice.reasoning} [transfer failed: provider reported failure]`;

    await run(() =>
      reconcileApInvoice({ ...invoice, reasoning }, { providerTxId: "circle-tx-1", status: "failed" }, { db: db(), provider, operating: { id: ACCOUNT_ID } })
    );

    const body = invoicePatches(fake.requests)[0].body as Record<string, unknown>;
    expect(body.status).toBe("held");
    expect(body.agent_reasoning).toBe(reasoning);
  });

  it("leaves the payment matched, and says so, when the reconcile itself could not read the provider", async () => {
    // executePayment's reconcile catch: the intent keeps its provider id and records our own error.
    payInvoiceMock.mockResolvedValue({
      status: "held", txRef: "circle-tx-1", note: " [transfer failed: provider unreachable]", operatingBalance: null,
      execution: { status: "failed", error: "provider unreachable", providerTxId: "circle-tx-1", providerMode: "live", reconciled: true },
    });
    const { fake, run } = cycleFake();

    const outcome = await run(() =>
      reconcileApInvoice(invoice, { providerTxId: "circle-tx-1", status: "pending" }, { db: db(), provider, operating: { id: ACCOUNT_ID } })
    );

    expect(outcome).toEqual({
      status: "matched",
      operatingBalance: null,
      line: { domain: "ap", message: "Acme Supplies: could not reconcile the in-flight payment, left pending for the next cycle (150 USDC)" },
    });
    expect(invoicePatches(fake.requests)).toHaveLength(0);
    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(append.p_action).toBe("ap_reconcile");
    expect(append.p_summary).toBe("RECONCILE invoice from Acme Supplies for 150 USDC: not completed, left pending");
    expect(append.p_detail).toMatchObject({
      invoiceId: INVOICE_ID,
      reconciled: false,
      reconcileError: "provider unreachable",
      execution: { txRef: "circle-tx-1", resultingStatus: "matched" },
    });
  });

  it("leaves the payment matched when the reconcile threw before any result", async () => {
    payInvoiceMock.mockResolvedValue({ status: "held", txRef: null, execution: null, note: " [execution failed: store unavailable]", operatingBalance: null });
    const { fake, run } = cycleFake();

    const outcome = await run(() =>
      reconcileApInvoice(invoice, { providerTxId: "circle-tx-1", status: "pending" }, { db: db(), provider, operating: { id: ACCOUNT_ID } })
    );

    expect(outcome.status).toBe("matched");
    expect(invoicePatches(fake.requests)).toHaveLength(0);
    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(append.p_detail).toMatchObject({ reconciled: false, reconcileError: "execution failed: store unavailable" });
  });

  it("leaves the payment matched, without calling payInvoice, when there is no operating account", async () => {
    const { fake, run } = cycleFake();

    const outcome = await run(() =>
      reconcileApInvoice(invoice, { providerTxId: "circle-tx-1", status: "pending" }, { db: db(), provider, operating: null })
    );

    expect(payInvoiceMock).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      status: "matched",
      operatingBalance: null,
      line: { domain: "ap", message: "Acme Supplies: in-flight payment left pending, no operating account to reconcile it against (150 USDC)" },
    });
    expect(invoicePatches(fake.requests)).toHaveLength(0);
  });

  it("does not resubmit to a counterparty now screened high risk, and holds with a note", async () => {
    const { fake, run } = cycleFake((r) => {
      if (r.path === "/rest/v1/counterparties" && r.method === "GET") return { body: { risk_level: "high" } };
      if (r.path === "/rest/v1/rpc/agent_paused") return { body: false };
      return undefined;
    });

    const outcome = await run(() =>
      reconcileApInvoice({ ...invoice, txRef: null }, { providerTxId: null, status: "submitting" }, { db: db(), provider, operating: { id: ACCOUNT_ID } })
    );

    expect(payInvoiceMock).not.toHaveBeenCalled();
    expect(decideMock).not.toHaveBeenCalled();
    const [lookup] = fake.requests.filter((r) => r.path === "/rest/v1/counterparties");
    expect(lookup.params.get("id")).toBe(`eq.${COUNTERPARTY_ID}`);
    expect(outcome.status).toBe("held");
    expect(outcome.line.message).toBe("Acme Supplies: not resubmitted, the counterparty is now screened high risk (150 USDC)");
    const body = invoicePatches(fake.requests)[0].body as Record<string, unknown>;
    expect(body.status).toBe("held");
    expect(body.tx_ref).toBeNull();
    expect(body.agent_reasoning).toBe(`${invoice.reasoning} [not resubmitted: counterparty now screened high risk]`);
    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(append.p_detail).toMatchObject({ notResubmittedBecause: "counterparty.high_risk", execution: { resultingStatus: "held" } });
  });

  it("resubmits through payInvoice when the counterparty is not high risk and the agent is not paused", async () => {
    payInvoiceMock.mockResolvedValue({ status: "paid", txRef: "0xhash", execution: null, note: "", operatingBalance: 200 });
    const { run } = cycleFake((r) => {
      if (r.path === "/rest/v1/counterparties" && r.method === "GET") return { body: { risk_level: "low" } };
      if (r.path === "/rest/v1/rpc/agent_paused") return { body: false };
      return undefined;
    });

    const outcome = await run(() =>
      reconcileApInvoice({ ...invoice, txRef: null }, { providerTxId: null, status: "submitting" }, { db: db(), provider, operating: { id: ACCOUNT_ID } })
    );

    expect(payInvoiceMock).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe("paid");
  });

  it("fails closed when the counterparty's risk level cannot be read", async () => {
    const { run } = cycleFake((r) =>
      r.path === "/rest/v1/counterparties" ? { status: 500, body: { message: "counterparties read failed: connection reset" } } : undefined
    );

    await expect(
      run(() => reconcileApInvoice({ ...invoice, txRef: null }, { providerTxId: null, status: "submitting" }, { db: db(), provider, operating: { id: ACCOUNT_ID } }))
    ).rejects.toThrow("counterparties read failed: connection reset");
    expect(payInvoiceMock).not.toHaveBeenCalled();
  });

  it("holds without calling payInvoice when no transfer exists yet and the agent is paused", async () => {
    const { fake, run } = cycleFake((r) => (r.path === "/rest/v1/rpc/agent_paused" ? { body: true } : undefined));

    const outcome = await run(() =>
      reconcileApInvoice({ ...invoice, txRef: null }, { providerTxId: null, status: "submitting" }, { db: db(), provider, operating: { id: ACCOUNT_ID } })
    );

    expect(payInvoiceMock).not.toHaveBeenCalled();
    expect(decideMock).not.toHaveBeenCalled();
    expect(outcome.status).toBe("held");
    const body = invoicePatches(fake.requests)[0].body as Record<string, unknown>;
    expect(body.status).toBe("held");
    expect(body.agent_reasoning).toBe(`${invoice.reasoning} [not paid: the agent was paused]`);
    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect((append.p_detail as { execution: Record<string, unknown> }).execution.heldBecause).toBe("agent_paused");
  });
});
