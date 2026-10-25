import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectRefusal } from "@/lib/connectors/connect-refusal";
import type { ProviderTokens } from "@/lib/connectors/provider";
import { DRIVE_API, GOOGLE_AUTHORIZE, GOOGLE_REVOKE, GOOGLE_TOKEN, GoogleError, SHEETS_API, googleFailure, googleFetch } from "@/lib/googlesheets/http";
import { authorizeUrl, exchangeCode, googleAccount, refreshTokens, revokeToken } from "@/lib/googlesheets/oauth";
import { googleSheetsProvider } from "@/lib/googlesheets/provider";
import { GOOGLE_SHEETS_SCOPES } from "@/lib/googlesheets/settings";

/**
 * Google's OAuth for Google Sheets (docs/superpowers/specs/2026-10-25-close-pack-google-sheets-design.md GS3, GS6, GS12,
 * GS13): the authorize URL asks for drive.file alone, offline, with a fresh consent and nothing folded in; the code
 * exchange and the refresh post forms to Google's token endpoint, a refresh keeping the refresh token Google does not send
 * back; revoking posts the token; the account is the Drive user's permission id with a masked email, and a grant without
 * drive.file is refused before any call. Every call goes to one of five Google addresses, follows no redirect, and logs
 * Google's short reason code, never a token, an email or a body.
 */

const SETTINGS = { clientId: "1234567890-abc123def456.apps.googleusercontent.com", clientSecret: "GOCSPX-the-secret" };
const REDIRECT = "https://www.vestiarion.xyz/api/integrations/googlesheets/callback";
const NOW = Date.parse("2026-10-25T09:00:00Z");
const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
const ACCESS = "ya29.a0-the-access-token";
const REFRESH = "1//0g-the-refresh-token";

type Sent = { url: string; init: RequestInit };
function http(respond: (sent: Sent) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const one = { url: String(input), init: init ?? {} };
    sent.push(one);
    return respond(one);
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const form = (init: RequestInit) => Object.fromEntries(new URLSearchParams(String(init.body)));
const silent = vi.fn(async () => {
  throw new TypeError("network");
}) as unknown as typeof fetch;
const tokens = (scopes: string[] = [DRIVE_FILE]): ProviderTokens => ({ accessToken: ACCESS, refreshToken: REFRESH, expiresAt: NOW + 3_599_000, scopes });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the authorize URL (close pack Sheets GS3)", () => {
  it("is Google's, with drive.file the only scope, offline, a fresh consent and no other grant folded in", () => {
    const url = authorizeUrl(SETTINGS, { state: "vx1.state.sig", redirectUri: REDIRECT });
    expect(url.startsWith(`${GOOGLE_AUTHORIZE}?`)).toBe(true);
    expect(GOOGLE_AUTHORIZE).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const params = new URL(url).searchParams;
    expect(Object.fromEntries(params)).toEqual({
      response_type: "code",
      client_id: SETTINGS.clientId,
      redirect_uri: REDIRECT,
      scope: DRIVE_FILE,
      state: "vx1.state.sig",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "false",
    });
    expect(url).not.toMatch(/openid|email|profile|spreadsheets|auth%2Fdrive(?!\.file)/);
    expect(url).not.toContain(SETTINGS.clientSecret);
  });
});

describe("the code exchange (close pack Sheets GS3, GS13)", () => {
  it("posts the form to Google's token endpoint, and maps expires_in and scope", async () => {
    const { sent, fetchImpl } = http(() => json({ access_token: ACCESS, expires_in: 3599, refresh_token: REFRESH, scope: DRIVE_FILE, token_type: "Bearer" }));
    const outcome = await exchangeCode(SETTINGS, { code: "4/the-code", redirectUri: REDIRECT }, { fetchImpl, now: () => NOW });
    expect(outcome).toEqual({ ok: true, authEventId: null, tokens: { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: NOW + 3_599_000, scopes: [DRIVE_FILE] } });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://oauth2.googleapis.com/token");
    expect(GOOGLE_TOKEN).toBe("https://oauth2.googleapis.com/token");
    expect(sent[0].init.method).toBe("POST");
    expect(new Headers(sent[0].init.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(form(sent[0].init)).toEqual({
      grant_type: "authorization_code",
      code: "4/the-code",
      redirect_uri: REDIRECT,
      client_id: SETTINGS.clientId,
      client_secret: SETTINGS.clientSecret,
    });
    expect(sent[0].init.redirect).toBe("error");
    expect(sent[0].init.cache).toBe("no-store");
    expect(sent[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("keeps the scopes Google granted, which may leave drive.file out", async () => {
    const outcome = await exchangeCode(SETTINGS, { code: "c", redirectUri: REDIRECT }, { ...http(() => json({ access_token: ACCESS, expires_in: 3599, refresh_token: REFRESH, scope: "openid" })), now: () => NOW });
    expect(outcome).toMatchObject({ ok: true, tokens: { scopes: ["openid"] } });
  });

  it("is refused on a 400 and on an answer with no refresh token; unavailable on a 429, a 5xx or no answer", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await exchangeCode(SETTINGS, { code: "c", redirectUri: REDIRECT }, http(() => json({ error: "invalid_grant", error_description: "Bad Request" }, 400)))).toEqual({ ok: false, reason: "refused" });
    expect(await exchangeCode(SETTINGS, { code: "c", redirectUri: REDIRECT }, http(() => json({ access_token: ACCESS, expires_in: 3599, scope: DRIVE_FILE })))).toEqual({ ok: false, reason: "refused" });
    expect(await exchangeCode(SETTINGS, { code: "c", redirectUri: REDIRECT }, http(() => json({}, 429)))).toEqual({ ok: false, reason: "unavailable" });
    expect(await exchangeCode(SETTINGS, { code: "c", redirectUri: REDIRECT }, http(() => json({}, 503)))).toEqual({ ok: false, reason: "unavailable" });
    expect(await exchangeCode(SETTINGS, { code: "c", redirectUri: REDIRECT }, { fetchImpl: silent })).toEqual({ ok: false, reason: "unavailable" });
    expect(await exchangeCode(SETTINGS, { code: "c", redirectUri: REDIRECT }, http(() => new Response("<html>", { status: 200 })))).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("a refresh (close pack Sheets GS13)", () => {
  it("keeps the refresh token it sent, since Google sends none back", async () => {
    const { sent, fetchImpl } = http(() => json({ access_token: "ya29.second", expires_in: 3599, scope: DRIVE_FILE, token_type: "Bearer" }));
    expect(await refreshTokens(SETTINGS, REFRESH, { fetchImpl, now: () => NOW })).toEqual({
      ok: true,
      tokens: { accessToken: "ya29.second", refreshToken: REFRESH, expiresAt: NOW + 3_599_000, scopes: [DRIVE_FILE] },
    });
    expect(sent[0].url).toBe(GOOGLE_TOKEN);
    expect(form(sent[0].init)).toEqual({ grant_type: "refresh_token", refresh_token: REFRESH, client_id: SETTINGS.clientId, client_secret: SETTINGS.clientSecret });
  });

  it("asks for a reconnect when Google no longer takes the grant", async () => {
    for (const error of ["invalid_grant", "unauthorized_client", "invalid_client"]) {
      expect(await refreshTokens(SETTINGS, REFRESH, http(() => json({ error, error_description: "Token has been expired or revoked." }, 400))), error).toEqual({ ok: false, reason: "reconnect" });
    }
    expect(await refreshTokens(SETTINGS, REFRESH, http(() => json({ error: "invalid_client" }, 401)))).toEqual({ ok: false, reason: "reconnect" });
  });

  it("is tried again later on anything else, with Google's Retry-After", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await refreshTokens(SETTINGS, REFRESH, { ...http(() => json({ error: "backend_error" }, 503, { "retry-after": "12" })), now: () => NOW })).toEqual({ ok: false, reason: "unavailable", retryAfterMs: 12_000 });
    expect(await refreshTokens(SETTINGS, REFRESH, { ...http(() => json({ error: "invalid_request" }, 400)), now: () => NOW })).toEqual({ ok: false, reason: "unavailable", retryAfterMs: null });
    expect(await refreshTokens(SETTINGS, REFRESH, { fetchImpl: silent })).toEqual({ ok: false, reason: "unavailable", retryAfterMs: null });
    expect(JSON.stringify(logged.mock.calls)).not.toContain(REFRESH);
  });
});

describe("revoking (close pack Sheets GS14)", () => {
  it("posts token= to Google's revoke endpoint: true on 200, false on 400 and on no answer", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { sent, fetchImpl } = http(() => json({}));
    expect(await revokeToken(REFRESH, { fetchImpl })).toBe(true);
    expect(sent[0].url).toBe("https://oauth2.googleapis.com/revoke");
    expect(GOOGLE_REVOKE).toBe("https://oauth2.googleapis.com/revoke");
    expect(sent[0].init.method).toBe("POST");
    expect(new Headers(sent[0].init.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(form(sent[0].init)).toEqual({ token: REFRESH });
    expect(sent[0].url).not.toContain(REFRESH);
    expect(await revokeToken(REFRESH, http(() => json({ error: "invalid_token" }, 400)))).toBe(false);
    expect(await revokeToken(REFRESH, { fetchImpl: silent })).toBe(false);
  });
});

describe("the account a grant reaches (close pack Sheets GS3, GS6)", () => {
  const ABOUT = { user: { kind: "drive#user", displayName: "Duong", emailAddress: "duong@gmail.com", permissionId: "07623471185212345678" } };

  it("calls about with the user's fields and the bearer token, and keeps the permission id and a masked email", async () => {
    const { sent, fetchImpl } = http(() => json(ABOUT));
    expect(await googleAccount(tokens(), { fetchImpl })).toEqual([{ externalOrgId: "07623471185212345678", name: "du***@gmail.com", connectionId: null }]);
    expect(sent).toHaveLength(1);
    const url = new URL(sent[0].url);
    expect(`${url.origin}${url.pathname}`).toBe(`${DRIVE_API}/about`);
    expect(url.searchParams.get("fields")).toBe("user(displayName,emailAddress,permissionId)");
    expect(new Headers(sent[0].init.headers).get("authorization")).toBe(`Bearer ${ACCESS}`);
    expect(sent[0].init.method).toBe("GET");
  });

  it("names the account 'A Google account' when Google gives no email", async () => {
    expect(await googleAccount(tokens(), http(() => json({ user: { permissionId: "07623471185212345678" } })))).toEqual([
      { externalOrgId: "07623471185212345678", name: "A Google account", connectionId: null },
    ]);
    expect(await googleAccount(tokens(), http(() => json({ user: { permissionId: "07623471185212345678", emailAddress: "not an email" } })))).toEqual([
      { externalOrgId: "07623471185212345678", name: "A Google account", connectionId: null },
    ]);
  });

  it("refuses a grant without drive.file before any call, as scopes", async () => {
    const { sent, fetchImpl } = http(() => json(ABOUT));
    const refused = googleAccount(tokens(["openid"]), { fetchImpl });
    await expect(refused).rejects.toBeInstanceOf(ConnectRefusal);
    await expect(googleAccount(tokens([]), { fetchImpl })).rejects.toMatchObject({ outcome: "scopes" });
    expect(sent).toHaveLength(0);
  });

  it("is a bad response when the permission id does not read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const permissionId of ["", "a b", "../x", "x".repeat(101), 42, null]) {
      await expect(googleAccount(tokens(), http(() => json({ user: { permissionId, emailAddress: "duong@gmail.com" } }))), String(permissionId)).rejects.toMatchObject({ failure: "bad_response" });
    }
    await expect(googleAccount(tokens(), http(() => json({ error: { code: 401, status: "UNAUTHENTICATED" } }, 401)))).rejects.toMatchObject({ failure: "unauthorized" });
  });

  it("is the provider's organisations, with the core's other calls", async () => {
    const provider = googleSheetsProvider(SETTINGS, http(() => json(ABOUT)));
    expect(provider.id).toBe("googlesheets");
    expect(provider.label).toBe("Google Sheets");
    expect(provider.scopes).toEqual([...GOOGLE_SHEETS_SCOPES]);
    expect(provider.exclusive).toBeFalsy();
    expect(await provider.organisations(tokens(), null)).toEqual([{ externalOrgId: "07623471185212345678", name: "du***@gmail.com", connectionId: null }]);
    expect(provider.authorizeUrl({ state: "s", redirectUri: REDIRECT })).toBe(authorizeUrl(SETTINGS, { state: "s", redirectUri: REDIRECT }));
  });
});

describe("googleFetch (close pack Sheets GS12)", () => {
  it("goes only to Google's five addresses, follows no redirect, and stores nothing", async () => {
    const { sent, fetchImpl } = http(() => json({}));
    for (const url of [`${GOOGLE_TOKEN}`, `${GOOGLE_REVOKE}`, `${DRIVE_API}/files`, `${SHEETS_API}/spreadsheets/x`]) await googleFetch(url, { method: "GET" }, "test", { fetchImpl });
    expect(sent.map((one) => new URL(one.url).hostname)).toEqual(["oauth2.googleapis.com", "oauth2.googleapis.com", "www.googleapis.com", "sheets.googleapis.com"]);
    for (const one of sent) {
      expect(one.init.redirect).toBe("error");
      expect(one.init.cache).toBe("no-store");
      expect(one.init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(DRIVE_API).toBe("https://www.googleapis.com/drive/v3");
    expect(SHEETS_API).toBe("https://sheets.googleapis.com/v4");
  });

  it("refuses any other host before sending", async () => {
    const { sent, fetchImpl } = http(() => json({}));
    for (const url of ["https://evil.test/drive/v3/files", "https://www.googleapis.com.evil.test/x", "http://www.googleapis.com/drive/v3/files", "https://docs.google.com/spreadsheets/d/x", "https://example.com"]) {
      await expect(googleFetch(url, { method: "GET" }, "test", { fetchImpl }), url).rejects.toMatchObject({ failure: "bad_response" });
    }
    expect(sent).toHaveLength(0);
  });

  it("is unavailable when Google does not answer", async () => {
    await expect(googleFetch(`${DRIVE_API}/files`, { method: "GET" }, "files.list", { fetchImpl: silent })).rejects.toMatchObject({ failure: "unavailable" });
  });
});

describe("googleFailure (close pack Sheets GS12)", () => {
  const driveError = (status: number, reason: string, headers: Record<string, string> = {}) =>
    json({ error: { code: status, message: "The user duong@gmail.com secret payee name", errors: [{ domain: "usageLimits", reason, message: "duong@gmail.com" }] } }, status, headers);
  const sheetsError = (status: number, state: string, reason?: string) =>
    json({ error: { code: status, message: "Payee Harbor Print", status: state, details: reason ? [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain: "googleapis.com" }] : [] } }, status);
  const failure = async (response: Response, onFile = false) => {
    const error = await googleFailure(response, "a call", NOW, onFile);
    return { failure: error.failure, retryAfterMs: error.retryAfterMs };
  };

  it("reads Google's short reason code into the core's failures", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await failure(json({}, 429, { "retry-after": "2" }))).toEqual({ failure: "rate_limited", retryAfterMs: 2000 });
    expect(await failure(json({}, 429))).toEqual({ failure: "rate_limited", retryAfterMs: 30_000 });
    expect(await failure(driveError(403, "userRateLimitExceeded"))).toEqual({ failure: "rate_limited", retryAfterMs: 30_000 });
    expect(await failure(driveError(403, "rateLimitExceeded"))).toEqual({ failure: "rate_limited", retryAfterMs: 30_000 });
    expect(await failure(sheetsError(429, "RESOURCE_EXHAUSTED", "RATE_LIMIT_EXCEEDED"))).toEqual({ failure: "rate_limited", retryAfterMs: 30_000 });
    expect(await failure(sheetsError(401, "UNAUTHENTICATED"))).toMatchObject({ failure: "unauthorized" });
    expect(await failure(driveError(403, "storageQuotaExceeded"))).toMatchObject({ failure: "drive_full" });
    expect(await failure(driveError(403, "insufficientPermissions"))).toMatchObject({ failure: "reconnect" });
    expect(await failure(sheetsError(403, "PERMISSION_DENIED", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"))).toMatchObject({ failure: "reconnect" });
    expect(await failure(json({ error: { code: 404, status: "NOT_FOUND" } }, 404), true)).toMatchObject({ failure: "gone" });
    expect(await failure(driveError(403, "insufficientFilePermissions"), true)).toMatchObject({ failure: "gone" });
    expect(await failure(json({ error: { code: 404 } }, 404))).toMatchObject({ failure: "bad_response" });
    expect(await failure(driveError(403, "insufficientFilePermissions"))).toMatchObject({ failure: "forbidden" });
    expect(await failure(sheetsError(403, "PERMISSION_DENIED"))).toMatchObject({ failure: "forbidden" });
    expect(await failure(driveError(403, "domainPolicy"))).toMatchObject({ failure: "forbidden" });
    expect(await failure(json({}, 500))).toMatchObject({ failure: "unavailable" });
    expect(await failure(new Response("<html>bad gateway</html>", { status: 502 }))).toMatchObject({ failure: "unavailable" });
    expect(await failure(json({ error: { code: 400, status: "INVALID_ARGUMENT" } }, 400))).toMatchObject({ failure: "bad_response" });
    expect(await failure(new Response("not json", { status: 400 }))).toMatchObject({ failure: "bad_response" });
  });

  it("logs the call, the status and the reason code, never Google's message, an email, a token or a body", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = await googleFailure(driveError(403, "storageQuotaExceeded"), "values.batchUpdate", NOW);
    await googleFailure(json({ error: { errors: [{ reason: "has spaces <b>" }], status: `Bearer ${ACCESS}` } }, 400), "files.list", NOW);
    expect(logged).toHaveBeenCalledWith("google sheets: values.batchUpdate answered 403 storageQuotaExceeded");
    expect(logged).toHaveBeenCalledWith("google sheets: files.list answered 400");
    const all = `${JSON.stringify(logged.mock.calls)} ${error.message}`;
    for (const secret of ["duong@gmail.com", "secret payee", ACCESS, "<b>", "has spaces"]) expect(all).not.toContain(secret);
    expect(error).toBeInstanceOf(GoogleError);
  });
});
