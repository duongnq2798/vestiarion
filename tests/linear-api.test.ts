import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "@/lib/connectors/provider";
import type { StoredTokens, TokenStore } from "@/lib/connectors/tokens";
import { ISSUE_QUERY, issueVariable, linearReader, peopleQuery } from "@/lib/linear/api";
import { graphql } from "@/lib/linear/http";
import { authorizeUrl, exchangeCode, grantWorkspace, refreshTokens, revokeToken } from "@/lib/linear/oauth";
import { linearProvider } from "@/lib/linear/provider";
import { LinearAccessError, linearSession } from "@/lib/linear/session";
import { LINEAR_SCOPES, linearSettingsFromEnv } from "@/lib/linear/settings";

/**
 * Linear over HTTP (docs/superpowers/specs/2026-10-31-linear-acceptance-design.md LN1, LN2, LN6, LN12): the authorize URL
 * asks for scope read as the user; the code exchange, the refresh and the revocation send the client's secret in the
 * body; a refresh keeps the new refresh token Linear rotates to; every read is one GraphQL query to api.linear.app with
 * the issue as a checked variable; an issue Linear no longer shows is an answer, not a failure; Linear's errors (an
 * expired token's 401, AUTHENTICATION_ERROR, RATELIMITED with its reset time) are read as such; and a session refreshes
 * a refused token once, under the token row's lease.
 */

const SETTINGS = { clientId: "5f0c2b0d8d6a4c1f9e0a7b3c2d1e4f5a", clientSecret: "secret-of-the-app", webhookSecret: "lin_wh_secret" };
const NOW = Date.parse("2026-10-31T09:00:00Z");
const ORG_ID = "8c5d2f62-0a5b-4a8e-9c1e-2b7f0f6c1a01";
const VIEWER_ID = "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a01";
const ISSUE_ID = "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c01";
const MAI_ID = "3b4c5d6e-7f8a-4b9c-8d0e-1f2a3b4c5d01";
const ATTACHMENT_ID = "4c5d6e7f-8a9b-4c0d-9e1f-2a3b4c5d6e01";
const COMMENT_ID = "5d6e7f8a-9b0c-4d1e-8f2a-3b4c5d6e7f01";

type Sent = { url: string; init: RequestInit };
function http(respond: (sent: Sent) => Response) {
  const sent: Sent[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const one = { url: String(input), init: init ?? {} };
    sent.push(one);
    return respond(one);
  }) as unknown as typeof fetch;
  return { sent, fetchImpl, now: () => NOW };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const form = (init: RequestInit) => new URLSearchParams(String(init.body));
const graphqlBody = (init: RequestInit) => JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };

/** An issue as Linear's GraphQL API answers `issue(id:)`. */
function issueNode(fields: Record<string, unknown> = {}) {
  return {
    id: ISSUE_ID,
    identifier: "ENG-123",
    title: "Billing export",
    url: "https://linear.app/fernhill/issue/ENG-123/billing-export",
    description: "Spec: https://www.figma.com/file/AbC123/billing\nThis issue: https://linear.app/fernhill/issue/ENG-123",
    trashed: false,
    archivedAt: null,
    updatedAt: "2026-10-31T08:59:00.000Z",
    completedAt: "2026-10-31T08:30:00.000Z",
    state: { type: "completed", name: "Done" },
    team: { id: "6e7f8a9b-0c1d-4e2f-9a3b-4c5d6e7f8a01", key: "ENG" },
    assignee: { id: MAI_ID, name: "Mai Tran" },
    attachments: { nodes: [{ id: ATTACHMENT_ID, url: "https://github.com/fernhill/app/pull/42", title: "PR #42", updatedAt: "2026-10-31T08:00:00.000Z" }], pageInfo: { hasNextPage: false } },
    comments: { nodes: [{ id: COMMENT_ID, body: "Final build: https://vercel.example/preview/1.", createdAt: "2026-10-31T08:10:00.000Z" }], pageInfo: { hasNextPage: false } },
    history: {
      nodes: [
        { createdAt: "2026-10-30T10:00:00.000Z", actor: { id: VIEWER_ID, name: "Duong" }, toState: { type: "started" } },
        { createdAt: "2026-10-31T08:30:00.000Z", actor: { id: MAI_ID, name: "Mai Tran" }, toState: { type: "completed" } },
      ],
    },
    ...fields,
  };
}

describe("settings (Linear acceptance LN1)", () => {
  it("is on only with the client id, the client secret and the webhook secret", () => {
    const env = { LINEAR_CLIENT_ID: SETTINGS.clientId, LINEAR_CLIENT_SECRET: "s", LINEAR_WEBHOOK_SECRET: "w" };
    expect(linearSettingsFromEnv(env)).toEqual({ clientId: SETTINGS.clientId, clientSecret: "s", webhookSecret: "w" });
    expect(linearSettingsFromEnv({ ...env, LINEAR_WEBHOOK_SECRET: "" })).toBeNull();
    expect(linearSettingsFromEnv({ ...env, LINEAR_CLIENT_SECRET: undefined })).toBeNull();
    expect(linearSettingsFromEnv({ ...env, LINEAR_CLIENT_ID: "not an id!" })).toBeNull();
    expect(LINEAR_SCOPES).toEqual(["read"]);
  });
});

describe("the authorize URL (LN2)", () => {
  it("asks for scope read only, as the user, with the state and the exact redirect, and shows the consent screen", () => {
    const url = authorizeUrl(SETTINGS, { state: "vx1.state", redirectUri: "https://www.vestiarion.xyz/api/integrations/linear/callback" });
    expect(url.startsWith("https://linear.app/oauth/authorize?")).toBe(true);
    const params = new URL(url).searchParams;
    expect(Object.fromEntries(params)).toEqual({
      client_id: SETTINGS.clientId,
      redirect_uri: "https://www.vestiarion.xyz/api/integrations/linear/callback",
      response_type: "code",
      scope: "read",
      state: "vx1.state",
      actor: "user",
      prompt: "consent",
    });
    expect(url).not.toContain(SETTINGS.clientSecret);
    expect(url).not.toContain(SETTINGS.webhookSecret);
  });
});

describe("the code exchange, the refresh and the revocation (LN2)", () => {
  it("sends the code and the client's secret in a form body to api.linear.app, and keeps the day-long token with its refresh token", async () => {
    const h = http(() => json({ access_token: "lin_oauth_access_1", token_type: "Bearer", expires_in: 86399, scope: ["read"], refresh_token: "lin_refresh_1" }));
    const outcome = await exchangeCode(SETTINGS, { code: "the-code", redirectUri: "https://www.vestiarion.xyz/api/integrations/linear/callback" }, h);
    expect(outcome).toEqual({ ok: true, authEventId: null, tokens: { accessToken: "lin_oauth_access_1", refreshToken: "lin_refresh_1", expiresAt: NOW + 86_399_000, scopes: ["read"] } });
    expect(h.sent[0].url).toBe("https://api.linear.app/oauth/token");
    expect(h.sent[0].init.method).toBe("POST");
    expect(Object.fromEntries(form(h.sent[0].init))).toEqual({
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: "https://www.vestiarion.xyz/api/integrations/linear/callback",
      client_id: SETTINGS.clientId,
      client_secret: SETTINGS.clientSecret,
    });
    // Linear may say the scopes as one string, too.
    const spaced = await exchangeCode(SETTINGS, { code: "c", redirectUri: "r" }, http(() => json({ access_token: "a", expires_in: 86399, scope: "read", refresh_token: "r" })));
    expect(spaced).toMatchObject({ ok: true, tokens: { scopes: ["read"] } });
  });

  it("is refused on a 4xx, and unavailable on a 5xx, a 429 or no answer", async () => {
    expect(await exchangeCode(SETTINGS, { code: "c", redirectUri: "r" }, http(() => json({ error: "invalid_grant" }, 400)))).toEqual({ ok: false, reason: "refused" });
    expect(await exchangeCode(SETTINGS, { code: "c", redirectUri: "r" }, http(() => json({}, 503)))).toEqual({ ok: false, reason: "unavailable" });
    expect(await exchangeCode(SETTINGS, { code: "c", redirectUri: "r" }, http(() => json({}, 429)))).toEqual({ ok: false, reason: "unavailable" });
    const silent = { fetchImpl: vi.fn(async () => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch };
    expect(await exchangeCode(SETTINGS, { code: "c", redirectUri: "r" }, silent)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("refreshes to the new refresh token Linear rotates to, and asks for a person on invalid_grant", async () => {
    const h = http(() => json({ access_token: "lin_oauth_access_2", token_type: "Bearer", expires_in: 86399, scope: ["read"], refresh_token: "lin_refresh_2" }));
    expect(await refreshTokens(SETTINGS, "lin_refresh_1", h)).toEqual({ ok: true, tokens: { accessToken: "lin_oauth_access_2", refreshToken: "lin_refresh_2", expiresAt: NOW + 86_399_000, scopes: ["read"] } });
    expect(Object.fromEntries(form(h.sent[0].init))).toEqual({ grant_type: "refresh_token", refresh_token: "lin_refresh_1", client_id: SETTINGS.clientId, client_secret: SETTINGS.clientSecret });
    expect(await refreshTokens(SETTINGS, "lin_refresh_1", http(() => json({ error: "invalid_grant", error_description: "refresh token revoked" }, 400)))).toEqual({ ok: false, reason: "reconnect" });
    expect(await refreshTokens(SETTINGS, "lin_refresh_1", http(() => json({}, 503, { "retry-after": "30" })))).toEqual({ ok: false, reason: "unavailable", retryAfterMs: 30_000 });
  });

  it("revokes the grant by its refresh token, with the client's credentials in the body", async () => {
    const h = http(() => new Response(null, { status: 200 }));
    expect(await revokeToken(SETTINGS, "lin_refresh_1", h)).toBe(true);
    expect(h.sent[0].url).toBe("https://api.linear.app/oauth/revoke");
    expect(Object.fromEntries(form(h.sent[0].init))).toEqual({ token: "lin_refresh_1", token_type_hint: "refresh_token", client_id: SETTINGS.clientId, client_secret: SETTINGS.clientSecret });
    expect(await revokeToken(SETTINGS, "lin_refresh_1", http(() => json({ error: "invalid_token" }, 400)))).toBe(false);
  });

  it("names the Linear workspace a fresh token reads, by viewer { organization { id name } }", async () => {
    const h = http(() => json({ data: { viewer: { id: VIEWER_ID, name: "Duong", organization: { id: ORG_ID, name: "Fernhill" } } } }));
    expect(await grantWorkspace("lin_oauth_access_1", h)).toEqual([{ externalOrgId: ORG_ID, name: "Fernhill", connectionId: null }]);
    expect(h.sent[0].url).toBe("https://api.linear.app/graphql");
    expect(new Headers(h.sent[0].init.headers).get("authorization")).toBe("Bearer lin_oauth_access_1");
    expect(graphqlBody(h.sent[0].init).query).toMatch(/viewer \{ id name organization \{ id name \} \}/);
    await expect(grantWorkspace("t", http(() => json({ data: { viewer: { id: "not-a-uuid" } } })))).rejects.toThrow(ProviderError);
  });
});

describe("GraphQL errors as Linear answers them", () => {
  const ask = (respond: (sent: Sent) => Response) => graphql("token", "query { viewer { id } }", {}, "viewer", http(respond));

  it("reads an expired token's 401, and an AUTHENTICATION_ERROR in a 400, as unauthorized", async () => {
    await expect(ask(() => json({ errors: [{ message: "Authentication required, not authenticated", extensions: { type: "authentication error", code: "AUTHENTICATION_ERROR", userError: true } }] }, 401))).rejects.toMatchObject({ failure: "unauthorized" });
    await expect(ask(() => json({ errors: [{ message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } }] }, 400))).rejects.toMatchObject({ failure: "unauthorized" });
  });

  it("reads RATELIMITED with the reset time Linear gives, and a 429", async () => {
    const reset = String(NOW + 12_000);
    await expect(ask(() => json({ errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }] }, 400, { "x-ratelimit-requests-reset": reset }))).rejects.toMatchObject({ failure: "rate_limited", retryAfterMs: 12_000 });
    await expect(ask(() => json({}, 429, { "retry-after": "2" }))).rejects.toMatchObject({ failure: "rate_limited", retryAfterMs: 2_000 });
  });

  it("reads a 5xx as unavailable, an answer not JSON as unreadable, and never sends anywhere but api.linear.app", async () => {
    await expect(ask(() => new Response("<html>", { status: 502 }))).rejects.toMatchObject({ failure: "unavailable" });
    await expect(ask(() => new Response("<html>", { status: 200 }))).rejects.toMatchObject({ failure: "bad_response" });
    const h = http(() => json({ data: {} }));
    await graphql("token", "query { viewer { id } }", {}, "viewer", h);
    expect(h.sent.map((one) => new URL(one.url).hostname)).toEqual(["api.linear.app"]);
    expect(h.sent[0].init.redirect).toBe("error");
  });
});

describe("the issue read (LN6)", () => {
  it("asks one GraphQL query by the identifier or the UUID, and reads its state, completion, people and deliverables", async () => {
    const h = http(() => json({ data: { issue: issueNode() } }));
    const read = await linearReader(h).issue("token", "eng-123");
    expect(graphqlBody(h.sent[0].init)).toEqual({ query: ISSUE_QUERY, variables: { id: "ENG-123" } });
    expect(ISSUE_QUERY).toMatch(/attachments\(first: 50\)/);
    expect(ISSUE_QUERY).toMatch(/comments\(first: 100\)/);
    expect(read).toMatchObject({
      kind: "issue",
      issue: {
        id: ISSUE_ID,
        identifier: "ENG-123",
        title: "Billing export",
        url: "https://linear.app/fernhill/issue/ENG-123/billing-export",
        teamKey: "ENG",
        stateType: "completed",
        stateName: "Done",
        completed: true,
        canceled: false,
        completedAt: "2026-10-31T08:30:00.000Z",
        completedBy: { id: MAI_ID, name: "Mai Tran" },
        assignee: { id: MAI_ID, name: "Mai Tran" },
        archived: false,
        attachments: [{ id: ATTACHMENT_ID, href: "https://github.com/fernhill/app/pull/42", title: "PR #42", updatedAt: "2026-10-31T08:00:00.000Z" }],
        moreUnread: false,
      },
    });
    await linearReader(h).issue("token", ISSUE_ID);
    expect(graphqlBody(h.sent[1].init).variables).toEqual({ id: ISSUE_ID });
  });

  it("reads a canceled, an archived and a trashed issue as such, and one reopened as not completed", async () => {
    const read = async (fields: Record<string, unknown>) => {
      const answer = await linearReader(http(() => json({ data: { issue: issueNode(fields) } }))).issue("token", "ENG-123");
      if (answer.kind !== "issue") throw new Error("gone");
      return answer.issue;
    };
    expect(await read({ state: { type: "canceled", name: "Canceled" }, completedAt: null })).toMatchObject({ completed: false, canceled: true, completedAt: null, completedBy: null });
    expect(await read({ archivedAt: "2026-10-31T09:00:00.000Z" })).toMatchObject({ archived: true });
    expect(await read({ trashed: true })).toMatchObject({ archived: true });
    expect(await read({ state: { type: "started", name: "In Progress" }, completedAt: null })).toMatchObject({ completed: false, canceled: false, stateName: "In Progress" });
    // Completed by an integration: the history names no person, and nothing is guessed.
    expect(await read({ history: { nodes: [{ createdAt: "2026-10-31T08:30:00.000Z", actor: null, toState: { type: "completed" } }] } })).toMatchObject({ completedBy: null });
    // More attachments or comments than are read: said.
    expect(await read({ comments: { nodes: [], pageInfo: { hasNextPage: true } } })).toMatchObject({ moreUnread: true });
  });

  it("answers gone for an issue Linear does not show, or no longer lets this connection see, and refuses anything not an id", async () => {
    const notFound = json({ data: null, errors: [{ message: "Entity not found: Issue", extensions: { type: "invalid input", code: "INPUT_ERROR", userError: true, userPresentableMessage: "Could not find referenced Issue." } }] }, 400);
    expect(await linearReader(http(() => notFound)).issue("token", "ENG-999")).toEqual({ kind: "gone", reason: "not_found" });
    expect(await linearReader(http(() => json({ data: { issue: null } }))).issue("token", "ENG-999")).toEqual({ kind: "gone", reason: "not_found" });
    expect(await linearReader(http(() => json({ errors: [{ message: "Forbidden", extensions: { code: "FORBIDDEN" } }] }, 400))).issue("token", "ENG-1")).toEqual({ kind: "gone", reason: "forbidden" });
    await expect(linearReader(http(() => json({}))).issue("token", "https://linear.app/x/issue/ENG-1")).rejects.toThrow(ProviderError);
    expect(() => issueVariable("ENG-1 OR 1=1")).toThrow(ProviderError);
    // Another issue answering for a UUID is not believed.
    await expect(linearReader(http(() => json({ data: { issue: issueNode({ id: MAI_ID }) } }))).issue("token", ISSUE_ID)).rejects.toThrow(/another issue/);
  });

  it("looks up the payee's and the member's Linear users by email across the workspace, as Asana's A9 does (Linear acceptance LN9)", async () => {
    const h = http(() =>
      json({
        data: {
          viewer: { id: VIEWER_ID },
          // Only a user whose own email is the one asked counts, whatever else Linear answered.
          payee: { nodes: [{ id: MAI_ID, email: "Mai@Fernhill.example" }, { id: ISSUE_ID, email: "someone@else.example" }] },
        },
      })
    );
    expect(await linearReader(h).people("token", { viewer: true, payeeEmail: " MAI@fernhill.example ", memberEmail: null })).toEqual({ viewerId: VIEWER_ID, payee: [MAI_ID], member: [] });
    const sent = graphqlBody(h.sent[0].init);
    expect(sent).toEqual({ query: peopleQuery({ viewer: true, payee: true, member: false }), variables: { payee: "mai@fernhill.example" } });
    expect(sent.query).toBe(
      "query AcceptancePeople($payee: String!) {   viewer { id }   payee: users(filter: { email: { eqIgnoreCase: $payee } }, includeDisabled: true, first: 10) { nodes { id email } } }"
    );
    // A member who did not connect Linear is known by their own email; each variable is declared only with its part.
    expect(peopleQuery({ viewer: false, payee: true, member: true })).toMatch(/^query AcceptancePeople\(\$payee: String!, \$member: String!\) \{ {3}payee: users\(.*\) \{ nodes \{ id email \} \} {3}member: users\(filter: \{ email: \{ eqIgnoreCase: \$member \} \}/);
    expect(peopleQuery({ viewer: false, payee: true, member: true })).not.toMatch(/viewer/);
  });

  it("asks nothing when there is nothing to compare, and never goes ahead on an answer that leaves a part out", async () => {
    const none = http(() => json({}));
    expect(await linearReader(none).people("token", { viewer: false, payeeEmail: null, memberEmail: "not an email" })).toEqual({ viewerId: null, payee: [], member: [] });
    expect(none.sent).toHaveLength(0);
    const partial = http(() => json({ data: { viewer: { id: VIEWER_ID } } }));
    await expect(linearReader(partial).people("token", { viewer: true, payeeEmail: "mai@fernhill.example", memberEmail: null })).rejects.toThrow(ProviderError);
    const noViewer = http(() => json({ data: { payee: { nodes: [] } } }));
    await expect(linearReader(noViewer).people("token", { viewer: true, payeeEmail: "mai@fernhill.example", memberEmail: null })).rejects.toThrow(/no viewer/);
    const refused = http(() => json({ data: null, errors: [{ message: "Field 'email' is not defined by type 'UserFilter'", extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }] }, 400));
    await expect(linearReader(refused).people("token", { viewer: false, payeeEmail: "mai@fernhill.example", memberEmail: null })).rejects.toThrow(ProviderError);
  });
});

describe("a session on a connection's token (LN12)", () => {
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

  it("refreshes once, under the lease, when Linear answers 401 for a token its expiry says is good, then reads again", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://api.linear.app/oauth/token") {
        calls.push(`refresh ${form(init ?? {}).get("refresh_token")}`);
        return json({ access_token: "lin_oauth_access_2", expires_in: 86399, scope: ["read"], refresh_token: "lin_refresh_2" });
      }
      const token = new Headers(init?.headers).get("authorization");
      calls.push(`graphql ${token}`);
      if (token !== "Bearer lin_oauth_access_2") return json({ errors: [{ message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } }] }, 401);
      return json({ data: { viewer: { id: VIEWER_ID, name: "Duong", organization: { id: ORG_ID, name: "Fernhill" } } } });
    }) as unknown as typeof fetch;
    const provider = linearProvider(SETTINGS, { fetchImpl, now: () => NOW });
    const kept = store({ id: "t-1", version: 1, accessToken: "lin_oauth_access_1", refreshToken: "lin_refresh_1", expiresAt: NOW + 3_600_000, scopes: ["read"] });
    const session = linearSession({ provider, tokens: kept.tokens, now: () => NOW, sleep: async () => undefined });
    expect(await session.call((token) => provider.reader.viewer(token))).toMatchObject({ organizationId: ORG_ID });
    expect(calls).toEqual(["graphql Bearer lin_oauth_access_1", "refresh lin_refresh_1", "graphql Bearer lin_oauth_access_2"]);
    // The new pair Linear rotated to is kept.
    expect(kept.row()).toMatchObject({ version: 2, accessToken: "lin_oauth_access_2", refreshToken: "lin_refresh_2" });
  });

  it("asks for a person when Linear refuses the refresh token, and waits out a short rate limit once", async () => {
    const provider = linearProvider(SETTINGS, { fetchImpl: (async () => json({ error: "invalid_grant" }, 400)) as unknown as typeof fetch, now: () => NOW });
    const expired = store({ id: "t-1", version: 1, accessToken: "old", refreshToken: "lin_refresh_1", expiresAt: 0, scopes: ["read"] });
    const session = linearSession({ provider, tokens: expired.tokens, now: () => NOW, sleep: async () => undefined });
    await expect(session.call(async () => "never")).rejects.toBeInstanceOf(LinearAccessError);
    await expect(session.call(async () => "never")).rejects.toMatchObject({ outcome: { reason: "reconnect" } });

    const waits: number[] = [];
    let limited = true;
    const good = store({ id: "t-2", version: 1, accessToken: "fresh", refreshToken: "r", expiresAt: NOW + 3_600_000, scopes: ["read"] });
    const waiting = linearSession({ provider, tokens: good.tokens, now: () => NOW, sleep: async (ms) => void waits.push(ms) });
    expect(
      await waiting.call(async () => {
        if (limited) {
          limited = false;
          throw new ProviderError("rate_limited", "Linear issue: 400 RATELIMITED", 2_000);
        }
        return "read";
      })
    ).toBe("read");
    expect(waits).toEqual([2_000]);
  });
});
