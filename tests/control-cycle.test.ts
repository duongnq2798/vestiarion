import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv, type FollowUpConfig } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { withOrg } from "@/lib/dal/scope";
import { applyFollowUp, existingPaymentIntents, followUpHeldMilestones, reconcileApInvoice } from "@/lib/agent/orchestrator";
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
    expect(patch.body).toEqual({ status: "pending", notified_at: null });
    expect(patch.params.get("id")).toBe(`eq.${INVOICE_ID}`);
    expect(patch.params.get("status")).toBe("eq.held");
    expect(patch.params.get("select")).toBe("id");
    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(append.p_action).toBe("invoice_reopened");
    expect(line).toEqual({ domain: "ap", message: "Reopened 150 USDC invoice: PO added" });
  });

  it("writes a EURC invoice's amount in EURC (review I2)", async () => {
    const { fake, run } = cycleFake((r) => (r.path === "/rest/v1/invoices" && r.method === "PATCH" ? { body: [{ id: INVOICE_ID }] } : undefined));
    const line = await run(() => applyFollowUp(db(), { id: INVOICE_ID, status: "held", amount: 150, currency: "EURC" }, reopen, FOLLOW_UP_CONFIG, Date.now()));
    expect(line).toEqual({ domain: "ap", message: "Reopened 150 EURC invoice: PO added" });
    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(append.p_summary).toBe("Reopened held invoice for 150 EURC: evidence changed");
  });

  it("records what a fresh quote changed for a EURC payable, and hands back the reopen's entry (FX re-evaluation F6)", async () => {
    const { fake, run } = cycleFake((r) => (r.path === "/rest/v1/invoices" && r.method === "PATCH" ? { body: [{ id: INVOICE_ID }] } : undefined));
    const reevaluation = {
      trigger: "rate_available" as const,
      previousDecision: { seq: 1434, action: "hold", guardrailRule: null },
      before: { rate: null, usdcValue: null, swapCostPercent: null },
      after: { rate: 1.215262, usdcValue: 0.607631, swapCostPercent: null, quotedAt: "2026-10-05T02:00:00.000Z" },
    };
    const reopened: number[] = [];

    await run(() =>
      applyFollowUp(db(), { id: INVOICE_ID, status: "held", amount: 0.5, currency: "EURC" }, { ...reopen, reevaluation }, FOLLOW_UP_CONFIG, Date.now(), (seq) =>
        reopened.push(seq)
      )
    );

    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect((append.p_detail as Record<string, unknown>).reevaluation).toEqual(reevaluation);
    expect(reopened).toEqual([1]);
  });

  it("clears notified_at on reopen, so a re-held payable is news again", async () => {
    const { fake, run } = cycleFake((r) => (r.path === "/rest/v1/invoices" && r.method === "PATCH" ? { body: [{ id: INVOICE_ID }] } : undefined));

    await run(() => applyFollowUp(db(), { id: INVOICE_ID, status: "held", amount: 150 }, reopen, FOLLOW_UP_CONFIG, Date.now()));

    const [patch] = invoicePatches(fake.requests);
    expect(patch.body).toMatchObject({ notified_at: null });
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

describe("followUpHeldMilestones — a held milestone goes back to the agent when its facts change", () => {
  const MILESTONE_A = "018f8ce0-1557-7b54-a931-4d777f6bc0a1";
  const MILESTONE_B = "018f8ce0-1557-7b54-a931-4d777f6bc0b1";
  const MILESTONE_C = "018f8ce0-1557-7b54-a931-4d777f6bc0c1";
  const held = [
    // A: held over a 1 USDC limit that is now 5.
    { id: MILESTONE_A, title: "Thumbnails", amount: "2", verification_source: "PR #84", counterparties: { risk_level: "clear", payment_limit: "5" } },
    // B: held by the model; nothing changed since.
    { id: MILESTONE_B, title: "Posts", amount: "1", verification_source: "PR #85", counterparties: { risk_level: "clear", payment_limit: "5" } },
    // C: held because the agent was paused.
    { id: MILESTONE_C, title: "Logo", amount: "1", verification_source: "PR #86", counterparties: { risk_level: "clear", payment_limit: "5" } },
  ];
  const decision = (milestoneId: string, observed: object, execution: object = { resultingStatus: "held" }) => ({
    detail: { milestoneId, decision: { action: "hold" }, observed, execution },
  });
  // Newest first, as the stage asks for them; a later non-decision entry (a verification) carries no facts.
  const ledger = [
    { detail: { milestoneId: MILESTONE_A, verified: true } },
    decision(MILESTONE_A, { riskLevel: "clear", paymentLimit: 1, verificationSource: "PR #84" }),
    decision(MILESTONE_A, { riskLevel: "clear", paymentLimit: 0.5, verificationSource: "PR #84" }),
    decision(MILESTONE_B, { riskLevel: "clear", paymentLimit: 5, verificationSource: "PR #85" }),
    decision(MILESTONE_C, { riskLevel: "clear", paymentLimit: 5, verificationSource: "PR #86" }, { resultingStatus: "held", heldBecause: "agent_paused" }),
  ];
  const milestonePatches = (requests: RecordedRequest[]) => requests.filter((r) => r.path === "/rest/v1/milestones" && r.method === "PATCH");

  function heldFake(patchReply: (r: RecordedRequest) => FakeReply = (r) => ({ body: [{ id: r.params.get("id")?.slice(3) }] })) {
    return cycleFake((r) => {
      if (r.path === "/rest/v1/milestones" && r.method === "GET") return { body: held };
      // Only the stage's read of decision facts; appending an entry reads the ledger's head too.
      if (r.path === "/rest/v1/ledger_entries" && r.params.get("domain") === "eq.contractor") return { body: ledger };
      if (r.path === "/rest/v1/milestones" && r.method === "PATCH") return patchReply(r);
      return undefined;
    });
  }

  it("reads held, verified milestones and the facts of each one's latest decision", async () => {
    const { fake, run } = heldFake();
    await run(() => followUpHeldMilestones(db()));
    const read = fake.requests.find((r) => r.path === "/rest/v1/milestones" && r.method === "GET")!;
    expect(read.params.get("status")).toBe("eq.held");
    expect(read.params.get("verified")).toBe("eq.true");
    const facts = fake.requests.find((r) => r.path === "/rest/v1/ledger_entries" && r.params.has("domain"))!;
    expect(facts.params.get("domain")).toBe("eq.contractor");
    expect(facts.params.get("order")).toBe("seq.desc");
  });

  it("reopens a milestone whose limit was raised and one held only by the pause, each as a compare-and-set on held", async () => {
    const { fake, run } = heldFake();
    const lines = await run(() => followUpHeldMilestones(db()));

    const patches = milestonePatches(fake.requests);
    expect(patches.map((p) => p.params.get("id"))).toEqual([`eq.${MILESTONE_A}`, `eq.${MILESTONE_C}`]);
    for (const patch of patches) {
      expect(patch.body).toEqual({ status: "verified" });
      expect(patch.params.get("status")).toBe("eq.held");
      expect(patch.params.get("select")).toBe("id");
      // Never one a person is deciding right now (held milestone actions R2).
      expect(patch.params.get("or")).toMatch(/^\(decision_claimed_at\.is\.null,decision_claimed_at\.lt\.\d{4}-\d{2}-\d{2}T[\d:.]+Z\)$/);
    }
    const appends = rpcBodies(fake.requests, "append_ledger_entry");
    expect(appends.map((a) => a.p_action)).toEqual(["milestone_reopened", "milestone_reopened"]);
    expect(appends[0].p_domain).toBe("contractor");
    expect(appends[0].p_detail).toMatchObject({
      milestoneId: MILESTONE_A,
      previousStatus: "held",
      followUp: { action: "reopen", changes: ["payment limit moved 1 USDC → 5 USDC"] },
    });
    expect(lines).toEqual([
      { domain: "contractor", message: 'Reopened 2 USDC milestone "Thumbnails": payment limit moved 1 USDC → 5 USDC' },
      { domain: "contractor", message: 'Reopened 1 USDC milestone "Logo": the agent was paused when it was held, and is running again' },
    ]);
  });

  it("writes nothing for a milestone a person changed meanwhile", async () => {
    const { fake, run } = heldFake(() => ({ body: [] }));
    const lines = await run(() => followUpHeldMilestones(db()));
    expect(milestonePatches(fake.requests)).toHaveLength(2);
    expect(rpcBodies(fake.requests, "append_ledger_entry")).toHaveLength(0);
    expect(lines).toEqual([]);
  });

  it("reopens a milestone held only for the spending limit once the limit has room for it, and leaves it while it has not", async () => {
    const MILESTONE_D = "018f8ce0-1557-7b54-a931-4d777f6bc0d1";
    const budgetHeld = [{ id: MILESTONE_D, title: "Docs", amount: "3", verification_source: "PR #87", counterparties: { risk_level: "clear", payment_limit: "5" } }];
    const facts = [decision(MILESTONE_D, { riskLevel: "clear", paymentLimit: 5, verificationSource: "PR #87" }, { resultingStatus: "held", heldBecause: "outflow_budget" })];
    const budgetFake = () =>
      cycleFake((r) => {
        if (r.path === "/rest/v1/milestones" && r.method === "GET") return { body: budgetHeld };
        if (r.path === "/rest/v1/ledger_entries" && r.params.get("domain") === "eq.contractor") return { body: facts };
        if (r.path === "/rest/v1/milestones" && r.method === "PATCH") return { body: [{ id: MILESTONE_D }] };
        return undefined;
      });
    const gate = (remaining: number | null) => ({
      room: vi.fn(async () =>
        remaining === null ? null : { dailyUsdc: 10, weeklyUsdc: null, spentToday: 10 - remaining, spentThisWeek: 10 - remaining, remaining, binding: "day" as const }
      ),
      spend: vi.fn(),
    });

    const short = budgetFake();
    expect(await short.run(() => followUpHeldMilestones(db(), gate(2)))).toEqual([]);
    expect(milestonePatches(short.fake.requests)).toHaveLength(0);

    const roomy = budgetFake();
    const lines = await roomy.run(() => followUpHeldMilestones(db(), gate(3)));
    expect(milestonePatches(roomy.fake.requests).map((p) => p.params.get("id"))).toEqual([`eq.${MILESTONE_D}`]);
    expect(lines).toEqual([{ domain: "contractor", message: `Reopened 3 USDC milestone "Docs": the agent's spending limit has room for it again (3 USDC left)` }]);

    const unlimited = budgetFake();
    expect(await unlimited.run(() => followUpHeldMilestones(db(), gate(null)))).toHaveLength(1);
  });

  it("does not read the limit when no milestone waits on it", async () => {
    const { run } = heldFake();
    const budget = { room: vi.fn(), spend: vi.fn() };
    await run(() => followUpHeldMilestones(db(), budget));
    expect(budget.room).not.toHaveBeenCalled();
  });

  it("reads nothing more when no milestone is held", async () => {
    const { fake, run } = cycleFake((r) => (r.path === "/rest/v1/milestones" ? { body: [] } : undefined));
    expect(await run(() => followUpHeldMilestones(db()))).toEqual([]);
    expect(fake.requests.some((r) => r.path === "/rest/v1/ledger_entries")).toBe(false);
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
              { source_id: "created-no-id", provider_tx_id: null, status: "created" },
            ],
          }
        : undefined
    );

    const intents = await run(() =>
      existingPaymentIntents(db(), [
        { id: "failed-no-id", status: "matched" },
        { id: "failed-by-provider", status: "matched" },
        { id: "submitting", status: "matched" },
        { id: "created-no-id", status: "matched" },
      ])
    );

    // No transfer to reconcile by: both go back through the model and the guardrails.
    expect(intents.has("failed-no-id")).toBe(false);
    expect(intents.has("created-no-id")).toBe(false);
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

  it("reconciles a EURC payment as EURC, and says so (EURC invoices design E5)", async () => {
    payInvoiceMock.mockResolvedValue({
      status: "paid", txRef: "0xhash", note: "", operatingBalance: null,
      execution: { providerMode: "live", feeUsd: 0.003, feeSource: "chain_reported", settledInMs: 4000, executedAt: "2026-09-29T00:00:00Z", reconciled: true },
    });
    const { run } = cycleFake();

    const outcome = await run(() =>
      reconcileApInvoice({ ...invoice, currency: "EURC" }, { providerTxId: "circle-tx-1", status: "pending" }, { db: db(), provider, operating: { id: ACCOUNT_ID } })
    );

    expect(payInvoiceMock.mock.calls[0][0]).toMatchObject({ amount: 150, currency: "EURC" });
    expect(outcome.line.message).toContain("150 EURC");
    expect(outcome.line.message).not.toContain("USDC");
  });

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
      { invoiceId: INVOICE_ID, counterpartyId: COUNTERPARTY_ID, address: "0xdead", amount: 150, discount: null, currency: "USDC" },
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
    // The amount was recorded with the transfer that carried it; the reconcile keeps it.
    expect(body).not.toHaveProperty("paid_amount");

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
    // Nothing moved: no paid amount stands.
    expect(body.paid_amount).toBeNull();
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

  it("does not resubmit to a counterparty whose changed address no one has confirmed, and holds it for a person", async () => {
    const { fake, run } = cycleFake((r) => {
      if (r.path === "/rest/v1/counterparties" && r.method === "GET") {
        return { body: { risk_level: "low", address_changed_at: "2026-09-30T12:00:00+00:00", address_confirmed_at: null } };
      }
      if (r.path === "/rest/v1/rpc/agent_paused") return { body: false };
      return undefined;
    });

    const outcome = await run(() =>
      reconcileApInvoice({ ...invoice, txRef: null }, { providerTxId: null, status: "submitting" }, { db: db(), provider, operating: { id: ACCOUNT_ID } })
    );

    expect(payInvoiceMock).not.toHaveBeenCalled();
    expect(outcome.status).toBe("held");
    expect(outcome.line.message).toBe("Acme Supplies: not resubmitted, the counterparty's address changed and no one has confirmed it (150 USDC)");
    const body = invoicePatches(fake.requests)[0].body as Record<string, unknown>;
    expect(body.agent_reasoning).toBe(`${invoice.reasoning} [not resubmitted: the counterparty's address changed and no one has confirmed it]`);
    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(append.p_detail).toMatchObject({ notResubmittedBecause: "counterparty.address_unconfirmed", execution: { resultingStatus: "held" } });
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

  it("resubmits through the spending limit contract when the workspace enforces it on Arc (onchain spending limit R3)", async () => {
    payInvoiceMock.mockResolvedValue({ status: "paid", txRef: "0xhash", execution: null, note: "", operatingBalance: 200, amountPaid: 150, discountTaken: 0 });
    const { run } = cycleFake((r) => {
      if (r.path === "/rest/v1/counterparties" && r.method === "GET") return { body: { risk_level: "low" } };
      if (r.path === "/rest/v1/rpc/agent_paused") return { body: false };
      return undefined;
    });
    const payment = { contract: `0x${"11".repeat(20)}`, agentWalletId: "wallet-agent", ref: `0x${"2".repeat(64)}` };
    const onChainLimit = { check: vi.fn(async () => ({ contract: payment.contract, agent: `0x${"a9".repeat(20)}`, ref: payment.ref, covered: true, verdict: null, payment })) };

    await run(() =>
      reconcileApInvoice({ ...invoice, txRef: null }, { providerTxId: null, status: "submitting" }, { db: db(), provider, operating: { id: ACCOUNT_ID }, onChainLimit })
    );

    expect(payInvoiceMock.mock.calls[0][0]).toMatchObject({ spendingLimit: payment });
  });

  it("does not resubmit, and holds for a person, a payment the enforced contract cannot carry (onchain spending limit R4)", async () => {
    const { fake, run } = cycleFake((r) => {
      if (r.path === "/rest/v1/counterparties" && r.method === "GET") return { body: { risk_level: "low" } };
      if (r.path === "/rest/v1/rpc/agent_paused") return { body: false };
      return undefined;
    });
    const onChainLimit = {
      check: vi.fn(async () => ({ contract: `0x${"11".repeat(20)}`, agent: `0x${"a9".repeat(20)}`, ref: `0x${"2".repeat(64)}`, covered: false, uncoveredBecause: "another_chain" as const, verdict: null, payment: null })),
    };

    const outcome = await run(() =>
      reconcileApInvoice({ ...invoice, txRef: null, destinationChain: "BASE-SEPOLIA" }, { providerTxId: null, status: "submitting" }, { db: db(), provider, operating: { id: ACCOUNT_ID }, onChainLimit })
    );

    expect(payInvoiceMock).not.toHaveBeenCalled();
    expect(outcome.status).toBe("held");
    const [body] = fake.requests.filter((r) => r.path === "/rest/v1/invoices" && r.method === "PATCH").map((r) => r.body as Record<string, string>);
    expect(body.agent_reasoning).toContain("the agent's spending limit is enforced on Arc, and this payment cannot go through its contract");
  });

  it("resubmits a payment to a payee on another chain to that chain, its fee bounded (CCTP payouts, review I7)", async () => {
    payInvoiceMock.mockResolvedValue({ status: "matched", txRef: "0xburn", execution: null, note: "", operatingBalance: null, amountPaid: 150, discountTaken: 0 });
    const { run } = cycleFake((r) => {
      if (r.path === "/rest/v1/counterparties" && r.method === "GET") return { body: { risk_level: "low" } };
      if (r.path === "/rest/v1/rpc/agent_paused") return { body: false };
      return undefined;
    });
    await run(() =>
      reconcileApInvoice({ ...invoice, txRef: null, destinationChain: "BASE-SEPOLIA" }, { providerTxId: null, status: "submitting" }, { db: db(), provider, operating: { id: ACCOUNT_ID } })
    );
    expect(payInvoiceMock.mock.calls[0][0]).toMatchObject({ destinationChain: "BASE-SEPOLIA", maxBridgeFeeUsdc: 15 });
  });

  it("resubmits with the invoice's discount, and records what the new transfer carried", async () => {
    payInvoiceMock.mockResolvedValue({ status: "paid", txRef: "0xhash", execution: null, note: "", operatingBalance: 200, amountPaid: 147, discountTaken: 3 });
    const { fake, run } = cycleFake((r) => {
      if (r.path === "/rest/v1/counterparties" && r.method === "GET") return { body: { risk_level: "low" } };
      if (r.path === "/rest/v1/rpc/agent_paused") return { body: false };
      return undefined;
    });
    const discount = { pct: 2, deadline: "2026-10-11T12:00:00+00:00" };

    await run(() =>
      reconcileApInvoice({ ...invoice, txRef: null, discount }, { providerTxId: null, status: "submitting" }, { db: db(), provider, operating: { id: ACCOUNT_ID } })
    );

    expect(payInvoiceMock.mock.calls[0][0]).toEqual({ invoiceId: INVOICE_ID, counterpartyId: COUNTERPARTY_ID, address: "0xdead", amount: 150, discount, currency: "USDC" });
    const body = invoicePatches(fake.requests)[0].body as Record<string, unknown>;
    expect(body.status).toBe("paid");
    expect(body.paid_amount).toBe(147);
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

describe("reconcileApInvoice — a payment the agent never sent, above the figure for two approvals (payment integrity I4)", () => {
  const provider = { mode: "live", earnMode: "simulate", estimatedFeeUsd: 0.003 } as unknown as ChainProvider;
  const FIRST = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1";
  const SECOND = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e2";
  const invoice = {
    id: INVOICE_ID,
    amount: 150,
    counterpartyId: COUNTERPARTY_ID,
    counterpartyName: "Acme Supplies",
    address: "0xdead",
    reasoning: "Paid 150 USDC to Acme Supplies.",
    txRef: null,
  };
  const neverSent = { providerTxId: null, status: "submitting" };
  const used = (by: string, over: Record<string, unknown> = {}) => ({
    approved_by: by, amount: "150.000000", currency: "USDC", address: "0xDEAD", used_at: "2026-10-05T08:00:00.000Z", ...over,
  });
  const world = (approvals: Array<Record<string, unknown>>) =>
    cycleFake((r) => {
      if (r.path === "/rest/v1/counterparties" && r.method === "GET") return { body: { risk_level: "low" } };
      if (r.path === "/rest/v1/rpc/agent_paused") return { body: false };
      if (r.path === "/rest/v1/payment_approvals" && r.method === "GET") return { body: approvals };
      return undefined;
    });
  const paid = () => payInvoiceMock.mockResolvedValue({ status: "paid", txRef: "0xhash", execution: null, note: "", operatingBalance: 200 });

  it("holds it for two people rather than sending it again on its own", async () => {
    const { fake, run } = world([]);

    const outcome = await run(() => reconcileApInvoice(invoice, neverSent, { db: db(), provider, operating: { id: ACCOUNT_ID }, twoApprovalsAbove: 100 }));

    expect(payInvoiceMock).not.toHaveBeenCalled();
    expect(outcome.status).toBe("held");
    expect(outcome.line.message).toBe("Acme Supplies: not resubmitted, payments above 100 USDC need two approvals (150 USDC)");
    const body = invoicePatches(fake.requests)[0].body as Record<string, unknown>;
    expect(body.status).toBe("held");
    expect(body.agent_reasoning).toBe(`${invoice.reasoning} [not resubmitted: payments above 100 USDC need two approvals — held for two people to approve]`);
    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(append.p_detail).toMatchObject({ notResubmittedBecause: "workspace.two_approvals", execution: { resultingStatus: "held" } });
    // What it asked: the approvals used to pay this payable.
    const [asked] = fake.requests.filter((r) => r.path === "/rest/v1/payment_approvals");
    expect(asked.params.get("source_type")).toBe("eq.invoice");
    expect(asked.params.get("source_id")).toBe(`eq.${INVOICE_ID}`);
    expect(asked.params.get("used_at")).toBe("not.is.null");
  });

  it("sends it again when two people's approvals of this payment paid it", async () => {
    paid();
    const { run } = world([used(FIRST), used(SECOND)]);

    const outcome = await run(() => reconcileApInvoice(invoice, neverSent, { db: db(), provider, operating: { id: ACCOUNT_ID }, twoApprovalsAbove: 100 }));

    expect(payInvoiceMock).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe("paid");
  });

  it("counts neither one person twice nor an approval of another amount or address", async () => {
    for (const approvals of [[used(FIRST), used(FIRST)], [used(FIRST), used(SECOND, { amount: "90.000000" })], [used(FIRST), used(SECOND, { address: "0xbeef" })]]) {
      payInvoiceMock.mockClear();
      const { run } = world(approvals);
      const outcome = await run(() => reconcileApInvoice(invoice, neverSent, { db: db(), provider, operating: { id: ACCOUNT_ID }, twoApprovalsAbove: 100 }));
      expect(outcome.status).toBe("held");
      expect(payInvoiceMock).not.toHaveBeenCalled();
    }
  });

  it("weighs a EURC payment at the USDC value its decision recorded, and holds one whose value is not known", async () => {
    paid();
    const decided = cycleFake((r) => {
      if (r.path === "/rest/v1/counterparties" && r.method === "GET") return { body: { risk_level: "low" } };
      if (r.path === "/rest/v1/rpc/agent_paused") return { body: false };
      if (r.path === "/rest/v1/payment_approvals" && r.method === "GET") return { body: [] };
      if (r.path === "/rest/v1/rpc/ledger_entries_for_targets") {
        return { body: [{ seq: 9, id: "e9", ts: "2026-10-05T08:00:00Z", actor: "agent", domain: "ap", action: "ap_pay", summary: "", detail: { invoiceId: INVOICE_ID, decision: { action: "pay" }, observed: {}, usdcValue: 175.5 }, body_hash: "00", signature: "00", prev_hash: "00", hash: "00", signing_key_id: null }] };
      }
      return undefined;
    });
    // 150 EURC weighed at 175.5 USDC: under a 1000 USDC figure it goes again on its own, above a 100 USDC one it waits.
    expect((await decided.run(() => reconcileApInvoice({ ...invoice, currency: "EURC" }, neverSent, { db: db(), provider, operating: { id: ACCOUNT_ID }, twoApprovalsAbove: 1000 }))).status).toBe("paid");
    expect((await decided.run(() => reconcileApInvoice({ ...invoice, currency: "EURC" }, neverSent, { db: db(), provider, operating: { id: ACCOUNT_ID }, twoApprovalsAbove: 100 }))).status).toBe("held");

    const { run } = world([]);
    const outcome = await run(() =>
      reconcileApInvoice({ ...invoice, currency: "EURC" }, neverSent, { db: db(), provider, operating: { id: ACCOUNT_ID }, twoApprovalsAbove: 1000 })
    );
    expect(outcome.status).toBe("held");
  });

  it("sends it again as before under the figure, or with none, without asking", async () => {
    paid();
    for (const twoApprovalsAbove of [500, null]) {
      const { fake, run } = world([]);
      await run(() => reconcileApInvoice(invoice, neverSent, { db: db(), provider, operating: { id: ACCOUNT_ID }, twoApprovalsAbove }));
      expect(fake.requests.some((r) => r.path === "/rest/v1/payment_approvals")).toBe(false);
    }
    expect(payInvoiceMock).toHaveBeenCalledTimes(2);
  });
});
