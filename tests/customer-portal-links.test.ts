import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { createPortalLink, listPortalLinks, PortalLinkError, stopPortalLink } from "@/lib/customer-portal/links";
import { closeCustomerRequest, CustomerRequestError, readCustomerRequests, readReminderPauses, replyToCustomer } from "@/lib/customer-portal/requests";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * A customer's statement link and the requests behind it, in the workspace in scope
 * (docs/superpowers/specs/2026-10-13-customer-portal-design.md P2, P7-P9): only the link's hash is stored, with its
 * expiry; a new link stops the customer's old one first; a link whose entry cannot be written is stopped at once;
 * stopping revokes first and records it after; a reply and a close are signed with the words' hash; before migration
 * 0109 runs, each says so.
 */

const { appendLedgerEntry, appendBestEffort, canSign } = vi.hoisted(() => ({
  appendLedgerEntry: vi.fn(),
  appendBestEffort: vi.fn(async () => undefined),
  canSign: vi.fn(),
}));
vi.mock("@/lib/ledger", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ledger")>()), appendLedgerEntry, assertLedgerCanSign: canSign }));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: appendBestEffort }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000d01";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000d1";
const CUSTOMER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000dc";
const OLD_LINK = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001d1";
const REQUEST = "0b6c1c9e-4a4f-4a7e-9b1e-0000000004d1";
const INVOICE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000005d1";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const MISSING: FakeReply = { status: 404, body: { code: "PGRST205", message: "Could not find the table 'public.customer_portal_links' in the schema cache" } };
const NOW = Date.parse("2026-10-13T09:00:00Z");

type Row = Record<string, unknown>;

function workspace(start: { role?: string; insert?: FakeReply; missing?: boolean; request?: Row; patch?: FakeReply } = {}) {
  const fake = fakeSupabase((request: RecordedRequest): FakeReply => {
    if (start.missing) return MISSING;
    if (request.path === "/rest/v1/counterparties") return { body: [{ id: CUSTOMER, name: "Acme Corp", role: start.role ?? "client" }] };
    if (request.path === "/rest/v1/customer_portal_links") {
      if (request.method === "PATCH") return start.patch ?? { body: [{ id: OLD_LINK }] };
      if (request.method === "POST") return start.insert ?? { status: 201, body: { id: "new-link" } };
      return { body: [{ id: OLD_LINK, counterparty_id: CUSTOMER, revoked_at: null, created_by: USER, created_at: "2026-10-01T00:00:00Z", expires_at: "2026-10-10T00:00:00Z" }] };
    }
    if (request.path === "/rest/v1/customer_requests") {
      if (request.method === "PATCH") return start.patch ?? { body: [{ id: REQUEST }] };
      return { body: start.request ? [start.request] : [] };
    }
    if (request.path === "/rest/v1/customer_request_messages") return request.method === "POST" ? { status: 201, body: { id: "message-1" } } : { body: [] };
    throw new Error(`unexpected request ${request.method} ${request.path}`);
  });
  const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: USER }), fn);
  return { fake, run };
}

const writes = (requests: RecordedRequest[], method: string, path: string) => requests.filter((request) => request.method === method && request.path === path);

beforeEach(() => {
  appendLedgerEntry.mockReset().mockResolvedValue({ seq: 9 });
  appendBestEffort.mockClear();
  canSign.mockReset();
});

describe("createPortalLink", () => {
  it("stops the customer's old link, stores only the new link's hash and expiry, and signs it", async () => {
    const { fake, run } = workspace();
    const made = await run(() => createPortalLink({ actorId: USER, counterpartyId: CUSTOMER, days: 30, now: NOW }));
    expect(made).toMatchObject({ linkId: "new-link", customerName: "Acme Corp", replaced: 1, expiresAt: "2026-11-12T09:00:00.000Z" });
    expect(made.token).toMatch(/^vxc_[A-Za-z0-9_-]{43}$/);

    const [stop] = writes(fake.requests, "PATCH", "/rest/v1/customer_portal_links");
    expect(stop.params.get("counterparty_id")).toBe(`eq.${CUSTOMER}`);
    expect(stop.params.get("revoked_at")).toBe("is.null");
    expect(stop.params.get("org_id")).toBe(`eq.${ORG}`);
    expect(stop.body).toEqual({ revoked_at: new Date(NOW).toISOString(), revoked_by: USER });

    const [insert] = writes(fake.requests, "POST", "/rest/v1/customer_portal_links");
    const stored = insert.body as Row;
    expect(stored).toMatchObject({ org_id: ORG, counterparty_id: CUSTOMER, created_by: USER, expires_at: "2026-11-12T09:00:00.000Z" });
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(made.token.slice(4));

    expect(appendLedgerEntry).toHaveBeenCalledWith(
      expect.objectContaining({ action: "customer_statement_shared", domain: "ar", detail: expect.objectContaining({ by: USER, linkId: "new-link", counterpartyId: CUSTOMER, days: 30, replaced: [OLD_LINK] }) })
    );
  });

  it("refuses a supplier, an unknown customer and a length it does not offer, before writing anything", async () => {
    const supplier = workspace({ role: "vendor" });
    await expect(supplier.run(() => createPortalLink({ actorId: USER, counterpartyId: CUSTOMER, days: 30 }))).rejects.toThrow(PortalLinkError);
    expect(writes(supplier.fake.requests, "POST", "/rest/v1/customer_portal_links")).toEqual([]);
    const { run } = workspace();
    await expect(run(() => createPortalLink({ actorId: USER, counterpartyId: CUSTOMER, days: 365 }))).rejects.toMatchObject({ code: "days" });
  });

  it("refuses before writing when the ledger cannot sign", async () => {
    canSign.mockImplementationOnce(() => {
      throw new Error("no key");
    });
    const { fake, run } = workspace();
    await expect(run(() => createPortalLink({ actorId: USER, counterpartyId: CUSTOMER, days: 7 }))).rejects.toThrow("no key");
    expect(fake.requests).toEqual([]);
  });

  it("stops a link whose entry could not be written, and asks to try again", async () => {
    appendLedgerEntry.mockRejectedValueOnce(new Error("ledger down"));
    const { fake, run } = workspace();
    await expect(run(() => createPortalLink({ actorId: USER, counterpartyId: CUSTOMER, days: 7 }))).rejects.toMatchObject({ code: "not_recorded" });
    const stops = writes(fake.requests, "PATCH", "/rest/v1/customer_portal_links");
    expect(stops.at(-1)?.params.get("id")).toBe("eq.new-link");
  });

  it("says another person made one a moment ago when the one-live index refuses", async () => {
    const { run } = workspace({ insert: { status: 409, body: { code: "23505", message: "duplicate key value violates unique constraint \"customer_portal_links_one_live\"" } } });
    await expect(run(() => createPortalLink({ actorId: USER, counterpartyId: CUSTOMER, days: 7 }))).rejects.toMatchObject({ code: "busy" });
  });

  it("says statements are not set up before migration 0109 runs", async () => {
    const { run } = workspace({ missing: true });
    expect(await run(() => listPortalLinks(db()))).toEqual({ available: false });
  });
});

describe("listPortalLinks and stopPortalLink", () => {
  it("lists links not stopped, marking an expired one", async () => {
    const { run } = workspace();
    const listed = await run(() => listPortalLinks(db(), NOW));
    expect(listed).toEqual({ available: true, links: [{ id: OLD_LINK, counterpartyId: CUSTOMER, createdBy: USER, createdAt: "2026-10-01T00:00:00Z", expiresAt: "2026-10-10T00:00:00Z", expired: true }] });
  });

  it("stops first, then records it best effort", async () => {
    const { fake, run } = workspace();
    await run(() => stopPortalLink({ actorId: USER, linkId: OLD_LINK }));
    const [stop] = writes(fake.requests, "PATCH", "/rest/v1/customer_portal_links");
    expect(stop.params.get("id")).toBe(`eq.${OLD_LINK}`);
    expect(appendBestEffort).toHaveBeenCalledWith(ORG, expect.objectContaining({ action: "customer_statement_unshared", detail: { by: USER, linkId: OLD_LINK, counterpartyId: CUSTOMER } }));
  });

  it("says a link stopped by someone else a moment ago was stopped already", async () => {
    const { run } = workspace({ patch: { body: [] } });
    await expect(run(() => stopPortalLink({ actorId: USER, linkId: OLD_LINK }))).rejects.toMatchObject({ code: "already_stopped" });
  });
});

describe("a customer's requests, in the workspace", () => {
  const OPEN = {
    id: REQUEST,
    kind: "paid",
    invoice_id: INVOICE,
    counterparty_id: CUSTOMER,
    link_id: OLD_LINK,
    paid_on: "2026-10-12",
    reference: "WIRE-2210",
    amount: "750.000000",
    promised_on: null,
    status: "open",
    outcome: null,
    created_at: "2026-10-12T10:00:00Z",
    closed_at: null,
  };

  it("reads open requests with their threads", async () => {
    const { fake, run } = workspace({ request: OPEN });
    const read = await run(() => readCustomerRequests(db(), { openOnly: true }));
    expect(read).toMatchObject({ available: true, requests: [{ id: REQUEST, kind: "paid", amount: 750, reference: "WIRE-2210", messages: [] }] });
    expect(fake.requests.find((request) => request.path === "/rest/v1/customer_requests")?.params.get("status")).toBe("eq.open");
  });

  it("reads no pause before migration 0109 runs", async () => {
    const { run } = workspace({ missing: true });
    expect(await run(() => readReminderPauses(db(), [INVOICE], "2026-10-13"))).toEqual(new Map());
  });

  it("replies under the request as the business, signed with the words' hash", async () => {
    const { fake, run } = workspace({ request: OPEN });
    expect(await run(() => replyToCustomer({ actorId: USER, requestId: REQUEST, body: "  We see it now.  " }))).toEqual({ customerName: "Acme Corp" });
    const [insert] = writes(fake.requests, "POST", "/rest/v1/customer_request_messages");
    expect(insert.body).toEqual({ org_id: ORG, request_id: REQUEST, body: "We see it now.", by: USER });
    const [, entry] = appendBestEffort.mock.calls[0] as unknown as [string, { action: string; detail: Row }];
    expect(entry.action).toBe("customer_request_replied");
    expect(entry.detail.textSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(entry)).not.toContain("We see it now");
  });

  it("refuses an empty reply and one to a closed request", async () => {
    const { run } = workspace({ request: OPEN });
    await expect(run(() => replyToCustomer({ actorId: USER, requestId: REQUEST, body: "  " }))).rejects.toMatchObject({ code: "empty" });
    const closed = workspace({ request: { ...OPEN, status: "closed", outcome: "resolved", closed_at: "2026-10-13T00:00:00Z" } });
    await expect(closed.run(() => replyToCustomer({ actorId: USER, requestId: REQUEST, body: "Hi" }))).rejects.toBeInstanceOf(CustomerRequestError);
  });

  it("closes a claim as not received, only while it is open, and signs it", async () => {
    const { fake, run } = workspace({ request: OPEN });
    expect(await run(() => closeCustomerRequest({ actorId: USER, requestId: REQUEST, outcome: "not_received" }))).toEqual({ customerName: "Acme Corp", kind: "paid" });
    const [patch] = writes(fake.requests, "PATCH", "/rest/v1/customer_requests");
    expect(patch.params.get("status")).toBe("eq.open");
    expect(patch.body).toMatchObject({ status: "closed", outcome: "not_received", closed_by: USER });
    expect(appendBestEffort).toHaveBeenCalledWith(ORG, expect.objectContaining({ action: "customer_request_closed", summary: "Closed Acme Corp's claim of payment (not received)" }));
  });

  it("refuses not received on anything but a claim of payment, and a close someone else made first", async () => {
    const dispute = workspace({ request: { ...OPEN, kind: "dispute", paid_on: null, reference: null, amount: null } });
    await expect(dispute.run(() => closeCustomerRequest({ actorId: USER, requestId: REQUEST, outcome: "not_received" }))).rejects.toMatchObject({ code: "outcome" });
    const raced = workspace({ request: OPEN, patch: { body: [] } });
    await expect(raced.run(() => closeCustomerRequest({ actorId: USER, requestId: REQUEST, outcome: "resolved" }))).rejects.toMatchObject({ code: "closed" });
  });
});
