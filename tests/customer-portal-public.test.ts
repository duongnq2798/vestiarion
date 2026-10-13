import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { generateCustomerPortalToken } from "@/lib/customer-portal/token";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * What a customer's statement link reads and sends (docs/superpowers/specs/2026-10-13-customer-portal-design.md P3-P6).
 * No session: a malformed link is never looked up; a stopped or unknown one is dead and names no one; an expired one says
 * only when it expired. A live one reads only its own customer's receivables, inside the workspace's scope, and never
 * a member's id. What the customer sends is checked by the database, which a forwarded link passes the same way, and is
 * signed with the SHA-256 of the customer's words.
 */

const ORG = "6d0f3a2e-8c1b-4f7a-9e6d-00000000c0c0";
const CUSTOMER = "6d0f3a2e-8c1b-4f7a-9e6d-0000000000c1";
const LINK = "6d0f3a2e-8c1b-4f7a-9e6d-00000000011c";
const INVOICE = "6d0f3a2e-8c1b-4f7a-9e6d-0000000001a1";
const PAID_INVOICE = "6d0f3a2e-8c1b-4f7a-9e6d-0000000001a2";
const REQUEST = "6d0f3a2e-8c1b-4f7a-9e6d-0000000004e1";
const MEMBER = "6d0f3a2e-8c1b-4f7a-9e6d-0000000000e1";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const RAW_KEYS = `t1:${crypto.randomBytes(32).toString("base64")}`;
const KEYS = parseMasterKeys(RAW_KEYS);
const PAY_TOKEN = `vxr_${"P".repeat(43)}`;

const { rpc, scopes, tenant, appendBestEffort } = vi.hoisted(() => ({
  rpc: vi.fn(),
  scopes: [] as string[],
  tenant: { reply: ((): unknown => ({ body: [] })) as (request: unknown) => unknown, requests: [] as unknown[] },
  appendBestEffort: vi.fn(async () => undefined),
}));
vi.mock("@/lib/dal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dal")>()),
  platformDb: () => ({ rpc }),
}));
vi.mock("@/lib/dal/scope", () => ({
  withOrg: async (orgId: string, fn: () => Promise<unknown>) => {
    scopes.push(orgId);
    const fake = fakeSupabase((request) => {
      tenant.requests.push(request);
      return tenant.reply(request) as FakeReply;
    });
    return runWith(orgTestContext({ config, client: fake.client, orgId }), fn);
  },
}));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: appendBestEffort }));

// A kept pay link's token is read back with the deployment's master keys.
process.env.VESTIARION_MASTER_KEYS = RAW_KEYS;

import { readStatement, replyAsCustomer, submitCustomerRequest } from "@/lib/customer-portal/public";
import { publicOrigin } from "@/lib/public-origin";

const NOW = Date.parse("2026-10-13T09:00:00Z");
const LIVE = {
  expired: false,
  linkId: LINK,
  orgId: ORG,
  counterpartyId: CUSTOMER,
  createdBy: MEMBER,
  expiresAt: "2026-11-12T09:00:00Z",
  orgName: "Northstar Studio",
  customerName: "Acme Corp",
  mode: "live",
  network: "arc-testnet",
};

function statementReplies(request: RecordedRequest): FakeReply {
  if (request.path === "/rest/v1/invoices") {
    return {
      body: [
        { id: INVOICE, counterparty_id: CUSTOMER, amount: "1250", currency: "USDC", due_date: "2026-10-05T12:00:00+00:00", memo: "Website, phase 2", po_reference: "PO-77", status: "pending", settled_at: null, created_at: "2026-09-20T10:00:00Z" },
        { id: PAID_INVOICE, counterparty_id: CUSTOMER, amount: "800", currency: "USDC", due_date: "2026-09-01T12:00:00+00:00", memo: "Phase 1", po_reference: null, status: "received", settled_at: "2026-09-03T10:00:00Z", created_at: "2026-08-20T10:00:00Z" },
      ],
    };
  }
  if (request.path === "/rest/v1/receivable_allocations") return { body: [] };
  if (request.path === "/rest/v1/receivable_links") {
    return { body: [{ invoice_id: INVOICE, token_enc: encryptSecret(PAY_TOKEN, { orgId: ORG, column: "receivable_links.token_enc" }, KEYS) }] };
  }
  if (request.path === "/rest/v1/customer_requests") {
    return {
      body: [
        {
          id: REQUEST,
          kind: "dispute",
          invoice_id: INVOICE,
          counterparty_id: CUSTOMER,
          link_id: LINK,
          paid_on: null,
          reference: null,
          amount: null,
          promised_on: null,
          status: "open",
          outcome: null,
          created_at: "2026-10-12T10:00:00Z",
          closed_at: null,
        },
      ],
    };
  }
  if (request.path === "/rest/v1/customer_request_messages") {
    return {
      body: [
        { id: "m1", request_id: REQUEST, author: "customer", body: "We were charged twice.", by: null, created_at: "2026-10-12T10:00:00Z" },
        { id: "m2", request_id: REQUEST, author: "business", body: "Checking with our bank.", by: MEMBER, created_at: "2026-10-12T15:00:00Z" },
      ],
    };
  }
  throw new Error(`unexpected request ${request.method} ${request.path}`);
}

beforeEach(() => {
  rpc.mockReset();
  scopes.length = 0;
  tenant.requests.length = 0;
  tenant.reply = statementReplies as (request: unknown) => unknown;
  appendBestEffort.mockClear();
});

const fresh = () => generateCustomerPortalToken();

describe("readStatement", () => {
  it("never looks up a malformed link", async () => {
    for (const token of ["", "vxc_short", `vxs_${"a".repeat(43)}`, "../../etc"]) expect(await readStatement(token, NOW)).toEqual({ state: "dead" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("looks a link up by the hash of its secret, and finds nothing for a stopped or unknown one", async () => {
    const { token, secretHash } = fresh();
    rpc.mockResolvedValueOnce({ data: null, error: null });
    expect(await readStatement(token, NOW)).toEqual({ state: "dead" });
    expect(rpc).toHaveBeenCalledWith("customer_portal_by_token", { p_token_hash: secretHash });
    expect(scopes).toEqual([]);
  });

  it.each(["PGRST202", "42883"])("finds nothing before migration 0109 runs (%s)", async (code) => {
    rpc.mockResolvedValueOnce({ data: null, error: { code, message: "missing" } });
    expect(await readStatement(fresh().token, NOW)).toEqual({ state: "dead" });
  });

  it("says only when an expired link expired, and reads nothing of the workspace", async () => {
    rpc.mockResolvedValueOnce({ data: { expired: true, expiresAt: "2026-10-01T09:00:00Z" }, error: null });
    expect(await readStatement(fresh().token, NOW)).toEqual({ state: "expired", expiresAt: "2026-10-01T09:00:00Z" });
    expect(scopes).toEqual([]);
  });

  it("reads only the link's customer's receivables, in the workspace's own scope", async () => {
    rpc.mockResolvedValueOnce({ data: LIVE, error: null });
    const read = await readStatement(fresh().token, NOW);
    expect(scopes).toEqual([ORG]);
    const reads = tenant.requests.filter((request) => (request as RecordedRequest).path === "/rest/v1/invoices") as RecordedRequest[];
    expect(reads.map((read) => read.params.get("status")).sort()).toEqual(["in.(pending,matched)", "in.(received,paid)"]);
    for (const read of reads) {
      expect(read.params.get("counterparty_id")).toBe(`eq.${CUSTOMER}`);
      expect(read.params.get("direction")).toBe("eq.receivable");
      expect(read.params.get("org_id")).toBe(`eq.${ORG}`);
    }
    expect(reads.find((read) => read.params.get("status") === "in.(received,paid)")?.params.get("settled_at")).toBe(`gte.${new Date(NOW - 90 * 86_400_000).toISOString()}`);
    const requests = tenant.requests.find((request) => (request as RecordedRequest).path === "/rest/v1/customer_requests") as RecordedRequest;
    expect(requests.params.get("counterparty_id")).toBe(`eq.${CUSTOMER}`);

    expect(read.state).toBe("live");
    if (read.state !== "live") return;
    expect(read.view.open.map((line) => line.id)).toEqual([INVOICE]);
    expect(read.view.paid.map((line) => line.id)).toEqual([PAID_INVOICE]);
    expect(read.view.open[0]).toMatchObject({ owed: 1250, overdueDays: 8, payUrl: `${publicOrigin()}/pay/${PAY_TOKEN}` });
  });

  it("never hands the page a member's id: a reply is the business's", async () => {
    rpc.mockResolvedValueOnce({ data: LIVE, error: null });
    const read = await readStatement(fresh().token, NOW);
    if (read.state !== "live") throw new Error("not live");
    const messages = read.view.open[0].requests[0].messages;
    expect(messages.map((message) => [message.author, message.by])).toEqual([
      ["customer", null],
      ["business", null],
    ]);
    expect(JSON.stringify(read)).not.toContain(MEMBER);
    expect(JSON.stringify(read)).not.toContain(ORG);
  });
});

describe("submitCustomerRequest", () => {
  const PAID = { invoiceId: INVOICE, kind: "paid", paidOn: "2026-10-12", reference: "WIRE-2210", amount: "1,250.00", message: "Sent from our bank." };
  const done = (over: Record<string, unknown> = {}) => ({
    data: { requestId: REQUEST, appended: false, superseded: [], orgId: ORG, linkId: LINK, counterpartyId: CUSTOMER, createdBy: MEMBER, invoiceId: INVOICE, ...over },
    error: null,
  });

  it("sends a claim of payment to the database by the link's hash, says it is being checked, and signs it without the words", async () => {
    const { token, secretHash } = fresh();
    rpc.mockResolvedValueOnce({ data: LIVE, error: null }).mockResolvedValueOnce(done());
    tenant.reply = ((request: RecordedRequest) => (request.path === "/rest/v1/invoices" ? { body: [{ amount: "1250", currency: "USDC" }] } : { body: [] })) as (request: unknown) => unknown;
    const answer = await submitCustomerRequest(token, PAID, NOW);
    expect(answer).toEqual({ ok: true, message: "Thanks. Northstar Studio will check for your payment. The invoice stays open until they find it." });
    expect(rpc).toHaveBeenLastCalledWith("customer_portal_submit", {
      p_token_hash: secretHash,
      p_invoice_id: INVOICE,
      p_kind: "paid",
      p_paid_on: "2026-10-12",
      p_reference: "WIRE-2210",
      p_amount: 1250,
      p_promised_on: null,
      p_message: "Sent from our bank.",
    });
    const [orgId, entry] = appendBestEffort.mock.calls[0] as unknown as [string, { action: string; summary: string; detail: Record<string, unknown> }];
    expect(orgId).toBe(ORG);
    expect(entry.action).toBe("customer_said_paid");
    expect(entry.summary).toBe("Acme Corp says it paid an invoice of 1,250.00 USDC on Oct 12, 2026: its word, not a payment received");
    expect(entry.detail).toMatchObject({ via: "customer_portal", linkId: LINK, requestId: REQUEST, invoiceId: INVOICE, kind: "paid", paidOn: "2026-10-12", amount: 1250 });
    expect(entry.detail.textSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(entry)).not.toContain("WIRE-2210");
    expect(JSON.stringify(entry)).not.toContain("Sent from our bank");
  });

  it("checks the form before the database: a field's own words, and nothing sent", async () => {
    rpc.mockResolvedValueOnce({ data: LIVE, error: null });
    expect(await submitCustomerRequest(fresh().token, { ...PAID, paidOn: "2026-10-20" }, NOW)).toEqual({ ok: false, field: "paidOn", message: "The day you paid can't be after today." });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("refuses an invoice that is not the link's customer's, as a forwarded link would try", async () => {
    rpc.mockResolvedValueOnce({ data: LIVE, error: null }).mockResolvedValueOnce({ data: null, error: { code: "P0001", message: "customer_portal_invoice_not_found: no such invoice on this statement" } });
    expect(await submitCustomerRequest(fresh().token, { invoiceId: PAID_INVOICE, kind: "pay_link" }, NOW)).toEqual({ ok: false, field: "form", message: "That invoice is not on this statement." });
    expect(appendBestEffort).not.toHaveBeenCalled();
  });

  it("says an expired, stopped or unknown link no longer works, and sends nothing", async () => {
    rpc.mockResolvedValueOnce({ data: { expired: true, expiresAt: "2026-10-01T00:00:00Z" }, error: null });
    expect(await submitCustomerRequest(fresh().token, PAID, NOW)).toMatchObject({ ok: false, message: "This link has expired. Ask the business that sent it for a new one." });
    rpc.mockResolvedValueOnce({ data: null, error: null });
    expect(await submitCustomerRequest(fresh().token, PAID, NOW)).toMatchObject({ ok: false, message: "This link no longer works. Ask the business that sent it for a new one." });
    // Stopped between the lookup and the write: the database says so.
    rpc.mockResolvedValueOnce({ data: LIVE, error: null }).mockResolvedValueOnce({ data: null, error: { code: "P0001", message: "customer_portal_link_dead: this link no longer works" } });
    expect(await submitCustomerRequest(fresh().token, PAID, NOW)).toMatchObject({ ok: false, message: "This link no longer works. Ask the business that sent it for a new one." });
    expect(appendBestEffort).not.toHaveBeenCalled();
  });

  it("says when a link sent all it can for today", async () => {
    rpc.mockResolvedValueOnce({ data: LIVE, error: null }).mockResolvedValueOnce({ data: null, error: { code: "P0001", message: "customer_portal_limit: this link sent enough for today" } });
    expect(await submitCustomerRequest(fresh().token, PAID, NOW)).toMatchObject({ ok: false, message: "This link has sent all it can for today. Try again tomorrow, or contact the business directly." });
  });

  it("slows a link that sends many at once, before it reaches the database", async () => {
    const { token } = fresh();
    rpc.mockResolvedValue({ data: null, error: null });
    for (let i = 0; i < 5; i += 1) await submitCustomerRequest(token, PAID, NOW);
    expect(await submitCustomerRequest(token, PAID, NOW)).toMatchObject({ ok: false, message: "You sent several just now. Wait a few seconds, then try again." });
    expect(rpc).toHaveBeenCalledTimes(5);
  });

  it("thanks a promise with its day, and a dispute added to one already open", async () => {
    rpc.mockResolvedValueOnce({ data: LIVE, error: null }).mockResolvedValueOnce(done());
    tenant.reply = (() => ({ body: [{ amount: "1250", currency: "USDC" }] })) as (request: unknown) => unknown;
    expect(await submitCustomerRequest(fresh().token, { invoiceId: INVOICE, kind: "promise", promisedOn: "2026-10-20" }, NOW)).toEqual({
      ok: true,
      message: "Thanks. Northstar Studio knows you will pay by Oct 20, 2026, and reminders about this invoice wait until then.",
    });
    expect((appendBestEffort.mock.calls[0] as unknown as [string, { action: string }])[1].action).toBe("customer_promised_payment");

    rpc.mockResolvedValueOnce({ data: LIVE, error: null }).mockResolvedValueOnce(done({ appended: true }));
    expect(await submitCustomerRequest(fresh().token, { invoiceId: INVOICE, kind: "dispute", message: "And the second charge." }, NOW)).toEqual({ ok: true, message: "Added. Northstar Studio will reply here." });
    expect((appendBestEffort.mock.calls[1] as unknown as [string, { action: string }])[1].action).toBe("customer_wrote");
  });
});

describe("replyAsCustomer", () => {
  it("adds the customer's words under its own request, and signs them as a hash", async () => {
    const { token, secretHash } = fresh();
    rpc
      .mockResolvedValueOnce({ data: LIVE, error: null })
      .mockResolvedValueOnce({ data: { messageId: "6d0f3a2e-8c1b-4f7a-9e6d-0000000000f1", requestId: REQUEST, kind: "dispute", orgId: ORG, linkId: LINK, counterpartyId: CUSTOMER, invoiceId: INVOICE }, error: null });
    expect(await replyAsCustomer(token, { requestId: REQUEST, message: "Here is the bank statement." }, NOW)).toEqual({ ok: true, message: "Sent. Northstar Studio will reply here." });
    expect(rpc).toHaveBeenLastCalledWith("customer_portal_reply", { p_token_hash: secretHash, p_request_id: REQUEST, p_message: "Here is the bank statement." });
    const [, entry] = appendBestEffort.mock.calls[0] as unknown as [string, { action: string; detail: Record<string, unknown> }];
    expect(entry.action).toBe("customer_wrote");
    expect(JSON.stringify(entry)).not.toContain("bank statement");
  });

  it("refuses an empty message and a request that is not the customer's", async () => {
    rpc.mockResolvedValueOnce({ data: LIVE, error: null });
    expect(await replyAsCustomer(fresh().token, { requestId: REQUEST, message: "  " }, NOW)).toEqual({ ok: false, field: "message", message: "Write your message first." });
    rpc.mockResolvedValueOnce({ data: LIVE, error: null }).mockResolvedValueOnce({ data: null, error: { code: "P0001", message: "customer_portal_request_not_found: no such request on this statement" } });
    expect(await replyAsCustomer(fresh().token, { requestId: REQUEST, message: "Hello" }, NOW)).toMatchObject({ ok: false, message: "That invoice is not on this statement." });
  });
});
