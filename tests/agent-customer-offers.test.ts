import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DecideParams } from "@/lib/agent/decide";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import type { EmailMessage, SendResult } from "@/lib/email/send";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * The agent offers customers a discount to pay early (docs/superpowers/specs/2026-10-17-customer-early-pay-discounts-design.md):
 * only where a person turned it on, in a live workspace, while bills are held for want of cash (C1, C2), decided by the
 * model between 0.25% and the ceiling (C3), claimed before it is made, emailed once with its link, withdrawn when the
 * email never went (C7), and signed.
 */

const { ledgerMock, decideMock } = vi.hoisted(() => ({ ledgerMock: vi.fn(), decideMock: vi.fn() }));
vi.mock("@/lib/ledger", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ledger")>()), appendLedgerEntry: ledgerMock }));
vi.mock("@/lib/agent/decide", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/agent/decide")>()), decide: decideMock }));

import { makeCustomerOffers } from "@/lib/agent/customer-offers";
import { customerDiscountEmail } from "@/lib/email/customer-discount";

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c0c";
const BILL = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001c1";
const RECEIVABLE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000002c2";
const CUSTOMER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000003c3";
const NOW = Date.parse("2026-10-17T09:00:00Z");

const receivable = (over: Record<string, unknown> = {}) => ({
  id: RECEIVABLE,
  counterparty_id: CUSTOMER,
  amount: "300",
  currency: "USDC",
  due_date: "2026-11-16T12:00:00+00:00",
  memo: "INV-2041 brand refresh",
  early_pay_discount_pct: null,
  counterparties: { name: "Northwind Goods", notice_email: "ap@northwind.example" },
  ...over,
});

const HELD_FOR_CASH = { invoiceId: BILL, execution: { heldBecause: "cash_shortfall" } };

interface World {
  mode?: string;
  on?: boolean;
  maxPct?: string;
  paused?: boolean;
  held?: Array<Record<string, unknown>>;
  decisions?: Array<Record<string, unknown>>;
  receivables?: Array<Record<string, unknown>>;
  offers?: Array<Record<string, unknown>>;
  reviews?: Array<Record<string, unknown>>;
  links?: Array<Record<string, unknown>>;
  claim?: FakeReply;
  /** The receivables of accepted offers still open. */
  stillOpen?: Array<Record<string, unknown>>;
  /** The agent's signed customer_discount_offered entries, by offer. */
  signed?: string[];
}

const created: Array<{ p_pct: number; p_pay_by: string }> = [];

function world(w: World = {}) {
  return fakeSupabase((request: RecordedRequest): FakeReply => {
    if (request.path === "/rest/v1/orgs") {
      return { body: { name: "Pinecrest Studio", mode: w.mode ?? "live", customer_offers_on_at: w.on === false ? null : "2026-10-17T08:00:00Z", customer_offers_max_pct: w.maxPct ?? "2.00" } };
    }
    if (request.path === "/rest/v1/rpc/agent_paused") return { body: w.paused === true };
    if (request.path === "/rest/v1/rpc/customer_discounts_ready") return { body: true };
    if (request.path === "/rest/v1/customer_discount_reviews" && request.method === "GET") return { body: w.reviews ?? [] };
    if (request.path === "/rest/v1/customer_discount_reviews" && request.method === "POST") return w.claim ?? { body: { id: "review-1" } };
    if (request.path === "/rest/v1/invoices" && request.params.get("direction") === "eq.payable") {
      return { body: w.held ?? [{ id: BILL, amount: "500", currency: "USDC" }] };
    }
    if (request.path === "/rest/v1/invoices" && request.params.get("direction") === "eq.receivable") return { body: w.receivables ?? [receivable()] };
    if (request.path === "/rest/v1/invoices") return { body: w.stillOpen ?? [] };
    if (request.path === "/rest/v1/ledger_entries" && request.params.get("action") === "eq.customer_discount_offered") {
      const offerId = request.params.get("detail->>offerId")?.replace(/^eq\./, "") ?? "";
      return { body: (w.signed ?? []).includes(offerId) ? [{ seq: 99 }] : [] };
    }
    if (request.path === "/rest/v1/ledger_entries") return { body: w.decisions ?? [{ seq: 10, detail: HELD_FOR_CASH }] };
    if (request.path === "/rest/v1/customer_discount_offers") return { body: w.offers ?? [] };
    if (request.path === "/rest/v1/receivable_links") return { body: w.links ?? [{ invoice_id: RECEIVABLE, token_enc: { v: 1 }, revoked_at: null }] };
    if (request.path === "/rest/v1/receivable_allocations" || request.path === "/rest/v1/incoming_transfers") return { body: [] };
    if (request.path === "/rest/v1/rpc/create_customer_discount_offer") {
      const body = request.body as { p_pct: number; p_pay_by: string };
      created.push(body);
      return {
        body: { id: "discount-1", invoice_id: RECEIVABLE, counterparty_id: CUSTOMER, amount: "300.000000", offered_amount: (300 * (1 - body.p_pct / 100)).toFixed(6), pay_by: body.p_pay_by, expires_at: `${body.p_pay_by}T23:59:59Z` },
      };
    }
    if (request.path === "/rest/v1/rpc/withdraw_customer_discount_offer") return { body: true };
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
const run = (client: ReturnType<typeof fakeSupabase>, cash = 100) =>
  runWith(orgTestContext({ config, client: client.client, orgId: ORG }), () =>
    makeCustomerOffers(db(), { operatingBalance: cash }, { now: NOW, send: sendMock, origin: "https://www.vestiarion.xyz" })
  );
const actions = () => ledgerMock.mock.calls.map((call) => (call[0] as { action: string }).action);

beforeEach(() => {
  created.length = 0;
  ledgerMock.mockReset().mockResolvedValue(undefined);
  decideMock.mockReset();
  sendMock.mockReset().mockResolvedValue({ sent: true, id: "email-1" });
  model();
});

describe("making an offer (C2-C4, C7)", () => {
  it("offers the customer the suggested discount while a bill is held for cash, emails the link once, and signs it", async () => {
    const lines = await run(world());
    // 30 days early: 1% suggested, under the 2% ceiling.
    expect(created).toEqual([expect.objectContaining({ p_pct: 1, p_pay_by: "2026-10-22" })]);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const message = sendMock.mock.calls[0][0];
    expect(message.to).toBe("ap@northwind.example");
    expect(message.subject).toBe("Pinecrest Studio offers 1.00% off invoice INV-2041 brand refresh for paying by Oct 22, 2026");
    expect(message.text).toContain("https://www.vestiarion.xyz/discount/vxd_");
    expect(message.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    const offered = ledgerMock.mock.calls.find((call) => (call[0] as { action: string }).action === "customer_discount_offered")?.[0] as { detail: Record<string, unknown> };
    expect(offered.detail).toMatchObject({ invoiceId: RECEIVABLE, discountPct: 1, offeredAmount: 297, payBy: "2026-10-22", shortfall: 400, to: "ap***@northwind.example" });
    expect(lines).toEqual([{ domain: "ar", message: "Offered Northwind Goods 1.00% off by email for paying by 2026-10-22: 297.000000 USDC" }]);
  });

  it("keeps the model's discount within the ceiling, and says so", async () => {
    model({ pct: 4 });
    await run(world());
    expect(created[0].p_pct).toBe(2);
    const offered = ledgerMock.mock.calls.find((call) => (call[0] as { action: string }).action === "customer_discount_offered")?.[0] as { detail: Record<string, unknown> };
    expect(offered.detail).toMatchObject({ pctLimited: { chosen: 4, sent: 2 } });
  });

  it("signs a skip and offers nothing", async () => {
    model({ action: "skip", reasoning: "The customer always pays on the day; a discount would only cost money." });
    await run(world());
    expect(created).toEqual([]);
    expect(sendMock).not.toHaveBeenCalled();
    expect(actions()).toEqual(["customer_discount_skipped"]);
  });

  it("withdraws an offer whose email did not go, and leaves the receivable for the next cycle", async () => {
    sendMock.mockResolvedValue({ sent: false, reason: "resend_error" });
    const client = world();
    const lines = await run(client);
    expect(client.requests.some((request) => request.path === "/rest/v1/rpc/withdraw_customer_discount_offer")).toBe(true);
    expect(actions()).toEqual([]);
    expect(lines[0].message).toMatch(/not sent/);
  });
});

describe("an offer left unsent by a stopped run (C7)", () => {
  const stale = { id: "review-0", invoice_id: RECEIVABLE, action: "offer", decided_at: "2026-10-17T08:00:00Z", emailed_at: null };
  const open = { id: "open-1", invoice_id: RECEIVABLE, counterparty_id: CUSTOMER, status: "open", discount_pct: "1", offered_amount: "297", pay_by: "2026-10-22", decided_at: null, expires_at: "2026-10-22T23:59:59Z" };

  it("withdraws the receivable's open offer even when the review never named it", async () => {
    const client = world({ reviews: [{ ...stale, offer_id: null }], offers: [open] });
    await run(client);
    const withdraw = client.requests.find((request) => request.path === "/rest/v1/rpc/withdraw_customer_discount_offer");
    expect(withdraw?.body).toMatchObject({ p_offer_id: "open-1" });
    expect(actions()).toContain("customer_discount_withdrawn");
  });

  it("keeps an offer signed as emailed, marking its review instead of withdrawing it", async () => {
    const client = world({ reviews: [{ ...stale, offer_id: "open-1" }], offers: [open], signed: ["open-1"] });
    await run(client);
    expect(client.requests.some((request) => request.path === "/rest/v1/rpc/withdraw_customer_discount_offer")).toBe(false);
    const marked = client.requests.find((request) => request.path === "/rest/v1/customer_discount_reviews" && request.method === "PATCH");
    expect(marked?.body).toMatchObject({ offer_id: "open-1", emailed_at: expect.any(String) });
    expect(actions()).not.toContain("customer_discount_withdrawn");
  });
});

describe("when it asks nothing (C1, C2)", () => {
  it("offers nothing while no bill is held for want of cash", async () => {
    await run(world({ decisions: [{ seq: 10, detail: { invoiceId: BILL, execution: {} } }] }));
    expect(decideMock).not.toHaveBeenCalled();
    expect(created).toEqual([]);
  });

  it("offers nothing when the operating USDC already covers the bills held", async () => {
    await run(world(), 600);
    expect(created).toEqual([]);
  });

  it("offers nothing when turned off, paused, or in a sandbox", async () => {
    await run(world({ on: false }));
    await run(world({ paused: true }));
    await run(world({ mode: "sandbox" }));
    expect(decideMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("offers nothing on a receivable without a kept pay link, a billing email, or one offered before", async () => {
    await run(world({ links: [] }));
    await run(world({ receivables: [receivable({ counterparties: { name: "Northwind Goods", notice_email: null } })] }));
    await run(world({ offers: [{ id: "old", invoice_id: RECEIVABLE, counterparty_id: CUSTOMER, status: "declined", discount_pct: "1", offered_amount: "297", pay_by: "2026-09-01", decided_at: "2026-09-01T00:00:00Z", expires_at: "2026-09-01T23:59:59Z" }] }));
    expect(decideMock).not.toHaveBeenCalled();
  });

  it("counts discounts accepted and still to come in against the shortfall, and not one already paid in full", async () => {
    const accepted = { id: "a", invoice_id: "other", counterparty_id: "other-customer", status: "accepted", discount_pct: "1", offered_amount: "400", pay_by: "2026-10-20", decided_at: "2026-10-16T00:00:00Z", expires_at: "2026-10-20T23:59:59Z" };
    await run(world({ offers: [accepted], stillOpen: [{ id: "other" }] }));
    expect(created).toEqual([]);
    // Paid in full instead: its money is in the operating USDC, so the shortfall stands and the agent offers.
    await run(world({ offers: [accepted], stillOpen: [] }));
    expect(created).toHaveLength(1);
  });

  it("weighs a receivable again after an offer whose email never went (C7)", async () => {
    const withdrawn = { id: "old", invoice_id: RECEIVABLE, counterparty_id: CUSTOMER, status: "withdrawn", discount_pct: "1", offered_amount: "297", pay_by: "2026-10-21", decided_at: "2026-10-16T00:00:00Z", expires_at: "2026-10-21T23:59:59Z" };
    await run(world({ offers: [withdrawn] }));
    expect(created).toHaveLength(1);
  });
});

describe("customerDiscountEmail (C7)", () => {
  it("says what the customer pays, by when, instead of what on which day, with the link, and that nothing else changes", () => {
    const email = customerDiscountEmail({
      orgName: "Pinecrest Studio",
      customerName: "Northwind Goods",
      reference: "INV-2041",
      amount: "300.00",
      discounted: "297.00",
      token: "USDC",
      pct: 1,
      dueOn: "Nov 16, 2026",
      payBy: "Oct 22, 2026",
      url: "https://www.vestiarion.xyz/discount/vxd_x",
      origin: "https://www.vestiarion.xyz",
    });
    expect(email.text).toContain("pay 297.00 USDC by Oct 22, 2026 instead of 300.00 USDC on Nov 16, 2026");
    expect(email.text).toContain("the invoice stays 300.00 USDC, due on Nov 16, 2026");
    expect(email.html).toContain("https://www.vestiarion.xyz/discount/vxd_x");
  });
});
