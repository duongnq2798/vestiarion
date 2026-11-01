import { afterEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { fakeSupabase, orgTestContext, type RecordedRequest } from "./support/fake-supabase";

vi.mock("server-only", () => ({}));
const { appendEntryMock } = vi.hoisted(() => ({ appendEntryMock: vi.fn() }));
vi.mock("@/lib/ledger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ledger")>()),
  appendLedgerEntry: appendEntryMock,
}));

import { GET as callback } from "@/app/api/integrations/googledrive/callback/route";
import { POST as connect } from "@/app/api/integrations/googledrive/connect/route";
import { accountingProvider, accountingProviderOn } from "@/lib/accounting-providers";
import { BOOKS_PAYMENTS, PICKS_PAYMENT_ACCOUNT } from "@/lib/connectors/booking";
import { ConnectRefusal } from "@/lib/connectors/connect-refusal";
import { EXPORT_NEVER_DUE, saveConnection } from "@/lib/connectors/connections";
import { CONSENT_HISTORY, CONSENT_VERSIONS, consentStatement } from "@/lib/connectors/consent";
import { PROVIDER_KINDS, PROVIDER_LABELS, PROVIDER_WORDS, providerKind, UNMARKED_PROVIDERS, type ProviderTokens } from "@/lib/connectors/provider";
import { connectionStatus, syncErrorWords } from "@/lib/connectors/status";
import { crmProvider } from "@/lib/crm-providers";
import { googleDriveConnectDeps } from "@/lib/googledrive/connect-deps";
import { googleDriveProvider } from "@/lib/googledrive/provider";
import { GOOGLE_DRIVE_SCOPES, googleDriveSettingsFromEnv } from "@/lib/googledrive/settings";
import { GOOGLE_AUTHORIZE, GOOGLE_REVOKE, GOOGLE_TOKEN } from "@/lib/googlesheets/http";
import { authorizeUrl } from "@/lib/googlesheets/oauth";
import { googleSheetsProvider } from "@/lib/googlesheets/provider";

/**
 * Google Drive on the connector core (docs/superpowers/specs/2026-11-01-google-drive-intake-design.md GD1, GD2, GD3):
 * a provider of a new kind, intake, on only with its own client; OAuth with drive.readonly alone, through Google's calls
 * that Google Sheets makes too and with Sheets' own asking unchanged; the account is the Drive user's permission id and
 * a masked email; a grant without drive.readonly is refused before any call; no booking, review or CRM path takes it; its
 * connection is due at once, and every 15 minutes after, unlike Sheets'; and its words say what comes in.
 */

const SETTINGS = { clientId: "1234567890-abc123def456.apps.googleusercontent.com", clientSecret: "GOCSPX-the-drive-secret" };
const REDIRECT = "https://www.vestiarion.xyz/api/integrations/googledrive/callback";
const NOW = Date.parse("2026-11-01T09:00:00Z");
const READONLY = "https://www.googleapis.com/auth/drive.readonly";
const ACCESS = "ya29.a0-the-access-token";
const REFRESH = "1//0g-the-refresh-token";
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-0000000d7c01";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000d7c02";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

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
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const form = (init: RequestInit) => Object.fromEntries(new URLSearchParams(String(init.body)));
const tokens = (scopes: string[] = [READONLY]): ProviderTokens => ({ accessToken: ACCESS, refreshToken: REFRESH, expiresAt: NOW + 3_599_000, scopes });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  appendEntryMock.mockReset();
});

describe("Google Drive's client (Google Drive intake GD1)", () => {
  it("is on only with both variables, the id checked as Google Sheets checks its own, never logging a value", () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(googleDriveSettingsFromEnv({})).toBeNull();
    expect(googleDriveSettingsFromEnv({ GOOGLE_DRIVE_CLIENT_ID: SETTINGS.clientId })).toBeNull();
    expect(googleDriveSettingsFromEnv({ GOOGLE_DRIVE_CLIENT_SECRET: SETTINGS.clientSecret })).toBeNull();
    // Google Sheets' variables are not Google Drive's.
    expect(googleDriveSettingsFromEnv({ GOOGLE_SHEETS_CLIENT_ID: SETTINGS.clientId, GOOGLE_SHEETS_CLIENT_SECRET: SETTINGS.clientSecret })).toBeNull();
    expect(googleDriveSettingsFromEnv({ GOOGLE_DRIVE_CLIENT_ID: ` ${SETTINGS.clientId} `, GOOGLE_DRIVE_CLIENT_SECRET: SETTINGS.clientSecret })).toEqual(SETTINGS);
    expect(googleDriveSettingsFromEnv({ GOOGLE_DRIVE_CLIENT_ID: "not-a-client", GOOGLE_DRIVE_CLIENT_SECRET: "s" })).toBeNull();
    expect(warned).toHaveBeenCalledWith("Google Drive is off: GOOGLE_DRIVE_CLIENT_ID is not a Google OAuth client id");
    expect(JSON.stringify(warned.mock.calls)).not.toContain("not-a-client");
  });

  it("has no connect route or callback without it", async () => {
    vi.stubEnv("GOOGLE_DRIVE_CLIENT_ID", "");
    vi.stubEnv("GOOGLE_DRIVE_CLIENT_SECRET", "");
    expect((await connect(new Request("https://www.vestiarion.xyz/api/integrations/googledrive/connect", { method: "POST" }))).status).toBe(404);
    expect((await callback(new Request(`${REDIRECT}?code=c&state=s`))).status).toBe(404);
  });
});

describe("connecting (Google Drive intake GD2)", () => {
  it("asks Google for drive.readonly alone, offline, with a fresh consent, at Google Drive's own callback", () => {
    const provider = googleDriveProvider(SETTINGS);
    expect(provider.scopes).toEqual([READONLY]);
    expect(GOOGLE_DRIVE_SCOPES).toEqual([READONLY]);
    const url = provider.authorizeUrl({ state: "vx1.state.sig", redirectUri: REDIRECT });
    expect(url.startsWith(`${GOOGLE_AUTHORIZE}?`)).toBe(true);
    expect(Object.fromEntries(new URL(url).searchParams)).toEqual({
      response_type: "code",
      client_id: SETTINGS.clientId,
      redirect_uri: REDIRECT,
      scope: READONLY,
      state: "vx1.state.sig",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "false",
    });
    expect(url).not.toMatch(/openid|email|profile|drive\.file|spreadsheets/);
    expect(url).not.toContain(SETTINGS.clientSecret);
    expect(googleDriveConnectDeps(SETTINGS).provider.id).toBe("googledrive");
  });

  it("leaves Google Sheets asking for drive.file alone", () => {
    const sheets = new URL(googleSheetsProvider(SETTINGS).authorizeUrl({ state: "s", redirectUri: "https://www.vestiarion.xyz/api/integrations/googlesheets/callback" }));
    expect(sheets.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
    expect(new URL(authorizeUrl(SETTINGS, { state: "s", redirectUri: REDIRECT })).searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
  });

  it("exchanges the code and refreshes with Drive's own client at Google's token endpoint, keeping the refresh token sent", async () => {
    const { sent, fetchImpl } = http(() => json({ access_token: ACCESS, expires_in: 3599, refresh_token: REFRESH, scope: READONLY, token_type: "Bearer" }));
    const provider = googleDriveProvider(SETTINGS, { fetchImpl, now: () => NOW });
    expect(await provider.exchangeCode({ code: "4/the-code", redirectUri: REDIRECT })).toEqual({
      ok: true,
      authEventId: null,
      tokens: { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: NOW + 3_599_000, scopes: [READONLY] },
    });
    expect(sent[0].url).toBe(GOOGLE_TOKEN);
    expect(form(sent[0].init)).toEqual({ grant_type: "authorization_code", code: "4/the-code", redirect_uri: REDIRECT, client_id: SETTINGS.clientId, client_secret: SETTINGS.clientSecret });

    const refreshed = http(() => json({ access_token: "ya29.second", expires_in: 3599, scope: READONLY, token_type: "Bearer" }));
    expect(await googleDriveProvider(SETTINGS, { fetchImpl: refreshed.fetchImpl, now: () => NOW }).refresh(REFRESH)).toEqual({
      ok: true,
      tokens: { accessToken: "ya29.second", refreshToken: REFRESH, expiresAt: NOW + 3_599_000, scopes: [READONLY] },
    });
    expect(form(refreshed.sent[0].init)).toEqual({ grant_type: "refresh_token", refresh_token: REFRESH, client_id: SETTINGS.clientId, client_secret: SETTINGS.clientSecret });
  });

  it("asks for a reconnect when Google answers invalid_grant to a refresh, and logs under Google Drive's name", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const provider = googleDriveProvider(SETTINGS, http(() => json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400)));
    expect(await provider.refresh(REFRESH)).toEqual({ ok: false, reason: "reconnect" });
    const failing = googleDriveProvider(SETTINGS, http(() => json({ error: "server_error" }, 503)));
    expect(await failing.refresh(REFRESH)).toMatchObject({ ok: false, reason: "unavailable" });
    expect(logged).toHaveBeenCalledWith("google drive: a refresh failed", 503);
    expect(JSON.stringify(logged.mock.calls)).not.toContain(REFRESH);
  });

  it("names the account from Drive's about: its permission id, and its email masked", async () => {
    const { sent, fetchImpl } = http(() => json({ user: { kind: "drive#user", displayName: "Duong Nguyen", permissionId: "07623471185212345678", emailAddress: "duongnq@gmail.com" } }));
    const accounts = await googleDriveProvider(SETTINGS, { fetchImpl }).organisations(tokens(), null);
    expect(accounts).toEqual([{ externalOrgId: "07623471185212345678", name: "du***@gmail.com", connectionId: null }]);
    expect(sent[0].url).toBe("https://www.googleapis.com/drive/v3/about?fields=user%28displayName%2CemailAddress%2CpermissionId%29");
    expect(new Headers(sent[0].init.headers).get("authorization")).toBe(`Bearer ${ACCESS}`);
  });

  it("refuses a grant without drive.readonly before any call, a drive.file grant included", async () => {
    const { sent, fetchImpl } = http(() => json({}));
    const provider = googleDriveProvider(SETTINGS, { fetchImpl });
    await expect(provider.organisations(tokens(["https://www.googleapis.com/auth/drive.file"]), null)).rejects.toBeInstanceOf(ConnectRefusal);
    await expect(provider.organisations(tokens([]), null)).rejects.toBeInstanceOf(ConnectRefusal);
    expect(sent).toEqual([]);
  });

  it("revokes at Google's revoke endpoint", async () => {
    const { sent, fetchImpl } = http(() => new Response("", { status: 200 }));
    expect(await googleDriveProvider(SETTINGS, { fetchImpl }).revoke(REFRESH)).toBe(true);
    expect(sent[0].url).toBe(GOOGLE_REVOKE);
    expect(form(sent[0].init)).toEqual({ token: REFRESH });
  });
});

describe("the googledrive provider id (Google Drive intake GD1)", () => {
  it("is an unmarked intake tool, with its label, words and consent", () => {
    expect(PROVIDER_LABELS.googledrive).toBe("Google Drive");
    expect(PROVIDER_KINDS.googledrive).toBe("intake");
    expect(providerKind("Google Drive")).toBe("intake");
    expect(UNMARKED_PROVIDERS).toContain("googledrive");
    expect(PROVIDER_WORDS.googledrive).toMatchObject({ possessive: "Google Drive's", organisation: "Google account", idleDays: 0, bills: "new files in its folder" });
    expect(CONSENT_VERSIONS.googledrive).toBe("googledrive-2026-11-01");
    expect(CONSENT_HISTORY.googledrive).toEqual(["googledrive-2026-11-01"]);
  });

  it("is taken by no booking, accounting or CRM path", () => {
    vi.stubEnv("GOOGLE_DRIVE_CLIENT_ID", SETTINGS.clientId);
    vi.stubEnv("GOOGLE_DRIVE_CLIENT_SECRET", SETTINGS.clientSecret);
    expect(BOOKS_PAYMENTS.googledrive).toBe(false);
    expect(PICKS_PAYMENT_ACCOUNT.googledrive).toBe(false);
    expect(accountingProvider("googledrive")).toBeNull();
    expect(accountingProviderOn("googledrive")).toBe(false);
    expect(crmProvider("googledrive")).toBeNull();
  });

  it("says the permission reaches every file the account sees, that one folder is read, and that a person adds each bill (GD2, GD9)", () => {
    const lines = consentStatement("googledrive");
    expect(lines).toHaveLength(6);
    expect(lines[0]).toContain("drive.readonly");
    expect(lines[0]).toContain("Google's permission lets it see every file the Google account you connect can see.");
    expect(lines[0]).toContain("Vestiarion reads only the one folder an owner or admin of this workspace chooses, and writes nothing to your Drive.");
    expect(lines[2]).toContain("never the file itself");
    expect(lines[3]).toContain("a file in the folder is never by itself a reason to pay");
    expect(lines[5]).toContain("forgets the folder");
  });

  it("speaks of the folder's files when Google no longer takes the grant, and keeps the files read when disconnected (GD2, GD13)", () => {
    expect(syncErrorWords("reconnect", "Google Drive", null)).toBe(
      "Google no longer accepts this connection: its access was removed in the Google Account. Reconnect Google Drive to go on reading the new files in its folder."
    );
    const facts = { providerLabel: "Google Drive", externalOrgName: "du***@gmail.com", lastSyncedAt: null, lastError: null, lastErrorAt: null, syncing: null };
    expect(connectionStatus({ ...facts, status: "revoked" }, NOW)).toMatchObject({
      title: "Disconnected from du***@gmail.com",
      detail: ["Files already read stay in the review list on Bills & receivables. Nothing more is read from Google Drive."],
    });
    expect(connectionStatus({ ...facts, status: "needs_reconnect" }, NOW)).toMatchObject({ tone: "error", reconnect: true, detail: [syncErrorWords("reconnect", "Google Drive", null)] });
  });
});

describe("saveConnection for an intake tool (Google Drive intake GD3, GD7)", () => {
  it("saves a Google Drive connection due at once, unlike Sheets', and signs where its files come in", async () => {
    const fake = fakeSupabase((request) => {
      if (request.path === "/rest/v1/accounting_connections" && request.method === "POST") {
        const body = request.body as Record<string, unknown>;
        return {
          body: [
            {
              id: "conn-drive", org_id: ORG, provider: body.provider, external_org_id: body.external_org_id, external_org_name: body.external_org_name, status: "connected",
              scopes: body.scopes, connected_by: USER, connected_at: body.connected_at, consent_version: "googledrive-2026-11-01", consented_at: "2026-11-01T08:59:00.000Z",
              revoked_at: null, window_from: body.window_from, last_synced_at: null, last_error: null, last_error_at: null, failures: 0, next_sync_after: body.next_sync_after,
              sync_lease_until: null, payment_account: null, payment_account_at: null,
            },
          ],
        };
      }
      return { body: [] };
    });
    const saved = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: USER }), () =>
      saveConnection({
        provider: "googledrive",
        organisation: { externalOrgId: "07623471185212345678", name: "du***@gmail.com", connectionId: null },
        connectedBy: USER,
        scopes: [READONLY],
        consent: { version: "googledrive-2026-11-01", at: "2026-11-01T08:59:00.000Z" },
        nowMs: NOW,
      })
    );
    expect(saved).toMatchObject({ ok: true, reconnected: false });
    const insert = fake.requests.find((request: RecordedRequest) => request.path === "/rest/v1/accounting_connections" && request.method === "POST");
    expect(insert?.body).toMatchObject({ provider: "googledrive", next_sync_after: null });
    expect((insert?.body as Record<string, unknown>).next_sync_after).not.toBe(EXPORT_NEVER_DUE);
    expect(appendEntryMock.mock.calls[0][0]).toMatchObject({
      action: "accounting_connected",
      summary: "Connected Google Drive: du***@gmail.com. Once a folder is chosen in Settings, the files added to it come in for review on Bills & receivables",
    });
  });
});
