import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DecideParams } from "@/lib/agent/decide";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import type { EmailMessage, SendResult } from "@/lib/email/send";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * The agent makes early-payment offers (docs/superpowers/specs/2026-10-16-agent-early-payment-offers-design.md): only
 * where a person turned it on and code allows it (AO1, AO2), decided by the model between the suggested discount and the
 * ceiling (AO3), claimed before it is made, emailed once with its link, withdrawn when the email never went (AO4), and
 * signed (AO5).
 */

const { ledgerMock, decideMock } = vi.hoisted(() => ({ ledgerMock: vi.fn(), decideMock: vi.fn() }));
vi.mock("@/lib/ledger", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ledger")>()), appendLedgerEntry: ledgerMock }));
vi.mock("@/lib/agent/decide", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/agent/decide")>()), decide: decideMock }));

import { makeEarlyPaymentOffers } from "@/lib/agent/early-offers";
import { agentOfferAllowed, boundOfferPct, cashForOffers, type AgentOfferFacts } from "@/lib/early-pay/agent-rules";
import { earlyPaymentOfferEmail } from "@/lib/email/early-payment-offer";

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000e0e";
const INVOICE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001e1";
const SUPPLIER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000002e2";
const OWNER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000003e3";
const NOW = Date.parse("2026-10-16T09:00:00Z");
const DAY = 86_400_000;

const payable = (over: Record<string, unknown> = {}) => ({
  id: INVOICE,
  counterparty_id: SUPPLIER,
  amount: "100",
  currency: "USDC",
  due_date: "2026-11-05T12:00:00+00:00",
  memo: "LP-117 print run",
  status: "scheduled",
  direction: "payable",
  early_pay_discount_pct: null,
  counterparties: { name: "Lumen Print Co.", notice_email: "ap@lumen.example" },
  ...over,
});

interface World {
  mode?: string;
  on?: boolean;
  maxPct?: string;
  paused?: boolean;
  payables?: Array<Record<string, unknown>>;
  offers?: Array<Record<string, unknown>>;
  reviews?: Array<Record<string, unknown>>;
  claim?: FakeReply;
  answer?: string;
  onBy?: string | null;
}

function world(w: World = {}) {
  return fakeSupabase((request: RecordedRequest): FakeReply => {
    if (request.path === "/rest/v1/orgs") {
      return { body: { name: "Pinecrest Studio", mode: w.mode ?? "live", early_offers_on_at: w.on === false ? null : "2026-10-16T08:00:00Z", early_offers_on_by: w.onBy === undefined ? OWNER : w.onBy, early_offers_max_pct: w.maxPct ?? "2.00" } };
    }
    if (request.path === "/rest/v1/rpc/org_members") {
      return { body: [{ user_id: OWNER, email: "owner@pinecrest.example", role: "owner", joined_at: "2026-09-01T00:00:00Z" }] };
    }
    if (request.path === "/rest/v1/rpc/agent_paused") return { body: w.paused === true };
    if (request.path === "/rest/v1/rpc/early_payment_offer_reviews_ready") return { body: true };
    if (request.path === "/rest/v1/early_payment_offer_reviews" && request.method === "GET") return { body: w.reviews ?? [] };
    if (request.path === "/rest/v1/early_payment_offer_reviews" && request.method === "POST") return w.claim ?? { body: { id: "review-1" } };
    if (request.path === "/rest/v1/invoices") return { body: w.payables ?? [payable()] };
    if (request.path === "/rest/v1/early_payment_offers") return { body: w.offers ?? [] };
    if (request.path === "/rest/v1/payment_intents") return { body: [] };
    if (request.path === "/rest/v1/rpc/create_early_payment_offer") {
      const pct = (request.body as { p_pct: number }).p_pct;
      return { body: { id: "offer-1", invoice_id: INVOICE, counterparty_id: SUPPLIER, amount: "100.000000", offered_amount: (100 - pct).toFixed(6), currency: "USDC", expires_at: "2026-10-23T09:00:00Z" } };
    }
    if (request.path === "/rest/v1/rpc/withdraw_early_payment_offer") return { body: true };
    if (request.path === "/rest/v1/counterparties") return { body: [{ id: SUPPLIER, name: "Lumen Print Co.", notice_email: "ap@lumen.example" }] };
    if (request.path === "/rest/v1/rpc/answer_early_payment_counter") {
      const accept = (request.body as { p_accept: boolean }).p_accept;
      const outcome = w.answer ?? (accept ? "accepted" : "declined");
      return { body: [{ outcome, invoice_id: INVOICE, counter_pct: "0.25", offered_amount: outcome === "accepted" ? "99.750000" : null, currency: "USDC" }] };
    }
    return { body: [] };
  });
}

function model(answer?: Record<string, unknown>) {
  decideMock.mockImplementation(async (params: DecideParams<unknown>) => {
    const reference = params.fallback() as { action: string };
    const value = answer ? params.schema.parse({ ...reference, ...answer }) : reference;
    return { value, mode: "deepseek", reference, agreedWithReference: (value as { action: string }).action === reference.action };
  });
}

const sendMock = vi.fn<(message: EmailMessage) => Promise<SendResult>>(async () => ({ sent: true, id: "email-1" }));
const run = (client: ReturnType<typeof fakeSupabase>, cash = 500) =>
  runWith(orgTestContext({ config, client: client.client, orgId: ORG }), () =>
    makeEarlyPaymentOffers(db(), { operatingBalance: cash, reserveApy: 0.042 }, { now: NOW, send: sendMock, origin: "https://www.vestiarion.xyz" })
  );

beforeEach(() => {
  ledgerMock.mockReset().mockResolvedValue(undefined);
  decideMock.mockReset();
  sendMock.mockReset().mockResolvedValue({ sent: true, id: "email-1" });
  model();
});

describe("what code allows (AO2)", () => {
  const facts = (over: Partial<AgentOfferFacts> = {}): AgentOfferFacts => ({
    status: "scheduled",
    currency: "USDC",
    daysEarly: 20,
    offeredBefore: false,
    reviewed: false,
    noticeEmail: "ap@lumen.example",
    supplierHasOpenOffer: false,
    supplierDeclinedAt: null,
    floorPct: 0.5,
    ceilingPct: 2,
    offeredAtFloor: 99.5,
    cashForOffers: 500,
    now: NOW,
    ...over,
  });

  it("allows a scheduled USDC bill a week or more out, never offered, its supplier reachable, with the cash to pay it today", () => {
    expect(agentOfferAllowed(facts())).toEqual({ allowed: true });
  });

  it("refuses each thing that would make the offer wrong, and says which", () => {
    expect(agentOfferAllowed(facts({ status: "pending" }))).toEqual({ allowed: false, because: "not_scheduled" });
    expect(agentOfferAllowed(facts({ currency: "EURC" }))).toEqual({ allowed: false, because: "not_usdc" });
    expect(agentOfferAllowed(facts({ daysEarly: 6 }))).toEqual({ allowed: false, because: "too_soon" });
    expect(agentOfferAllowed(facts({ offeredBefore: true }))).toEqual({ allowed: false, because: "offered_before" });
    expect(agentOfferAllowed(facts({ reviewed: true }))).toEqual({ allowed: false, because: "reviewed" });
    expect(agentOfferAllowed(facts({ noticeEmail: null }))).toEqual({ allowed: false, because: "no_email" });
    expect(agentOfferAllowed(facts({ supplierHasOpenOffer: true }))).toEqual({ allowed: false, because: "supplier_has_offer" });
    expect(agentOfferAllowed(facts({ supplierDeclinedAt: new Date(NOW - 10 * DAY).toISOString() }))).toEqual({ allowed: false, because: "supplier_declined" });
    expect(agentOfferAllowed(facts({ supplierDeclinedAt: new Date(NOW - 31 * DAY).toISOString() }))).toEqual({ allowed: true });
    expect(agentOfferAllowed(facts({ floorPct: 2.5 }))).toEqual({ allowed: false, because: "above_ceiling" });
    expect(agentOfferAllowed(facts({ cashForOffers: 99 }))).toEqual({ allowed: false, because: "cash" });
  });

  it("keeps the model's discount between the floor and the ceiling, to the nearest 0.25%, and leaves cash for what falls due", () => {
    expect(boundOfferPct(1.3, 0.5, 2)).toEqual({ pct: 1.25, limited: false });
    expect(boundOfferPct(4, 0.5, 2)).toEqual({ pct: 2, limited: true });
    expect(boundOfferPct(0.2, 0.5, 2)).toEqual({ pct: 0.5, limited: true });
    expect(boundOfferPct(undefined, 0.75, 2)).toEqual({ pct: 0.75, limited: false });
    expect(cashForOffers({ operating: 500, dueSoon: 120, openOffers: 80 })).toBe(300);
    expect(cashForOffers({ operating: 50, dueSoon: 120, openOffers: 0 })).toBe(0);
  });
});

describe("an offer the agent makes", () => {
  it("is decided between the floor and the ceiling, claimed, made, emailed with its link once, and signed (AO3-AO5)", async () => {
    model({ action: "offer", pct: 1.3, reasoning: "Lumen accepted 1.25% before; 20 days early is worth asking that again." });
    const client = world({ offers: [{ id: "old", invoice_id: "other-bill", counterparty_id: SUPPLIER, status: "accepted", discount_pct: "1.25", offered_amount: "49", decided_at: "2026-09-20T10:00:00Z", expires_at: "2026-09-27T10:00:00Z" }] });
    const lines = await run(client);

    const asked = JSON.parse((decideMock.mock.calls[0][0] as DecideParams<unknown>).userPrompt) as Record<string, unknown>;
    expect(asked).toMatchObject({
      bill: { amount: 100, daysEarly: 20, reference: "LP-117 print run" },
      supplier: { name: "Lumen Print Co.", offersBefore: { made: 1, accepted: 1, declined: 0, acceptedDiscountsPct: [1.25] } },
      discount: { floorPct: 0.5, ceilingPct: 2 },
      cash: { operatingAfterTodaysPayments: 500, leftForOffers: 500 },
      writtenPolicy: { action: "offer", pct: 0.5 },
    });

    const claim = client.requests.find((r) => r.path === "/rest/v1/early_payment_offer_reviews" && r.method === "POST")!;
    expect(claim.body).toMatchObject({ org_id: ORG, invoice_id: INVOICE, action: "offer", discount_pct: 1.25 });
    const made = client.requests.find((r) => r.path === "/rest/v1/rpc/create_early_payment_offer")!;
    expect(made.body).toMatchObject({ p_org_id: ORG, p_invoice_id: INVOICE, p_pct: 1.25, p_by: null });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const email = sendMock.mock.calls[0][0];
    expect(email.to).toBe("ap@lumen.example");
    expect(email.subject).toBe("Pinecrest Studio offers to pay invoice LP-117 print run today");
    expect(email.text).toContain("Pinecrest Studio offers to pay invoice LP-117 print run today: 98.75 USDC instead of 100.00 USDC on Nov 5, 2026.");
    expect(email.text).toMatch(/https:\/\/www\.vestiarion\.xyz\/offer\/vxo_[A-Za-z0-9_-]{43}/);
    expect(email.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);

    const updates = client.requests.filter((r) => r.path === "/rest/v1/early_payment_offer_reviews" && r.method === "PATCH").map((r) => r.body);
    expect(updates).toEqual([{ offer_id: "offer-1" }, { emailed_at: expect.any(String) }]);

    expect(ledgerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: "agent",
        domain: "ap",
        action: "early_payment_offered",
        detail: expect.objectContaining({ via: "agent", offerId: "offer-1", invoiceId: INVOICE, to: "ap***@lumen.example", discountPct: 1.25, offeredAmount: 98.75, decisionMode: "deepseek", agreedWithReference: true }),
      })
    );
    expect(JSON.stringify(ledgerMock.mock.calls)).not.toContain("vxo_");
    expect(lines).toEqual([{ domain: "ap", message: "Offered Lumen Print Co. early payment by email: 1.25% off, 98.750000 USDC today" }]);
  });

  it("asks no more than the ceiling, and the entry says what the model chose", async () => {
    model({ action: "offer", pct: 6, reasoning: "Ask high." });
    await run(world());
    const detail = ledgerMock.mock.calls[0][0].detail;
    expect(detail).toMatchObject({ discountPct: 2, pctLimited: { chosen: 6, sent: 2 } });
    expect(detail.decision.reasoning).toContain("code allows 0.5% to 2%, so the offer asks 2%");
  });

  it("is never made where it is off, while paused, in a sandbox whose member left, or without cash or a reachable supplier (AO1, AO2)", async () => {
    for (const w of [{ on: false }, { paused: true }, { mode: "sandbox", onBy: "someone-gone" }] as World[]) {
      const client = world(w);
      await run(client);
      expect(client.requests.some((r) => r.path === "/rest/v1/rpc/create_early_payment_offer"), JSON.stringify(w)).toBe(false);
    }
    await run(world(), 50);
    await run(world({ payables: [payable({ counterparties: { name: "Lumen Print Co.", notice_email: null } })] }));
    await run(world({ offers: [{ id: "d", invoice_id: "other", counterparty_id: SUPPLIER, status: "declined", discount_pct: "1", offered_amount: "9", decided_at: "2026-10-10T10:00:00Z", expires_at: "2026-10-17T10:00:00Z" }] }));
    await run(world({ payables: [payable({ due_date: "2026-10-21T12:00:00+00:00" })] }));
    expect(decideMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("is not made when the model skips it: the skip is signed and the bill weighed again in a week (AO3)", async () => {
    model({ action: "skip", reasoning: "A 100 USDC bill 20 days out is not worth troubling a new supplier over." });
    const client = world();
    const lines = await run(client);
    const claim = client.requests.find((r) => r.path === "/rest/v1/early_payment_offer_reviews" && r.method === "POST")!;
    expect(claim.body).toMatchObject({ invoice_id: INVOICE, action: "skip" });
    expect(client.requests.some((r) => r.path === "/rest/v1/rpc/create_early_payment_offer")).toBe(false);
    expect(ledgerMock.mock.calls[0][0]).toMatchObject({ action: "early_payment_offer_skipped", detail: { decision: { action: "skip" }, decisionMode: "deepseek", agreedWithReference: false } });
    expect(lines).toEqual([{ domain: "ap", message: "Lumen Print Co.: no early-payment offer, weighed again in 7 days" }]);
  });

  it("is withdrawn when its email never went, and its bill weighed again (AO4)", async () => {
    sendMock.mockResolvedValue({ sent: false, reason: "resend 500" });
    const client = world();
    const lines = await run(client);
    expect(client.requests.find((r) => r.path === "/rest/v1/rpc/withdraw_early_payment_offer")?.body).toMatchObject({ p_org_id: ORG, p_offer_id: "offer-1", p_by: null });
    expect(client.requests.some((r) => r.path === "/rest/v1/early_payment_offer_reviews" && r.method === "DELETE")).toBe(true);
    expect(ledgerMock).not.toHaveBeenCalled();
    expect(lines[0].message).toContain("not sent (resend 500); tried again at the next cycle");
  });

  it("is withdrawn when a stopped run left it unsent, and a review already claimed is never made twice (AO4)", async () => {
    const stale = { id: "review-0", invoice_id: "stale-bill", action: "offer", offer_id: "offer-0", decided_at: new Date(NOW - 20 * 60_000).toISOString(), emailed_at: null };
    const client = world({ reviews: [stale], claim: { status: 409, body: { code: "23505", message: "duplicate key value violates unique constraint" } } });
    await run(client);
    expect(client.requests.find((r) => r.path === "/rest/v1/rpc/withdraw_early_payment_offer")?.body).toMatchObject({ p_offer_id: "offer-0" });
    expect(ledgerMock.mock.calls[0][0]).toMatchObject({ action: "early_payment_offer_withdrawn", detail: { offerId: "offer-0", via: "agent", reason: "not_emailed" } });
    // The claim on this cycle's bill lost to another run: nothing made, nothing sent.
    expect(client.requests.some((r) => r.path === "/rest/v1/rpc/create_early_payment_offer")).toBe(false);
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("the supplier's email (AO4)", () => {
  it("says who offers what, until when, and that doing nothing keeps the due date; nothing a model wrote", () => {
    const email = earlyPaymentOfferEmail({
      orgName: "Pinecrest Studio",
      supplierName: "Lumen Print Co.",
      reference: "LP-117",
      amount: "100.00",
      offered: "99.00",
      token: "USDC",
      pct: 1,
      dueOn: "Nov 5, 2026",
      until: "Oct 23, 2026",
      url: "https://www.vestiarion.xyz/offer/vxo_x",
      origin: "https://www.vestiarion.xyz",
    });
    expect(email.subject).toBe("Pinecrest Studio offers to pay invoice LP-117 today");
    expect(email.text).toContain("That is 1.00% less, paid today instead of waiting for the due date. It goes where Pinecrest Studio already pays you. The offer stands until Oct 23, 2026, and the link works once.");
    expect(email.text).toContain("If you would rather wait, decline it or do nothing: your invoice is paid as planned, on its due date.");
    expect(email.html).toContain("https://www.vestiarion.xyz/offer/vxo_x");
  });
});

describe("a counter the agent answers (offer counters N3-N6)", () => {
  const countered = (over: Record<string, unknown> = {}) => ({ id: "offer-c", invoice_id: INVOICE, counter_pct: "0.25", counterparty_id: SUPPLIER, status: "countered", discount_pct: "0.50", offered_amount: "99.5", decided_at: "2026-10-16T08:59:00Z", expires_at: "2026-10-23T09:00:00Z", ...over });
  const agentReview = { id: "review-c", invoice_id: INVOICE, action: "offer", offer_id: "offer-c", decided_at: "2026-10-16T08:00:00Z", emailed_at: "2026-10-16T08:00:05Z" };

  it("is accepted where code allows it and the model agrees, answered in one step, emailed and signed, and makes no new offer on its bill", async () => {
    model({ action: "accept", reasoning: "0.25% still beats the reserve, and Lumen takes early payment." });
    const client = world({ offers: [countered()], reviews: [agentReview] });
    const lines = await run(client);

    const asked = JSON.parse((decideMock.mock.calls[0][0] as DecideParams<unknown>).userPrompt) as Record<string, unknown>;
    expect(asked).toMatchObject({ offer: { discountPct: 0.5, supplierProposedPct: 0.25, supplierWouldReceiveToday: 99.75 }, writtenPolicy: { action: "accept" } });
    expect(client.requests.find((r) => r.path === "/rest/v1/rpc/answer_early_payment_counter")?.body).toMatchObject({ p_org_id: ORG, p_offer_id: "offer-c", p_accept: true });
    expect(ledgerMock.mock.calls[0][0]).toMatchObject({ actor: "agent", action: "early_payment_counter_accepted", detail: { offerId: "offer-c", counterPct: 0.25, offeredAmount: 99.75, decisionMode: "deepseek", agreedWithReference: true } });
    const email = sendMock.mock.calls[0][0];
    expect(email.to).toBe("ap@lumen.example");
    expect(email.subject).toBe("Pinecrest Studio accepted your 0.25% for invoice LP-117 print run");
    expect(email.text).toContain("Pinecrest Studio accepted your 0.25%: it pays you 99.75 USDC today, instead of 100.00 USDC on Nov 5, 2026, once its usual checks pass.");
    expect(email.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    // Its bill had an offer: none is made again.
    expect(client.requests.some((r) => r.path === "/rest/v1/rpc/create_early_payment_offer")).toBe(false);
    expect(lines).toEqual([{ domain: "ap", message: "Accepted Lumen Print Co.'s counter: 0.25% off, paid today" }]);
  });

  it("is declined by code, with no model, when it is no more than the reserve would earn, the cash is short, or the offers are off", async () => {
    for (const [w, cash, why] of [
      [{ offers: [countered({ counter_pct: "0.20" })], reviews: [agentReview] }, 500, "no more than the 0.23% the cash would earn"],
      [{ offers: [countered()], reviews: [agentReview] }, 50, "cannot pay it today"],
      [{ offers: [countered()], reviews: [agentReview], on: false }, 500, "no longer makes early-payment offers"],
    ] as Array<[World, number, string]>) {
      ledgerMock.mockClear();
      sendMock.mockClear();
      const client = world(w);
      await run(client, cash);
      expect(client.requests.find((r) => r.path === "/rest/v1/rpc/answer_early_payment_counter")?.body, why).toMatchObject({ p_accept: false });
      expect(ledgerMock.mock.calls[0][0]).toMatchObject({ action: "early_payment_counter_declined", detail: { decisionMode: "code" } });
      expect(ledgerMock.mock.calls[0][0].detail.decision.reasoning).toContain(why);
      expect(sendMock.mock.calls[0][0].text).toContain("Pinecrest Studio keeps the original terms: your invoice is paid as planned, 100.00 USDC on Nov 5, 2026.");
    }
    expect(decideMock).not.toHaveBeenCalled();
  });

  it("is left alone when another run answered it, and a person's offer countered is not the agent's to answer", async () => {
    const client = world({ offers: [countered()], reviews: [agentReview], answer: "not_countered" });
    expect(await run(client)).toEqual([]);
    expect(ledgerMock).not.toHaveBeenCalled();
    const person = world({ offers: [countered()], reviews: [] });
    await run(person);
    expect(person.requests.some((r) => r.path === "/rest/v1/rpc/answer_early_payment_counter")).toBe(false);
  });
});

describe("the offers out stay covered (offer results R2)", () => {
  const open = (id: string, offered: string, invoice: string) => ({ id, invoice_id: invoice, counterparty_id: SUPPLIER, status: "open", discount_pct: "0.50", offered_amount: offered, counter_pct: null, decided_at: null, expires_at: "2026-10-23T09:00:00Z" });
  const review = (offer: string, invoice: string) => ({ id: "review-" + offer, invoice_id: invoice, action: "offer", offer_id: offer, decided_at: "2026-10-16T08:00:00Z", emailed_at: "2026-10-16T08:00:05Z" });

  it("withdraws the agent's largest offers until the cash covers what is left, and signs each", async () => {
    const client = world({ offers: [open("offer-big", "300", "bill-a"), open("offer-small", "100", "bill-b")], reviews: [review("offer-big", "bill-a"), review("offer-small", "bill-b")] });
    const lines = await run(client, 250);

    const withdrawn = client.requests.filter((r) => r.path === "/rest/v1/rpc/withdraw_early_payment_offer").map((r) => (r.body as { p_offer_id: string }).p_offer_id);
    expect(withdrawn).toEqual(["offer-big"]);
    expect(ledgerMock.mock.calls[0][0]).toMatchObject({ actor: "agent", action: "early_payment_offer_withdrawn", detail: { offerId: "offer-big", via: "agent", reason: "cash", offeredAmount: 300, covering: 250 } });
    expect(lines[0]).toEqual({ domain: "ap", message: "Withdrew the early-payment offer to the supplier: the cash no longer covers it" });
  });

  it("never withdraws a person's offer, and withdraws nothing while the cash covers them all", async () => {
    const personal = world({ offers: [open("offer-person", "300", "bill-a")], reviews: [] });
    await run(personal, 100);
    expect(personal.requests.some((r) => r.path === "/rest/v1/rpc/withdraw_early_payment_offer")).toBe(false);
    const covered = world({ offers: [open("offer-big", "300", "bill-a")], reviews: [review("offer-big", "bill-a")] });
    await run(covered, 500);
    expect(covered.requests.some((r) => r.path === "/rest/v1/rpc/withdraw_early_payment_offer")).toBe(false);
  });
});

describe("an offer in a sandbox (sandbox offers S1)", () => {
  it("goes to the member who turned the offers on, says it is a sandbox, and is signed as one", async () => {
    const client = world({ mode: "sandbox", payables: [payable({ counterparties: { name: "Kestrel Print Co", notice_email: null } })] });
    await run(client);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const email = sendMock.mock.calls[0][0];
    expect(email.to).toBe("owner@pinecrest.example");
    expect(email.subject).toBe("[Sandbox] Pinecrest Studio offers to pay invoice LP-117 print run today");
    expect(email.text).toContain("This is a sandbox. You get this in place of Kestrel Print Co, a sample supplier, so you can answer as the supplier would. Its payments are simulated.");
    expect(ledgerMock.mock.calls[0][0]).toMatchObject({ action: "early_payment_offered", detail: { via: "agent", sandbox: true, to: "ow***@pinecrest.example" } });
  });
});
