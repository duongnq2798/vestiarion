import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "@/lib/connectors/provider";
import { freshAccessToken, type StoredTokens, type TokenStore } from "@/lib/connectors/tokens";
import { asanaReader } from "@/lib/asana/api";
import { authorizeUrl, exchangeCode, grantUser, refreshTokens, revokeToken } from "@/lib/asana/oauth";
import { asanaProvider } from "@/lib/asana/provider";
import { AsanaAccessError, asanaSession } from "@/lib/asana/session";
import { ASANA_SCOPES, asanaSettingsFromEnv } from "@/lib/asana/settings";

/**
 * Asana over HTTP (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md A1, A2, A6, A11): the authorize URL asks
 * for exactly the app's registered scopes; the code exchange, the refresh and the revocation send the client's secret
 * in the body; a refresh keeps the refresh token Asana does not send back; every read goes to app.asana.com at an address
 * built from digits; a task Asana no longer shows is an answer, not a failure; and a session refreshes a refused token
 * once, under the token row's lease.
 */

const SETTINGS = { clientId: "1211111111111111", clientSecret: "secret-of-the-app" };
const NOW = Date.parse("2026-10-14T09:00:00Z");

type Sent = { url: string; init: RequestInit };
function http(respond: (sent: Sent) => Response) {
  const sent: Sent[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const one = { url: String(input), init: init ?? {} };
    sent.push(one);
    return respond(one);
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const form = (init: RequestInit) => new URLSearchParams(String(init.body));

describe("settings", () => {
  it("is on only with both variables, and never with an id that is not one", () => {
    expect(asanaSettingsFromEnv({ ASANA_CLIENT_ID: SETTINGS.clientId, ASANA_CLIENT_SECRET: "s" })).toEqual({ clientId: SETTINGS.clientId, clientSecret: "s" });
    expect(asanaSettingsFromEnv({ ASANA_CLIENT_ID: SETTINGS.clientId })).toBeNull();
    expect(asanaSettingsFromEnv({ ASANA_CLIENT_ID: "not an id!", ASANA_CLIENT_SECRET: "s" })).toBeNull();
  });
});

describe("the authorize URL", () => {
  it("asks for exactly the registered scopes, space-delimited as %20, with the state and the exact redirect", () => {
    const url = authorizeUrl(SETTINGS, { state: "vx1.state", redirectUri: "https://www.vestiarion.xyz/api/integrations/asana/callback" });
    expect(url.startsWith("https://app.asana.com/-/oauth_authorize?")).toBe(true);
    expect(url).toContain("scope=workspaces%3Aread%20projects%3Aread%20tasks%3Aread%20attachments%3Aread%20stories%3Aread%20users%3Aread%20webhooks%3Aread%20webhooks%3Awrite%20webhooks%3Adelete");
    expect(url).not.toContain("+");
    const params = new URL(url).searchParams;
    expect(params.get("scope")?.split(" ")).toEqual([...ASANA_SCOPES]);
    expect(params.get("client_id")).toBe(SETTINGS.clientId);
    expect(params.get("redirect_uri")).toBe("https://www.vestiarion.xyz/api/integrations/asana/callback");
    expect(params.get("response_type")).toBe("code");
    expect(params.get("state")).toBe("vx1.state");
    expect(url).not.toContain(SETTINGS.clientSecret);
    expect(ASANA_SCOPES).toEqual(["workspaces:read", "projects:read", "tasks:read", "attachments:read", "stories:read", "users:read", "webhooks:read", "webhooks:write", "webhooks:delete"]);
  });
});

describe("the code exchange", () => {
  it("sends the code and the client's secret in a form body, and hands the grant's user on", async () => {
    const { sent, fetchImpl } = http(() =>
      json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, token_type: "bearer", data: { id: 4673218951, gid: "4673218951", name: "Duong", email: "duong@example.com" } })
    );
    const outcome = await exchangeCode(SETTINGS, { code: "the-code", redirectUri: "https://www.vestiarion.xyz/api/integrations/asana/callback" }, { fetchImpl, now: () => NOW });
    expect(outcome).toEqual({ ok: true, authEventId: "4673218951", tokens: { accessToken: "access-1", refreshToken: "refresh-1", expiresAt: NOW + 3_600_000, scopes: [...ASANA_SCOPES] } });
    expect(sent[0].url).toBe("https://app.asana.com/-/oauth_token");
    const body = form(sent[0].init);
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: "https://www.vestiarion.xyz/api/integrations/asana/callback",
      client_id: SETTINGS.clientId,
      client_secret: SETTINGS.clientSecret,
    });
  });

  it("is refused on a 4xx, and unavailable on a 5xx or no answer", async () => {
    expect(await exchangeCode(SETTINGS, { code: "c", redirectUri: "r" }, http(() => json({ error: "invalid_grant" }, 400)))).toEqual({ ok: false, reason: "refused" });
    expect(await exchangeCode(SETTINGS, { code: "c", redirectUri: "r" }, http(() => json({}, 503)))).toEqual({ ok: false, reason: "unavailable" });
    const silent = vi.fn(async () => {
      throw new TypeError("network");
    }) as unknown as typeof fetch;
    expect(await exchangeCode(SETTINGS, { code: "c", redirectUri: "r" }, { fetchImpl: silent })).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("a refresh", () => {
  it("keeps the refresh token when Asana sends none back, and takes a new one when it does", async () => {
    const kept = await refreshTokens(SETTINGS, "refresh-1", { ...http(() => json({ access_token: "access-2", expires_in: 3600 })), now: () => NOW });
    expect(kept).toEqual({ ok: true, tokens: { accessToken: "access-2", refreshToken: "refresh-1", expiresAt: NOW + 3_600_000, scopes: [...ASANA_SCOPES] } });
    const rotated = await refreshTokens(SETTINGS, "refresh-1", { ...http(() => json({ access_token: "access-3", refresh_token: "refresh-2", expires_in: 3600 })), now: () => NOW });
    expect(rotated).toMatchObject({ ok: true, tokens: { refreshToken: "refresh-2" } });
  });

  it("asks for a reconnect when the grant is gone, and waits on anything else", async () => {
    expect(await refreshTokens(SETTINGS, "refresh-1", http(() => json({ error: "invalid_grant" }, 400)))).toEqual({ ok: false, reason: "reconnect" });
    expect(await refreshTokens(SETTINGS, "refresh-1", { ...http(() => json({}, 503, { "retry-after": "30" })), now: () => NOW })).toEqual({ ok: false, reason: "unavailable", retryAfterMs: 30_000 });
  });

  it("revokes the refresh token, which ends its access tokens too", async () => {
    const { sent, fetchImpl } = http(() => json({}));
    expect(await revokeToken(SETTINGS, "refresh-1", { fetchImpl })).toBe(true);
    expect(sent[0].url).toBe("https://app.asana.com/-/oauth_revoke");
    expect(Object.fromEntries(form(sent[0].init))).toEqual({ token: "refresh-1", client_id: SETTINGS.clientId, client_secret: SETTINGS.clientSecret });
    expect(await revokeToken(SETTINGS, "refresh-1", http(() => json({}, 400)))).toBe(false);
  });

  it("knows the grant's user by /users/me, and refuses a grant that names two", async () => {
    expect(await grantUser("access-1", "4673218951", http(() => json({ data: { gid: "4673218951", name: "Duong" } })))).toEqual([{ externalOrgId: "4673218951", name: "Duong", connectionId: null }]);
    await expect(grantUser("access-1", "4673218951", http(() => json({ data: { gid: "999", name: "Someone" } })))).rejects.toThrow(/two users/);
    // Asana not answering /users/me still connects the user the exchange named.
    expect(await grantUser("access-1", "4673218951", http(() => json({}, 503)))).toEqual([{ externalOrgId: "4673218951", name: "Asana user 4673218951", connectionId: null }]);
  });
});

const TASK = {
  data: {
    gid: "1219477646404728",
    name: "Logo animation",
    notes: "Acceptance: a 5-second logo animation.\nDeliverable: https://www.figma.com/file/AbC123/logo-motion",
    completed: true,
    completed_at: "2026-10-14T08:00:00.000Z",
    completed_by: { gid: "5550001", name: "Mai Tran" },
    assignee: { gid: "5550001", name: "Mai Tran" },
    modified_at: "2026-10-14T08:00:00.000Z",
    permalink_url: "https://app.asana.com/0/1219477646404725/1219477646404728",
    workspace: { gid: "1204081671801519" },
    projects: [{ gid: "1219477646404725" }],
  },
};

describe("the reads", () => {
  it("read a task whole, from app.asana.com only, with the bearer token", async () => {
    const { sent, fetchImpl } = http(({ url }) => {
      if (url.includes("/attachments?")) return json({ data: [{ gid: "301", name: "logo.mp4", host: "asana", created_at: "2026-10-14T07:00:00Z", permanent_url: "https://app.asana.com/app/asana/-/get_asset?asset_id=301" }], next_page: null });
      if (url.includes("/stories?")) return json({ data: [{ gid: "77", resource_subtype: "comment_added", text: "v2: https://vimeo.com/1234" }, { gid: "78", resource_subtype: "marked_complete", text: "completed this task" }], next_page: null });
      return json(TASK);
    });
    const read = await asanaReader({ fetchImpl }).task("access-1", "1219477646404728");
    expect(read).toMatchObject({ kind: "task", task: { gid: "1219477646404728", completed: true, completedBy: { gid: "5550001", name: "Mai Tran" }, workspaceGid: "1204081671801519" } });
    if (read.kind !== "task") throw new Error("not read");
    expect(read.attachments).toEqual([{ gid: "301", name: "logo.mp4", host: "asana", createdAt: "2026-10-14T07:00:00.000Z", href: "https://app.asana.com/app/asana/-/get_asset?asset_id=301" }]);
    expect(read.comments.map((comment) => comment.gid)).toEqual(["77"]);
    for (const one of sent) {
      expect(new URL(one.url).hostname).toBe("app.asana.com");
      expect(new Headers(one.init.headers).get("authorization")).toBe("Bearer access-1");
      expect(one.init.redirect).toBe("error");
    }
    expect(sent.map((one) => new URL(one.url).pathname)).toEqual(["/api/1.0/tasks/1219477646404728", "/api/1.0/attachments", "/api/1.0/tasks/1219477646404728/stories"]);
  });

  it("answer gone for a task deleted or out of the connection's reach, and throw on a refusal of the token", async () => {
    expect(await asanaReader(http(() => json({ errors: [] }, 404))).task("t", "1")).toEqual({ kind: "gone", reason: "not_found" });
    expect(await asanaReader(http(() => json({ errors: [] }, 403))).task("t", "1")).toEqual({ kind: "gone", reason: "forbidden" });
    await expect(asanaReader(http(() => json({}, 401))).task("t", "1")).rejects.toMatchObject({ failure: "unauthorized" });
    await expect(asanaReader({ ...http(() => json({}, 429, { "retry-after": "2" })), now: () => NOW }).task("t", "1")).rejects.toMatchObject({ failure: "rate_limited", retryAfterMs: 2000 });
  });

  it("never builds an address from anything but digits", async () => {
    const { sent, fetchImpl } = http(() => json({ data: [] }));
    const reader = asanaReader({ fetchImpl });
    await expect(reader.task("t", "../users/me")).rejects.toBeInstanceOf(ProviderError);
    await expect(reader.projects("t", "1 OR 1")).rejects.toBeInstanceOf(ProviderError);
    await expect(reader.deleteWebhook("t", "abc")).rejects.toBeInstanceOf(ProviderError);
    expect(sent).toHaveLength(0);
  });

  it("looks a user up by email, and answers none where Asana shows none", async () => {
    const { sent, fetchImpl } = http(({ url }) => (url.includes("mai%40fernhill.example") ? json({ data: { gid: "5550001", name: "Mai" } }) : json({ errors: [] }, 404)));
    const reader = asanaReader({ fetchImpl });
    expect(await reader.userByEmail("t", "Mai@Fernhill.example")).toBe("5550001");
    expect(await reader.userByEmail("t", "someone@else.example")).toBeNull();
    expect(await reader.userByEmail("t", "not an email")).toBeNull();
    expect(sent.map((one) => new URL(one.url).pathname)).toEqual(["/api/1.0/users/mai%40fernhill.example", "/api/1.0/users/someone%40else.example"]);
  });

  it("makes a webhook on a task with an https target, and keeps the secret Asana answered with", async () => {
    const { sent, fetchImpl } = http(() => json({ data: { gid: "8800001", resource: { gid: "1219477646404728" }, active: true } }, 201, { "x-hook-secret": "secret-from-asana" }));
    const reader = asanaReader({ fetchImpl });
    expect(await reader.createWebhook("t", { resource: "1219477646404728", target: "https://www.vestiarion.xyz/api/integrations/asana/webhook/abc" })).toEqual({ gid: "8800001", secret: "secret-from-asana" });
    expect(JSON.parse(String(sent[0].init.body))).toEqual({ data: { resource: "1219477646404728", target: "https://www.vestiarion.xyz/api/integrations/asana/webhook/abc" } });
    await expect(reader.createWebhook("t", { resource: "1219477646404728", target: "http://localhost:3000/x" })).rejects.toBeInstanceOf(ProviderError);
  });

  it("reads the secret where Asana documents it, at the top of the 201's body beside data", async () => {
    const { fetchImpl } = http(() => json({ data: { gid: "8800001", resource: { gid: "1219477646404728" }, active: true }, "X-Hook-Secret": "secret-in-the-body" }, 201));
    const reader = asanaReader({ fetchImpl });
    expect(await reader.createWebhook("t", { resource: "1219477646404728", target: "https://www.vestiarion.xyz/api/integrations/asana/webhook/abc" })).toEqual({ gid: "8800001", secret: "secret-in-the-body" });
    // Neither in the body nor in a header: no secret, which the caller takes as no handshake of Asana's.
    const none = asanaReader({ fetchImpl: http(() => json({ data: { gid: "8800002" } }, 201)).fetchImpl });
    expect(await none.createWebhook("t", { resource: "1219477646404728", target: "https://www.vestiarion.xyz/api/integrations/asana/webhook/abc" })).toEqual({ gid: "8800002", secret: null });
  });

  it("says Asana's own reason when it refuses to make or delete a webhook, without any address in it", async () => {
    const target = "https://www.vestiarion.xyz/api/integrations/asana/webhook/abc";
    const refused = (body: unknown, status = 403) => asanaReader({ fetchImpl: http(() => (typeof body === "string" ? new Response(body, { status }) : json(body, status))).fetchImpl });
    const said = await refused({ errors: [{ message: `Forbidden: the target ${target} is not allowed`, help: "https://developers.asana.com/docs/errors" }] })
      .createWebhook("t", { resource: "1219477646404728", target })
      .catch((error: unknown) => error);
    expect(said).toBeInstanceOf(ProviderError);
    expect(said).toMatchObject({ failure: "forbidden", message: "Asana webhook: 403: Forbidden: the target [an address] is not allowed" });
    // Long words are cut and control characters dropped; no reason, or a body that is not JSON, leaves the status alone.
    const long = await refused({ errors: [{ message: `Too\nmany ${"x".repeat(400)}` }] }, 400).createWebhook("t", { resource: "1", target }).catch((error: Error) => error.message);
    expect(long).toMatch(/^Asana webhook: 400: Too many x+…$/);
    expect(long.length).toBe("Asana webhook: 400: ".length + 200);
    expect(await refused("<html>blocked</html>").createWebhook("t", { resource: "1", target }).catch((error: Error) => error.message)).toBe("Asana webhook: 403");
    expect(await refused({ errors: [] }).createWebhook("t", { resource: "1", target }).catch((error: Error) => error.message)).toBe("Asana webhook: 403");
    expect(await refused({ errors: [{ message: "Not Authorized" }] }, 401).deleteWebhook("t", "8800001").catch((error: Error) => error.message)).toBe("Asana webhook delete: 401: Not Authorized");
  });
});

/** A token row in memory, with the core's lease and compare-and-set. */
function memoryTokens(initial: { accessToken: string; refreshToken: string; expiresAt: number }) {
  let row: StoredTokens = { id: "token-1", version: 1, scopes: [], ...initial };
  let holder: string | null = null;
  const store: TokenStore = {
    read: async () => ({ ...row }),
    lease: async (who) => {
      if (holder && holder !== who) return null;
      holder = who;
      return { ...row };
    },
    store: async (who, version, tokens) => {
      if (holder !== who || version !== row.version) return false;
      row = { ...row, ...tokens, version: row.version + 1 };
      holder = null;
      return true;
    },
    release: async (who) => {
      if (holder === who) holder = null;
    },
  };
  return { store, row: () => row };
}

describe("token refresh", () => {
  it("refreshes an expired token before the call, and stores the new pair under the lease", async () => {
    const tokens = memoryTokens({ accessToken: "old", refreshToken: "refresh-1", expiresAt: NOW - 1 });
    const refresh = vi.fn(async () => ({ ok: true as const, tokens: { accessToken: "new", refreshToken: "refresh-1", expiresAt: NOW + 3_600_000, scopes: [] } }));
    const session = asanaSession({ provider: { refresh }, tokens: tokens.store, now: () => NOW });
    expect(await session.call(async (token) => token)).toBe("new");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(tokens.row()).toMatchObject({ accessToken: "new", version: 2 });
    // The next call uses it without refreshing again.
    expect(await session.call(async (token) => token)).toBe("new");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes once a token Asana refused, and sends the call again", async () => {
    const tokens = memoryTokens({ accessToken: "refused-one", refreshToken: "refresh-1", expiresAt: NOW + 3_600_000 });
    const refresh = vi.fn(async () => ({ ok: true as const, tokens: { accessToken: "fresh", refreshToken: "refresh-1", expiresAt: NOW + 3_600_000, scopes: [] } }));
    const session = asanaSession({ provider: { refresh }, tokens: tokens.store, now: () => NOW });
    const used: string[] = [];
    const answer = await session.call(async (token) => {
      used.push(token);
      if (token === "refused-one") throw new ProviderError("unauthorized", "Asana task: 401");
      return "read";
    });
    expect(answer).toBe("read");
    expect(used).toEqual(["refused-one", "fresh"]);
    // A second refusal is not refreshed again: it is the caller's to say.
    await expect(
      session.call(async () => {
        throw new ProviderError("unauthorized", "Asana task: 401");
      })
    ).rejects.toMatchObject({ failure: "unauthorized" });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("says the connection needs a person when Asana refuses the refresh token", async () => {
    const tokens = memoryTokens({ accessToken: "old", refreshToken: "revoked", expiresAt: NOW - 1 });
    const session = asanaSession({ provider: { refresh: async () => ({ ok: false, reason: "reconnect" }) }, tokens: tokens.store, now: () => NOW });
    await expect(session.call(async () => "never")).rejects.toBeInstanceOf(AsanaAccessError);
    await expect(session.call(async () => "never")).rejects.toMatchObject({ outcome: { reason: "reconnect" } });
  });

  it("waits for another holder's refresh rather than sending the same refresh token twice", async () => {
    const tokens = memoryTokens({ accessToken: "old", refreshToken: "refresh-1", expiresAt: NOW - 1 });
    await tokens.store.lease("someone-else", 60);
    const refresh = vi.fn();
    const sleep = vi.fn(async () => {
      await tokens.store.store("someone-else", 1, { accessToken: "theirs", refreshToken: "refresh-1", expiresAt: NOW + 3_600_000, scopes: [] });
    });
    expect(await freshAccessToken({ store: tokens.store, refresh, now: () => NOW, sleep })).toEqual({ ok: true, accessToken: "theirs" });
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("the provider", () => {
  it("is Asana on the connector core, not exclusive, with the registered scopes", () => {
    const provider = asanaProvider(SETTINGS);
    expect(provider).toMatchObject({ id: "asana", label: "Asana", scopes: ASANA_SCOPES });
    expect(provider.exclusive).toBeUndefined();
    expect(provider.callbackOrganisationParam).toBeUndefined();
  });
});
