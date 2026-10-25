import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { ORG_ROLES, type OrgRole } from "@/lib/auth/roles";
import { closePackMonth } from "@/lib/close-pack/month";
import { NotSetUpError, toConnection, type ConnectionRow } from "@/lib/connectors/connections";
import { closePackSheetsView, googleSheetsPanelFor } from "@/lib/googlesheets/panel";
import { googleSheetsReady } from "@/lib/googlesheets/ready";
import { closePackSheetsViewOf, googleSheetsPanelView, type GoogleSheetsPanelView } from "@/lib/googlesheets/views";
import { fakeSupabase, orgTestContext, type RecordedRequest } from "./support/fake-supabase";

/**
 * What the Settings card and the close pack page show of Google Sheets
 * (docs/superpowers/specs/2026-10-25-close-pack-google-sheets-design.md GS2, GS5, GS6, "Screens and copy"): nothing at
 * all without the deployment's Google client; "not set up" with the client before migration 0145; the masked account
 * for every member; the export button for an owner, admin or accountant; connecting for an owner or admin only; and the
 * month's last export with its link, built from a checked id.
 */

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-0000000a6c01";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000a6c02";
const ID = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const OCTOBER = closePackMonth("2026-10", new Date("2026-11-02T09:00:00Z"))!;
const RECONNECT_WORDS =
  "Google no longer accepts this connection: its access was removed in the Google Account, or it went unused for six months. Reconnect Google Sheets to export close packs again.";

function row(overrides: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    id: "conn-sheets", org_id: ORG, provider: "googlesheets", external_org_id: "07623471185212345678", external_org_name: "du***@gmail.com", status: "connected",
    scopes: ["https://www.googleapis.com/auth/drive.file"], connected_by: USER, connected_at: "2026-10-25T08:00:00Z", consent_version: "googlesheets-2026-10-25",
    consented_at: "2026-10-25T08:00:00Z", revoked_at: null, window_from: "2026-07-27", last_synced_at: null, last_error: null, last_error_at: null, failures: 0,
    next_sync_after: "9999-12-31T00:00:00.000Z", sync_lease_until: null, payment_account: null, payment_account_at: null,
    ...overrides,
  };
}

function scope(options: { connection?: ConnectionRow | null; ready?: "yes" | "missing" | "broken"; last?: Array<{ ts: string; detail: Record<string, unknown> }>; ledgerFails?: boolean } = {}) {
  const fake = fakeSupabase((request: RecordedRequest) => {
    if (request.path === "/rest/v1/rpc/googlesheets_connector_ready") {
      if (options.ready === "missing") return { status: 404, body: { code: "PGRST202", message: "Could not find the function public.googlesheets_connector_ready" } };
      if (options.ready === "broken") return { status: 500, body: { code: "XX000", message: "the database is down" } };
      return { body: true };
    }
    if (request.path === "/rest/v1/accounting_connections") return { body: options.connection === null ? [] : [options.connection ?? row()] };
    if (request.path === "/rest/v1/ledger_entries") return options.ledgerFails ? { status: 500, body: { code: "XX000", message: "down" } } : { body: options.last ?? [] };
    return { body: [] };
  });
  const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: USER }), fn);
  return { fake, run };
}

const withClient = () => {
  vi.stubEnv("GOOGLE_SHEETS_CLIENT_ID", "1234567890-abc123def456.apps.googleusercontent.com");
  vi.stubEnv("GOOGLE_SHEETS_CLIENT_SECRET", "GOCSPX-the-secret");
};

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("googleSheetsReady (close pack Sheets GS2, GS19)", () => {
  it("passes once migration 0145 has run, asking with the workspace", async () => {
    const { run, fake } = scope();
    await expect(run(() => googleSheetsReady())).resolves.toBeUndefined();
    expect(fake.requests[0].body).toEqual({ p_org_id: ORG });
  });

  it("is not set up before it, and throws on any other error", async () => {
    await expect(scope({ ready: "missing" }).run(() => googleSheetsReady())).rejects.toBeInstanceOf(NotSetUpError);
    await expect(scope({ ready: "broken" }).run(() => googleSheetsReady())).rejects.toThrow("the database is down");
  });
});

describe("googleSheetsPanelView (the Google Sheets card)", () => {
  it("names the account by its masked email in every state", () => {
    expect(googleSheetsPanelView(null)).toEqual({ state: "not_connected" });
    expect(googleSheetsPanelView(toConnection(row()))).toEqual({ state: "connected", account: "du***@gmail.com", connectedAt: "Oct 25" });
    expect(googleSheetsPanelView(toConnection(row({ status: "needs_reconnect", last_error: RECONNECT_WORDS })))).toEqual({ state: "needs_reconnect", account: "du***@gmail.com", words: RECONNECT_WORDS });
    expect(googleSheetsPanelView(toConnection(row({ status: "needs_reconnect" })))).toEqual({ state: "needs_reconnect", account: "du***@gmail.com", words: RECONNECT_WORDS });
    expect(googleSheetsPanelView(toConnection(row({ status: "revoked", revoked_at: "2026-10-26T08:00:00Z" })))).toEqual({ state: "revoked", account: "du***@gmail.com" });
    expect(googleSheetsPanelView(toConnection(row({ external_org_name: null })))).toMatchObject({ account: "A Google account" });
  });
});

describe("closePackSheetsViewOf (the close pack page, close pack Sheets GS5)", () => {
  const connected: GoogleSheetsPanelView = { state: "connected", account: "du***@gmail.com", connectedAt: "Oct 25" };
  const last = { at: "2026-10-25 14:03 UTC", payments: 14, url: `https://docs.google.com/spreadsheets/d/${ID}/edit` };
  const view = (panel: GoogleSheetsPanelView | null, role: OrgRole) => closePackSheetsViewOf({ panel, role, last });

  it("is hidden off and before 0145, for every role", () => {
    for (const role of ORG_ROLES) {
      expect(view(null, role)).toEqual({ state: "hidden" });
      expect(view({ state: "not_set_up" }, role)).toEqual({ state: "hidden" });
    }
  });

  it("asks an owner or admin to connect, tells an accountant who can, and shows an approver or viewer nothing", () => {
    for (const panel of [{ state: "not_connected" } as const, { state: "revoked", account: "du***@gmail.com" } as const]) {
      expect(view(panel, "owner")).toEqual({ state: "connect", canConnect: true });
      expect(view(panel, "admin")).toEqual({ state: "connect", canConnect: true });
      expect(view(panel, "accountant")).toEqual({ state: "connect", canConnect: false });
      expect(view(panel, "approver")).toEqual({ state: "hidden" });
      expect(view(panel, "viewer")).toEqual({ state: "hidden" });
    }
  });

  it("says a reconnect is needed, with the button for an owner or admin only", () => {
    const panel: GoogleSheetsPanelView = { state: "needs_reconnect", account: "du***@gmail.com", words: RECONNECT_WORDS };
    expect(view(panel, "owner")).toEqual({ state: "reconnect", canConnect: true });
    expect(view(panel, "admin")).toEqual({ state: "reconnect", canConnect: true });
    expect(view(panel, "accountant")).toEqual({ state: "reconnect", canConnect: false });
    expect(view(panel, "approver")).toEqual({ state: "hidden" });
    expect(view(panel, "viewer")).toEqual({ state: "hidden" });
  });

  it("gives the export button to an owner, admin or accountant, and the last export to every member", () => {
    for (const role of ORG_ROLES) {
      expect(view(connected, role)).toEqual({ state: "ready", account: "du***@gmail.com", canExport: role === "owner" || role === "admin" || role === "accountant", last });
    }
    expect(closePackSheetsViewOf({ panel: connected, role: "viewer", last: null })).toEqual({ state: "ready", account: "du***@gmail.com", canExport: false, last: null });
  });
});

describe("googleSheetsPanelFor (the Settings card, close pack Sheets GS2)", () => {
  it("is null without the deployment's Google client, and reads nothing", async () => {
    const { run, fake } = scope();
    expect(await run(() => googleSheetsPanelFor())).toBeNull();
    expect(fake.requests).toEqual([]);
  });

  it("says not set up with the client before 0145", async () => {
    withClient();
    expect(await scope({ ready: "missing" }).run(() => googleSheetsPanelFor())).toEqual({ state: "not_set_up" });
  });

  it("reads the workspace's connection", async () => {
    withClient();
    expect(await scope({ connection: null }).run(() => googleSheetsPanelFor())).toEqual({ state: "not_connected" });
    const { run, fake } = scope();
    expect(await run(() => googleSheetsPanelFor())).toEqual({ state: "connected", account: "du***@gmail.com", connectedAt: "Oct 25" });
    const read = fake.requests.find((request) => request.path === "/rest/v1/accounting_connections");
    expect(read?.params.get("provider")).toBe("eq.googlesheets");
  });
});

describe("closePackSheetsView (the close pack page)", () => {
  const LAST = { ts: "2026-10-25T14:03:27.000Z", detail: { format: "google_sheets", month: "2026-10", payments: 14, spreadsheetId: ID, connectionId: "conn-sheets", sha256: "ab".repeat(32) } };

  it("is hidden without the client, reading nothing", async () => {
    const { run, fake } = scope({ last: [LAST] });
    expect(await run(() => closePackSheetsView({ month: OCTOBER, role: "owner" }))).toEqual({ state: "hidden" });
    expect(fake.requests).toEqual([]);
  });

  it("shows the month's last export to Google Sheets, read from the ledger, with a link from its checked id", async () => {
    withClient();
    const { run, fake } = scope({ last: [LAST] });
    expect(await run(() => closePackSheetsView({ month: OCTOBER, role: "viewer" }))).toEqual({
      state: "ready",
      account: "du***@gmail.com",
      canExport: false,
      last: { at: "2026-10-25 14:03 UTC", payments: 14, url: `https://docs.google.com/spreadsheets/d/${ID}/edit` },
    });
    const read = fake.requests.find((request) => request.path === "/rest/v1/ledger_entries")!;
    expect(read.params.get("action")).toBe("eq.close_pack_exported");
    expect(read.params.get("detail->>format")).toBe("eq.google_sheets");
    expect(read.params.get("detail->>month")).toBe("eq.2026-10");
    expect(read.params.get("order")).toBe("seq.desc");
    expect(read.params.get("limit")).toBe("1");
  });

  it("shows no last export when none was made, or its id does not read as a spreadsheet's", async () => {
    withClient();
    expect(await scope({ last: [] }).run(() => closePackSheetsView({ month: OCTOBER, role: "accountant" }))).toEqual({ state: "ready", account: "du***@gmail.com", canExport: true, last: null });
    const bad = { ...LAST, detail: { ...LAST.detail, spreadsheetId: "https://evil.test/x" } };
    expect(await scope({ last: [bad] }).run(() => closePackSheetsView({ month: OCTOBER, role: "owner" }))).toMatchObject({ state: "ready", last: null });
    const noCount = { ...LAST, detail: { ...LAST.detail, payments: "many" } };
    expect(await scope({ last: [noCount] }).run(() => closePackSheetsView({ month: OCTOBER, role: "owner" }))).toMatchObject({ state: "ready", last: null });
  });

  it("is hidden before 0145, and for a read that fails, logged", async () => {
    withClient();
    expect(await scope({ ready: "missing" }).run(() => closePackSheetsView({ month: OCTOBER, role: "owner" }))).toEqual({ state: "hidden" });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await scope({ ledgerFails: true }).run(() => closePackSheetsView({ month: OCTOBER, role: "owner" }))).toEqual({ state: "hidden" });
    expect(await scope({ ready: "broken" }).run(() => closePackSheetsView({ month: OCTOBER, role: "owner" }))).toEqual({ state: "hidden" });
    expect(logged).toHaveBeenCalledWith("google sheets: the close pack page's view was not read", "Error");
  });

  it("does not read the last export when there is no button or line to show it on", async () => {
    withClient();
    const { run, fake } = scope({ connection: null, last: [LAST] });
    expect(await run(() => closePackSheetsView({ month: OCTOBER, role: "owner" }))).toEqual({ state: "connect", canConnect: true });
    expect(fake.requests.some((request) => request.path === "/rest/v1/ledger_entries")).toBe(false);
  });
});
