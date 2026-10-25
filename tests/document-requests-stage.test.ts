import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import type { EmailMessage, SendResult } from "@/lib/email/send";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * The cycle's document requests stage (docs/superpowers/specs/2026-10-23-document-requests-design.md ER2-ER4, ER7): which
 * bills qualify, shadow signing and sending nothing, on emailing each request once under its own claim, the daily cap
 * and the cooldown, a failed email tried at most three times, nothing before migration 0142, and no write to any bill.
 */

const { ledgerMock } = vi.hoisted(() => ({ ledgerMock: vi.fn() }));
vi.mock("@/lib/ledger", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ledger")>()), appendLedgerEntry: ledgerMock }));

import { requestMissingDocuments } from "@/lib/agent/document-requests";

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000d0d";
const INVOICE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001d1";
const VENDOR = "0b6c1c9e-4a4f-4a7e-9b1e-0000000002d2";
const REQUEST = "0b6c1c9e-4a4f-4a7e-9b1e-0000000003d3";
const NOW = Date.parse("2026-10-23T09:00:00Z");
const DAY = 86_400_000;

const bill = (over: Record<string, unknown> = {}, vendor: Record<string, unknown> = {}) => ({
  id: INVOICE,
  counterparty_id: VENDOR,
  amount: "1250",
  currency: "USDC",
  due_date: "2026-10-30T12:00:00+00:00",
  memo: "INV-2215",
  po_reference: null,
  goods_received: true,
  status: "awaiting_info",
  counterparties: { name: "Northstar Studio", notice_email: "AP@Northstar.example", risk_level: "clear", purchase_order_required: true, frozen_at: null, ...vendor },
  ...over,
});

interface World {
  setting?: string | "missing";
  paused?: boolean;
  bills?: Array<Record<string, unknown>>;
  /** Earlier requests of these bills. */
  requests?: Array<Record<string, unknown>>;
  /** Requests made or sent in the last 24 hours. */
  today?: Array<Record<string, unknown>>;
  /** Counterparties' frozen_at before migration 0137: the select naming it fails. */
  noFreeze?: boolean;
  create?: FakeReply;
  claim?: boolean;
  release?: string;
  /** The workspace's mode; live by default. */
  mode?: string;
  /** Who last set vendor requests, from its signed change; null for no such entry. */
  changedBy?: string | null;
  /** The workspace's members, for a sandbox's recipient. */
  members?: Array<{ user_id: string; email: string; role: string }>;
}

const OWNER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000004d4";

function world(w: World = {}) {
  return fakeSupabase((request: RecordedRequest): FakeReply => {
    if (request.path === "/rest/v1/approval_policies") {
      if (w.setting === "missing") return { status: 400, body: { code: "42703", message: "column approval_policies.document_requests does not exist" } };
      return { body: [{ document_requests: w.setting ?? "on" }] };
    }
    if (request.path === "/rest/v1/rpc/agent_paused") return { body: w.paused === true };
    if (request.path === "/rest/v1/orgs") return { body: { name: "Pinecrest Studio", mode: w.mode ?? "live" } };
    if (request.path === "/rest/v1/ledger_entries") {
      const by = w.changedBy === undefined ? OWNER : w.changedBy;
      return { body: by === null ? [] : [{ detail: { by, from: "off", to: w.setting ?? "on" } }] };
    }
    if (request.path === "/rest/v1/rpc/org_members") {
      return { body: (w.members ?? [{ user_id: OWNER, email: "owner@pinecrest.example", role: "owner" }]).map((m) => ({ ...m, joined_at: "2026-09-01T00:00:00Z" })) };
    }
    if (request.path === "/rest/v1/rpc/close_document_requests") return { body: 0 };
    if (request.path === "/rest/v1/invoices") {
      if (w.noFreeze && request.params.get("select")?.includes("frozen_at")) return { status: 400, body: { code: "42703", message: "column counterparties_1.frozen_at does not exist" } };
      return { body: w.bills ?? [bill()] };
    }
    if (request.path === "/rest/v1/document_requests") {
      if (request.params.has("or")) {
        // A member's attachment has no email domain (0144): the read that leaves those out gets the vendors' alone.
        const vendorsOnly = request.params.get("email_domain") === "not.is.null";
        return { body: (w.today ?? []).filter((row) => !vendorsOnly || row.email_domain !== null) };
      }
      return { body: w.requests ?? [] };
    }
    if (request.path === "/rest/v1/rpc/create_document_request") {
      return w.create ?? { body: { id: REQUEST, invoice_id: INVOICE, counterparty_id: VENDOR, status: "drafted", send_attempts: 0, missing: ["purchase_order"] } };
    }
    if (request.path === "/rest/v1/rpc/claim_document_request_send") return { body: w.claim ?? true };
    if (request.path === "/rest/v1/rpc/mark_document_request_sent") return { body: true };
    if (request.path === "/rest/v1/rpc/release_document_request_send") return { body: w.release ?? "drafted" };
    return { body: [] };
  });
}

const sendMock = vi.fn<(message: EmailMessage) => Promise<SendResult>>();
const run = (client: ReturnType<typeof fakeSupabase>, send: typeof sendMock | null = sendMock) =>
  runWith(orgTestContext({ config, client: client.client, orgId: ORG }), () =>
    requestMissingDocuments(db(), { now: NOW, send, origin: "https://www.vestiarion.xyz" })
  );

const rpcs = (client: ReturnType<typeof fakeSupabase>, name: string) => client.requests.filter((r) => r.path === `/rest/v1/rpc/${name}`);

beforeEach(() => {
  ledgerMock.mockReset().mockResolvedValue(undefined);
  sendMock.mockReset().mockResolvedValue({ sent: true, id: "email-1" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("which bills it asks about (ER2)", () => {
  it("asks about a bill waiting for its purchase order, whatever rule held it, without reading the agent's decisions", async () => {
    const client = world();
    await run(client);
    expect(rpcs(client, "create_document_request")[0]?.body).toEqual({ p_org_id: ORG, p_invoice_id: INVOICE, p_missing: ["purchase_order"], p_email_domain: "northstar.example" });
    // A match hold usually carries no guardrail rule: the stage keys on the bill as it is, not on its decision.
    expect(client.requests.some((r) => r.path === "/rest/v1/ledger_entries")).toBe(false);
    const read = client.requests.find((r) => r.path === "/rest/v1/invoices")!;
    expect(read.params.get("status")).toBe("eq.awaiting_info");
    expect(read.params.get("direction")).toBe("eq.payable");
  });

  it("asks for the goods receipt too when neither is on file, and never for a purchase order from a vendor paid without them", async () => {
    const both = world({ bills: [bill({ goods_received: false })] });
    await run(both);
    expect((rpcs(both, "create_document_request")[0].body as { p_missing: string[] }).p_missing).toEqual(["purchase_order", "goods_receipt"]);
    const waived = world({ bills: [bill({ goods_received: false }, { purchase_order_required: false })] });
    await run(waived);
    expect((rpcs(waived, "create_document_request")[0].body as { p_missing: string[] }).p_missing).toEqual(["goods_receipt"]);
  });

  it("skips a bill missing nothing, a vendor with no billing email, a frozen vendor and one screened high risk", async () => {
    for (const skipped of [
      bill({ po_reference: "PO-1" }),
      bill({}, { purchase_order_required: false }),
      bill({}, { notice_email: null }),
      bill({}, { frozen_at: "2026-10-22T10:00:00Z" }),
      bill({}, { risk_level: "high" }),
    ]) {
      const client = world({ bills: [skipped] });
      expect(await run(client)).toEqual([]);
      expect(rpcs(client, "create_document_request")).toHaveLength(0);
    }
  });

  it("still asks before migration 0137, reading every vendor as not frozen", async () => {
    const client = world({ noFreeze: true });
    await run(client);
    expect(rpcs(client, "create_document_request")).toHaveLength(1);
  });

  it("waits 7 days after an answer or an expiry, and never asks again after a revoke", async () => {
    const recent = world({ requests: [{ id: "r0", invoice_id: INVOICE, status: "answered", send_attempts: 1, created_at: new Date(NOW - 5 * DAY).toISOString(), sent_at: new Date(NOW - 5 * DAY).toISOString(), expires_at: new Date(NOW + 9 * DAY).toISOString(), answered_at: new Date(NOW - 2 * DAY).toISOString() }] });
    await run(recent);
    expect(rpcs(recent, "create_document_request")).toHaveLength(0);
    const later = world({ requests: [{ id: "r0", invoice_id: INVOICE, status: "expired", send_attempts: 1, created_at: new Date(NOW - 30 * DAY).toISOString(), sent_at: new Date(NOW - 30 * DAY).toISOString(), expires_at: new Date(NOW - 16 * DAY).toISOString(), answered_at: null }] });
    await run(later);
    expect(rpcs(later, "create_document_request")).toHaveLength(1);
    const revoked = world({ requests: [{ id: "r0", invoice_id: INVOICE, status: "revoked", send_attempts: 1, created_at: new Date(NOW - 60 * DAY).toISOString(), sent_at: new Date(NOW - 60 * DAY).toISOString(), expires_at: new Date(NOW - 59 * DAY).toISOString(), answered_at: null }] });
    await run(revoked);
    expect(rpcs(revoked, "create_document_request")).toHaveLength(0);
  });

  it("makes at most 20 requests a day, and emails at most 20", async () => {
    const made = Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, created_at: new Date(NOW - i * 3_600_000).toISOString(), sent_at: null }));
    const full = world({ today: made });
    await run(full);
    expect(rpcs(full, "create_document_request")).toHaveLength(0);
    // A drafted request is still emailed while fewer than 20 went out.
    const drafted = world({ today: made, requests: [{ id: REQUEST, invoice_id: INVOICE, status: "drafted", send_attempts: 0, created_at: new Date(NOW - DAY).toISOString(), sent_at: null, expires_at: null, answered_at: null }] });
    await run(drafted);
    expect(sendMock).toHaveBeenCalledTimes(1);
    sendMock.mockClear();
    const sent = Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, created_at: new Date(NOW - 2 * DAY).toISOString(), sent_at: new Date(NOW - i * 3_600_000).toISOString() }));
    const noMore = world({ today: sent, requests: [{ id: REQUEST, invoice_id: INVOICE, status: "drafted", send_attempts: 0, created_at: new Date(NOW - DAY).toISOString(), sent_at: null, expires_at: null, answered_at: null }] });
    await run(noMore);
    expect(sendMock).not.toHaveBeenCalled();
    expect(rpcs(noMore, "claim_document_request_send")).toHaveLength(0);
  });

  it("counts only its own requests toward the 20 a day: documents members attached today use none of them", async () => {
    // 0144: a member's attachment is an answered row with no email domain, made now, never emailed.
    const attached = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, created_at: new Date(NOW - i * 3_600_000).toISOString(), sent_at: null, email_domain: null, source: "member" }));
    const client = world({ today: attached });
    await run(client);
    expect(rpcs(client, "create_document_request")).toHaveLength(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const read = client.requests.find((r) => r.path === "/rest/v1/document_requests" && r.params.has("or"))!;
    // Before 0144 every row has an email domain (0142's not null), so the same filter reads the same rows there.
    expect(read.params.get("email_domain")).toBe("not.is.null");
  });

  it("reads the bills' earlier requests 100 bills at a time, so no read's address grows past the others'", async () => {
    const many = Array.from({ length: 150 }, (_, i) => bill({ id: `0b6c1c9e-4a4f-4a7e-9b1e-${String(i).padStart(12, "0")}` }));
    const made = Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, created_at: new Date(NOW - i * 3_600_000).toISOString(), sent_at: new Date(NOW - i * 3_600_000).toISOString() }));
    const client = world({ bills: many, today: made });
    await run(client);
    const reads = client.requests.filter((r) => r.path === "/rest/v1/document_requests" && r.params.has("invoice_id"));
    const named = reads.map((r) => (r.params.get("invoice_id") ?? "").replace(/^in\.\(|\)$/g, "").split(",").length);
    expect(named).toEqual([100, 50]);
  });
});

describe("shadow (ER3)", () => {
  it("records what it would ask, signs the email's domain only, and sends nothing", async () => {
    const client = world({ setting: "shadow" });
    const lines = await run(client);
    expect(sendMock).not.toHaveBeenCalled();
    expect(rpcs(client, "claim_document_request_send")).toHaveLength(0);
    expect(ledgerMock).toHaveBeenCalledTimes(1);
    const entry = ledgerMock.mock.calls[0][0];
    expect(entry).toMatchObject({
      actor: "agent",
      domain: "ap",
      action: "document_request_drafted",
      detail: { invoiceId: INVOICE, counterpartyId: VENDOR, requestId: REQUEST, missing: ["purchase_order"], emailDomain: "northstar.example" },
    });
    expect(JSON.stringify(entry)).not.toContain("AP@");
    expect(lines).toEqual([{ domain: "ap", message: "Would ask Northstar Studio for the purchase order (vendor requests are in shadow)" }]);
  });

  it("records a bill once: a request drafted already is not drafted again", async () => {
    const client = world({ setting: "shadow", requests: [{ id: REQUEST, invoice_id: INVOICE, status: "drafted", send_attempts: 0, created_at: new Date(NOW - DAY).toISOString(), sent_at: null, expires_at: null, answered_at: null }] });
    expect(await run(client)).toEqual([]);
    expect(rpcs(client, "create_document_request")).toHaveLength(0);
    expect(ledgerMock).not.toHaveBeenCalled();
  });
});

describe("on (ER4)", () => {
  it("claims the request, emails the billing address once in the workspace's name, opens the link and signs it", async () => {
    const client = world();
    const lines = await run(client);
    const [claim] = rpcs(client, "claim_document_request_send");
    expect(claim.body).toMatchObject({ p_org_id: ORG, p_id: REQUEST, p_attempts: 0, p_missing: ["purchase_order"], p_email_domain: "northstar.example" });
    const tokenHash = (claim.body as { p_token_hash: string }).p_token_hash;
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const email = sendMock.mock.calls[0][0];
    expect(email).toMatchObject({ to: "AP@Northstar.example", fromName: "Pinecrest Studio", subject: "Pinecrest Studio needs the purchase order for invoice INV-2215" });
    expect(email.text).toContain("Pinecrest Studio has invoice INV-2215 for 1,250.00 USDC, due Oct 30, 2026. To check it, they need the purchase order.");
    expect(email.text).toContain("The link takes one document, until Nov 6, 2026 (UTC).");
    const link = /https:\/\/www\.vestiarion\.xyz\/documents\/(vxu_[A-Za-z0-9_-]{43})/.exec(email.text)?.[1];
    expect(link).toBeTruthy();
    expect(email.text).not.toContain(tokenHash);
    expect(email.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);

    expect(rpcs(client, "mark_document_request_sent")[0].body).toEqual({ p_org_id: ORG, p_id: REQUEST, p_token_hash: tokenHash, p_expires_at: "2026-11-06T09:00:00.000Z" });
    expect(ledgerMock).toHaveBeenCalledTimes(1);
    expect(ledgerMock.mock.calls[0][0]).toMatchObject({
      actor: "agent",
      domain: "ap",
      action: "document_requested",
      detail: { invoiceId: INVOICE, counterpartyId: VENDOR, requestId: REQUEST, missing: ["purchase_order"], emailDomain: "northstar.example", expiresAt: "2026-11-06T09:00:00.000Z" },
    });
    expect(JSON.stringify(ledgerMock.mock.calls[0][0])).not.toContain(link as string);
    expect(lines).toEqual([{ domain: "ap", message: "Asked Northstar Studio by email for the purchase order; the link expires Nov 6" }]);
  });

  it("sends a request shadow drafted, without drafting another", async () => {
    const client = world({ requests: [{ id: REQUEST, invoice_id: INVOICE, status: "drafted", send_attempts: 0, created_at: new Date(NOW - 3 * DAY).toISOString(), sent_at: null, expires_at: null, answered_at: null }] });
    await run(client);
    expect(rpcs(client, "create_document_request")).toHaveLength(0);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when another run claimed the request first", async () => {
    const client = world({ claim: false });
    await run(client);
    expect(sendMock).not.toHaveBeenCalled();
    expect(ledgerMock).not.toHaveBeenCalled();
  });

  it("leaves a request whose email failed unsent, tried again at the next cycle, and gives up after the third try", async () => {
    sendMock.mockResolvedValue({ sent: false, reason: "status 500" });
    const client = world({ requests: [{ id: REQUEST, invoice_id: INVOICE, status: "drafted", send_attempts: 1, created_at: new Date(NOW - DAY).toISOString(), sent_at: null, expires_at: null, answered_at: null }] });
    const lines = await run(client);
    expect((rpcs(client, "claim_document_request_send")[0].body as { p_attempts: number }).p_attempts).toBe(1);
    const tokenHash = (rpcs(client, "claim_document_request_send")[0].body as { p_token_hash: string }).p_token_hash;
    expect(rpcs(client, "release_document_request_send")[0].body).toEqual({ p_org_id: ORG, p_id: REQUEST, p_token_hash: tokenHash });
    expect(rpcs(client, "mark_document_request_sent")).toHaveLength(0);
    expect(ledgerMock).not.toHaveBeenCalled();
    expect(lines).toEqual([{ domain: "ap", message: "The request to Northstar Studio was not emailed (status 500); tried again at the next cycle" }]);

    const last = world({ release: "expired", requests: [{ id: REQUEST, invoice_id: INVOICE, status: "drafted", send_attempts: 2, created_at: new Date(NOW - DAY).toISOString(), sent_at: null, expires_at: null, answered_at: null }] });
    expect(await run(last)).toEqual([{ domain: "ap", message: "The request to Northstar Studio was not emailed after 3 tries (status 500); it was dropped" }]);

    const spent = world({ requests: [{ id: REQUEST, invoice_id: INVOICE, status: "drafted", send_attempts: 3, created_at: new Date(NOW - DAY).toISOString(), sent_at: null, expires_at: null, answered_at: null }] });
    await run(spent);
    expect(rpcs(spent, "claim_document_request_send")).toHaveLength(0);
  });

  it("drafts nothing while email is not set up", async () => {
    const client = world();
    expect(await run(client, null)).toEqual([]);
    expect(rpcs(client, "create_document_request")).toHaveLength(0);
  });
});

describe("a sandbox", () => {
  it("never emails the vendor: the request goes to the member who set vendor requests, marked as a sandbox", async () => {
    const client = world({ mode: "sandbox" });
    const lines = await run(client);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const email = sendMock.mock.calls[0][0];
    expect(email.to).toBe("owner@pinecrest.example");
    expect(email.subject).toBe("[Sandbox] Pinecrest Studio needs the purchase order for invoice INV-2215");
    expect(email.text).toContain("This is a sandbox, so Vestiarion never emails its vendors. You get this in place of Northstar Studio");
    expect(JSON.stringify(client.requests)).not.toContain("Northstar.example");
    expect((rpcs(client, "create_document_request")[0].body as { p_email_domain: string }).p_email_domain).toBe("pinecrest.example");
    expect((rpcs(client, "claim_document_request_send")[0].body as { p_email_domain: string }).p_email_domain).toBe("pinecrest.example");
    expect(ledgerMock.mock.calls[0][0]).toMatchObject({ action: "document_requested", detail: { emailDomain: "pinecrest.example", sandbox: true } });
    expect(lines).toEqual([{ domain: "ap", message: "Asked Northstar Studio for the purchase order; as this is a sandbox, the email went to the member who turned vendor requests on. The link expires Nov 6" }]);
  });

  it("still asks only about a vendor with a billing email, and records a sandbox's draft as one", async () => {
    const noEmail = world({ mode: "sandbox", bills: [bill({}, { notice_email: null })] });
    expect(await run(noEmail)).toEqual([]);
    expect(rpcs(noEmail, "create_document_request")).toHaveLength(0);
    const shadow = world({ mode: "sandbox", setting: "shadow" });
    await run(shadow);
    expect(sendMock).not.toHaveBeenCalled();
    expect(ledgerMock.mock.calls[0][0]).toMatchObject({ action: "document_request_drafted", detail: { emailDomain: "pinecrest.example", sandbox: true } });
  });

  it("asks no one when the member who set vendor requests has left, or no signed change names them", async () => {
    for (const client of [world({ mode: "sandbox", members: [] }), world({ mode: "sandbox", changedBy: null })]) {
      expect(await run(client)).toEqual([]);
      expect(rpcs(client, "create_document_request")).toHaveLength(0);
      expect(sendMock).not.toHaveBeenCalled();
    }
  });
});

describe("when it does nothing", () => {
  it("does nothing before migration 0142, while off, or while the agent is paused", async () => {
    const before = world({ setting: "missing" });
    expect(await run(before)).toEqual([]);
    expect(before.requests.map((r) => r.path)).toEqual(["/rest/v1/approval_policies"]);

    // Off, the setting is the one read: a cycle of a workspace that never turned it on costs nothing more.
    const off = world({ setting: "off" });
    expect(await run(off)).toEqual([]);
    expect(off.requests.map((r) => r.path)).toEqual(["/rest/v1/approval_policies"]);

    const paused = world({ paused: true });
    expect(await run(paused)).toEqual([]);
    expect(rpcs(paused, "close_document_requests")).toHaveLength(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("does nothing when the requests table is not there yet", async () => {
    const client = fakeSupabase((request) => {
      if (request.path === "/rest/v1/approval_policies") return { body: [{ document_requests: "on" }] };
      if (request.path === "/rest/v1/rpc/agent_paused") return { body: false };
      if (request.path === "/rest/v1/rpc/close_document_requests") return { status: 404, body: { code: "PGRST202", message: "Could not find the function" } };
      return { body: [] };
    });
    expect(await run(client)).toEqual([]);
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("never pays (ER7)", () => {
  it("writes nothing to a bill, a counterparty or a payment, and calls only its own functions", async () => {
    for (const setting of ["on", "shadow"]) {
      const client = world({ setting });
      await run(client);
      const writes = client.requests.filter((r) => r.method !== "GET" && !r.path.startsWith("/rest/v1/rpc/"));
      expect(writes).toEqual([]);
      const called = new Set(client.requests.filter((r) => r.path.startsWith("/rest/v1/rpc/")).map((r) => r.path.slice("/rest/v1/rpc/".length)));
      for (const name of called) {
        expect(["agent_paused", "close_document_requests", "create_document_request", "claim_document_request_send", "mark_document_request_sent", "release_document_request_send"]).toContain(name);
      }
    }
  });
});
