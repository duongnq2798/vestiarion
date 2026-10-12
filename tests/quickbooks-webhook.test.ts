import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/integrations/quickbooks/webhook/route";
import { NotSetUpError, type ExternalMatch } from "@/lib/connectors/connections";
import { handleQuickBooksWebhook, readEvents, realmsToNudge, verifyIntuitSignature, type WebhookDeps } from "@/lib/quickbooks/webhook";

/**
 * QuickBooks' webhook (docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md Q11): the signature checked
 * against the raw body before anything is read; a CloudEvents array of several events, for several companies, read
 * for the companies whose bills, bill payments or vendors changed; each matched connection nudged into one sync after
 * the answer, unless it is not connected or is waiting out a rate limit; an unknown company answered and left alone;
 * a replay nudging again, which a sync makes harmless; nothing trusted from the payload but which company changed.
 */

vi.mock("server-only", () => ({}));

const TOKEN = "verifier-token-from-the-developer-portal";
const NOW = Date.parse("2026-10-12T10:00:00.000Z");
const REALM = "9341455327810551";
const OTHER_REALM = "123145812345678";

const sign = (body: string, token = TOKEN) => crypto.createHmac("sha256", token).update(body, "utf8").digest("base64");

const event = (type: string, realm: string, id = crypto.randomUUID()) => ({
  specversion: "1.0",
  id,
  source: "intuit.dsnBgbseACLLRZNxo2dfc4evmEJdxde58xeeYcZliOU=",
  type,
  datacontenttype: "application/json",
  time: "2026-10-12T09:59:58.179Z",
  intuitentityid: "146",
  intuitaccountid: realm,
  data: {},
});

function notification(body: string, signature: string | null = sign(body)): Request {
  return new Request("https://www.vestiarion.xyz/api/integrations/quickbooks/webhook", {
    method: "POST",
    headers: { "content-type": "application/cloudevents+json", ...(signature !== null ? { "intuit-signature": signature } : {}) },
    body,
  });
}

const match = (fields: Partial<ExternalMatch> = {}): ExternalMatch => ({
  orgId: "0b6c1c9e-4a4f-4a7e-9b1e-000000000f01",
  connectionId: "conn-1",
  externalOrgId: REALM,
  status: "connected",
  nextSyncAfter: null,
  ...fields,
});

function harness(found: ExternalMatch[] | Error = []) {
  const deferred: Array<() => Promise<void>> = [];
  const findConnections = vi.fn(async (realms: string[]) => {
    void realms;
    if (found instanceof Error) throw found;
    return found;
  });
  const nudge = vi.fn(async (nudged: ExternalMatch) => {
    void nudged;
    return { outcome: "synced" };
  });
  const deps: WebhookDeps = { verifierToken: TOKEN, defer: (work) => deferred.push(work), findConnections, nudge, now: () => NOW };
  const drain = async () => {
    for (const work of deferred.splice(0)) await work();
  };
  return { deps, deferred, findConnections, nudge, drain };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("verifyIntuitSignature", () => {
  it("takes Intuit's base64 HMAC-SHA256 of the exact body, and nothing else", () => {
    const body = JSON.stringify([event("qbo.bill.created.v1", REALM)]);
    expect(verifyIntuitSignature(TOKEN, body, sign(body))).toBe(true);
    expect(verifyIntuitSignature(TOKEN, `${body} `, sign(body))).toBe(false);
    expect(verifyIntuitSignature(TOKEN, body, sign(body, "another-token"))).toBe(false);
    expect(verifyIntuitSignature(TOKEN, body, crypto.createHmac("sha256", TOKEN).update(body).digest("hex"))).toBe(false);
    expect(verifyIntuitSignature(TOKEN, body, "")).toBe(false);
    expect(verifyIntuitSignature(TOKEN, body, null)).toBe(false);
  });
});

describe("readEvents", () => {
  it("reads which company and which kind of record from each event, and nothing else", () => {
    const body = JSON.stringify([event("qbo.bill.created.v1", REALM), event("qbo.BillPayment.updated.v1", OTHER_REALM), event("qbo.customer.merged.v1", REALM)]);
    expect(readEvents(body)).toEqual([
      { realmId: REALM, entity: "bill" },
      { realmId: OTHER_REALM, entity: "billpayment" },
      { realmId: REALM, entity: "customer" },
    ]);
  });

  it("reads one object as an array of one, and leaves out an event it cannot read", () => {
    expect(readEvents(JSON.stringify(event("qbo.vendor.deleted.v1", REALM)))).toEqual([{ realmId: REALM, entity: "vendor" }]);
    expect(readEvents(JSON.stringify([{ type: "qbo.bill.created.v1", intuitaccountid: "../1" }, { type: "something", intuitaccountid: REALM }, 7]))).toEqual([]);
    expect(readEvents("not json")).toBeNull();
  });

  it("nudges for bills, bill payments and vendors only, each company once", () => {
    expect(
      realmsToNudge([
        { realmId: REALM, entity: "bill" },
        { realmId: REALM, entity: "vendor" },
        { realmId: OTHER_REALM, entity: "invoice" },
        { realmId: "555", entity: "billpayment" },
        { realmId: "777", entity: "account" },
      ])
    ).toEqual([REALM, "555"]);
  });
});

describe("handleQuickBooksWebhook", () => {
  it("refuses a missing or wrong signature with 401, before reading anything", async () => {
    const { deps, deferred, findConnections } = harness([match()]);
    const body = JSON.stringify([event("qbo.bill.updated.v1", REALM)]);
    const wrong = await handleQuickBooksWebhook(notification(body, sign(body, "not-the-token")), deps);
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "invalid_signature" });
    expect((await handleQuickBooksWebhook(notification(body, null), deps)).status).toBe(401);
    expect(deferred).toHaveLength(0);
    expect(findConnections).not.toHaveBeenCalled();
  });

  it("answers at once, then nudges the company's connection into one sync", async () => {
    const { deps, deferred, findConnections, nudge, drain } = harness([match()]);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const body = JSON.stringify([event("qbo.bill.created.v1", REALM)]);
    const response = await handleQuickBooksWebhook(notification(body), deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: 1 });
    // Nothing is read or synced before the answer.
    expect(findConnections).not.toHaveBeenCalled();
    expect(deferred).toHaveLength(1);
    await drain();
    expect(findConnections).toHaveBeenCalledWith([REALM]);
    expect(nudge).toHaveBeenCalledTimes(1);
    expect(nudge).toHaveBeenCalledWith(match());
    expect(JSON.stringify(info.mock.calls)).not.toContain(REALM);
  });

  it("reads a CloudEvents array of several events and companies: each company once, other entities ignored", async () => {
    const connections = [
      match({ connectionId: "conn-1" }),
      match({ connectionId: "conn-2", externalOrgId: OTHER_REALM, orgId: "0b6c1c9e-4a4f-4a7e-9b1e-000000000f02" }),
    ];
    const { deps, findConnections, nudge, drain } = harness(connections);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const body = JSON.stringify([
      event("qbo.bill.created.v1", REALM),
      event("qbo.bill.updated.v1", REALM),
      event("qbo.billpayment.created.v1", OTHER_REALM),
      event("qbo.invoice.created.v1", "555"),
      event("qbo.customer.updated.v1", "555"),
    ]);
    const response = await handleQuickBooksWebhook(notification(body), deps);
    expect(await response.json()).toEqual({ received: 5 });
    await drain();
    expect(findConnections).toHaveBeenCalledTimes(1);
    expect(findConnections).toHaveBeenCalledWith([REALM, OTHER_REALM]);
    expect(nudge.mock.calls.map(([nudged]) => nudged.connectionId)).toEqual(["conn-1", "conn-2"]);
  });

  it("answers a company no workspace has connected, and does nothing more", async () => {
    const { deps, nudge, drain } = harness([]);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const body = JSON.stringify([event("qbo.bill.created.v1", "4620816365272840290")]);
    expect((await handleQuickBooksWebhook(notification(body), deps)).status).toBe(200);
    await drain();
    expect(nudge).not.toHaveBeenCalled();
  });

  it("starts nothing for entities that do not bear on bills", async () => {
    const { deps, deferred } = harness([match()]);
    const body = JSON.stringify([event("qbo.customer.created.v1", REALM), event("qbo.account.updated.v1", REALM)]);
    const response = await handleQuickBooksWebhook(notification(body), deps);
    expect(await response.json()).toEqual({ received: 2 });
    expect(deferred).toHaveLength(0);
  });

  it("leaves a connection that needs reconnecting, or is waiting out a rate limit, to its own time", async () => {
    const { deps, nudge, drain } = harness([
      match({ connectionId: "waiting", nextSyncAfter: "2026-10-12T10:05:00.000Z" }),
      match({ connectionId: "reconnect", status: "needs_reconnect" }),
      match({ connectionId: "due", nextSyncAfter: "2026-10-12T09:59:00.000Z" }),
    ]);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    await handleQuickBooksWebhook(notification(JSON.stringify([event("qbo.bill.updated.v1", REALM)])), deps);
    await drain();
    expect(nudge.mock.calls.map(([nudged]) => nudged.connectionId)).toEqual(["due"]);
  });

  it("nudges again for a replayed notification, which the sync's version check makes harmless", async () => {
    const { deps, nudge, drain } = harness([match()]);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const body = JSON.stringify([event("qbo.bill.updated.v1", REALM, "88cd52aa-33b6-4351-9aa4-47572edbd068")]);
    expect((await handleQuickBooksWebhook(notification(body), deps)).status).toBe(200);
    expect((await handleQuickBooksWebhook(notification(body), deps)).status).toBe(200);
    await drain();
    expect(nudge).toHaveBeenCalledTimes(2);
  });

  it("does nothing before migration 0102, and survives a sync that throws", async () => {
    const notSetUp = harness(new NotSetUpError());
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const body = JSON.stringify([event("qbo.bill.updated.v1", REALM)]);
    expect((await handleQuickBooksWebhook(notification(body), notSetUp.deps)).status).toBe(200);
    await notSetUp.drain();
    expect(notSetUp.nudge).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    const failing = harness([match({ connectionId: "conn-1" }), match({ connectionId: "conn-2" })]);
    failing.nudge.mockRejectedValueOnce(new Error("boom"));
    await handleQuickBooksWebhook(notification(body), failing.deps);
    await failing.drain();
    expect(failing.nudge).toHaveBeenCalledTimes(2);
  });

  it("refuses a body over 1 MB, and a signed body that is not JSON", async () => {
    const { deps } = harness();
    const huge = "x".repeat(1_000_001);
    expect((await handleQuickBooksWebhook(notification(huge), deps)).status).toBe(413);
    expect((await handleQuickBooksWebhook(notification("not json"), deps)).status).toBe(400);
  });
});

describe("POST /api/integrations/quickbooks/webhook", () => {
  it("is not there without the app and its verifier token", async () => {
    vi.stubEnv("QUICKBOOKS_CLIENT_ID", "");
    vi.stubEnv("QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN", TOKEN);
    expect((await POST(notification("[]"))).status).toBe(404);
    vi.stubEnv("QUICKBOOKS_CLIENT_ID", "ABcdEFghIJklMNopQRstUVwxYZ0123456789abcdefghijklmn");
    vi.stubEnv("QUICKBOOKS_CLIENT_SECRET", "s");
    vi.stubEnv("QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN", "");
    expect((await POST(notification("[]"))).status).toBe(404);
  });

  it("refuses an unsigned notification once it is set up", async () => {
    vi.stubEnv("QUICKBOOKS_CLIENT_ID", "ABcdEFghIJklMNopQRstUVwxYZ0123456789abcdefghijklmn");
    vi.stubEnv("QUICKBOOKS_CLIENT_SECRET", "s");
    vi.stubEnv("QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN", TOKEN);
    expect((await POST(notification("[]", "bad"))).status).toBe(401);
    expect((await POST(notification("[]"))).status).toBe(200);
  });
});
