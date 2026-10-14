import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExternalMatch } from "@/lib/connectors/connections";
import type { MasterKey } from "@/lib/secrets";
import { ensureWebhook, handlePipedriveUninstall, handlePipedriveWebhook, NUDGE_SYNC, reachable, verifyClientAuth, verifyWebhookAuth, webhookPassword } from "@/lib/pipedrive/webhooks";
import { API_DOMAIN, COMPANY_ID, fakePipedrive } from "./support/fake-pipedrive";

/**
 * Pipedrive's webhooks and its uninstall notice (docs/superpowers/specs/2026-10-14-pipedrive-connector-design.md P7):
 * Basic auth compared in constant time before anything is read, against every master key; an authenticated notice only
 * starts a sync of the company's connections after the answer, and its body is never used; the webhook made sure of once
 * per company, never twice.
 */

const KEY_NOW: MasterKey = { id: "k2", key: Buffer.alloc(32, 7) };
const KEY_BEFORE: MasterKey = { id: "k1", key: Buffer.alloc(32, 3) };
const COMPANY = String(COMPANY_ID);
const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
const ORIGIN = "https://www.vestiarion.xyz";
const HOST = new URL(API_DOMAIN).host;

function nudges() {
  const deferred: Array<() => Promise<void>> = [];
  const match: ExternalMatch = { orgId: "org-1", connectionId: "conn-pd", externalOrgId: COMPANY, status: "connected", nextSyncAfter: null };
  const findConnections = vi.fn(async (ids: string[]) => (ids.includes(COMPANY) ? [match] : []));
  const nudge = vi.fn(async () => undefined);
  return { deps: { defer: (work: () => Promise<void>) => deferred.push(work), findConnections, nudge }, deferred, findConnections, nudge, match };
}

function webhookRequest(authorization: string | null, body = '{"meta":{"action":"change","entity":"deal","entity_id":"42","company_id":"13013937"},"data":{"value":999999}}') {
  return new Request(`${ORIGIN}/api/integrations/pipedrive/webhook`, { method: "POST", headers: authorization ? { authorization, "content-type": "application/json" } : {}, body });
}

describe("the webhook's Basic auth", () => {
  it("is the company id and a password derived from the master key, different per company and per key", () => {
    expect(webhookPassword(COMPANY, KEY_NOW)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(webhookPassword(COMPANY, KEY_NOW)).not.toBe(webhookPassword("13013938", KEY_NOW));
    expect(webhookPassword(COMPANY, KEY_NOW)).not.toBe(webhookPassword(COMPANY, KEY_BEFORE));
  });

  it("verifies against every master key, so a rotation keeps the registered webhook working", () => {
    expect(verifyWebhookAuth(basic(COMPANY, webhookPassword(COMPANY, KEY_BEFORE)), [KEY_NOW, KEY_BEFORE])).toBe(COMPANY);
    expect(verifyWebhookAuth(basic(COMPANY, webhookPassword(COMPANY, KEY_NOW)), [KEY_NOW])).toBe(COMPANY);
    // Another company's password, a wrong one, a user that is not a company id, no auth at all.
    expect(verifyWebhookAuth(basic(COMPANY, webhookPassword("13013938", KEY_NOW)), [KEY_NOW])).toBeNull();
    expect(verifyWebhookAuth(basic(COMPANY, "guess"), [KEY_NOW])).toBeNull();
    expect(verifyWebhookAuth(basic("../admin", webhookPassword("../admin", KEY_NOW)), [KEY_NOW])).toBeNull();
    expect(verifyWebhookAuth(null, [KEY_NOW])).toBeNull();
    expect(verifyWebhookAuth(`Bearer ${webhookPassword(COMPANY, KEY_NOW)}`, [KEY_NOW])).toBeNull();
  });

  it("checks the uninstall notice against the app's own client id and secret", () => {
    const settings = { clientId: "b4d083d9216b7d0c", clientSecret: "client-secret-value" };
    expect(verifyClientAuth(basic(settings.clientId, settings.clientSecret), settings)).toBe(true);
    expect(verifyClientAuth(basic(settings.clientId, "wrong"), settings)).toBe(false);
    expect(verifyClientAuth(basic("other", settings.clientSecret), settings)).toBe(false);
    expect(verifyClientAuth(null, settings)).toBe(false);
  });
});

describe("POST /api/integrations/pipedrive/webhook", () => {
  it("refuses a notice without the right auth before anything is read, and nudges nothing", async () => {
    const { deps, deferred, findConnections } = nudges();
    const request = webhookRequest(basic(COMPANY, "guess"));
    const text = vi.spyOn(request, "text");
    const json = vi.spyOn(request, "json");
    const response = await handlePipedriveWebhook(request, { ...deps, keys: [KEY_NOW] });
    expect(response.status).toBe(401);
    expect(text).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
    expect(deferred).toHaveLength(0);
    expect(findConnections).not.toHaveBeenCalled();
    expect((await handlePipedriveWebhook(webhookRequest(null), { ...deps, keys: [KEY_NOW] })).status).toBe(401);
  });

  it("answers an authenticated notice at once, then syncs the company's connections, never using what the notice says", async () => {
    const { deps, deferred, findConnections, nudge, match } = nudges();
    const request = webhookRequest(basic(COMPANY, webhookPassword(COMPANY, KEY_NOW)));
    const json = vi.spyOn(request, "json");
    const response = await handlePipedriveWebhook(request, { ...deps, keys: [KEY_NOW] });
    expect(response.status).toBe(200);
    expect(nudge).not.toHaveBeenCalled();
    await deferred[0]();
    expect(findConnections).toHaveBeenCalledWith([COMPANY]);
    expect(nudge).toHaveBeenCalledWith(match);
    // The body (its deal, its value) is never read.
    expect(json).not.toHaveBeenCalled();
  });

  it("leaves a connection waiting out a rate limit or needing a reconnect alone", async () => {
    const { deps, deferred, nudge } = nudges();
    deps.findConnections.mockResolvedValueOnce([
      { orgId: "org-1", connectionId: "a", externalOrgId: COMPANY, status: "connected", nextSyncAfter: "2999-01-01T00:00:00.000Z" },
      { orgId: "org-2", connectionId: "b", externalOrgId: COMPANY, status: "needs_reconnect", nextSyncAfter: null },
    ]);
    await handlePipedriveWebhook(webhookRequest(basic(COMPANY, webhookPassword(COMPANY, KEY_NOW))), { ...deps, keys: [KEY_NOW] });
    await deferred[0]();
    expect(nudge).not.toHaveBeenCalled();
  });

  it("refuses a body too large to be one event, unread", async () => {
    const { deps } = nudges();
    const request = new Request(`${ORIGIN}/api/integrations/pipedrive/webhook`, { method: "POST", headers: { "content-length": "999999999", authorization: basic(COMPANY, webhookPassword(COMPANY, KEY_NOW)) }, body: "{}" });
    expect((await handlePipedriveWebhook(request, { ...deps, keys: [KEY_NOW] })).status).toBe(413);
  });

  it("starts a sync of what changed, never a read of every kept deal by id: one notice per deal change stays cheap", () => {
    expect(NUDGE_SYNC).toEqual({ maxPages: 5, recheck: false });
    // The route runs each nudge with it (`tests/pipedrive-sync.test.ts` runs a sync with it against Pipedrive).
    const route = readFileSync(path.join(process.cwd(), "src/app/api/integrations/pipedrive/webhook/route.ts"), "utf8");
    expect(route).toContain("crmSyncInScope(match.connectionId, provider, NUDGE_SYNC)");
  });
});

describe("DELETE /api/integrations/pipedrive/callback: the uninstall notice", () => {
  const settings = { clientId: "b4d083d9216b7d0c", clientSecret: "client-secret-value" };
  const notice = (authorization: string | null, body: unknown = { client_id: settings.clientId, company_id: COMPANY_ID, user_id: 7001, timestamp: "2026-10-14T10:00:00Z" }) =>
    new Request(`${ORIGIN}/api/integrations/pipedrive/callback`, { method: "DELETE", headers: authorization ? { authorization } : {}, body: JSON.stringify(body) });

  it("nudges the company's connections, so the next refresh finds the app gone and asks for a reconnect", async () => {
    const { deps, deferred, nudge, match } = nudges();
    expect((await handlePipedriveUninstall(notice(basic(settings.clientId, settings.clientSecret)), { ...deps, settings })).status).toBe(200);
    await deferred[0]();
    expect(nudge).toHaveBeenCalledWith(match);
  });

  it("refuses a notice without the app's credentials, or naming no company", async () => {
    const { deps, deferred } = nudges();
    expect((await handlePipedriveUninstall(notice(basic(settings.clientId, "wrong")), { ...deps, settings })).status).toBe(401);
    expect((await handlePipedriveUninstall(notice(basic(settings.clientId, settings.clientSecret), { company_id: "x" }), { ...deps, settings })).status).toBe(400);
    expect(deferred).toHaveLength(0);
  });
});

describe("ensureWebhook", () => {
  const credential = `pd1|${HOST}|v1u:access-a`;

  it("registers one webhook for the company's deals, with its Basic auth, and keeps it the next time", async () => {
    const fake = fakePipedrive();
    expect(await ensureWebhook({ credential, companyId: COMPANY, origin: ORIGIN, keys: [KEY_NOW] }, { fetchImpl: fake.fetchImpl })).toBe("registered");
    expect(fake.webhooks).toHaveLength(1);
    expect(fake.webhooks[0]).toMatchObject({
      subscription_url: `${ORIGIN}/api/integrations/pipedrive/webhook`,
      event_action: "*",
      event_object: "deal",
      version: "2.0",
      http_auth_user: COMPANY,
      http_auth_password: webhookPassword(COMPANY, KEY_NOW),
    });
    expect(await ensureWebhook({ credential, companyId: COMPANY, origin: ORIGIN, keys: [KEY_NOW] }, { fetchImpl: fake.fetchImpl })).toBe("present");
    expect(fake.webhooks).toHaveLength(1);
  });

  it("removes another of Vestiarion's webhooks to the same address, and makes none from a deployment Pipedrive cannot reach", async () => {
    const fake = fakePipedrive();
    fake.webhooks.push({ id: 5, subscription_url: `${ORIGIN}/api/integrations/pipedrive/webhook`, event_object: "deal", http_auth_user: "999", is_active: 1 });
    fake.webhooks.push({ id: 6, subscription_url: "https://elsewhere.example/hook", event_object: "deal", http_auth_user: "x", is_active: 1 });
    expect(await ensureWebhook({ credential, companyId: COMPANY, origin: ORIGIN, keys: [KEY_NOW] }, { fetchImpl: fake.fetchImpl })).toBe("registered");
    expect(fake.webhooks.map((hook) => hook.subscription_url)).toEqual(["https://elsewhere.example/hook", `${ORIGIN}/api/integrations/pipedrive/webhook`]);
    expect(fake.webhooks[1]).toMatchObject({ http_auth_user: COMPANY });
    expect(reachable("http://localhost:3000")).toBe(false);
    expect(reachable("https://app.localhost")).toBe(false);
    expect(await ensureWebhook({ credential, companyId: COMPANY, origin: "http://localhost:3000", keys: [KEY_NOW] }, { fetchImpl: fake.fetchImpl })).toBe("skipped");
  });

  it("says Pipedrive refused it, never throws for that: the sweeper reads every 15 minutes anyway", async () => {
    const fake = fakePipedrive();
    fake.state.webhooksRefused = true;
    expect(await ensureWebhook({ credential, companyId: COMPANY, origin: ORIGIN, keys: [KEY_NOW] }, { fetchImpl: fake.fetchImpl })).toBe("refused");
  });
});
