import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { withOrg } from "@/lib/dal/scope";
import { dueForDecision, obligationsDueBy, runApStage, type CycleLogLine } from "@/lib/agent/orchestrator";
import { onChainLimitGate, type OnChainLimitGate } from "@/lib/agent/onchain-limit";
import type { SpendingLimitVerdict } from "@/lib/spending-limit/onchain";
import { CycleMetricsCollector } from "@/lib/agent/cycle-metrics";
import type { DecideParams } from "@/lib/agent/decide";
import type { BalanceSnapshot, ChainProvider, EarnResult, TransferParams, TransferResult } from "@/lib/circle";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";
import { paymentIntentsBackend } from "./support/payment-intents";

/**
 * The AP stage (`runApStage`, src/lib/agent/orchestrator.ts) deciding *when*
 * to pay (spec 2026-09-30-payment-timing §1): scheduling, the bounds code
 * puts on the model's date, the discount paid on the day, and every check
 * run again then (P3).
 *
 * The stage runs for real over the recorded fake — the load, duplicate
 * detection, the timing policy, the guardrails, the pause, `payInvoice` and
 * `executePayment` over the shared `payment_intents` table, the invoice
 * write and a really signed ledger entry — with a fake chain provider whose
 * transfers are recorded, so the amount that would leave is asserted, not
 * inferred. Only the model is stubbed: `decide` is the real one (the
 * rule-based policy, since this config has no model key) unless a test
 * gives the model an answer, which then goes through the real schema.
 *
 * A full `runAgentCycle()` is out of proportion here for the reasons
 * tests/orchestrator.test.ts gives; the stage is the seam.
 */

const { decideMock } = vi.hoisted(() => ({ decideMock: vi.fn() }));
vi.mock("@/lib/agent/decide", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/decide")>()),
  decide: decideMock,
}));

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000a9a9";
const INVOICE_ID = "018f8ce0-1557-7b54-a931-4d777f6ba001";
const OTHER_INVOICE_ID = "018f8ce0-1557-7b54-a931-4d777f6ba002";
const NORTHWIND = "018f8ce0-1557-7b54-a931-4d777f6ba003";
const CONTOSO = "018f8ce0-1557-7b54-a931-4d777f6ba004";
const ACCOUNT_ID = "018f8ce0-1557-7b54-a931-4d777f6ba005";

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

const MASTER_KEYS = `t1:${crypto.randomBytes(32).toString("base64")}`;
const LEDGER_PEM = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const savedMasterKeys = process.env.VESTIARION_MASTER_KEYS;
beforeEach(async () => {
  process.env.VESTIARION_MASTER_KEYS = MASTER_KEYS;
  const actual = await vi.importActual<typeof import("@/lib/agent/decide")>("@/lib/agent/decide");
  decideMock.mockReset();
  decideMock.mockImplementation(actual.decide);
});
afterEach(() => {
  vi.useRealTimers();
  if (savedMasterKeys === undefined) delete process.env.VESTIARION_MASTER_KEYS;
  else process.env.VESTIARION_MASTER_KEYS = savedMasterKeys;
});

function today(iso: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}

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

const LEDGER_ROW = {
  seq: 1, id: "e1", ts: "2026-10-01T00:00:00Z", actor: "agent", domain: "ap", action: "x",
  summary: "", detail: {}, body_hash: "00", signature: "00", prev_hash: null, hash: "00", signing_key_id: null,
};

const TERMS = { early_pay_discount_pct: "2.00", discount_due_date: "2026-10-11T12:00:00+00:00" };

function counterparty(overrides: Record<string, unknown> = {}) {
  return {
    id: NORTHWIND, name: "Northwind", risk_level: "low", payment_limit: "1000", performance_score: null, performance_inputs: null,
    address: "0xnorth", address_changed_at: null, address_confirmed_at: null,
    ...overrides,
  };
}

/** The "Annual support plan": 400 USDC, 2% off if paid by Oct 11, due Oct 31. */
function payable(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID, direction: "payable", status: "pending", amount: "400", memo: "Annual support plan", po_reference: "PO-1044",
    goods_received: true, due_date: "2026-10-31T12:00:00+00:00", counterparty_id: NORTHWIND,
    agent_reasoning: null, tx_ref: null, decided_at: null, scheduled_for: null, paid_amount: null,
    ...TERMS,
    counterparties: counterparty(),
    ...overrides,
  };
}

/** Scheduled by an earlier cycle for its discount deadline. */
function scheduledPayable(overrides: Record<string, unknown> = {}) {
  return payable({
    status: "scheduled",
    scheduled_for: "2026-10-11T00:00:00+00:00",
    agent_reasoning: "A 2% discount (8 USDC) is worth more than 0.99 USDC of yield; paying on the deadline.",
    decided_at: "2026-10-01T09:00:00+00:00",
    ...overrides,
  });
}

class Chain implements ChainProvider {
  readonly mode = "live" as const;
  readonly earnMode = "simulate" as const;
  readonly estimatedFeeUsd = 0.003;
  transfers: TransferParams[] = [];

  async transfer(params: TransferParams): Promise<TransferResult> {
    this.transfers.push(params);
    return {
      providerTxId: `circle-tx-${this.transfers.length}`, txHash: "0xhash", txRef: "0xhash", chain: "ARC-TESTNET", status: "confirmed",
      feeUsd: 0.003, feeSource: "chain_reported", providerMode: "live", settledInMs: 4000, providerState: "COMPLETE", failureReason: null,
    };
  }
  async reconcileTransfer(): Promise<TransferResult> { throw new Error("not used"); }
  async getBalance(): Promise<BalanceSnapshot> { throw new Error("not used"); }
  async depositToEarn(): Promise<EarnResult> { throw new Error("not used"); }
  async withdrawFromEarn(): Promise<EarnResult> { throw new Error("not used"); }
}

/**
 * Rows sorted as PostgREST sorts them for `order=col.asc,col2.desc,…`; rows
 * left in the book's order when the request names none, as a table without
 * an ORDER BY promises nothing.
 */
function orderedAs(rows: Array<Record<string, unknown>>, order: string | null): Array<Record<string, unknown>> {
  if (!order) return rows;
  const keys = order.split(",").map((term) => {
    const [column, direction] = term.split(".");
    return { column, sign: direction === "desc" ? -1 : 1 };
  });
  return [...rows].sort((a, b) => {
    for (const { column, sign } of keys) {
      const left = String(a[column] ?? "");
      const right = String(b[column] ?? "");
      if (left !== right) return left < right ? -sign : sign;
    }
    return 0;
  });
}

/**
 * PostgREST as the AP stage meets it. `book` is the whole payable ledger:
 * the stage's load gets the rows whose status its `in` filter names, in the
 * order it asks for, the duplicate-detection history gets all of them.
 */
function apFake(options: {
  book: Array<Record<string, unknown>>;
  paused?: boolean;
  milestones?: Array<{ amount: string }>;
  /** The agent's spending limit row, and its payment decisions in the 7-day window (outflow budget spec). */
  budget?: { daily_usdc: string | null; weekly_usdc: string | null };
  agentPayments?: Array<Record<string, unknown>>;
  /** The spending limit enforced on Arc, as the stage sees it (onchain spending limit spec); not enforced when absent. */
  onChainLimit?: OnChainLimitGate;
}) {
  const intents = paymentIntentsBackend(ORG);
  const fake = fakeSupabase((request) => {
    if (request.path === "/rest/v1/orgs") return { body: orgRow() };
    if (request.path === "/rest/v1/agent_budgets") return { body: options.budget ? [options.budget] : [] };
    // The spending limit's read of the agent's payments (filtered by actor), not the ledger's own head read.
    if (request.path === "/rest/v1/ledger_entries" && request.method === "GET" && request.params.has("actor")) return { body: options.agentPayments ?? [] };
    if (request.path === "/rest/v1/rpc/append_ledger_entry") return { body: LEDGER_ROW };
    if (request.path === "/rest/v1/rpc/agent_paused") return { body: options.paused ?? false };
    if (request.path === "/rest/v1/invoices" && request.method === "GET") {
      const statuses = request.params.get("status")?.match(/^in\.\((.*)\)$/)?.[1].split(",");
      const rows = statuses ? options.book.filter((row) => statuses.includes(row.status as string)) : options.book;
      return { body: orderedAs(rows, request.params.get("order")) };
    }
    if (request.path === "/rest/v1/invoices" && request.method === "PATCH") return { body: [] };
    if (request.path === "/rest/v1/milestones") return { body: options.milestones ?? [] };
    if (request.path === "/rest/v1/accounts" && request.method === "GET") {
      return { body: { id: ACCOUNT_ID, chain: "ARC-TESTNET", token: "USDC", balance: "608", apy: "0" } };
    }
    if (request.path === "/rest/v1/accounts" && request.method === "PATCH") return { body: [] };
    return intents.respond(request);
  });
  const chain = new Chain();
  const metrics = new CycleMetricsCollector();
  const lines: CycleLogLine[] = [];
  const stage = (operatingBalance = 1000, reserveBalance = 0) =>
    runWith({ config, db: fake.client, fetch: fake.fetch }, () =>
      withOrg(ORG, () =>
        runApStage({
          db: db(),
          provider: chain,
          operating: { id: ACCOUNT_ID },
          operatingBalance,
          reserveApy: 0.045,
          reserveBalance,
          metrics,
          lines,
          onChainLimit: options.onChainLimit ?? onChainLimitGate({ read: async () => null }),
        })
      )
    );
  return { fake, chain, metrics, lines, stage };
}

/** A model that answers `answer(params)` — parsed by the real schema, as `decide` parses a reply. */
function model(answer: (params: DecideParams<unknown>) => unknown) {
  decideMock.mockImplementation(async (params: DecideParams<unknown>) => {
    const reference = params.fallback() as { action: string };
    const value = params.schema.parse(answer(params)) as { action: string };
    return { value, mode: "anthropic", reference, agreedWithReference: value.action === reference.action };
  });
}

function promptOf(call = 0) {
  return JSON.parse((decideMock.mock.calls[call][0] as DecideParams<unknown>).userPrompt) as Record<string, unknown>;
}
function ledger(requests: RecordedRequest[]) {
  return requests.filter((r) => r.path === "/rest/v1/rpc/append_ledger_entry").map((r) => r.body as Record<string, unknown>);
}
function invoicePatches(requests: RecordedRequest[]) {
  return requests.filter((r) => r.path === "/rest/v1/invoices" && r.method === "PATCH");
}

describe("the AP stage schedules a correct invoice with terms", () => {
  it("schedules it for its discount deadline, with the figures, the terms and the reference in the ledger", async () => {
    today("2026-10-01T09:00:00.000Z");
    model(() => ({
      action: "schedule",
      payOn: "2026-10-11",
      reasoning: "A 2% discount (8 USDC) is worth more than 0.99 USDC of yield to the due date; paying on the deadline, Oct 11.",
      confidence: 0.9,
    }));
    const { fake, chain, metrics, lines, stage } = apFake({ book: [payable()] });

    await stage();

    // What the model was told.
    const prompt = promptOf();
    expect(prompt.terms).toEqual({ earlyPayDiscount: { percent: 2, deadline: "2026-10-11T12:00:00+00:00" } });
    expect(prompt.timing).toMatchObject({
      today: "2026-10-01",
      dueOn: "2026-10-31",
      discountValue: 8,
      discountAvailableUntil: "2026-10-11",
      floatValueToDue: 0.986301,
      targetOn: "2026-10-11",
      shortfall: false,
      amountDueAtTarget: 392,
      earlierObligations: { total: 0, count: 0 },
    });
    expect(prompt.scheduledEarlier).toBeNull();
    const shape = prompt.responseShape as Record<string, string>;
    expect(shape.action).toBe("pay | schedule | hold | flag_fraud | request_info");
    expect(shape.payOn).toContain("YYYY-MM-DD");
    // A schedule without a date is not a usable reply.
    const schema = (decideMock.mock.calls[0][0] as DecideParams<unknown>).schema;
    expect(schema.safeParse({ action: "schedule", reasoning: "Pay on the deadline.", confidence: 0.8 }).success).toBe(false);
    expect(schema.safeParse({ action: "pay", payOn: null, reasoning: "Due today; paying now.", confidence: 0.8 }).success).toBe(true);

    // Nothing moves today.
    expect(chain.transfers).toEqual([]);
    expect(fake.requests.some((r) => r.path.includes("payment_intents"))).toBe(false);

    const [patch] = invoicePatches(fake.requests);
    expect(patch.params.get("id")).toBe(`eq.${INVOICE_ID}`);
    expect(patch.body).toMatchObject({
      status: "scheduled",
      scheduled_for: "2026-10-11T00:00:00.000Z",
      agent_reasoning: "A 2% discount (8 USDC) is worth more than 0.99 USDC of yield to the due date; paying on the deadline, Oct 11.",
      settled_at: null,
      tx_ref: null,
      paid_amount: null,
    });
    expect(typeof (patch.body as Record<string, unknown>).decided_at).toBe("string");

    const [entry] = ledger(fake.requests);
    expect(entry.p_action).toBe("ap_schedule");
    expect(entry.p_summary).toBe("SCHEDULE invoice from Northwind for 400 USDC on 2026-10-11");
    expect(entry.p_detail).toMatchObject({
      invoiceId: INVOICE_ID,
      counterpartyId: NORTHWIND,
      decision: { action: "schedule", payOn: "2026-10-11" },
      decisionMode: "anthropic",
      referenceDecision: { action: "schedule", payOn: "2026-10-11" },
      agreedWithReference: true,
      guardrailBlocked: false,
      guardrailRule: null,
      timing: {
        targetOn: "2026-10-11",
        discountValue: 8,
        amountDueAtTarget: 392,
        earlierObligations: { total: 0, count: 0 },
        recommendation: { action: "schedule", payOn: "2026-10-11" },
      },
      timingRule: null,
      terms: { earlyPayDiscount: { percent: 2, deadline: "2026-10-11T12:00:00+00:00" } },
      observed: { amount: 400, paymentLimit: 1000, riskLevel: "low", poReference: "PO-1044", goodsReceived: true, operatingBalance: 1000 },
      execution: { txRef: null, resultingStatus: "scheduled" },
    });
    expect(entry.p_detail).not.toHaveProperty("scheduledFor");
    expect(entry.p_detail).not.toHaveProperty("amountPaid");

    expect(lines).toEqual([{ domain: "ap", message: "Northwind: scheduled for 2026-10-11 (400 USDC)" }]);
    expect(metrics.snapshot()).toMatchObject({ decisionCount: 1, scheduledCount: 1, paidCount: 0 });
  });

  it("moves a date past the due date back to the due date, and records the correction", async () => {
    today("2026-10-01T09:00:00.000Z");
    model(() => ({ action: "schedule", payOn: "2026-11-15", reasoning: "Keep the cash as long as possible.", confidence: 0.6 }));
    const { fake, lines, stage } = apFake({ book: [payable()] });

    await stage();

    const [patch] = invoicePatches(fake.requests);
    expect(patch.body).toMatchObject({ status: "scheduled", scheduled_for: "2026-10-31T00:00:00.000Z" });
    expect((patch.body as Record<string, string>).agent_reasoning).toContain("Keep the cash as long as possible.");
    expect((patch.body as Record<string, string>).agent_reasoning).toContain("2026-10-31");
    const [entry] = ledger(fake.requests);
    expect(entry.p_action).toBe("ap_schedule");
    expect(entry.p_detail).toMatchObject({
      decision: { action: "schedule", payOn: "2026-10-31" },
      timingRule: "payon.after_due",
      requestedPayOn: "2026-11-15",
    });
    expect(lines[0].message).toBe("Northwind: scheduled for 2026-10-31 (400 USDC)");
  });

  it("pays now, at the discounted amount, when the date the model chose is not after today", async () => {
    today("2026-10-01T09:00:00.000Z");
    model(() => ({ action: "schedule", payOn: "2026-10-01", reasoning: "Pay it today and take the discount.", confidence: 0.7 }));
    const { fake, chain, stage } = apFake({ book: [payable()] });

    await stage();

    expect(chain.transfers.map((t) => t.amount)).toEqual([392]);
    const [patch] = invoicePatches(fake.requests);
    expect(patch.body).toMatchObject({ status: "paid", scheduled_for: null, paid_amount: 392 });
    const [entry] = ledger(fake.requests);
    expect(entry.p_action).toBe("ap_pay");
    expect(entry.p_detail).toMatchObject({ decision: { action: "pay" }, timingRule: "payon.not_after_today", amountPaid: 392, discountTaken: 8 });
    expect((entry.p_detail as { decision: Record<string, unknown> }).decision).not.toHaveProperty("payOn");
  });

  it("keeps no date on a decision that is not a schedule, whatever the model sent with it", async () => {
    today("2026-10-01T09:00:00.000Z");
    model(() => ({ action: "hold", payOn: "2026-10-11", reasoning: "Hold until the PO is confirmed by the buyer.", confidence: 0.6 }));
    const { fake, stage } = apFake({ book: [payable()] });

    await stage();

    expect(invoicePatches(fake.requests)[0].body).toMatchObject({ status: "held", scheduled_for: null });
    const [entry] = ledger(fake.requests);
    expect(entry.p_action).toBe("ap_hold");
    expect((entry.p_detail as { decision: Record<string, unknown> }).decision).not.toHaveProperty("payOn");
    expect(entry.p_detail).toMatchObject({ timingRule: null });
  });

  it("refuses to schedule for a high-risk counterparty, as it would refuse to pay", async () => {
    today("2026-10-01T09:00:00.000Z");
    model(() => ({ action: "schedule", payOn: "2026-10-11", reasoning: "Take the discount on the deadline.", confidence: 0.8 }));
    const { fake, chain, metrics, stage } = apFake({ book: [payable({ counterparties: counterparty({ risk_level: "high" }) })] });

    await stage();

    expect(chain.transfers).toEqual([]);
    const [patch] = invoicePatches(fake.requests);
    expect(patch.body).toMatchObject({ status: "flagged", scheduled_for: null, paid_amount: null });
    const [entry] = ledger(fake.requests);
    expect(entry.p_action).toBe("ap_schedule");
    expect(entry.p_detail).toMatchObject({ guardrailBlocked: true, guardrailRule: "counterparty.high_risk", execution: { resultingStatus: "flagged" } });
    expect(metrics.snapshot()).toMatchObject({ scheduledCount: 0, flaggedCount: 1, guardrailOverrideCount: 1 });
  });
});

describe("the AP stage and a scheduled invoice", () => {
  it("loads scheduled payables next to pending and matched ones", async () => {
    today("2026-10-01T09:00:00.000Z");
    const { fake, stage } = apFake({ book: [] });

    await stage();

    const [load] = fake.requests.filter((r) => r.path === "/rest/v1/invoices" && r.params.get("status"));
    expect(load.params.get("status")).toBe("in.(pending,matched,scheduled)");
    expect(load.params.get("direction")).toBe("eq.payable");
  });

  it("loads them in the order they were submitted, then by id, so each cycle decides them in the same order", async () => {
    today("2026-10-01T09:00:00.000Z");
    const { fake, stage } = apFake({ book: [] });

    await stage();

    const [load] = fake.requests.filter((r) => r.path === "/rest/v1/invoices" && r.params.get("status"));
    expect(load.params.get("order")).toBe("created_at.asc,id.asc");
  });

  it("leaves it alone before its day, and still counts it as falling due before a later invoice", async () => {
    today("2026-10-01T09:00:00.000Z");
    const later = {
      ...payable({
        id: OTHER_INVOICE_ID, amount: "100", memo: "Office chairs", po_reference: "PO-2210", due_date: "2026-10-20T12:00:00+00:00",
        counterparty_id: CONTOSO, early_pay_discount_pct: null, discount_due_date: null,
      }),
      counterparties: counterparty({ id: CONTOSO, name: "Contoso" }),
    };
    const { fake, chain, lines, stage } = apFake({ book: [scheduledPayable(), later] });

    await stage(450);

    // Only the later invoice was decided; the scheduled one was not written, not logged, not paid.
    expect(decideMock).toHaveBeenCalledTimes(1);
    expect(invoicePatches(fake.requests).map((p) => p.params.get("id"))).toEqual([`eq.${OTHER_INVOICE_ID}`]);
    expect(ledger(fake.requests).map((e) => (e.p_detail as Record<string, unknown>).invoiceId)).toEqual([OTHER_INVOICE_ID]);
    expect(chain.transfers).toEqual([]);
    // 450 less the 400 leaving on Oct 11 cannot cover 100 on Oct 20, so the written policy holds it.
    expect(lines).toEqual([{ domain: "ap", message: "Contoso: hold (100 USDC)" }]);

    // The 400 USDC leaving on Oct 11 comes before Oct 20: 450 less 400 cannot cover 100.
    expect(promptOf().timing).toMatchObject({ targetOn: "2026-10-20", earlierObligations: { total: 400, count: 1 }, shortfall: true });
    expect(ledger(fake.requests)[0].p_detail).toMatchObject({ timing: { earlierObligations: { total: 400, count: 1 }, shortfall: true } });
  });

  it("counts verified milestones as falling due first", async () => {
    today("2026-10-01T09:00:00.000Z");
    const { fake, stage } = apFake({ book: [payable()], milestones: [{ amount: "250" }] });

    await stage(500);

    const milestones = fake.requests.find((r) => r.path === "/rest/v1/milestones");
    expect(milestones?.params.get("status")).toBe("eq.verified");
    // 500 less the 250 milestone released today cannot cover the 392 due on Oct 11.
    expect(promptOf().timing).toMatchObject({ earlierObligations: { total: 250, count: 1 }, shortfall: true });
  });

  it("decides it again on its day, tells the model why it waited, and pays the discounted amount", async () => {
    today("2026-10-11T06:00:00.000Z");
    model((params) => params.fallback());
    const { fake, chain, metrics, lines, stage } = apFake({ book: [scheduledPayable()] });

    await stage();

    expect(promptOf().scheduledEarlier).toEqual({
      payOn: "2026-10-11",
      reasoning: "A 2% discount (8 USDC) is worth more than 0.99 USDC of yield; paying on the deadline.",
    });
    expect(chain.transfers).toHaveLength(1);
    expect(chain.transfers[0]).toMatchObject({ amount: 392, toAddress: "0xnorth", fromAccountId: ACCOUNT_ID });

    const [patch] = invoicePatches(fake.requests);
    expect(patch.body).toMatchObject({ status: "paid", scheduled_for: null, paid_amount: 392, tx_ref: "0xhash" });
    expect(typeof (patch.body as Record<string, unknown>).settled_at).toBe("string");

    const [entry] = ledger(fake.requests);
    expect(entry.p_action).toBe("ap_pay");
    expect(entry.p_summary).toBe("PAY invoice from Northwind for 400 USDC: 392 USDC with the early-payment discount");
    expect(entry.p_detail).toMatchObject({
      decision: { action: "pay" },
      amountPaid: 392,
      discountTaken: 8,
      scheduledFor: "2026-10-11T00:00:00+00:00",
      execution: { resultingStatus: "paid", txRef: "0xhash" },
    });
    expect(lines).toEqual([{ domain: "ap", message: "Northwind: pay (392 USDC after a 2% early-payment discount on 400 USDC)" }]);
    expect(metrics.snapshot()).toMatchObject({ paidCount: 1, scheduledCount: 0 });
  });

  it("pays the full amount when it is paid the day after the deadline", async () => {
    today("2026-10-12T06:00:00.000Z");
    model(() => ({ action: "pay", reasoning: "Pay it now; the discount has lapsed but the invoice is correct.", confidence: 0.7 }));
    const { fake, chain, stage } = apFake({ book: [scheduledPayable()] });

    await stage();

    expect(chain.transfers.map((t) => t.amount)).toEqual([400]);
    expect(invoicePatches(fake.requests)[0].body).toMatchObject({ status: "paid", paid_amount: 400, scheduled_for: null });
    expect(ledger(fake.requests)[0].p_detail).toMatchObject({ amountPaid: 400, discountTaken: 0, scheduledFor: "2026-10-11T00:00:00+00:00" });
  });

  it("with no model, reschedules a missed deadline to the due date rather than paying early", async () => {
    today("2026-10-12T06:00:00.000Z");
    const { fake, chain, stage } = apFake({ book: [scheduledPayable()] });

    await stage();

    expect(chain.transfers).toEqual([]);
    expect(invoicePatches(fake.requests)[0].body).toMatchObject({ status: "scheduled", scheduled_for: "2026-10-31T00:00:00.000Z" });
    expect(ledger(fake.requests)[0].p_detail).toMatchObject({
      decision: { action: "schedule", payOn: "2026-10-31" },
      decisionMode: "heuristic",
      scheduledFor: "2026-10-11T00:00:00+00:00",
    });
  });

  it("holds it on its day while the agent is paused, and moves nothing", async () => {
    today("2026-10-11T06:00:00.000Z");
    const { fake, chain, lines, stage } = apFake({ book: [scheduledPayable()], paused: true });

    await stage();

    expect(chain.transfers).toEqual([]);
    expect(fake.requests.some((r) => r.path === "/rest/v1/rpc/claim_payment_intent")).toBe(false);
    const [patch] = invoicePatches(fake.requests);
    expect(patch.body).toMatchObject({ status: "held", scheduled_for: null, paid_amount: null });
    expect((patch.body as Record<string, string>).agent_reasoning).toContain("[not paid: the agent was paused]");
    const [entry] = ledger(fake.requests);
    expect(entry.p_action).toBe("ap_pay");
    expect(entry.p_detail).toMatchObject({ amountPaid: null, discountTaken: null, execution: { heldBecause: "agent_paused", resultingStatus: "held" } });
    expect(lines).toEqual([{ domain: "ap", message: "Northwind: not paid, the agent was paused (400 USDC)" }]);
  });

  it("holds it on its day when the counterparty's address changed since and no one has confirmed it, and moves nothing", async () => {
    today("2026-10-11T06:00:00.000Z");
    model(() => ({ action: "pay", reasoning: "Scheduled for today; paying at the discount.", confidence: 0.9 }));
    const changed = counterparty({ address: "0xredirected", address_changed_at: "2026-10-05T14:00:00+00:00", address_confirmed_at: null });
    const { fake, chain, stage } = apFake({ book: [scheduledPayable({ counterparties: changed })] });

    await stage();

    expect(chain.transfers).toEqual([]);
    expect(fake.requests.some((r) => r.path.includes("payment_intents"))).toBe(false);
    const [patch] = invoicePatches(fake.requests);
    expect(patch.body).toMatchObject({ status: "held", scheduled_for: null, paid_amount: null, tx_ref: null });
    expect((patch.body as Record<string, string>).agent_reasoning).toContain(
      "the counterparty's address changed on 2026-10-05 and no one has confirmed it — held for a person to approve"
    );
    const [entry] = ledger(fake.requests);
    expect(entry.p_action).toBe("ap_pay");
    expect(entry.p_detail).toMatchObject({
      guardrailBlocked: true,
      guardrailRule: "counterparty.address_unconfirmed",
      amountPaid: null,
      discountTaken: null,
      scheduledFor: "2026-10-11T00:00:00+00:00",
      observed: { addressUnconfirmed: true },
      execution: { txRef: null, resultingStatus: "held" },
    });
  });

  it("flags it on its day when the counterparty turned high risk since, and moves nothing", async () => {
    today("2026-10-11T06:00:00.000Z");
    model(() => ({ action: "pay", reasoning: "Scheduled for today; paying at the discount.", confidence: 0.9 }));
    const { fake, chain, stage } = apFake({ book: [scheduledPayable({ counterparties: counterparty({ risk_level: "high" }) })] });

    await stage();

    expect(chain.transfers).toEqual([]);
    expect(fake.requests.some((r) => r.path.includes("payment_intents"))).toBe(false);
    expect(invoicePatches(fake.requests)[0].body).toMatchObject({ status: "flagged", scheduled_for: null, paid_amount: null });
    expect(ledger(fake.requests)[0].p_detail).toMatchObject({
      guardrailBlocked: true, guardrailRule: "counterparty.high_risk", amountPaid: null, scheduledFor: "2026-10-11T00:00:00+00:00",
    });
  });
});

/**
 * A duplicate must never be paid twice because the agent took its time. Two
 * identical invoices are one obligation: whichever is paid, scheduled or in
 * flight first, the other is refused in code (`invoice.duplicate_of_settled`),
 * within one cycle as across cycles.
 */
describe("the AP stage and duplicates of money already committed", () => {
  const twin = (overrides: Record<string, unknown> = {}) => ({ id: OTHER_INVOICE_ID, ...overrides });

  it("pays only one of two identical invoices scheduled for the same day, and the guardrail flags the other", async () => {
    today("2026-10-11T06:00:00.000Z");
    // The worst case: a model that ignores the duplicate evidence and pays.
    model(() => ({ action: "pay", reasoning: "Scheduled for today; paying at the discount.", confidence: 0.9 }));
    const { fake, chain, stage } = apFake({ book: [scheduledPayable(), scheduledPayable(twin())] });

    await stage();

    expect(chain.transfers).toHaveLength(1);
    const statuses = invoicePatches(fake.requests).map((p) => (p.body as Record<string, unknown>).status);
    expect(statuses.sort()).toEqual(["flagged", "paid"]);
    const flagged = ledger(fake.requests).find((e) => (e.p_detail as Record<string, unknown>).guardrailBlocked === true);
    expect(flagged?.p_detail).toMatchObject({ guardrailRule: "invoice.duplicate_of_settled", execution: { resultingStatus: "flagged" } });
    const flaggedPatch = invoicePatches(fake.requests).find((p) => (p.body as Record<string, unknown>).status === "flagged");
    expect((flaggedPatch?.body as Record<string, string>).agent_reasoning).toMatch(/already (scheduled|paid)/);
    // The one paid is the one the flagged twin was refused against.
    const paidPatch = invoicePatches(fake.requests).find((p) => (p.body as Record<string, unknown>).status === "paid");
    const [match] = (flagged?.p_detail as { observed: { duplicateCheck: { matches: Array<{ otherInvoiceId: string }> } } }).observed.duplicateCheck.matches;
    expect(paidPatch?.params.get("id")).toBe(`eq.${match.otherInvoiceId}`);
  });

  it("flags the second of two identical fresh invoices in one cycle, rather than scheduling both", async () => {
    today("2026-10-01T09:00:00.000Z");
    model(() => ({ action: "schedule", payOn: "2026-10-11", reasoning: "Take the 2% discount on its deadline.", confidence: 0.9 }));
    const { fake, chain, stage } = apFake({ book: [payable(), payable(twin())] });

    await stage();

    expect(chain.transfers).toEqual([]);
    const [first, second] = invoicePatches(fake.requests);
    expect(first.params.get("id")).toBe(`eq.${INVOICE_ID}`);
    expect(first.body).toMatchObject({ status: "scheduled", scheduled_for: "2026-10-11T00:00:00.000Z" });
    expect(second.params.get("id")).toBe(`eq.${OTHER_INVOICE_ID}`);
    expect(second.body).toMatchObject({ status: "flagged", scheduled_for: null });
    expect((second.body as Record<string, string>).agent_reasoning).toContain("already scheduled");
    expect(ledger(fake.requests)[1].p_detail).toMatchObject({
      guardrailBlocked: true,
      guardrailRule: "invoice.duplicate_of_settled",
      observed: { duplicateCheck: { matches: [{ otherInvoiceId: INVOICE_ID, otherInvoiceStatus: "scheduled" }] } },
    });
  });

  it("flags the twin submitted later, whichever order the book holds them in", async () => {
    today("2026-10-01T09:00:00.000Z");
    model(() => ({ action: "schedule", payOn: "2026-10-11", reasoning: "Take the 2% discount on its deadline.", confidence: 0.9 }));
    // The later submission comes first in the table and has the lower id: only created_at says which came first.
    const later = payable({ id: "018f8ce0-1557-7b54-a931-4d777f6ba000", created_at: "2026-10-01T08:00:00+00:00" });
    const earlier = payable({ created_at: "2026-09-30T08:00:00+00:00" });
    const { fake, stage } = apFake({ book: [later, earlier] });

    await stage();

    const patches = invoicePatches(fake.requests);
    expect(patches.map((p) => [p.params.get("id"), (p.body as Record<string, unknown>).status])).toEqual([
      [`eq.${INVOICE_ID}`, "scheduled"],
      ["eq.018f8ce0-1557-7b54-a931-4d777f6ba000", "flagged"],
    ]);
  });

  it("breaks a tie in submission time by id", async () => {
    today("2026-10-01T09:00:00.000Z");
    const at = "2026-09-30T08:00:00+00:00";
    const { fake, stage } = apFake({ book: [payable(twin({ created_at: at })), payable({ created_at: at })] });

    await stage();

    const patches = invoicePatches(fake.requests);
    expect(patches.map((p) => [p.params.get("id"), (p.body as Record<string, unknown>).status])).toEqual([
      [`eq.${INVOICE_ID}`, "scheduled"],
      [`eq.${OTHER_INVOICE_ID}`, "flagged"],
    ]);
  });

  it("with no model, flags the second of two identical fresh invoices too", async () => {
    today("2026-10-01T09:00:00.000Z");
    const { fake, stage } = apFake({ book: [payable(), payable(twin())] });

    await stage();

    const statuses = invoicePatches(fake.requests).map((p) => (p.body as Record<string, unknown>).status);
    expect(statuses).toEqual(["scheduled", "flagged"]);
    expect(ledger(fake.requests).map((e) => e.p_action)).toEqual(["ap_schedule", "ap_flag_fraud"]);
  });

  it("flags a duplicate of an invoice a person is approving and paying right now, whatever the model says", async () => {
    today("2026-10-01T09:00:00.000Z");
    model(() => ({ action: "pay", reasoning: "PO-1044 matches and the goods were received; paying now.", confidence: 0.9 }));
    const { fake, chain, stage } = apFake({ book: [payable({ status: "processing" }), payable(twin())] });

    await stage();

    expect(chain.transfers).toEqual([]);
    const patches = invoicePatches(fake.requests);
    expect(patches.map((p) => p.params.get("id"))).toEqual([`eq.${OTHER_INVOICE_ID}`]);
    expect(patches[0].body).toMatchObject({ status: "flagged", scheduled_for: null, paid_amount: null });
    expect((patches[0].body as Record<string, string>).agent_reasoning).toContain("already being decided by a person");
    expect((patches[0].body as Record<string, string>).agent_reasoning).toContain(
      "[guardrail override: this invoice repeats one already paid, being paid, scheduled or being decided by a person ("
    );
    expect(promptOf().duplicateNote).toContain(
      "A match that bills the same purchase order for the same amount as an invoice already paid, being paid, scheduled or being decided by a person is duplicate billing"
    );
    expect(ledger(fake.requests)[0].p_detail).toMatchObject({
      guardrailBlocked: true,
      guardrailRule: "invoice.duplicate_of_settled",
      observed: { duplicateCheck: { matches: [{ otherInvoiceId: INVOICE_ID, otherInvoiceStatus: "processing" }] } },
    });
  });

  it("flags a duplicate of a scheduled invoice decided on a later day", async () => {
    today("2026-10-03T09:00:00.000Z");
    const { fake, chain, stage } = apFake({ book: [scheduledPayable(), payable(twin())] });

    await stage();

    expect(chain.transfers).toEqual([]);
    const patches = invoicePatches(fake.requests);
    expect(patches.map((p) => p.params.get("id"))).toEqual([`eq.${OTHER_INVOICE_ID}`]);
    expect(patches[0].body).toMatchObject({ status: "flagged", scheduled_for: null });
    const [entry] = ledger(fake.requests);
    expect(entry.p_action).toBe("ap_flag_fraud");
    expect((entry.p_detail as { decision: { reasoning: string } }).decision.reasoning).toContain("already scheduled");
  });
});

/**
 * The model decides when to pay from the facts (spec 2026-09-30-payment-timing
 * P1). The written policy's own answer — its `recommendation` and `reason` —
 * is withheld from the prompt, and recorded in the ledger as the reference, so
 * agreeing with it is something the model does, not something it is told.
 */
describe("the AP stage gives the model the timing facts, not the policy's answer", () => {
  const FACTS = [
    "today", "dueOn", "discountValue", "discountAvailableUntil", "floatValueToDue", "targetOn", "amountDueAtTarget", "earlierObligations", "shortfall",
  ];

  it("sends every timing fact, and neither the recommendation nor its reason", async () => {
    today("2026-10-01T09:00:00.000Z");
    model(() => ({ action: "schedule", payOn: "2026-10-11", reasoning: "Take the 2% discount (8 USDC) on its deadline.", confidence: 0.9 }));
    const { fake, stage } = apFake({ book: [payable()] });

    await stage();

    const timing = promptOf().timing as Record<string, unknown>;
    expect(Object.keys(timing).sort()).toEqual([...FACTS].sort());
    expect(timing).not.toHaveProperty("recommendation");
    expect(timing).not.toHaveProperty("reason");
    const sent = (decideMock.mock.calls[0][0] as DecideParams<unknown>).userPrompt;
    expect(sent).not.toContain('"recommendation"');
    expect(sent).not.toContain('"reason"');
    expect(sent).not.toContain("paying on the discount deadline, Oct 11, 2026");

    // The reference is still worked out, and kept where an auditor reads it.
    expect(ledger(fake.requests)[0].p_detail).toMatchObject({
      referenceDecision: { action: "schedule", payOn: "2026-10-11" },
      agreedWithReference: true,
      timing: {
        recommendation: { action: "schedule", payOn: "2026-10-11" },
        reason: expect.stringContaining("paying on the discount deadline, Oct 11, 2026"),
      },
    });
  });

  it("tells the model how many payments fall due first, and their total", async () => {
    today("2026-10-01T09:00:00.000Z");
    const chairs = payable({
      id: OTHER_INVOICE_ID, amount: "100", memo: "Office chairs", po_reference: "PO-2210", due_date: "2026-10-05T12:00:00+00:00",
      counterparty_id: CONTOSO, early_pay_discount_pct: null, discount_due_date: null, status: "held",
      counterparties: counterparty({ id: CONTOSO, name: "Contoso" }),
    });
    const { stage } = apFake({ book: [payable(), chairs], milestones: [{ amount: "20" }, { amount: "30" }] });

    await stage();

    expect(promptOf().timing).toMatchObject({ targetOn: "2026-10-11", earlierObligations: { total: 150, count: 3 }, shortfall: false });
  });

  it("tells the model to hold a payment the balance cannot cover after what falls due on or before its date", async () => {
    today("2026-10-01T09:00:00.000Z");
    const { stage } = apFake({ book: [payable()] });

    await stage();

    const system = (decideMock.mock.calls[0][0] as DecideParams<unknown>).systemPrompt;
    expect(system).toContain(
      "When `timing.shortfall` is true, the cash available by its date (the operating balance, plus the reserve for a later day) cannot cover this payment after the payables that fall due on or before that date. Hold it and cite the figures, rather than scheduling or paying into a failure."
    );
    expect(system).toContain("what falls due on or before its date");
    expect(system).not.toMatch(/falls due before/);
  });
});

/**
 * The shortfall check counts the reserve for a payment targeted at a later
 * day, since the treasury stage redeems it back into operating before that
 * day comes due — but not for a payment due (and so targeted) today, since
 * the treasury stage that would redeem it runs after AP in the same cycle.
 */
describe("the AP stage counts the reserve balance for a payment scheduled later", () => {
  it("schedules it for the discount deadline rather than holding it, when the reserve alone covers it", async () => {
    today("2026-10-01T09:00:00.000Z");
    // payable(): 400 USDC, 2% off by 2026-10-11 (10 days out), due 2026-10-31.
    const { fake, stage } = apFake({ book: [payable()] });

    await stage(0, 10_000); // no operating cash at all; the reserve covers the 392 USDC due on the deadline

    expect(promptOf().timing).toMatchObject({ targetOn: "2026-10-11", shortfall: false, amountDueAtTarget: 392 });
    const [patch] = invoicePatches(fake.requests);
    expect(patch.body).toMatchObject({ status: "scheduled", scheduled_for: "2026-10-11T00:00:00.000Z" });
  });

  it("holds it rather than paying, when it is due today and the reserve cannot be drawn on this minute", async () => {
    today("2026-10-01T09:00:00.000Z");
    const dueToday = payable({
      amount: "400", due_date: "2026-10-01T12:00:00+00:00", early_pay_discount_pct: null, discount_due_date: null,
    });
    const { fake, stage } = apFake({ book: [dueToday] });

    await stage(0, 10_000); // no operating cash; the reserve is not liquid for a payment this minute

    expect(promptOf().timing).toMatchObject({ targetOn: "2026-10-01", shortfall: true, amountDueAtTarget: 400 });
    const [patch] = invoicePatches(fake.requests);
    expect(patch.body).toMatchObject({ status: "held", scheduled_for: null, paid_amount: null });
  });

  it("marks a hold for want of cash, with what it needed and the cash it saw, so the follow-up decides it again once cash moves (reserve cash back R4)", async () => {
    today("2026-10-01T09:00:00.000Z");
    const dueToday = payable({
      amount: "400", due_date: "2026-10-01T12:00:00+00:00", early_pay_discount_pct: null, discount_due_date: null,
    });
    const { fake, stage } = apFake({ book: [dueToday] });

    await stage(0, 10_000);

    expect(ledger(fake.requests)[0].p_detail).toMatchObject({
      execution: { resultingStatus: "held", heldBecause: "cash_shortfall", cashNeededUsdc: 400, cashSeen: { operating: 0, reserve: 10_000 } },
    });
  });

  it("holds it when the operating balance and the (empty) reserve together still fall short of a later target", async () => {
    today("2026-10-01T09:00:00.000Z");
    const dueIn20Days = payable({
      amount: "400", due_date: "2026-10-21T12:00:00+00:00", early_pay_discount_pct: null, discount_due_date: null,
    });
    const { fake, stage } = apFake({ book: [dueIn20Days] });

    await stage(100, 0);

    expect(promptOf().timing).toMatchObject({ targetOn: "2026-10-21", shortfall: true, amountDueAtTarget: 400 });
    const [patch] = invoicePatches(fake.requests);
    expect(patch.body).toMatchObject({ status: "held", scheduled_for: null, paid_amount: null });
  });
});

describe("the AP stage with no model holds a payable the balance cannot cover", () => {
  const chairs = (overrides: Record<string, unknown> = {}) =>
    payable({
      id: OTHER_INVOICE_ID, amount: "100", memo: "Office chairs", po_reference: "PO-2210", due_date: "2026-10-20T12:00:00+00:00",
      counterparty_id: CONTOSO, early_pay_discount_pct: null, discount_due_date: null,
      counterparties: counterparty({ id: CONTOSO, name: "Contoso" }),
      ...overrides,
    });

  it("holds it rather than scheduling it, and cites the balance, what falls due first and the amount", async () => {
    today("2026-10-01T09:00:00.000Z");
    const { fake, chain, stage } = apFake({ book: [scheduledPayable(), chairs()] });

    await stage(450);

    expect(chain.transfers).toEqual([]);
    const [patch] = invoicePatches(fake.requests);
    expect(patch.body).toMatchObject({ status: "held", scheduled_for: null, paid_amount: null });
    const reasoning = (patch.body as Record<string, string>).agent_reasoning;
    expect(reasoning).toBe(
      "Operating balance 450 USDC, less 400 USDC for 1 obligation falling due on or before Oct 20, 2026, cannot cover the 100 USDC this invoice needs then; holding it rather than scheduling it into a shortfall."
    );
    const [entry] = ledger(fake.requests);
    expect(entry.p_action).toBe("ap_hold");
    expect(entry.p_detail).toMatchObject({
      decisionMode: "heuristic",
      decision: { action: "hold" },
      referenceDecision: { action: "hold" },
      guardrailBlocked: false,
      timing: { shortfall: true, earlierObligations: { total: 400, count: 1 }, amountDueAtTarget: 100 },
    });
  });

  it("cites the reserve with the operating balance when it holds one targeted at a later day", async () => {
    today("2026-10-01T09:00:00.000Z");
    const { fake, stage } = apFake({ book: [scheduledPayable(), chairs()] });

    await stage(300, 150);

    const [patch] = invoicePatches(fake.requests);
    expect(patch.body).toMatchObject({ status: "held", scheduled_for: null });
    expect((patch.body as Record<string, string>).agent_reasoning).toBe(
      "Operating balance 300 USDC plus 150 USDC in the reserve, less 400 USDC for 1 obligation falling due on or before Oct 20, 2026, cannot cover the 100 USDC this invoice needs then; holding it rather than scheduling it into a shortfall."
    );
  });

  it("does not cite the reserve when it holds one due today, since the reserve cannot pay this minute", async () => {
    today("2026-10-01T09:00:00.000Z");
    const { fake, stage } = apFake({ book: [chairs({ due_date: "2026-10-01T12:00:00+00:00" })] });

    await stage(60, 500);

    expect((invoicePatches(fake.requests)[0].body as Record<string, string>).agent_reasoning).toBe(
      "Operating balance 60 USDC cannot cover the 100 USDC this invoice needs on Oct 1, 2026; holding it rather than paying it into a shortfall."
    );
  });

  it("holds one due today rather than paying into a failure", async () => {
    today("2026-10-01T09:00:00.000Z");
    const { fake, chain, stage } = apFake({ book: [chairs({ due_date: "2026-10-01T12:00:00+00:00" })] });

    await stage(60);

    expect(chain.transfers).toEqual([]);
    expect(fake.requests.some((r) => r.path.includes("payment_intents"))).toBe(false);
    const [patch] = invoicePatches(fake.requests);
    expect(patch.body).toMatchObject({ status: "held", paid_amount: null });
    expect((patch.body as Record<string, string>).agent_reasoning).toBe(
      "Operating balance 60 USDC cannot cover the 100 USDC this invoice needs on Oct 1, 2026; holding it rather than paying it into a shortfall."
    );
  });

  it("records the hold as the reference a model's schedule into a shortfall disagrees with", async () => {
    today("2026-10-01T09:00:00.000Z");
    model(() => ({ action: "schedule", payOn: "2026-10-20", reasoning: "Keep the cash until the due date.", confidence: 0.7 }));
    const { fake, metrics, stage } = apFake({ book: [scheduledPayable(), chairs()] });

    await stage(450);

    expect(ledger(fake.requests)[0].p_detail).toMatchObject({
      decision: { action: "schedule", payOn: "2026-10-20" },
      referenceDecision: { action: "hold" },
      agreedWithReference: false,
    });
    expect(metrics.snapshot().referenceDisagreementCount).toBe(1);
  });

  it("still asks for information first when the three-way match is incomplete", async () => {
    today("2026-10-01T09:00:00.000Z");
    const { fake, stage } = apFake({ book: [chairs({ due_date: "2026-10-01T12:00:00+00:00", goods_received: false })] });

    await stage(60);

    expect(ledger(fake.requests)[0].p_action).toBe("ap_request_info");
  });
});

describe("the AP stage compares the model with the reference on the decision code let stand", () => {
  it("counts a schedule for another day as a disagreement", async () => {
    today("2026-10-01T09:00:00.000Z");
    model(() => ({ action: "schedule", payOn: "2026-10-31", reasoning: "Keep the cash until the due date.", confidence: 0.7 }));
    const { fake, metrics, stage } = apFake({ book: [payable()] });

    await stage();

    expect(ledger(fake.requests)[0].p_detail).toMatchObject({
      decision: { action: "schedule", payOn: "2026-10-31" },
      referenceDecision: { action: "schedule", payOn: "2026-10-11" },
      agreedWithReference: false,
    });
    expect(metrics.snapshot().referenceDisagreementCount).toBe(1);
  });

  it("judges a date code moved back to the due date as the date it now is", async () => {
    today("2026-10-01T09:00:00.000Z");
    model(() => ({ action: "schedule", payOn: "2026-12-01", reasoning: "Keep the cash for as long as possible.", confidence: 0.7 }));
    const { fake, metrics, stage } = apFake({ book: [payable({ early_pay_discount_pct: null, discount_due_date: null })] });

    await stage();

    expect(ledger(fake.requests)[0].p_detail).toMatchObject({
      decision: { action: "schedule", payOn: "2026-10-31" },
      referenceDecision: { action: "schedule", payOn: "2026-10-31" },
      timingRule: "payon.after_due",
      agreedWithReference: true,
    });
    expect(metrics.snapshot().referenceDisagreementCount).toBe(0);
  });

  it("counts a schedule code turned into pay now as a disagreement with a reference schedule", async () => {
    today("2026-10-01T09:00:00.000Z");
    model(() => ({ action: "schedule", payOn: "2026-09-30", reasoning: "Pay it on the date it arrived.", confidence: 0.7 }));
    const { fake, stage } = apFake({ book: [payable()] });

    await stage();

    expect(ledger(fake.requests)[0].p_detail).toMatchObject({
      decision: { action: "pay" },
      referenceDecision: { action: "schedule", payOn: "2026-10-11" },
      agreedWithReference: false,
    });
  });

  it("records no comparison when the policy itself decided", async () => {
    today("2026-10-01T09:00:00.000Z");
    const { fake, stage } = apFake({ book: [payable()] });

    await stage();

    expect(ledger(fake.requests)[0].p_detail).toMatchObject({ decisionMode: "heuristic", agreedWithReference: null });
  });
});

describe("the AP stage with no model follows the timing policy", () => {
  it("schedules a correct invoice without terms for its due date, and says why", async () => {
    today("2026-10-01T09:00:00.000Z");
    const { fake, chain, stage } = apFake({ book: [payable({ early_pay_discount_pct: null, discount_due_date: null })] });

    await stage();

    expect(chain.transfers).toEqual([]);
    expect(invoicePatches(fake.requests)[0].body).toMatchObject({ status: "scheduled", scheduled_for: "2026-10-31T00:00:00.000Z" });
    const [entry] = ledger(fake.requests);
    expect(entry.p_detail).toMatchObject({
      decisionMode: "heuristic",
      decision: { action: "schedule", payOn: "2026-10-31" },
      terms: { earlyPayDiscount: null },
      timing: { recommendation: { action: "schedule", payOn: "2026-10-31" } },
    });
    expect((entry.p_detail as { decision: { reasoning: string } }).decision.reasoning).toContain("No early-payment discount; paying on the due date");
  });

  it("schedules a correct invoice with terms for its discount deadline", async () => {
    today("2026-10-01T09:00:00.000Z");
    const { fake, stage } = apFake({ book: [payable()] });

    await stage();

    expect(invoicePatches(fake.requests)[0].body).toMatchObject({ status: "scheduled", scheduled_for: "2026-10-11T00:00:00.000Z" });
  });

  it("still pays an invoice due today in this cycle, at the full amount", async () => {
    today("2026-10-01T09:00:00.000Z");
    const { fake, chain, stage } = apFake({
      book: [payable({ due_date: "2026-10-01T12:00:00+00:00", early_pay_discount_pct: null, discount_due_date: null })],
    });

    await stage();

    expect(chain.transfers.map((t) => t.amount)).toEqual([400]);
    expect(invoicePatches(fake.requests)[0].body).toMatchObject({ status: "paid", paid_amount: 400 });
    expect(ledger(fake.requests)[0].p_detail).toMatchObject({ decision: { action: "pay" }, amountPaid: 400, discountTaken: 0 });
  });
});

describe("dueForDecision — which loaded payables the AP stage decides", () => {
  const now = new Date("2026-10-11T06:00:00.000Z");

  it("decides every payable that is not scheduled", () => {
    expect(dueForDecision({ status: "pending", scheduled_for: null, due_date: "2026-12-01T12:00:00Z" }, now)).toBe(true);
    expect(dueForDecision({ status: "matched", scheduled_for: null, due_date: "2026-12-01T12:00:00Z" }, now)).toBe(true);
  });

  it("waits for a scheduled payable's day, UTC, and decides it on or after it", () => {
    const due = "2026-10-31T12:00:00Z";
    expect(dueForDecision({ status: "scheduled", scheduled_for: "2026-10-12T00:00:00Z", due_date: due }, now)).toBe(false);
    expect(dueForDecision({ status: "scheduled", scheduled_for: "2026-10-11T00:00:00Z", due_date: due }, now)).toBe(true);
    expect(dueForDecision({ status: "scheduled", scheduled_for: "2026-10-09T00:00:00Z", due_date: due }, now)).toBe(true);
    expect(dueForDecision({ status: "scheduled", scheduled_for: "2026-10-12T00:00:00Z", due_date: due }, new Date("2026-10-11T23:59:59.999Z"))).toBe(false);
  });

  it("never lets one wait past its due date, even with a later scheduled day", () => {
    expect(dueForDecision({ status: "scheduled", scheduled_for: "2026-10-20T00:00:00Z", due_date: "2026-10-11T12:00:00Z" }, now)).toBe(true);
  });

  it("decides one whose dates cannot be read, rather than waiting on them", () => {
    expect(dueForDecision({ status: "scheduled", scheduled_for: null, due_date: "2026-10-31T12:00:00Z" }, now)).toBe(true);
    expect(dueForDecision({ status: "scheduled", scheduled_for: "not a date", due_date: "2026-10-31T12:00:00Z" }, now)).toBe(true);
  });
});

describe("obligationsDueBy — what falls due by an invoice's payment date", () => {
  const book = [
    { id: "a", amount: 100, due_date: "2026-10-05T12:00:00Z", status: "pending", scheduled_for: null },
    { id: "b", amount: 200, due_date: "2026-10-30T12:00:00Z", status: "scheduled", scheduled_for: "2026-10-08T00:00:00Z" },
    { id: "c", amount: 50, due_date: "2026-10-09T12:00:00Z", status: "held", scheduled_for: null },
    { id: "d", amount: 70, due_date: "2026-10-10T12:00:00Z", status: "pending", scheduled_for: null },
    { id: "e", amount: 999, due_date: "2026-10-01T12:00:00Z", status: "paid", scheduled_for: null },
    { id: "f", amount: 999, due_date: "2026-10-01T12:00:00Z", status: "flagged", scheduled_for: null },
    { id: "g", amount: 30, due_date: "2026-11-30T12:00:00Z", status: "matched", scheduled_for: null },
    { id: "self", amount: 500, due_date: "2026-10-02T12:00:00Z", status: "pending", scheduled_for: null },
  ];
  const TODAY = "2026-10-01";

  const NONE = { total: 0, count: 0 };

  it("counts only payables in the deciding invoice's currency, and milestones only for USDC (EURC design P1)", () => {
    const mixed = [
      { id: "u", amount: 100, due_date: "2026-10-05T12:00:00Z", status: "pending", scheduled_for: null },
      { id: "e1", amount: 40, due_date: "2026-10-05T12:00:00Z", status: "pending", scheduled_for: null, currency: "EURC" as const },
      { id: "e2", amount: 60, due_date: "2026-10-06T12:00:00Z", status: "held", scheduled_for: null, currency: "EURC" as const },
    ];
    const milestones = { total: 25, count: 1 };
    expect(obligationsDueBy(mixed, { excludeId: "self", by: "2026-10-10", today: TODAY, milestones })).toEqual({ total: 125, count: 2 });
    expect(obligationsDueBy(mixed, { excludeId: "self", by: "2026-10-10", today: TODAY, milestones, currency: "EURC" })).toEqual({ total: 100, count: 2 });
  });

  it("sums the open payables dated on or before the target, by scheduled day where there is one, not this invoice, plus the milestones, and counts them", () => {
    expect(obligationsDueBy(book, { excludeId: "self", by: "2026-10-10", today: TODAY, milestones: NONE })).toEqual({ total: 450, count: 5 });
    expect(obligationsDueBy(book, { excludeId: "self", by: "2026-10-10", today: TODAY, milestones: { total: 25.5, count: 1 } })).toEqual({ total: 475.5, count: 6 });
    expect(obligationsDueBy(book, { excludeId: "self", by: "2026-10-08", today: TODAY, milestones: NONE })).toEqual({ total: 330, count: 3 });
    expect(obligationsDueBy(book, { excludeId: "self", by: "2026-10-07", today: TODAY, milestones: NONE })).toEqual({ total: 130, count: 2 });
  });

  it("counts one due on the target day itself", () => {
    expect(obligationsDueBy(book, { excludeId: "self", by: "2026-10-05", today: TODAY, milestones: NONE })).toEqual({ total: 130, count: 2 });
    expect(obligationsDueBy(book, { excludeId: "self", by: "2026-10-04", today: TODAY, milestones: NONE })).toEqual({ total: 30, count: 1 });
  });

  it("dates money already in flight today, whatever its due date says", () => {
    expect(obligationsDueBy([book[6]], { excludeId: "self", by: TODAY, today: TODAY, milestones: NONE })).toEqual({ total: 30, count: 1 });
  });

  it("counts an obligation it cannot date, since it may well come first", () => {
    expect(obligationsDueBy([{ id: "x", amount: 10, due_date: "garbage", status: "pending", scheduled_for: null }], { excludeId: "self", by: "2026-10-10", today: TODAY, milestones: NONE })).toEqual({ total: 10, count: 1 });
  });

  it("counts nothing when nothing falls due by then", () => {
    expect(obligationsDueBy([], { excludeId: "self", by: "2026-10-10", today: TODAY, milestones: NONE })).toEqual(NONE);
  });
});

describe("the cycle's obligation measurement", () => {
  it("reads scheduled_for with the open payables, so a scheduled invoice counts on the day it leaves", () => {
    const source = readFileSync(path.join(process.cwd(), "src", "lib", "agent", "orchestrator.ts"), "utf8");
    const measurement = source.slice(source.indexOf("shared obligation measurement"));
    expect(measurement).toMatch(
      /\.select\("amount, due_date, status, scheduled_for, currency"\)\s*\.eq\("direction", "payable"\)\s*\.in\("status", \[\.\.\.OPEN_PAYABLE_STATUSES\]\)/
    );
  });
});

describe("the AP stage and the agent's spending limit (outflow budget spec)", () => {
  const plain = { early_pay_discount_pct: null, discount_due_date: null };
  const northwind = () => payable({ amount: "300", ...plain });
  const contoso = () =>
    payable({
      id: OTHER_INVOICE_ID, amount: "250", memo: "Hosting", po_reference: "PO-2001", counterparty_id: CONTOSO, ...plain,
      counterparties: counterparty({ id: CONTOSO, name: "Contoso", address: "0xcontoso" }),
    });
  const payNow = () => model(() => ({ action: "pay", reasoning: "Matched and within the limit; paying now.", confidence: 0.9 }));

  it("pays what fits, then holds the payment that would take the agent past the day's limit", async () => {
    today("2026-10-02T09:00:00.000Z");
    payNow();
    const { fake, chain, stage } = apFake({ book: [northwind(), contoso()], budget: { daily_usdc: "500.000000", weekly_usdc: null } });

    await stage();

    expect(chain.transfers.map((t) => t.amount)).toEqual([300]);
    const [paid, held] = invoicePatches(fake.requests);
    expect(paid.body).toMatchObject({ status: "paid" });
    expect(held.params.get("id")).toBe(`eq.${OTHER_INVOICE_ID}`);
    expect(held.body).toMatchObject({ status: "held" });
    expect((held.body as Record<string, string>).agent_reasoning).toContain(
      "paying 250 USDC would take the agent past its 500 USDC daily spending limit: 300 USDC already paid today, 200 USDC left — held for a person to approve"
    );
    const [, entry] = ledger(fake.requests);
    expect(entry.p_detail).toMatchObject({
      guardrailBlocked: true,
      guardrailRule: "workspace.outflow_budget",
      outflowBudget: { dailyUsdc: 500, weeklyUsdc: null, spentToday: 300, remaining: 200, binding: "day" },
      execution: { resultingStatus: "held", heldBecause: "outflow_budget" },
    });
  });

  it("counts what the agent already paid this week, read once from its signed decisions", async () => {
    today("2026-10-02T09:00:00.000Z");
    payNow();
    const earlier = { actor: "agent", action: "ap_pay", ts: "2026-09-30T10:00:00Z", detail: { currency: "USDC", amountPaid: 900, execution: { resultingStatus: "paid" } } };
    const { fake, chain, stage } = apFake({ book: [northwind(), contoso()], budget: { daily_usdc: null, weekly_usdc: "1200" }, agentPayments: [earlier] });

    await stage();

    expect(chain.transfers.map((t) => t.amount)).toEqual([300]);
    expect((invoicePatches(fake.requests)[1].body as Record<string, string>).agent_reasoning).toContain(
      "past its 1200 USDC 7-day spending limit: 1200 USDC already paid in the last 7 days, 0 USDC left"
    );
    expect(fake.requests.filter((r) => r.path === "/rest/v1/ledger_entries" && r.params.has("actor"))).toHaveLength(1);
  });

  it("schedules past the limit, since a scheduled payable is decided again on its day", async () => {
    today("2026-10-02T09:00:00.000Z");
    model(() => ({ action: "schedule", payOn: "2026-10-20", reasoning: "Pay on the due date.", confidence: 0.9 }));
    const { fake, chain, stage } = apFake({ book: [northwind()], budget: { daily_usdc: "10", weekly_usdc: null } });

    await stage();

    expect(chain.transfers).toEqual([]);
    expect(invoicePatches(fake.requests)[0].body).toMatchObject({ status: "scheduled" });
    expect(fake.requests.some((r) => r.path === "/rest/v1/agent_budgets")).toBe(false);
  });

  it("pays as before with no limit set", async () => {
    today("2026-10-02T09:00:00.000Z");
    payNow();
    const { fake, chain, stage } = apFake({ book: [northwind(), contoso()] });

    await stage();

    expect(chain.transfers.map((t) => t.amount)).toEqual([300, 250]);
    expect(ledger(fake.requests).every((e) => !("outflowBudget" in (e.p_detail as Record<string, unknown>)))).toBe(true);
  });
});

describe("the AP stage and the spending limit enforced on Arc (onchain spending limit spec)", () => {
  const plain = { early_pay_discount_pct: null, discount_due_date: null };
  const northwind = () => payable({ amount: "300", ...plain });
  const payNow = () => model(() => ({ action: "pay", reasoning: "Matched and within the limit; paying now.", confidence: 0.9 }));
  const LIMIT = { contract: "0x11a1700000000000000000000000000000001111", agentWalletId: "wallet-agent", agentAddress: "0xA9e7000000000000000000000000000000000A9e" };
  const enforced = (verdict: SpendingLimitVerdict) => onChainLimitGate({ read: async () => LIMIT, verdict: async () => verdict });

  it("pays through the contract from the agent's wallet when the contract allows it, and records the check", async () => {
    today("2026-10-03T09:00:00.000Z");
    payNow();
    const { fake, chain, stage } = apFake({ book: [northwind()], onChainLimit: enforced({ state: "allowed" }) });

    await stage();

    expect(chain.transfers).toHaveLength(1);
    expect(chain.transfers[0].spendingLimit).toMatchObject({ contract: LIMIT.contract, agentWalletId: "wallet-agent" });
    expect(chain.transfers[0].spendingLimit?.ref).toMatch(/^0x[0-9a-f]{64}$/);
    expect(invoicePatches(fake.requests)[0].body).toMatchObject({ status: "paid" });
    const [entry] = ledger(fake.requests);
    expect(entry.p_detail).toMatchObject({
      guardrailBlocked: false,
      onChainLimit: { contract: LIMIT.contract, agent: LIMIT.agentAddress, covered: true, verdict: { state: "allowed" } },
    });
  });

  it("holds a payment the contract would refuse, sends nothing, and records the contract's figures", async () => {
    today("2026-10-03T09:00:00.000Z");
    payNow();
    const refused = { state: "refused" as const, error: "OverDailyLimit", spent: 4.9, amount: 300, limit: 5 };
    const { fake, chain, stage } = apFake({ book: [northwind()], onChainLimit: enforced(refused) });

    await stage();

    expect(chain.transfers).toEqual([]);
    const [held] = invoicePatches(fake.requests);
    expect(held.body).toMatchObject({ status: "held" });
    expect((held.body as Record<string, string>).agent_reasoning).toContain(
      "the spending limit contract on Arc would refuse this payment: 4.9 USDC already paid today against its 5 USDC daily limit — nothing was sent"
    );
    const [entry] = ledger(fake.requests);
    expect(entry.p_detail).toMatchObject({ guardrailBlocked: true, guardrailRule: "workspace.onchain_limit", onChainLimit: { verdict: refused } });
  });

  it("holds for a person a payment the contract cannot carry, and sends nothing", async () => {
    today("2026-10-03T09:00:00.000Z");
    payNow();
    const gate: OnChainLimitGate = {
      check: async () => ({ contract: LIMIT.contract, agent: LIMIT.agentAddress, ref: `0x${"1".repeat(64)}`, covered: false, uncoveredBecause: "another_chain", verdict: null, payment: null }),
    };
    const { fake, chain, stage } = apFake({ book: [northwind()], onChainLimit: gate });

    await stage();

    expect(chain.transfers).toEqual([]);
    expect(invoicePatches(fake.requests)[0].body).toMatchObject({ status: "held" });
    expect(ledger(fake.requests)[0].p_detail).toMatchObject({ guardrailRule: "workspace.onchain_limit_route" });
  });

  it("lets the code's own limit speak first, and records the contract's verdict beside it", async () => {
    today("2026-10-03T09:00:00.000Z");
    payNow();
    const refused = { state: "refused" as const, error: "OverDailyLimit", spent: 0, amount: 300, limit: 10 };
    const { fake, chain, stage } = apFake({ book: [northwind()], budget: { daily_usdc: "10", weekly_usdc: null }, onChainLimit: enforced(refused) });

    await stage();

    expect(chain.transfers).toEqual([]);
    expect(ledger(fake.requests)[0].p_detail).toMatchObject({
      guardrailRule: "workspace.outflow_budget",
      outflowBudget: { dailyUsdc: 10, remaining: 10 },
      onChainLimit: { covered: true, verdict: refused },
    });
  });

  it("does not ask the contract about a schedule: it is decided again on its day", async () => {
    today("2026-10-03T09:00:00.000Z");
    model(() => ({ action: "schedule", payOn: "2026-10-20", reasoning: "Pay on the due date.", confidence: 0.9 }));
    const verdict = vi.fn(async () => ({ state: "allowed" as const }));
    const { fake, chain, stage } = apFake({ book: [northwind()], onChainLimit: onChainLimitGate({ read: async () => LIMIT, verdict }) });

    await stage();

    expect(chain.transfers).toEqual([]);
    expect(verdict).not.toHaveBeenCalled();
    expect(ledger(fake.requests)[0].p_detail).not.toHaveProperty("onChainLimit");
  });
});
