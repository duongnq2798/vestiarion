import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ConnectRefusal } from "@/lib/connectors/connect-refusal";
import { CONSENT_HISTORY, CONSENT_VERSIONS } from "@/lib/connectors/consent";
import { ProviderError } from "@/lib/connectors/provider";
import type { StoredTokens, TokenStore } from "@/lib/connectors/tokens";
import { ATTACHMENTS_READ, COMMENTS_READ, ISSUE_FULL_FIELDS, ISSUE_STATUS_FIELDS, issuePathOf, jiraReader, REMOTE_LINKS_READ } from "@/lib/jira/api";
import {
  apiUrl,
  failureOf,
  ISSUE_JSON_BYTES,
  JIRA_API_HOST,
  JIRA_AUTH_HOST,
  JIRA_AUTHORIZE,
  JIRA_LOGIN,
  JIRA_RESOURCES,
  JIRA_TOKEN,
  jiraFetch,
  jsonOf,
  pausedUntil,
  waitOf,
  type JiraPause,
} from "@/lib/jira/http";
import { authorizeUrl, exchangeCode, grantSites, refreshTokens, revokeToken } from "@/lib/jira/oauth";
import { jiraProvider } from "@/lib/jira/provider";
import { JiraAccessError, jiraSession } from "@/lib/jira/session";
import { JIRA_SCOPES, SCOPES_BY_CONSENT } from "@/lib/jira/settings";
import { desiredJql, JIRA_EVENTS, jiraWebhookApi, refusalWords } from "@/lib/jira/webhooks";

/**
 * Jira's settings, scopes and addresses, and Jira over HTTP (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md
 * JR1 to JR4, JR8, JR12, JR14, JR16, JR17): Jira is on only with both of its variables set, and a deployment that sets
 * one says once which other it lacks, never a value; the four classic scopes are the ones recorded for the consent
 * version a new connection agrees to; every request goes to Atlassian's two hosts; the token endpoint takes JSON, and a
 * refresh is read by its error code; revoking makes no request; an issue is read by checked parts at one of two depths;
 * Atlassian's shared rate limit pauses every Jira call; and the webhook calls say Jira's refusals in its own words.
 */

const CLIENT_ID = "Qm3tR8vZ1kLp0sXy7wNc4hJd2fGb6aEu";
const CLIENT_SECRET = "ATOAx-secret-of-the-app-Zr9q";

/** The settings module as a new process loads it, with nothing logged yet. */
async function freshSettings() {
  vi.resetModules();
  return import("@/lib/jira/settings");
}

describe("Jira's settings (Jira acceptance JR1)", () => {
  let warn: MockInstance<typeof console.warn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
    vi.unstubAllEnvs();
  });

  it("is on with both the client id and the secret, trimmed, and off with neither, saying nothing", async () => {
    const { jiraSettingsFromEnv } = await freshSettings();
    expect(jiraSettingsFromEnv({ JIRA_CLIENT_ID: CLIENT_ID, JIRA_CLIENT_SECRET: CLIENT_SECRET })).toEqual({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    expect(jiraSettingsFromEnv({ JIRA_CLIENT_ID: ` ${CLIENT_ID} `, JIRA_CLIENT_SECRET: `${CLIENT_SECRET}\n` })).toEqual({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    expect(jiraSettingsFromEnv({})).toBeNull();
    expect(jiraSettingsFromEnv({ JIRA_CLIENT_ID: "", JIRA_CLIENT_SECRET: "  " })).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("reads the deployment's environment by default", async () => {
    const { jiraSettingsFromEnv } = await freshSettings();
    vi.stubEnv("JIRA_CLIENT_ID", "");
    vi.stubEnv("JIRA_CLIENT_SECRET", "");
    expect(jiraSettingsFromEnv()).toBeNull();
    vi.stubEnv("JIRA_CLIENT_ID", CLIENT_ID);
    vi.stubEnv("JIRA_CLIENT_SECRET", CLIENT_SECRET);
    expect(jiraSettingsFromEnv()).toEqual({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  });

  it("has no third variable: Jira signs its deliveries with the client secret (JR15)", () => {
    const source = readFileSync("src/lib/jira/settings.ts", "utf8");
    expect([...source.matchAll(/\benv\.([A-Z0-9_]+)/g)].map((match) => match[1])).toEqual(["JIRA_CLIENT_ID", "JIRA_CLIENT_SECRET"]);
    expect(source).not.toMatch(/JIRA_WEBHOOK_SECRET|JIRA_SIGNING/);
  });

  it("is off with one variable alone, saying once a process which one is not set, and never a value", async () => {
    const { jiraSettingsFromEnv } = await freshSettings();
    expect(jiraSettingsFromEnv({ JIRA_CLIENT_ID: CLIENT_ID })).toBeNull();
    expect(jiraSettingsFromEnv({ JIRA_CLIENT_ID: CLIENT_ID, JIRA_CLIENT_SECRET: " " })).toBeNull();
    expect(warn.mock.calls).toEqual([["Jira is off: JIRA_CLIENT_SECRET is not set"]]);
    expect(jiraSettingsFromEnv({ JIRA_CLIENT_SECRET: CLIENT_SECRET })).toBeNull();
    expect(jiraSettingsFromEnv({ JIRA_CLIENT_SECRET: CLIENT_SECRET })).toBeNull();
    expect(warn.mock.calls).toEqual([["Jira is off: JIRA_CLIENT_SECRET is not set"], ["Jira is off: JIRA_CLIENT_ID is not set"]]);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(CLIENT_ID);
    expect(logged).not.toContain(CLIENT_SECRET);
  });

  it("takes a client id of 6 to 64 letters, digits, dashes and underscores, and names only the variable when it refuses one", async () => {
    const { jiraSettingsFromEnv } = await freshSettings();
    const withId = (clientId: string) => jiraSettingsFromEnv({ JIRA_CLIENT_ID: clientId, JIRA_CLIENT_SECRET: CLIENT_SECRET });
    expect(withId("a".repeat(6))).not.toBeNull();
    expect(withId("A_b-9".repeat(12) + "Zz09")).not.toBeNull();
    expect(withId("a".repeat(5))).toBeNull();
    expect(withId("a".repeat(65))).toBeNull();
    expect(withId("id with spaces")).toBeNull();
    expect(withId("id/../path")).toBeNull();
    expect(warn.mock.calls).toEqual([["Jira is off: JIRA_CLIENT_ID is not an Atlassian client id"]]);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/aaaaa|spaces|path|ATOAx/);
  });
});

describe("Jira's scopes (JR3)", () => {
  it("are the four classic scopes, with offline_access for a refresh token", () => {
    expect([...JIRA_SCOPES]).toEqual(["read:jira-work", "read:jira-user", "manage:jira-webhook", "offline_access"]);
    // Classic scopes only: a granular one (such as read:issue-details:jira) waits for L13 and a new consent version.
    for (const scope of JIRA_SCOPES) expect(scope, scope).not.toMatch(/:jira$/);
  });

  it("equal the scopes recorded for the consent version a new connection agrees to, so a change of scope needs a new version", () => {
    expect(SCOPES_BY_CONSENT[CONSENT_VERSIONS.jira]).toEqual([...JIRA_SCOPES]);
    expect(Object.keys(SCOPES_BY_CONSENT)).toEqual([...CONSENT_HISTORY.jira]);
    for (const [version, scopes] of Object.entries(SCOPES_BY_CONSENT)) expect(new Set(scopes).size, version).toBe(scopes.length);
  });
});

describe("Atlassian's addresses (JR2, JR8)", () => {
  it("send a person to auth.atlassian.com to authorize, and every request to Atlassian's two hosts", () => {
    expect(JIRA_AUTH_HOST).toBe("auth.atlassian.com");
    expect(JIRA_API_HOST).toBe("api.atlassian.com");
    expect(JIRA_AUTHORIZE).toBe("https://auth.atlassian.com/authorize");
    expect(JIRA_TOKEN).toBe("https://auth.atlassian.com/oauth/token");
    expect(JIRA_RESOURCES).toBe("https://api.atlassian.com/oauth/token/accessible-resources");
    // Atlassian's sign-in is named only for the content security policy: no request goes there.
    expect(JIRA_LOGIN).toBe("https://id.atlassian.com");
  });
});

const SETTINGS = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET };
const NOW = Date.parse("2026-11-09T08:00:00.000Z");
const CLOUD = "11223344-a1b2-4b33-8c44-def123456789";
const OTHER_CLOUD = "99887766-5544-4332-8110-ffeeddccbbaa";
const SITE = { cloudId: CLOUD, url: "https://northstar.atlassian.net" };
const REDIRECT = "https://www.vestiarion.xyz/api/integrations/jira/callback";
const BASE = `https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3`;

type Sent = { url: string; init: RequestInit };
function http(respond: (sent: Sent) => Response, pause: JiraPause = { until: 0 }) {
  const sent: Sent[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const one = { url: String(input), init: init ?? {} };
    sent.push(one);
    return respond(one);
  }) as unknown as typeof fetch;
  return { sent, fetchImpl, now: () => NOW, pause };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const bodyOf = (init: RequestInit) => JSON.parse(String(init.body)) as Record<string, unknown>;
const authOf = (init: RequestInit) => new Headers(init.headers).get("authorization");

/** An issue as Jira's REST API answers `GET /rest/api/3/issue/{id}` at a full read's depth. */
function issueJson(fields: Record<string, unknown> = {}, top: Record<string, unknown> = {}) {
  return {
    id: "10042",
    key: "ENG-142",
    self: `${BASE}/issue/10042`,
    fields: {
      summary: "Webhook retries with backoff",
      status: { name: "Done", statusCategory: { id: 3, key: "done", name: "Done" } },
      resolution: { id: "10000", name: "Done" },
      resolutiondate: "2026-11-09T14:20:00.000+0700",
      statuscategorychangedate: "2026-11-09T14:30:00.000+0700",
      updated: "2026-11-09T14:31:00.000+0700",
      project: { id: "10000", key: "ENG", name: "Engineering" },
      description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Spec: https://www.figma.com/file/AbC123/retries." }] }] },
      attachment: [{ id: "10100", filename: "retries.pdf", created: "2026-11-09T13:00:00.000+0700", size: 1024, mimeType: "application/pdf" }],
      comment: {
        comments: [{ id: "10200", created: "2026-11-09T14:00:00.000+0700", body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Preview", marks: [{ type: "link", attrs: { href: "https://preview.example/eng-142" } }] }] }] } }],
        maxResults: 5000,
        total: 1,
        startAt: 0,
      },
      ...fields,
    },
    ...top,
  };
}
const REMOTE = [{ id: 10300, self: `${BASE}/issue/10042/remotelink/10300`, object: { url: "https://github.com/northstar/api/pull/42", title: "PR #42" } }];

/** Jira's REST API for one issue: the issue, its web links and its comment page, by address. */
function issueApi(issue: unknown = issueJson(), extra: Record<string, () => Response> = {}) {
  return http((sent) => {
    const url = new URL(sent.url);
    for (const [path, answer] of Object.entries(extra)) if (url.pathname.endsWith(path)) return answer();
    if (url.pathname.endsWith("/remotelink")) return json(REMOTE);
    return json(issue);
  });
}

describe("the authorize URL (Jira acceptance JR2)", () => {
  it("carries exactly Atlassian's seven parameters, the four scopes joined by spaces, and no secret", () => {
    const url = authorizeUrl(SETTINGS, { state: "vx1.state", redirectUri: REDIRECT });
    expect(url.startsWith("https://auth.atlassian.com/authorize?")).toBe(true);
    const params = new URL(url).searchParams;
    expect([...params.keys()]).toEqual(["audience", "client_id", "scope", "redirect_uri", "state", "response_type", "prompt"]);
    expect(Object.fromEntries(params)).toEqual({
      audience: "api.atlassian.com",
      client_id: CLIENT_ID,
      scope: "read:jira-work read:jira-user manage:jira-webhook offline_access",
      redirect_uri: REDIRECT,
      state: "vx1.state",
      response_type: "code",
      prompt: "consent",
    });
    // Spaces as %20, never a plus Atlassian might not read as one.
    expect(url).toContain("scope=read%3Ajira-work%20read%3Ajira-user%20manage%3Ajira-webhook%20offline_access");
    expect(url).not.toContain(CLIENT_SECRET);
  });
});

describe("the code exchange (JR2)", () => {
  it("posts a JSON body of five fields to auth.atlassian.com, and keeps the tokens for as long as expires_in says", async () => {
    const h = http(() => json({ access_token: "jira_access_1", refresh_token: "jira_refresh_1", expires_in: 3600, scope: "read:jira-work read:jira-user manage:jira-webhook offline_access", token_type: "Bearer" }));
    const outcome = await exchangeCode(SETTINGS, { code: "the-code", redirectUri: REDIRECT }, h);
    expect(outcome).toEqual({
      ok: true,
      authEventId: null,
      tokens: { accessToken: "jira_access_1", refreshToken: "jira_refresh_1", expiresAt: NOW + 3_600_000, scopes: ["read:jira-work", "read:jira-user", "manage:jira-webhook", "offline_access"] },
    });
    expect(h.sent[0].url).toBe("https://auth.atlassian.com/oauth/token");
    expect(h.sent[0].init.method).toBe("POST");
    expect(new Headers(h.sent[0].init.headers).get("content-type")).toBe("application/json");
    expect(bodyOf(h.sent[0].init)).toEqual({ grant_type: "authorization_code", code: "the-code", redirect_uri: REDIRECT, client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
    expect(h.sent[0].url).not.toContain(CLIENT_SECRET);
    // An hour when Atlassian does not say.
    const unsaid = await exchangeCode(SETTINGS, { code: "c", redirectUri: REDIRECT }, http(() => json({ access_token: "a", refresh_token: "r" })));
    expect(unsaid).toMatchObject({ ok: true, tokens: { expiresAt: NOW + 3_600_000, scopes: [...JIRA_SCOPES] } });
  });

  it("fails the connect when the answer has no refresh token, and is unavailable on a 5xx, a 429 or no answer", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await exchangeCode(SETTINGS, { code: "c", redirectUri: REDIRECT }, http(() => json({ access_token: "a", expires_in: 3600 })))).toEqual({ ok: false, reason: "refused" });
    expect(await exchangeCode(SETTINGS, { code: "c", redirectUri: REDIRECT }, http(() => json({ error: "invalid_grant" }, 403)))).toEqual({ ok: false, reason: "refused" });
    expect(await exchangeCode(SETTINGS, { code: "c", redirectUri: REDIRECT }, http(() => json({}, 503)))).toEqual({ ok: false, reason: "unavailable" });
    expect(await exchangeCode(SETTINGS, { code: "c", redirectUri: REDIRECT }, http(() => json({}, 429)))).toEqual({ ok: false, reason: "unavailable" });
    const silent = { fetchImpl: vi.fn(async () => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch };
    expect(await exchangeCode(SETTINGS, { code: "c", redirectUri: REDIRECT }, silent)).toEqual({ ok: false, reason: "unavailable" });
    expect(JSON.stringify(error.mock.calls)).not.toContain(CLIENT_SECRET);
    error.mockRestore();
  });
});

describe("a refresh (JR3)", () => {
  let error: MockInstance<typeof console.error>;
  let warn: MockInstance<typeof console.warn>;
  beforeEach(() => {
    error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    error.mockRestore();
    warn.mockRestore();
  });

  it("rotates to the new refresh token, with a JSON body of four fields", async () => {
    const h = http(() => json({ access_token: "jira_access_2", refresh_token: "jira_refresh_2", expires_in: 3600, scope: "read:jira-work offline_access" }));
    expect(await refreshTokens(SETTINGS, "jira_refresh_1", h)).toEqual({
      ok: true,
      tokens: { accessToken: "jira_access_2", refreshToken: "jira_refresh_2", expiresAt: NOW + 3_600_000, scopes: ["read:jira-work", "offline_access"] },
    });
    expect(bodyOf(h.sent[0].init)).toEqual({ grant_type: "refresh_token", refresh_token: "jira_refresh_1", client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
  });

  it("keeps the refresh token it sent when the answer has none, and says so", async () => {
    expect(await refreshTokens(SETTINGS, "jira_refresh_1", http(() => json({ access_token: "jira_access_2", expires_in: 3600 })))).toMatchObject({ ok: true, tokens: { refreshToken: "jira_refresh_1" } });
    expect(warn).toHaveBeenCalledWith("jira: a refresh answered no new refresh token; the one sent is kept");
  });

  it("asks for a person on invalid_grant, with a 403 as Atlassian answers it, and a 400 or 401 alike", async () => {
    for (const status of [403, 400, 401]) {
      expect(await refreshTokens(SETTINGS, "jira_refresh_1", http(() => json({ error: "invalid_grant", error_description: "Unknown or invalid refresh token." }, status))), String(status)).toEqual({
        ok: false,
        reason: "reconnect",
      });
    }
  });

  it("is unavailable, never a reconnect, when Atlassian refuses the deployment's own credentials, and says so once with no secret", async () => {
    vi.resetModules();
    const fresh = await import("@/lib/jira/oauth");
    const words = (code: string) => `jira: Atlassian refused this deployment's client credentials (${code}): check JIRA_CLIENT_ID and JIRA_CLIENT_SECRET`;
    expect(await fresh.refreshTokens(SETTINGS, "jira_refresh_1", http(() => json({ error: "invalid_client" }, 401)))).toEqual({ ok: false, reason: "unavailable", retryAfterMs: null });
    expect(await fresh.refreshTokens(SETTINGS, "jira_refresh_2", http(() => json({ error: "invalid_client" }, 401)))).toEqual({ ok: false, reason: "unavailable", retryAfterMs: null });
    expect(await fresh.refreshTokens(SETTINGS, "jira_refresh_3", http(() => json({ error: "unauthorized_client" }, 400)))).toEqual({ ok: false, reason: "unavailable", retryAfterMs: null });
    expect(error.mock.calls).toEqual([[words("invalid_client")], [words("unauthorized_client")]]);
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).not.toContain(CLIENT_SECRET);
    expect(logged).not.toContain("jira_refresh");
  });

  it("is unavailable on any other refusal, logging its status and code, and waits as long as a 503's Retry-After says", async () => {
    expect(await refreshTokens(SETTINGS, "jira_refresh_1", http(() => json({ error: "invalid_request", error_description: "x".repeat(500) }, 400)))).toEqual({ ok: false, reason: "unavailable", retryAfterMs: null });
    expect(error).toHaveBeenCalledWith("jira: a refresh was refused", 400, "invalid_request");
    expect(await refreshTokens(SETTINGS, "jira_refresh_1", http(() => json({}, 503, { "retry-after": "30" })))).toEqual({ ok: false, reason: "unavailable", retryAfterMs: 30_000 });
    expect(await refreshTokens(SETTINGS, "jira_refresh_1", http(() => json({}, 429, { "retry-after": "12" })))).toEqual({ ok: false, reason: "unavailable", retryAfterMs: 12_000 });
    const silent = { fetchImpl: vi.fn(async () => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch };
    expect(await refreshTokens(SETTINGS, "jira_refresh_1", silent)).toEqual({ ok: false, reason: "unavailable", retryAfterMs: null });
    // A long error code is cut to 40 characters.
    await refreshTokens(SETTINGS, "jira_refresh_1", http(() => json({ error: "a".repeat(60) }, 400)));
    expect(error).toHaveBeenLastCalledWith("jira: a refresh was refused", 400, "a".repeat(40));
    expect(JSON.stringify(error.mock.calls)).not.toContain("jira_refresh");
  });
});

describe("revoking (JR4)", () => {
  it("makes no request at all: Atlassian gives apps no way to end their own grant", async () => {
    expect(await revokeToken()).toBe(false);
    const h = http(() => json({}));
    expect(await jiraProvider(SETTINGS, h).revoke("jira_refresh_1")).toBe(false);
    expect(h.sent).toHaveLength(0);
  });
});

describe("the sites a grant reaches (JR2)", () => {
  const site = (id: string, url: string, scopes: string[] = ["read:jira-work", "manage:jira-webhook"], name = "Northstar") => ({ id, name, url, scopes, avatarUrl: "https://site-admin-avatar-cdn.prod.public.atl-paas.net/avatars/240/x.png" });

  it("keeps the Jira sites only, each once, by a UUID id and an https address, with its name cut to 200 characters", async () => {
    const h = http(() =>
      json([
        site(CLOUD, "https://northstar.atlassian.net"),
        site(CLOUD, "https://northstar.atlassian.net", ["read:jira-work"], "Northstar again"),
        // Confluence on the same cloud: Atlassian's ids are not unique across its products.
        site(OTHER_CLOUD, "https://northstar.atlassian.net/wiki", ["read:confluence-content.all"]),
        site("not-a-uuid", "https://evil.example"),
        site("aabbccdd-eeff-4011-8233-445566778899", "http://plain.atlassian.net"),
        site("aabbccdd-eeff-4011-8233-445566778800", "https://Ridge.Atlassian.net", ["read:jira-work"], "R".repeat(300)),
      ])
    );
    const sites = await grantSites("jira_access_1", h);
    expect(sites).toEqual([
      { externalOrgId: CLOUD, name: "Northstar", connectionId: null },
      { externalOrgId: "aabbccdd-eeff-4011-8233-445566778800", name: "R".repeat(200), connectionId: null },
    ]);
    expect(h.sent[0].url).toBe("https://api.atlassian.com/oauth/token/accessible-resources");
    expect(authOf(h.sent[0].init)).toBe("Bearer jira_access_1");
    expect(await jiraReader(h).sites("jira_access_1")).toContainEqual({ cloudId: "aabbccdd-eeff-4011-8233-445566778800", name: "R".repeat(200), url: "https://ridge.atlassian.net" });
  });

  it("refuses a grant that reaches no Jira site as no_site", async () => {
    await expect(grantSites("jira_access_1", http(() => json([])))).rejects.toEqual(new ConnectRefusal("no_site"));
    await expect(grantSites("jira_access_1", http(() => json([site(CLOUD, "https://northstar.atlassian.net", ["read:confluence-content.all"])])))).rejects.toMatchObject({ outcome: "no_site" });
    // With no site, the list is empty, not a refusal: the daily upkeep reads it (JR3).
    expect(await jiraReader(http(() => json([]))).sites("jira_access_1")).toEqual([]);
    await expect(grantSites("jira_access_1", http(() => json({}, 401)))).rejects.toMatchObject({ failure: "unauthorized" });
  });
});

describe("every request (JR8, JR17)", () => {
  it("goes to Atlassian's two hosts only, over https with no port, never follows a redirect and is never cached", async () => {
    const h = http(() => json({}));
    await jiraFetch(`${BASE}/myself`, { method: "GET" }, "myself", h);
    await jiraFetch(JIRA_TOKEN, { method: "POST" }, "refresh", h);
    expect(h.sent.map((one) => new URL(one.url).hostname)).toEqual(["api.atlassian.com", "auth.atlassian.com"]);
    expect(h.sent[0].init).toMatchObject({ redirect: "error", cache: "no-store" });
    expect(h.sent[0].init.signal).toBeInstanceOf(AbortSignal);
    for (const url of [
      `https://northstar.atlassian.net/rest/api/3/issue/10042`,
      `http://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/myself`,
      `https://api.atlassian.com:8443/ex/jira/${CLOUD}/rest/api/3/myself`,
      `https://me:pw@api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/myself`,
      `https://api.atlassian.com.evil.example/ex/jira/${CLOUD}/rest/api/3/myself`,
      // A slash before the query is answered "scope does not match" by Jira.
      `${BASE}/issue/10042/?fields=summary`,
      "not a url",
    ]) {
      await expect(jiraFetch(url, { method: "GET" }, "x", h), url).rejects.toMatchObject({ failure: "bad_response" });
    }
    expect(h.sent).toHaveLength(2);
  });

  it("builds an address from checked parts only, with no slash before its query and its commas as written", () => {
    expect(apiUrl(CLOUD, "/issue/10042", { fields: "summary,status" })).toBe(`${BASE}/issue/10042?fields=summary,status`);
    expect(apiUrl(CLOUD, "/webhook/refresh")).toBe(`${BASE}/webhook/refresh`);
    expect(apiUrl(CLOUD, "/search/jql", { jql: "id in (1, 2)" })).toBe(`${BASE}/search/jql?jql=id%20in%20(1,%202)`);
    for (const [cloud, path] of [
      ["../../other", "/myself"],
      [CLOUD.toUpperCase(), "/myself"],
      [CLOUD, "/issue/10042/"],
      [CLOUD, "/issue/../admin"],
      [CLOUD, "issue/10042"],
      [CLOUD, "/issue/10042?fields=x"],
      [CLOUD, "/issue/ENG 1"],
    ]) {
      expect(() => apiUrl(cloud, path), `${cloud} ${path}`).toThrow(ProviderError);
    }
  });

  it("reads a refusal by its status, and waits as Retry-After says, in seconds or as a date, a minute without one, an hour at most", () => {
    const answer = (status: number, headers: Record<string, string> = {}) => new Response(null, { status, headers });
    expect(failureOf(answer(429, { "retry-after": "7", "ratelimit-reason": "jira-burst-based" }), "issue", NOW)).toMatchObject({ failure: "rate_limited", retryAfterMs: 7_000, message: "Jira issue: 429 jira-burst-based" });
    expect(failureOf(answer(401), "issue", NOW)).toMatchObject({ failure: "unauthorized" });
    expect(failureOf(answer(403), "issue", NOW)).toMatchObject({ failure: "forbidden" });
    expect(failureOf(answer(502), "issue", NOW)).toMatchObject({ failure: "unavailable" });
    expect(failureOf(answer(409), "issue", NOW)).toMatchObject({ failure: "bad_response" });
    expect(waitOf(answer(429), NOW)).toBe(60_000);
    expect(waitOf(answer(429, { "retry-after": new Date(NOW + 90_000).toUTCString() }), NOW)).toBe(90_000);
    expect(waitOf(answer(429, { "retry-after": "86400" }), NOW)).toBe(3_600_000);
  });

  it("reads at most the bytes it allows of an answer, and nothing that is not JSON", async () => {
    await expect(jsonOf(new Response("x".repeat(2_000)), "issue", 1_000)).rejects.toMatchObject({ failure: "bad_response", message: "Jira issue: an answer larger than 1000 bytes" });
    await expect(jsonOf(new Response("{}", { headers: { "content-length": String(ISSUE_JSON_BYTES + 1) } }), "issue", ISSUE_JSON_BYTES)).rejects.toMatchObject({ failure: "bad_response" });
    await expect(jsonOf(new Response("<html>"), "issue", 1_000)).rejects.toMatchObject({ failure: "bad_response" });
    expect(await jsonOf(new Response('{"id":"10042"}'), "issue", 1_000)).toEqual({ id: "10042" });
  });

  it("pauses every Jira call when Atlassian's shared pool is spent, making no request while it lasts (JR17)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const pause: JiraPause = { until: 0 };
    let clock = NOW;
    let limited = true;
    const sent: string[] = [];
    const deps = {
      pause,
      now: () => clock,
      fetchImpl: (async (input: RequestInfo | URL) => {
        sent.push(String(input));
        if (limited && String(input).includes("/ex/jira/")) return new Response(null, { status: 429, headers: { "retry-after": "120", "ratelimit-reason": "jira-quota-global-based" } });
        return json([]);
      }) as unknown as typeof fetch,
    };
    const reader = jiraReader(deps);
    await expect(reader.issue("token", SITE, "10042", "status")).rejects.toMatchObject({ failure: "rate_limited", retryAfterMs: 120_000 });
    expect(pausedUntil(deps)).toBe(NOW + 120_000);
    expect(warn).toHaveBeenCalledTimes(1);
    limited = false;
    clock = NOW + 60_000;
    // While it lasts: a rate limit at once, with what is left of the wait, and no request.
    await expect(reader.issue("token", SITE, "10042", "status")).rejects.toMatchObject({ failure: "rate_limited", retryAfterMs: 60_000 });
    await expect(reader.changed("token", SITE, ["10042"])).rejects.toMatchObject({ failure: "rate_limited" });
    await expect(jiraWebhookApi(deps).list("token", SITE)).rejects.toMatchObject({ failure: "rate_limited" });
    expect(sent).toHaveLength(1);
    // The token endpoint and the sites a grant reaches are not in Jira's pool.
    await refreshTokens(SETTINGS, "jira_refresh_1", deps).catch(() => undefined);
    await reader.sites("token");
    expect(sent.slice(1).map((url) => new URL(url).pathname)).toEqual(["/oauth/token", "/oauth/token/accessible-resources"]);
    // Once it is over, calls go again.
    clock = NOW + 120_001;
    expect(pausedUntil(deps)).toBeNull();
    await reader.changed("token", SITE, ["10042"]).catch(() => undefined);
    expect(sent).toHaveLength(4);
    warn.mockRestore();
  });

  it("does not pause for one site's or one issue's rate limit, which is the caller's to wait out", async () => {
    for (const reason of ["jira-quota-tenant-based", "jira-burst-based", "jira-per-issue-on-write", ""]) {
      const h = http(() => new Response(null, { status: 429, headers: { "retry-after": "3", ...(reason ? { "ratelimit-reason": reason } : {}) } }));
      await expect(jiraReader(h).issue("token", SITE, "10042", "status"), reason).rejects.toMatchObject({ failure: "rate_limited", retryAfterMs: 3_000 });
      expect(pausedUntil(h), reason).toBeNull();
    }
  });
});

describe("an issue read (JR8)", () => {
  it("is one request at a status read's depth, by the issue's numeric id, with the status fields only", async () => {
    const h = issueApi(issueJson({ description: undefined, attachment: undefined, comment: undefined }));
    const read = await jiraReader(h).issue("jira_access_1", SITE, "10042", "status");
    expect(h.sent.map((one) => one.url)).toEqual([`${BASE}/issue/10042?fields=summary,status,resolution,resolutiondate,statuscategorychangedate,updated,project`]);
    expect(ISSUE_STATUS_FIELDS).toBe("summary,status,resolution,resolutiondate,statuscategorychangedate,updated,project");
    expect(authOf(h.sent[0].init)).toBe("Bearer jira_access_1");
    expect(read).toMatchObject({
      kind: "issue",
      issue: {
        id: "10042",
        key: "ENG-142",
        title: "Webhook retries with backoff",
        url: "https://northstar.atlassian.net/browse/ENG-142",
        projectId: "10000",
        projectKey: "ENG",
        statusCategory: "done",
        statusName: "Done",
        resolutionName: "Done",
        completed: true,
        canceled: false,
        completedAt: "2026-11-09T07:30:00.000Z",
        updatedAt: "2026-11-09T07:31:00.000Z",
        depth: "status",
        attachments: [],
        remoteLinks: [],
        comments: [],
        counts: { attachments: 0, remoteLinks: 0, comments: 0 },
      },
    });
  });

  it("is two requests in full, the issue and its web links, with the deliverables' fields too, and never a person field", async () => {
    const h = issueApi();
    const read = await jiraReader(h).issue("token", SITE, "10042", "full");
    expect(h.sent.map((one) => one.url)).toEqual([
      `${BASE}/issue/10042?fields=summary,status,resolution,resolutiondate,statuscategorychangedate,updated,project,description,attachment,comment`,
      `${BASE}/issue/10042/remotelink`,
    ]);
    expect(ISSUE_FULL_FIELDS).toBe(`${ISSUE_STATUS_FIELDS},description,attachment,comment`);
    expect(ISSUE_FULL_FIELDS).not.toMatch(/assignee|reporter|creator|watches|changelog/);
    expect([ATTACHMENTS_READ, REMOTE_LINKS_READ, COMMENTS_READ]).toEqual([50, 50, 50]);
    expect(read).toMatchObject({
      kind: "issue",
      issue: {
        depth: "full",
        descriptionLinks: ["https://www.figma.com/file/AbC123/retries"],
        attachments: [{ id: "10100", filename: "retries.pdf", href: "https://northstar.atlassian.net/secure/attachment/10100/retries.pdf", createdAt: "2026-11-09T06:00:00.000Z" }],
        remoteLinks: [{ id: "10300", title: "PR #42", href: "https://github.com/northstar/api/pull/42" }],
        comments: [{ id: "10200", createdAt: "2026-11-09T07:00:00.000Z", links: ["https://preview.example/eng-142"] }],
        moreUnread: false,
        counts: { attachments: 1, remoteLinks: 1, comments: 1 },
      },
    });
  });

  it("reads the newest 50 comments on their own when the embedded page holds fewer than its total", async () => {
    const page = { startAt: 0, maxResults: 50, total: 120, comments: [{ id: "10900", created: "2026-11-09T14:10:00.000+0700", body: { type: "doc", content: [{ type: "text", text: "Final: https://final.example/build" }] } }] };
    const h = issueApi(issueJson({ comment: { comments: [], maxResults: 0, total: 120, startAt: 0 } }), { "/comment": () => json(page) });
    const read = await jiraReader(h).issue("token", SITE, "10042", "full");
    expect(h.sent.map((one) => one.url)).toEqual([
      `${BASE}/issue/10042?fields=${ISSUE_FULL_FIELDS}`,
      `${BASE}/issue/10042/remotelink`,
      `${BASE}/issue/10042/comment?orderBy=-created&maxResults=50`,
    ]);
    expect(read).toMatchObject({ kind: "issue", issue: { comments: [{ id: "10900", links: ["https://final.example/build"] }], moreUnread: true } });
  });

  it("is read by key once, upper-cased, and takes the issue Jira resolves the key to", async () => {
    const h = issueApi(issueJson({}, { key: "OPS-7" }));
    const read = await jiraReader(h).issue("token", SITE, " eng-142 ", "status");
    expect(h.sent[0].url).toBe(`${BASE}/issue/ENG-142?fields=${ISSUE_STATUS_FIELDS}`);
    // A moved issue keeps its id; its key, browse link and project are the new ones.
    expect(read).toMatchObject({ kind: "issue", issue: { id: "10042", key: "OPS-7", url: "https://northstar.atlassian.net/browse/OPS-7" } });
  });

  it("answers gone for a 404 and a 403, at either request of a full read, and is refused when another issue answers", async () => {
    expect(await jiraReader(http(() => json({ errorMessages: ["Issue does not exist or you do not have permission to see it."] }, 404))).issue("token", SITE, "10042", "status")).toEqual({ kind: "gone", reason: "not_found" });
    expect(await jiraReader(http(() => json({}, 403))).issue("token", SITE, "10042", "full")).toEqual({ kind: "gone", reason: "forbidden" });
    expect(await jiraReader(issueApi(issueJson(), { "/remotelink": () => json({}, 404) })).issue("token", SITE, "10042", "full")).toEqual({ kind: "gone", reason: "not_found" });
    await expect(jiraReader(issueApi(issueJson({}, { id: "10043" }))).issue("token", SITE, "10042", "status")).rejects.toThrow(/another issue/);
    await expect(jiraReader(issueApi({ key: "ENG-142" })).issue("token", SITE, "ENG-142", "status")).rejects.toThrow(ProviderError);
    await expect(jiraReader(http(() => json({}, 401))).issue("token", SITE, "10042", "status")).rejects.toMatchObject({ failure: "unauthorized" });
    await expect(jiraReader(http(() => json({}, 500))).issue("token", SITE, "10042", "status")).rejects.toMatchObject({ failure: "unavailable" });
  });

  it("refuses an injected key, id or cloudId before any request is made", async () => {
    const h = issueApi();
    for (const ref of ["ENG-1/../../myself", "10042?expand=changelog", "ENG-1 OR 1=1", "1".repeat(19), "https://northstar.atlassian.net/browse/ENG-1", ""]) {
      await expect(jiraReader(h).issue("token", SITE, ref, "full"), ref).rejects.toThrow(ProviderError);
      expect(() => issuePathOf(ref), ref).toThrow(ProviderError);
    }
    await expect(jiraReader(h).issue("token", { ...SITE, cloudId: "../../oauth" }, "10042", "full")).rejects.toThrow(ProviderError);
    await expect(jiraReader(h).changed("token", SITE, ["10042", "1) OR (1=1"])).rejects.toThrow(ProviderError);
    expect(h.sent).toHaveLength(0);
  });
});

describe("the change check (JR16)", () => {
  it("asks when each issue changed by one JQL search per 50 ids, at most two, and leaves out an issue not answered for", async () => {
    const ids = Array.from({ length: 120 }, (_, index) => String(10_000 + index));
    const h = http((sent) => {
      const jql = new URL(sent.url).searchParams.get("jql") ?? "";
      const asked = /\((.*)\)/.exec(jql)?.[1].split(", ") ?? [];
      // Jira answers for every id but the first of each search, and once for an id not asked.
      return json({ issues: [...asked.slice(1).map((id) => ({ id, key: `ENG-${id}`, fields: { updated: "2026-11-09T14:31:00.000+0700" } })), { id: "99999", fields: { updated: "2026-11-09T14:31:00.000+0700" } }], isLast: true });
    });
    const changed = await jiraReader(h).changed("token", SITE, [...ids, "10000"]);
    expect(h.sent).toHaveLength(2);
    const first = new URL(h.sent[0].url);
    expect(`${first.origin}${first.pathname}`).toBe(`${BASE}/search/jql`);
    expect(first.searchParams.get("jql")).toBe(`id in (${ids.slice(0, 50).join(", ")})`);
    expect(first.searchParams.get("fields")).toBe("updated");
    expect(first.searchParams.get("maxResults")).toBe("50");
    expect(new URL(h.sent[1].url).searchParams.get("jql")).toBe(`id in (${ids.slice(50, 100).join(", ")})`);
    expect(changed).not.toBe("refused");
    const map = changed as Map<string, string>;
    expect(map.size).toBe(98);
    expect(map.has("10000")).toBe(false);
    expect(map.has("99999")).toBe(false);
    expect(map.get("10001")).toBe("2026-11-09T07:31:00.000Z");
  });

  it("answers refused when Jira refuses the search, as it does for an id deleted or hidden, and asks nothing for no ids", async () => {
    expect(await jiraReader(http(() => json({ errorMessages: ["An issue with key '10099' does not exist for field 'id'."] }, 400))).changed("token", SITE, ["10099"])).toBe("refused");
    await expect(jiraReader(http(() => json({}, 503))).changed("token", SITE, ["10099"])).rejects.toMatchObject({ failure: "unavailable" });
    const none = http(() => json({}));
    expect(await jiraReader(none).changed("token", SITE, [])).toEqual(new Map());
    expect(none.sent).toHaveLength(0);
  });
});

describe("the payee check's people (JR12)", () => {
  it("keeps an account with the payee's email, or with its email hidden, and drops one with another email", async () => {
    const h = http((sent) => {
      const url = new URL(sent.url);
      if (url.pathname.endsWith("/myself")) return json({ accountId: "5b10ac8d82e05b22cc7d4ef5", emailAddress: "duong@northstar.example", displayName: "Duong" });
      if (url.searchParams.get("query") === "mai@contractor.example") {
        return json([
          { accountId: "557058:f58131cb-b67d-43c7-b30d-6b58d40bd077", accountType: "atlassian", emailAddress: "Mai@Contractor.example", displayName: "Mai Tran" },
          { accountId: "61a1b2c3d4e5f60071234567", accountType: "atlassian", displayName: "Mai T." },
          { accountId: "61a1b2c3d4e5f60071234568", accountType: "atlassian", emailAddress: "mai.tran@elsewhere.example", displayName: "Mai Tran" },
          { accountId: "not an id!", emailAddress: "mai@contractor.example" },
        ]);
      }
      return json([]);
    });
    const people = await jiraReader(h).people("token", SITE, { myself: true, payeeEmail: " MAI@contractor.example ", memberEmail: null });
    expect(people).toEqual({ myselfId: "5b10ac8d82e05b22cc7d4ef5", payee: ["557058:f58131cb-b67d-43c7-b30d-6b58d40bd077", "61a1b2c3d4e5f60071234567"], member: [] });
    expect(h.sent.map((one) => one.url)).toEqual([`${BASE}/myself`, `${BASE}/user/search?query=mai%40contractor.example&maxResults=10`]);
    // A member who did not connect Jira is known by their own email.
    const member = http(() => json([{ accountId: "61a1b2c3d4e5f60071234599", emailAddress: "duong@northstar.example" }]));
    expect(await jiraReader(member).people("token", SITE, { myself: false, payeeEmail: "mai@contractor.example", memberEmail: "Duong@Northstar.example" })).toEqual({
      myselfId: null,
      payee: [],
      member: ["61a1b2c3d4e5f60071234599"],
    });
    expect(member.sent.map((one) => new URL(one.url).searchParams.get("query"))).toEqual(["mai@contractor.example", "duong@northstar.example"]);
  });

  it("asks nothing without the payee's email, and never goes ahead on an answer that does not read", async () => {
    const none = http(() => json([]));
    expect(await jiraReader(none).people("token", SITE, { myself: true, payeeEmail: null, memberEmail: "duong@northstar.example" })).toEqual({ myselfId: null, payee: [], member: [] });
    expect(await jiraReader(none).people("token", SITE, { myself: true, payeeEmail: "not an email", memberEmail: null })).toEqual({ myselfId: null, payee: [], member: [] });
    expect(none.sent).toHaveLength(0);
    await expect(jiraReader(http(() => json({ accountId: "" }))).people("token", SITE, { myself: true, payeeEmail: "mai@contractor.example", memberEmail: null })).rejects.toThrow(/no account/);
    await expect(jiraReader(http(() => json({ values: [] }))).people("token", SITE, { myself: false, payeeEmail: "mai@contractor.example", memberEmail: null })).rejects.toThrow(ProviderError);
  });
});

describe("a session on a connection's token (JR3)", () => {
  function store(initial: StoredTokens) {
    let row = { ...initial };
    let holder: string | null = null;
    const tokens: TokenStore = {
      read: async () => ({ ...row }),
      lease: async (who) => (holder && holder !== who ? null : ((holder = who), { ...row })),
      store: async (who, version, next) => {
        if (holder !== who || version !== row.version) return false;
        row = { ...row, ...next, version: row.version + 1 };
        holder = null;
        return true;
      },
      release: async (who) => {
        if (holder === who) holder = null;
      },
    };
    return { tokens, row: () => row };
  }

  it("refreshes once, under the lease, when Jira answers 401 for a token its expiry says is good, then reads again", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === JIRA_TOKEN) {
        calls.push(`refresh ${String(bodyOf(init ?? {}).refresh_token)}`);
        return json({ access_token: "jira_access_2", refresh_token: "jira_refresh_2", expires_in: 3600 });
      }
      calls.push(`issue ${authOf(init ?? {})}`);
      if (authOf(init ?? {}) !== "Bearer jira_access_2") return json({}, 401);
      return json(issueJson());
    }) as unknown as typeof fetch;
    const provider = jiraProvider(SETTINGS, { fetchImpl, now: () => NOW, pause: { until: 0 } });
    const kept = store({ id: "t-1", version: 1, accessToken: "jira_access_1", refreshToken: "jira_refresh_1", expiresAt: NOW + 3_600_000, scopes: [...JIRA_SCOPES] });
    const session = jiraSession({ provider, tokens: kept.tokens, now: () => NOW, sleep: async () => undefined });
    expect(await session.call((token) => provider.reader.issue(token, SITE, "10042", "status"))).toMatchObject({ kind: "issue", issue: { key: "ENG-142" } });
    expect(calls).toEqual(["issue Bearer jira_access_1", "refresh jira_refresh_1", "issue Bearer jira_access_2"]);
    // The pair Atlassian rotated to is kept.
    expect(kept.row()).toMatchObject({ version: 2, accessToken: "jira_access_2", refreshToken: "jira_refresh_2" });
  });

  it("asks for a person when Atlassian refuses the refresh token, and waits out a short rate limit once", async () => {
    const provider = jiraProvider(SETTINGS, { fetchImpl: (async () => json({ error: "invalid_grant" }, 403)) as unknown as typeof fetch, now: () => NOW });
    const expired = store({ id: "t-1", version: 1, accessToken: "old", refreshToken: "jira_refresh_1", expiresAt: 0, scopes: [...JIRA_SCOPES] });
    const session = jiraSession({ provider, tokens: expired.tokens, now: () => NOW, sleep: async () => undefined });
    await expect(session.call(async () => "never")).rejects.toBeInstanceOf(JiraAccessError);
    await expect(session.call(async () => "never")).rejects.toMatchObject({ outcome: { reason: "reconnect" } });

    const waits: number[] = [];
    let limited = true;
    const good = store({ id: "t-2", version: 1, accessToken: "fresh", refreshToken: "r", expiresAt: NOW + 3_600_000, scopes: [...JIRA_SCOPES] });
    const waiting = jiraSession({ provider, tokens: good.tokens, now: () => NOW, sleep: async (ms) => void waits.push(ms) });
    expect(
      await waiting.call(async () => {
        if (limited) {
          limited = false;
          throw new ProviderError("rate_limited", "Jira issue: 429 jira-burst-based", 2_000);
        }
        return "read";
      })
    ).toBe("read");
    expect(waits).toEqual([2_000]);
    // A long wait, Atlassian's shared pool among them, fails the call with its wait.
    await expect(waiting.call(async () => Promise.reject(new ProviderError("rate_limited", "Jira issue: paused", 60_000)))).rejects.toMatchObject({ retryAfterMs: 60_000 });
  });
});

describe("the webhook's calls (JR14)", () => {
  it("names the projects of the open links by their ids, each once, in order, at most 100, and nothing when there is none", () => {
    expect(desiredJql(["10001", "10000", "10001", null, "9", "not-an-id"])).toBe("project in (9, 10000, 10001)");
    expect(desiredJql([])).toBeNull();
    expect(desiredJql([null])).toBeNull();
    expect(desiredJql(Array.from({ length: 150 }, (_, index) => String(20_000 + index)))).toBe(`project in (${Array.from({ length: 100 }, (_, index) => String(20_000 + index)).join(", ")})`);
    expect([...JIRA_EVENTS]).toEqual(["jira:issue_updated", "jira:issue_deleted", "comment_created", "comment_updated", "comment_deleted"]);
  });

  it("registers one webhook to our address for the five events and the filter, with no field filter", async () => {
    const h = http(() => json({ webhookRegistrationResult: [{ createdWebhookId: 1001 }] }));
    const made = await jiraWebhookApi(h).register("token", SITE, { url: "https://www.vestiarion.xyz/api/integrations/jira/webhook", jql: "project in (10000, 10001)" });
    expect(made).toEqual({ ok: true, id: 1001 });
    expect(h.sent[0].url).toBe(`${BASE}/webhook`);
    expect(h.sent[0].init.method).toBe("POST");
    expect(bodyOf(h.sent[0].init)).toEqual({
      url: "https://www.vestiarion.xyz/api/integrations/jira/webhook",
      webhooks: [{ events: ["jira:issue_updated", "jira:issue_deleted", "comment_created", "comment_updated", "comment_deleted"], jqlFilter: "project in (10000, 10001)" }],
    });
    await expect(jiraWebhookApi(h).register("token", SITE, { url: "http://www.vestiarion.xyz/api/integrations/jira/webhook", jql: "project in (1)" })).rejects.toThrow(ProviderError);
  });

  it("says why Jira would not make one, in its own words with any address taken out, and throws for a refused token or an outage", async () => {
    const refused = await jiraWebhookApi(http(() => json({ webhookRegistrationResult: [{ errors: ["The JQL query is invalid: https://www.vestiarion.xyz/api/integrations/jira/webhook"] }] }))).register("token", SITE, {
      url: "https://www.vestiarion.xyz/api/integrations/jira/webhook",
      jql: "project in (10000)",
    });
    expect(refused).toEqual({ ok: false, error: "The JQL query is invalid: [an address]" });
    const forbidden = await jiraWebhookApi(http(() => json({ errorMessages: ["Only 5 webhooks can be registered per app, per user, per site."] }, 403))).register("token", SITE, { url: "https://www.vestiarion.xyz/x", jql: "project in (1)" });
    expect(forbidden).toEqual({ ok: false, error: "Only 5 webhooks can be registered per app, per user, per site." });
    expect(await jiraWebhookApi(http(() => new Response("<html>", { status: 400 }))).register("token", SITE, { url: "https://www.vestiarion.xyz/x", jql: "project in (1)" })).toEqual({ ok: false, error: "Jira answered 400" });
    await expect(jiraWebhookApi(http(() => json({}, 401))).register("token", SITE, { url: "https://www.vestiarion.xyz/x", jql: "project in (1)" })).rejects.toMatchObject({ failure: "unauthorized" });
    await expect(jiraWebhookApi(http(() => json({}, 503))).register("token", SITE, { url: "https://www.vestiarion.xyz/x", jql: "project in (1)" })).rejects.toMatchObject({ failure: "unavailable" });
    expect(refusalWords(["x".repeat(500)], 400)).toHaveLength(200);
  });

  it("renews by PUT /webhook/refresh, and by PUT /webhook when the first is not there, reading the expiry either way", async () => {
    const h = http(() => json({ expirationDate: "2026-12-09T08:00:00.000+0000" }));
    expect(await jiraWebhookApi(h).renew("token", SITE, [1001, 1001])).toBe("2026-12-09T08:00:00.000Z");
    expect(h.sent.map((one) => [one.init.method, one.url])).toEqual([["PUT", `${BASE}/webhook/refresh`]]);
    expect(bodyOf(h.sent[0].init)).toEqual({ webhookIds: [1001] });
    for (const status of [404, 405]) {
      const fallback = http((sent) => (sent.url.endsWith("/refresh") ? json({}, status) : json({ expirationDate: Date.parse("2026-12-09T08:00:00.000Z") })));
      expect(await jiraWebhookApi(fallback).renew("token", SITE, [1001]), String(status)).toBe("2026-12-09T08:00:00.000Z");
      expect(fallback.sent.map((one) => [one.init.method, one.url])).toEqual([
        ["PUT", `${BASE}/webhook/refresh`],
        ["PUT", `${BASE}/webhook`],
      ]);
    }
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await jiraWebhookApi(http(() => json({}, 404))).renew("token", SITE, [1001])).toBeNull();
    expect(await jiraWebhookApi(http(() => json({}))).renew("token", SITE, [1001])).toBeNull();
    error.mockRestore();
    await expect(jiraWebhookApi(http(() => json({}, 429, { "retry-after": "5" }))).renew("token", SITE, [1001])).rejects.toMatchObject({ failure: "rate_limited" });
    await expect(jiraWebhookApi(http(() => json({}))).renew("token", SITE, [])).rejects.toThrow(ProviderError);
  });

  it("lists the app's webhooks page by page until the last, three pages at most", async () => {
    const page = (startAt: number, isLast: boolean) => ({
      startAt,
      maxResults: 100,
      isLast,
      values: [{ id: 1000 + startAt, jqlFilter: "project in (10000)", events: ["jira:issue_updated", "comment_created"], expirationDate: "2026-12-01T00:00:00.000+0000" }],
    });
    const h = http((sent) => {
      const startAt = Number(new URL(sent.url).searchParams.get("startAt"));
      return json(page(startAt, startAt >= 5));
    });
    const hooks = await jiraWebhookApi(h).list("token", SITE);
    expect(h.sent.map((one) => one.url)).toEqual([`${BASE}/webhook?startAt=0&maxResults=100`, `${BASE}/webhook?startAt=1&maxResults=100`, `${BASE}/webhook?startAt=2&maxResults=100`]);
    expect(hooks[0]).toEqual({ id: 1000, jql: "project in (10000)", events: ["jira:issue_updated", "comment_created"], expiresAt: "2026-12-01T00:00:00.000Z", url: null });
    expect(hooks).toHaveLength(3);
    const last = http(() => json({ ...page(0, true), values: [{ id: 7, url: "https://www.vestiarion.xyz/api/integrations/jira/webhook", expirationDate: 1_796_000_000_000 }] }));
    expect(await jiraWebhookApi(last).list("token", SITE)).toEqual([{ id: 7, jql: null, events: [], expiresAt: new Date(1_796_000_000_000).toISOString(), url: "https://www.vestiarion.xyz/api/integrations/jira/webhook" }]);
    expect(last.sent).toHaveLength(1);
  });

  it("deletes webhooks by id in one DELETE, true once Jira has none of them", async () => {
    const h = http(() => new Response(null, { status: 202 }));
    expect(await jiraWebhookApi(h).remove("token", SITE, [1001, 1002])).toBe(true);
    expect(h.sent[0].init.method).toBe("DELETE");
    expect(h.sent[0].url).toBe(`${BASE}/webhook`);
    expect(bodyOf(h.sent[0].init)).toEqual({ webhookIds: [1001, 1002] });
    expect(await jiraWebhookApi(http(() => json({}, 404))).remove("token", SITE, [1001])).toBe(true);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await jiraWebhookApi(http(() => json({ errorMessages: ["no"] }, 400))).remove("token", SITE, [1001])).toBe(false);
    error.mockRestore();
    await expect(jiraWebhookApi(http(() => json({}, 401))).remove("token", SITE, [1001])).rejects.toMatchObject({ failure: "unauthorized" });
    await expect(jiraWebhookApi(http(() => json({}))).remove("token", SITE, [0])).rejects.toThrow(ProviderError);
  });
});
