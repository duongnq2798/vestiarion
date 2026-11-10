import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { deliveryOf, EXP_LEEWAY_S, handleJiraWebhook, MAX_BODY_BYTES, selfOf, verifyJiraToken, type JiraWebhookDeps } from "@/lib/jira/webhook";

/**
 * Jira's webhook deliveries (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR15): the bearer token is
 * checked before the body is read, as an HMAC under the client secret by HS256, HS384 or HS512 only, compared in
 * constant time, with an exp at most 300 seconds past and an nbf at most 300 seconds ahead; a failure answers 401 and
 * reads nothing. A signed delivery is answered exactly 200, of any age, and only after the answer is the one issue it
 * names read again. Nothing in the body is used but the event, the webhooks it matched, the issue's id, its address and
 * when it was sent.
 */

const SECRET = "ATOAx-client-secret-of-the-app-Zr9q";
const NOW = Date.parse("2026-11-09T08:00:00.000Z");
const NOW_S = NOW / 1000;
const CLOUD = "11223344-a1b2-4b33-8c44-def123456789";
const URL_ = "https://www.vestiarion.xyz/api/integrations/jira/webhook";

const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** A token as Jira signs one: `header.payload.signature`, the HMAC under the secret by the header's algorithm. */
function token(claims: Record<string, unknown> = { iss: "jira", iat: NOW_S - 5, exp: NOW_S + 175 }, options: { alg?: string; secret?: string; header?: Record<string, unknown> } = {}) {
  const alg = options.alg ?? "HS256";
  const header = part(options.header ?? { alg, typ: "JWT" });
  const payload = part(claims);
  const hash = { HS256: "sha256", HS384: "sha384", HS512: "sha512" }[alg] ?? "sha256";
  const signature = crypto.createHmac(hash, options.secret ?? SECRET).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

const issueEvent = (fields: Record<string, unknown> = {}) => ({
  timestamp: NOW - 1_000,
  webhookEvent: "jira:issue_updated",
  issue_event_type_name: "issue_generic",
  matchedWebhookIds: [1001],
  user: { accountId: "557058:f58131cb-b67d-43c7-b30d-6b58d40bd077", displayName: "Mai Tran", emailAddress: "mai@contractor.example" },
  // What Jira says changed is never believed: the issue is read again through the API.
  issue: {
    id: "10042",
    key: "ENG-142",
    self: `https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/issue/10042`,
    fields: { status: { name: "Done", statusCategory: { key: "done" } }, resolution: { name: "Done" }, summary: "Webhook retries with backoff" },
  },
  changelog: { id: "10500", items: [{ field: "status", fromString: "In Progress", toString: "Done" }] },
  ...fields,
});

function delivery(body: unknown, headers: Record<string, string> = {}, raw = JSON.stringify(body)) {
  return new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token()}`, "x-atlassian-webhook-identifier": "c2e8f3b1", "x-atlassian-webhook-flow": "Primary", ...headers },
    body: raw,
  });
}

function deps(over: Partial<JiraWebhookDeps> = {}) {
  const deferred: Array<() => Promise<void>> = [];
  const reread = vi.fn(async () => 1);
  const value: JiraWebhookDeps = { secret: SECRET, defer: (work) => void deferred.push(work), reread, now: () => NOW, ...over };
  return { value, deferred, reread, flush: async () => Promise.all(deferred.map((work) => work())) };
}

describe("the delivery's token (Jira acceptance JR15)", () => {
  let info: MockInstance<typeof console.info>;
  let warn: MockInstance<typeof console.warn>;
  beforeEach(() => {
    info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    info.mockRestore();
    warn.mockRestore();
  });
  const check = (value: string | null, now = NOW) => verifyJiraToken(SECRET, value, now);

  it("is an HMAC under the client secret by HS256, HS384 or HS512, with no claim required", () => {
    for (const alg of ["HS256", "HS384", "HS512"]) expect(check(`Bearer ${token(undefined, { alg })}`), alg).toMatchObject({ ok: true });
    expect(check(`bearer   ${token()}`)).toMatchObject({ ok: true });
    expect(check(`Bearer ${token({})}`)).toEqual({ ok: true, claims: [] });
  });

  it("refuses none, RS256, ES256 and no algorithm, so no other algorithm passes for one keyed by the secret", () => {
    const unsigned = `${part({ alg: "none", typ: "JWT" })}.${part({ iss: "jira" })}.`;
    expect(check(`Bearer ${unsigned}`)).toMatchObject({ ok: false, reason: "malformed" });
    expect(check(`Bearer ${unsigned}c2ln`)).toMatchObject({ ok: false, reason: "algorithm" });
    for (const header of [{ alg: "RS256" }, { alg: "ES256" }, { typ: "JWT" }, { alg: "hs256" }, { alg: "toString" }]) {
      // Signed with the secret as though it were an HMAC key: still refused by its algorithm.
      expect(check(`Bearer ${token(undefined, { header })}`), JSON.stringify(header)).toMatchObject({ ok: false, reason: "algorithm" });
    }
  });

  it("refuses another secret, a changed header or payload, and a signature cut short, comparing in constant time", () => {
    expect(check(`Bearer ${token(undefined, { secret: "another-secret" })}`)).toMatchObject({ ok: false, reason: "signature" });
    const [header, payload, signature] = token().split(".");
    expect(check(`Bearer ${part({ alg: "HS256", typ: "JWT", kid: "x" })}.${payload}.${signature}`)).toMatchObject({ ok: false, reason: "signature" });
    expect(check(`Bearer ${header}.${part({ iss: "jira", exp: NOW_S + 999 })}.${signature}`)).toMatchObject({ ok: false, reason: "signature" });
    expect(check(`Bearer ${header}.${payload}.${signature.slice(0, -2)}`)).toMatchObject({ ok: false, reason: "signature" });
    expect(verifyJiraToken("", `Bearer ${token(undefined, { secret: "" })}`, NOW)).toMatchObject({ ok: false, reason: "signature" });
    expect(readFileSync("src/lib/jira/webhook.ts", "utf8")).toMatch(/crypto\.timingSafeEqual\(actual, expected\)/);
  });

  it("takes an exp up to 300 seconds past, a token with none, and refuses an nbf more than 300 seconds ahead", () => {
    expect(EXP_LEEWAY_S).toBe(300);
    expect(check(`Bearer ${token({ exp: NOW_S - 299 })}`)).toMatchObject({ ok: true });
    expect(check(`Bearer ${token({ exp: NOW_S - 301 })}`)).toEqual({ ok: false, reason: "expired", secondsPastExp: 301 });
    expect(check(`Bearer ${token({ iss: "jira" })}`)).toMatchObject({ ok: true });
    expect(check(`Bearer ${token({ nbf: NOW_S + 299 })}`)).toMatchObject({ ok: true });
    expect(check(`Bearer ${token({ nbf: NOW_S + 301 })}`)).toMatchObject({ ok: false, reason: "not_yet_valid" });
    expect(check(`Bearer ${token({ exp: "tomorrow" })}`)).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("refuses a token that is not one: no scheme, two parts or four, characters outside base64url, over 4,096 characters, a header that is not JSON", () => {
    const good = token();
    for (const value of [
      null,
      "",
      good,
      `Basic ${good}`,
      `Bearer ${good.split(".").slice(0, 2).join(".")}`,
      `Bearer ${good}.extra`,
      `Bearer ${good.replace(".", ".+")}`,
      `Bearer ${good} ${good}`,
      `Bearer ${token({ pad: "x".repeat(4_000) })}`,
      `Bearer ${Buffer.from("not json").toString("base64url")}.${good.split(".")[1]}.${good.split(".")[2]}`,
    ]) {
      expect(check(value), String(value).slice(0, 40)).toMatchObject({ ok: false });
    }
  });

  it("logs the claims' names once a process, never their values or the token", async () => {
    vi.resetModules();
    const fresh = await import("@/lib/jira/webhook");
    const signed = token({ iss: "jira:6c1f0f6e-1a01", iat: NOW_S - 5, exp: NOW_S + 175, qsh: "context-qsh" });
    expect(fresh.verifyJiraToken(SECRET, `Bearer ${signed}`, NOW)).toEqual({ ok: true, claims: ["exp", "iat", "iss", "qsh"] });
    fresh.verifyJiraToken(SECRET, `Bearer ${signed}`, NOW);
    fresh.verifyJiraToken(SECRET, `Bearer ${token({ iss: "jira:6c1f0f6e-1a01", exp: NOW_S + 100, qsh: "x", iat: NOW_S })}`, NOW);
    expect(info.mock.calls).toEqual([["jira webhook: a delivery's token claims", "exp,iat,iss,qsh"]]);
    fresh.verifyJiraToken(SECRET, `Bearer ${token(undefined, { header: { alg: "RS256" } })}`, NOW);
    fresh.verifyJiraToken(SECRET, `Bearer ${token(undefined, { header: { alg: "RS256" } })}`, NOW);
    expect(warn.mock.calls).toEqual([["jira webhook: a token with an algorithm that is not taken", "RS256"]]);
    const logged = JSON.stringify([info.mock.calls, warn.mock.calls]);
    expect(logged).not.toContain("6c1f0f6e");
    expect(logged).not.toContain("context-qsh");
    expect(logged).not.toContain(signed.split(".")[2]);
  });
});

describe("what a delivery is read for", () => {
  it("is the event, the webhooks it matched, the issue's numeric id, its address and when it was sent", () => {
    expect(deliveryOf(issueEvent())).toEqual({
      kind: "issue",
      event: "jira:issue_updated",
      webhookIds: [1001],
      issueId: "10042",
      self: { cloudId: CLOUD },
      timestamp: NOW - 1_000,
    });
    for (const event of ["jira:issue_deleted", "comment_created", "comment_updated", "comment_deleted"]) {
      expect(deliveryOf(issueEvent({ webhookEvent: event, comment: { id: "10200", body: "https://evil.example" } })), event).toMatchObject({ kind: "issue", event, issueId: "10042" });
    }
    expect(deliveryOf(issueEvent({ matchedWebhookIds: [1001, 1002, 1001], timestamp: undefined }))).toMatchObject({ webhookIds: [1001, 1002], timestamp: null });
  });

  it("ignores another event, other shapes, and more than 20 webhook ids", () => {
    for (const body of [
      issueEvent({ webhookEvent: "jira:issue_created" }),
      issueEvent({ webhookEvent: "project_updated" }),
      issueEvent({ webhookEvent: undefined }),
      issueEvent({ matchedWebhookIds: [] }),
      issueEvent({ matchedWebhookIds: Array.from({ length: 21 }, (_, index) => index + 1) }),
      issueEvent({ matchedWebhookIds: ["1001"] }),
      issueEvent({ matchedWebhookIds: [0] }),
      issueEvent({ matchedWebhookIds: [1.5] }),
      issueEvent({ matchedWebhookIds: 1001 }),
      issueEvent({ issue: { id: 10042 } }),
      issueEvent({ issue: { id: "ENG-142" } }),
      issueEvent({ issue: { id: "1".repeat(19) } }),
      issueEvent({ issue: undefined }),
    ]) {
      expect(deliveryOf(body), JSON.stringify(body).slice(0, 80)).toEqual({ kind: "ignored" });
    }
    expect(deliveryOf(issueEvent({ matchedWebhookIds: Array.from({ length: 20 }, (_, index) => index + 1) }))).toMatchObject({ kind: "issue" });
  });

  it("reads both forms of the issue's address for its site alone, and nothing else as one", () => {
    expect(selfOf(`https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/issue/10042`)).toEqual({ cloudId: CLOUD });
    expect(selfOf(`https://api.atlassian.com/ex/jira/${CLOUD.toUpperCase()}/rest/api/2/issue/10042`)).toEqual({ cloudId: CLOUD });
    expect(selfOf("https://Northstar.atlassian.net/rest/api/2/issue/10042")).toEqual({ host: "northstar.atlassian.net" });
    expect(selfOf("https://northstar.atlassian.net/rest/api/3/issue/10042")).toEqual({ host: "northstar.atlassian.net" });
    for (const value of [
      "https://api.atlassian.com/ex/jira/not-a-cloud/rest/api/3/issue/10042",
      "https://northstar.atlassian.net/browse/ENG-142",
      "https://northstar.atlassian.net/rest/api/3/issue/ENG-142",
      "http://northstar.atlassian.net/rest/api/2/issue/10042",
      "https://northstar.atlassian.net:8443/rest/api/2/issue/10042",
      "not a url",
      42,
      null,
    ]) {
      expect(selfOf(value), String(value)).toBeNull();
    }
    expect(deliveryOf(issueEvent({ issue: { id: "10042", self: "https://northstar.atlassian.net/browse/ENG-142" } }))).toMatchObject({ kind: "issue", self: null });
  });

  it("never reads the issue's fields, the change list or the person who made the change", () => {
    const source = readFileSync("src/lib/jira/webhook.ts", "utf8");
    expect(source).not.toMatch(/\bfields\b/);
    expect(source).not.toMatch(/changelog/i);
    expect(source).not.toMatch(/\buser\b/i);
    expect(source).not.toMatch(/\bkey\b\s*[:,]|\.key\b/);
  });
});

describe("a delivery", () => {
  let warn: MockInstance<typeof console.warn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("is answered exactly 200 at once, and the issue it names is read again only after the answer", async () => {
    const d = deps();
    const response = await handleJiraWebhook(delivery(issueEvent()), d.value);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(d.reread).not.toHaveBeenCalled();
    await d.flush();
    expect(d.reread).toHaveBeenCalledWith({ event: "jira:issue_updated", webhookIds: [1001], issueId: "10042", self: { cloudId: CLOUD }, timestamp: NOW - 1_000 });
  });

  it("is read however old it is: Jira tries again 5 to 15 minutes later, and never after a 401", async () => {
    const d = deps();
    const old = issueEvent({ timestamp: NOW - 20 * 60_000 });
    expect((await handleJiraWebhook(delivery(old, { authorization: `Bearer ${token({ exp: NOW_S - 120 })}` }), d.value)).status).toBe(200);
    await d.flush();
    expect(d.reread).toHaveBeenCalledTimes(1);
  });

  it("answers 200 and reads nothing for an event it does not read", async () => {
    const d = deps();
    expect((await handleJiraWebhook(delivery(issueEvent({ webhookEvent: "jira:issue_created" })), d.value)).status).toBe(200);
    expect(d.deferred).toHaveLength(0);
  });

  it("answers 401 before its body is read, for a token that is missing, wrong or expired, logging Jira's retry headers and never the token", async () => {
    const bad = token({ exp: NOW_S - 900 });
    for (const [name, authorization] of [
      ["no token", ""],
      ["another secret", `Bearer ${token(undefined, { secret: "another-secret" })}`],
      ["expired", `Bearer ${bad}`],
    ]) {
      let pulled = false;
      const body = new ReadableStream<Uint8Array>(
        {
          pull() {
            pulled = true;
            throw new Error("the body was read");
          },
        },
        { highWaterMark: 0 }
      );
      const request = new Request(URL_, { method: "POST", headers: { authorization, "x-atlassian-webhook-retry": "2", "x-atlassian-webhook-flow": "Secondary" }, body, duplex: "half" } as RequestInit);
      const d = deps();
      expect((await handleJiraWebhook(request, d.value)).status, name).toBe(401);
      expect(pulled, name).toBe(false);
      expect(d.deferred, name).toHaveLength(0);
    }
    expect(warn).toHaveBeenCalledWith("jira webhook: a delivery was refused", "expired", { retry: "2", flow: "Secondary", secondsPastExp: 900 });
    expect(warn).toHaveBeenCalledWith("jira webhook: a delivery was refused", "missing", { retry: "2", flow: "Secondary" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(bad.split(".")[2]);
  });

  it("answers 401 for a signed body that is not one JSON object", async () => {
    for (const raw of ["not json", "[1,2]", "null"]) {
      const d = deps();
      expect((await handleJiraWebhook(delivery({}, {}, raw), d.value)).status, raw).toBe(401);
      expect(d.deferred).toHaveLength(0);
    }
  });

  it("answers 413 for a body over 4,000,000 bytes, declared or sent, once its token is good", async () => {
    expect(MAX_BODY_BYTES).toBe(4_000_000);
    const declared = new Request(URL_, { method: "POST", headers: { authorization: `Bearer ${token()}`, "content-length": String(MAX_BODY_BYTES + 1) }, body: "{}" });
    expect((await handleJiraWebhook(declared, deps().value)).status).toBe(413);
    const sent = delivery({}, {}, JSON.stringify({ ...issueEvent(), pad: "x".repeat(MAX_BODY_BYTES) }));
    expect((await handleJiraWebhook(sent, deps().value)).status).toBe(413);
    // A token that fails comes first, whatever the size.
    expect((await handleJiraWebhook(new Request(URL_, { method: "POST", headers: { "content-length": String(MAX_BODY_BYTES + 1) }, body: "{}" }), deps().value)).status).toBe(401);
  });

  it("logs a read that failed after the answer by its error's name, with no detail from the body", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const d = deps({ reread: vi.fn(async () => Promise.reject(new TypeError("token for 10042"))) });
    expect((await handleJiraWebhook(delivery(issueEvent()), d.value)).status).toBe(200);
    await d.flush();
    expect(error).toHaveBeenCalledWith("jira webhook: the issue was not read again", "TypeError");
  });
});

describe("the route", () => {
  it("checks each delivery with the client secret, and reads again only after the answer, in every workspace it matched (JR15)", () => {
    const route = readFileSync("src/app/api/integrations/jira/webhook/route.ts", "utf8");
    expect(route).toContain("secret: settings.clientSecret,");
    expect(route).toContain("defer: (work) => after(work),");
    expect(route).toContain("reread: (event) => rereadForDelivery(event, provider),");
    expect(route).toContain("export const maxDuration = 60;");
    // Not there unless Jira is configured (JR1): no third variable, the deliveries are signed with the client secret.
    expect(route).toMatch(/const settings = jiraSettingsFromEnv\(\);\s*if \(!settings\) return Response\.json\(\{ error: "not_found" \}, \{ status: 404 \}\);/);
    expect(route).not.toMatch(/JIRA_WEBHOOK|webhookSecret/);
  });
});
