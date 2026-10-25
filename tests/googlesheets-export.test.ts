import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { fakeSupabase, orgTestContext, type RecordedRequest } from "./support/fake-supabase";

const { appendEntryMock } = vi.hoisted(() => ({ appendEntryMock: vi.fn() }));
vi.mock("@/lib/ledger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ledger")>()),
  appendLedgerEntry: appendEntryMock,
}));

import { CLOSE_PACK_COLUMNS } from "@/lib/close-pack/export";
import { closePackMonth } from "@/lib/close-pack/month";
import type { ClosePack } from "@/lib/close-pack/types";
import type { ProviderTokens } from "@/lib/connectors/provider";
import type { StoredTokens, TokenStore } from "@/lib/connectors/tokens";
import { exportClosePackToSheet, type SheetExportDeps } from "@/lib/googlesheets/export";
import { googleSheetsProvider } from "@/lib/googlesheets/provider";
import { samplePack, OCTOBER } from "./support/close-pack-fixtures";

/**
 * Exporting a month's close pack to Google Sheets (docs/superpowers/specs/2026-10-25-close-pack-google-sheets-design.md
 * GS7-GS13), against a fake Google that keeps its files and tabs: the month's file is found by its tag or made, renamed
 * each time, de-duplicated after a race, made again when gone; its two tabs are Vestiarion's and every other tab is left
 * alone; the values go RAW in requests of 500 rows; the Payments tab is read back and hashed; each export is recorded,
 * and one that failed after rows may have reached Google too; retries are one per call and never for a create; the
 * brake counts both kinds; and nothing leaves for a host but Google's, nor carries an email, a token or a link into the
 * ledger.
 */

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-0000000a6c01";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000a6c02";
const CONNECTION = "0b6c1c9e-4a4f-4a7e-9b1e-0000000a6c09";
const TAG = `${ORG}:2026-10`;
const SETTINGS = { clientId: "1234567890-abc123def456.apps.googleusercontent.com", clientSecret: "GOCSPX-the-secret" };
const ACCESS = "ya29.first-access-token";
const REFRESH = "1//0g-the-refresh-token";
const ORIGIN = "https://www.vestiarion.xyz";
const NOW = Date.parse("2026-11-02T09:00:00Z");
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const RECONNECT_WORDS =
  "Google no longer accepts this connection: its access was removed in the Google Account, or it went unused for six months. Reconnect Google Sheets to export close packs again.";
const GOOGLE_HOSTS = ["oauth2.googleapis.com", "www.googleapis.com", "sheets.googleapis.com"];

// --- A fake Google: Drive's files and each spreadsheet's tabs and values.

type Sent = { method: string; url: URL; body: unknown; token: string | null };
/** One request of a format `batchUpdate`, as far as the fake and the tests read it. */
type SheetRequest = {
  addSheet?: { properties: { sheetId: number; title: string } };
  updateSheetProperties?: { properties: { sheetId: number; title?: string } };
  [kind: string]: unknown;
};
interface FakeFile {
  id: string;
  name: string;
  createdTime: string;
  tag: string | null;
  trashed: boolean;
  tabs: Array<{ sheetId: number; title: string }>;
  values: Map<string, unknown[][]>;
}

interface FakeGoogle {
  files: FakeFile[];
  sent: Sent[];
  addFile(input?: Partial<FakeFile>): FakeFile;
  fetchImpl: typeof fetch;
  answer(one: Sent, json: (body: unknown, status?: number) => Response): Response;
  calls(): string[];
}

function fakeGoogle(options: { fail?: (sent: Sent, google: FakeGoogle) => Response | "throw" | null; afterCreate?: (google: FakeGoogle) => void } = {}): FakeGoogle {
  const files: FakeFile[] = [];
  const sent: Sent[] = [];
  let made = 0;
  let clock = Date.parse("2026-10-25T10:00:00Z");
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const google: FakeGoogle = {
    files,
    sent,
    addFile(input: Partial<FakeFile> = {}): FakeFile {
      made += 1;
      clock += 1000;
      const file: FakeFile = {
        id: `1Vx${"A".repeat(38)}${String(made).padStart(3, "0")}`,
        name: "",
        createdTime: new Date(clock).toISOString(),
        tag: null,
        trashed: false,
        tabs: [{ sheetId: 0, title: "Sheet1" }],
        values: new Map(),
        ...input,
      };
      files.push(file);
      return file;
    },
    fetchImpl: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const raw = init?.body;
      const body = typeof raw === "string" ? (url.hostname === "oauth2.googleapis.com" ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw)) : undefined;
      const auth = new Headers(init?.headers).get("authorization");
      const one: Sent = { method: (init?.method ?? "GET").toUpperCase(), url, body, token: auth?.startsWith("Bearer ") ? auth.slice(7) : null };
      sent.push(one);
      const failed = options.fail?.(one, google);
      if (failed === "throw") throw new TypeError("timeout");
      if (failed) return failed;
      return google.answer(one, json);
    }) as unknown as typeof fetch,
    answer(one: Sent, json: (body: unknown, status?: number) => Response): Response {
      const path = one.url.pathname;
      if (one.url.hostname === "oauth2.googleapis.com" && path === "/token") return json({ access_token: "ya29.refreshed-token", expires_in: 3599, scope: "https://www.googleapis.com/auth/drive.file" });
      if (one.url.hostname === "www.googleapis.com" && path === "/drive/v3/files" && one.method === "GET") {
        const tag = /value='([^']+)'/.exec(one.url.searchParams.get("q") ?? "")?.[1];
        const found = files.filter((file) => !file.trashed && file.tag === tag).sort((a, b) => a.createdTime.localeCompare(b.createdTime));
        return json({ files: found.map((file) => ({ id: file.id, createdTime: file.createdTime })) });
      }
      if (one.url.hostname === "www.googleapis.com" && path === "/drive/v3/files" && one.method === "POST") {
        const request = one.body as { name: string; appProperties: { vestiarionClosePack: string } };
        const file = google.addFile({ name: request.name, tag: request.appProperties.vestiarionClosePack });
        options.afterCreate?.(google);
        return json({ id: file.id });
      }
      const fileMatch = /^\/drive\/v3\/files\/([^/]+)$/.exec(path);
      if (one.url.hostname === "www.googleapis.com" && fileMatch && one.method === "PATCH") {
        const file = files.find((candidate) => candidate.id === fileMatch[1] && !candidate.trashed);
        if (!file) return json({ error: { code: 404, errors: [{ reason: "notFound" }] } }, 404);
        const request = one.body as { name?: string; trashed?: boolean };
        if (request.name !== undefined) file.name = request.name;
        if (request.trashed) file.trashed = true;
        return json({ id: file.id });
      }
      const sheet = /^\/v4\/spreadsheets\/([^/:]+)(.*)$/.exec(path);
      if (one.url.hostname === "sheets.googleapis.com" && sheet) {
        const file = files.find((candidate) => candidate.id === sheet[1] && !candidate.trashed);
        if (!file) return json({ error: { code: 404, status: "NOT_FOUND" } }, 404);
        const rest = decodeURIComponent(sheet[2]);
        if (rest === "" && one.method === "GET") return json({ sheets: file.tabs.map((tab) => ({ properties: { ...tab } })) });
        if (rest === ":batchUpdate") {
          for (const request of (one.body as { requests: SheetRequest[] }).requests) {
            if (request.addSheet) file.tabs.push({ sheetId: request.addSheet.properties.sheetId, title: request.addSheet.properties.title });
            const props = request.updateSheetProperties?.properties;
            if (props?.title) file.tabs.find((tab) => tab.sheetId === props.sheetId)!.title = props.title;
          }
          return json({ replies: [] });
        }
        if (rest === "/values:batchUpdate") {
          for (const data of (one.body as { data: Array<{ range: string; values: unknown[][] }> }).data) {
            const [tab, cells] = data.range.split("!");
            const start = Number(/^A(\d+):/.exec(cells)![1]);
            const grid = file.values.get(tab) ?? [];
            data.values.forEach((row, index) => (grid[start - 1 + index] = row));
            file.values.set(tab, grid);
          }
          return json({ totalUpdatedRows: 1 });
        }
        if (rest.startsWith("/values/Payments!A1:AY")) {
          // As Google answers: trailing empty cells and rows dropped.
          const rows = (file.values.get("Payments") ?? []).map((row) => {
            const cells = [...row];
            while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
            return cells;
          });
          return json({ range: "Payments!A1:AY4", majorDimension: "ROWS", values: rows });
        }
      }
      return json({ error: { code: 400 } }, 400);
    },
    /** The calls to Drive and Sheets, as "METHOD host path". */
    calls: () => sent.filter((one) => one.url.hostname !== "oauth2.googleapis.com").map((one) => `${one.method} ${one.url.hostname === "www.googleapis.com" ? "drive" : "sheets"} ${decodeURIComponent(one.url.pathname).replace(/1VxA+\d+/, "<id>")}`),
  };
  return google;
}

// --- The workspace: its connection, the readiness probe and the brake, through a fake Supabase.

function connectionRow(status: "connected" | "needs_reconnect" | "revoked" = "connected") {
  return {
    id: CONNECTION, org_id: ORG, provider: "googlesheets", external_org_id: "07623471185212345678", external_org_name: "du***@gmail.com", status,
    scopes: ["https://www.googleapis.com/auth/drive.file"], connected_by: USER, connected_at: "2026-10-25T08:00:00Z", consent_version: "googlesheets-2026-10-25",
    consented_at: "2026-10-25T08:00:00Z", revoked_at: status === "revoked" ? "2026-10-25T08:30:00Z" : null, window_from: "2026-07-27", last_synced_at: null, last_error: null,
    last_error_at: null, failures: 0, next_sync_after: "9999-12-31T00:00:00.000Z", sync_lease_until: null, payment_account: null, payment_account_at: null,
  };
}

function workspace(options: { connection?: ReturnType<typeof connectionRow> | null; ready?: boolean; recent?: number } = {}) {
  const fake = fakeSupabase((request: RecordedRequest) => {
    if (request.path === "/rest/v1/rpc/googlesheets_connector_ready") {
      return options.ready === false ? { status: 404, body: { code: "PGRST202", message: "Could not find the function public.googlesheets_connector_ready" } } : { body: true };
    }
    if (request.path === "/rest/v1/accounting_connections" && request.method === "GET") return { body: options.connection === null ? [] : [options.connection ?? connectionRow()] };
    if (request.path === "/rest/v1/accounting_connections" && request.method === "PATCH") return { body: [{ id: CONNECTION }] };
    if (request.path === "/rest/v1/ledger_entries" && request.params.get("action") === "in.(close_pack_exported,close_pack_export_failed)") {
      return { body: Array.from({ length: options.recent ?? 0 }, (_, index) => ({ id: `x${index}` })) };
    }
    return { body: [] };
  });
  const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: USER }), fn);
  return { fake, run };
}

/** A token row in memory, with the lease of the real store. */
function tokenStore(input: { expiresAt?: number } = {}) {
  let row: StoredTokens = { id: "tok-1", version: 1, accessToken: ACCESS, refreshToken: REFRESH, expiresAt: input.expiresAt ?? NOW + 3_000_000, scopes: ["https://www.googleapis.com/auth/drive.file"] };
  let holder: string | null = null;
  const stored: ProviderTokens[] = [];
  const store: TokenStore = {
    read: async () => ({ ...row }),
    lease: async (who) => {
      if (holder && holder !== who) return null;
      holder = who;
      return { ...row };
    },
    store: async (who, version, tokens) => {
      if (holder !== who || version !== row.version) return false;
      stored.push(tokens);
      row = { ...row, ...tokens, version: row.version + 1 };
      return true;
    },
    release: async () => {
      holder = null;
    },
  };
  return { store, stored, row: () => row };
}

const USER_INPUT = { orgId: ORG, user: { id: USER, email: "accountant@firm.test" }, workspace: { slug: "pinecrest-studio", name: "Pinecrest Studio" }, month: OCTOBER };

function exporter(options: { google?: FakeGoogle; pack?: ClosePack; tokens?: ReturnType<typeof tokenStore>; now?: () => number; sleep?: (ms: number) => Promise<void>; deps?: Partial<SheetExportDeps> } = {}) {
  const google = options.google ?? fakeGoogle();
  const tokens = options.tokens ?? tokenStore();
  const readPack = vi.fn(async () => options.pack ?? samplePack());
  const sleep = vi.fn(options.sleep ?? (async () => {}));
  const now = options.now ?? (() => NOW);
  const http = { fetchImpl: google.fetchImpl, now, sleep };
  const deps: SheetExportDeps = { provider: googleSheetsProvider(SETTINGS, http), http, tokens: tokens.store, readPack, origin: ORIGIN, ...options.deps };
  return { google, tokens, readPack, sleep, deps };
}

const entries = () => appendEntryMock.mock.calls.map((call) => call[0] as { action: string; summary: string; detail: Record<string, unknown> });
const writes = (google: FakeGoogle) => google.sent.filter((one) => one.url.pathname.endsWith("/values:batchUpdate"));

beforeEach(() => {
  appendEntryMock.mockReset();
  appendEntryMock.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a first export of the month (close pack Sheets GS7-GS11)", () => {
  it("makes the month's spreadsheet, writes its two tabs RAW, reads Payments back and records close_pack_exported", async () => {
    const { run } = workspace();
    const { google, deps } = exporter();
    const outcome = await run(() => exportClosePackToSheet(USER_INPUT, deps));
    const id = google.files[0].id;
    expect(outcome).toEqual({ ok: true, spreadsheetId: id, url: `https://docs.google.com/spreadsheets/d/${id}/edit`, payments: 3, created: true, account: "du***@gmail.com" });

    expect(google.calls()).toEqual([
      "GET drive /drive/v3/files",
      "POST drive /drive/v3/files",
      "GET drive /drive/v3/files",
      "GET sheets /v4/spreadsheets/<id>",
      "POST sheets /v4/spreadsheets/<id>:batchUpdate",
      "POST sheets /v4/spreadsheets/<id>/values:batchUpdate",
      "GET sheets /v4/spreadsheets/<id>/values/Payments!A1:AY",
    ]);
    // Listed by the month's tag, with nothing a person typed in the query.
    const list = google.sent[0].url.searchParams;
    expect(list.get("q")).toBe(`appProperties has { key='vestiarionClosePack' and value='${TAG}' } and trashed = false`);
    expect(list.get("fields")).toBe("files(id,createdTime)");
    expect(list.get("orderBy")).toBe("createdTime");
    expect(list.get("pageSize")).toBe("10");
    // Made as a spreadsheet with the name and the tag.
    expect(google.sent[1].body).toEqual({
      name: "Vestiarion close pack · Pinecrest Studio · October 2026 · Arc testnet",
      mimeType: "application/vnd.google-apps.spreadsheet",
      appProperties: { vestiarionClosePack: TAG },
    });
    for (const one of google.sent) expect(one.token).toBe(ACCESS);

    // The first tab becomes Payments, Summary is added, the header frozen and bold, the grid sized to the rows.
    const format = (google.sent[4].body as { requests: SheetRequest[] }).requests;
    expect(format[0]).toEqual({ updateSheetProperties: { properties: { sheetId: 0, title: "Payments" }, fields: "title" } });
    expect(format[1]).toMatchObject({ addSheet: { properties: { title: "Summary" } } });
    const summaryId = format[1].addSheet!.properties.sheetId;
    expect(summaryId).not.toBe(0);
    expect(format).toContainEqual({
      updateSheetProperties: {
        properties: { sheetId: 0, gridProperties: { rowCount: 4, columnCount: 51, frozenRowCount: 1 } },
        fields: "gridProperties.rowCount,gridProperties.columnCount,gridProperties.frozenRowCount",
      },
    });
    expect(format).toContainEqual({
      repeatCell: { range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat.bold" },
    });
    expect(format).toContainEqual({ repeatCell: { range: { sheetId: 0, startRowIndex: 1 }, cell: { userEnteredFormat: { wrapStrategy: "CLIP" } }, fields: "userEnteredFormat.wrapStrategy" } });
    const amountPaid = CLOSE_PACK_COLUMNS.indexOf("amount_paid");
    expect(format).toContainEqual({
      repeatCell: {
        range: { sheetId: 0, startRowIndex: 1, startColumnIndex: amountPaid, endColumnIndex: amountPaid + 1 },
        cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "#,##0.00####" } } },
        fields: "userEnteredFormat.numberFormat",
      },
    });
    const attempts = CLOSE_PACK_COLUMNS.indexOf("earlier_attempts");
    expect(format).toContainEqual({
      repeatCell: {
        range: { sheetId: 0, startRowIndex: 1, startColumnIndex: attempts, endColumnIndex: attempts + 1 },
        cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "0" } } },
        fields: "userEnteredFormat.numberFormat",
      },
    });
    expect(format).toContainEqual({ updateDimensionProperties: { range: { sheetId: 0, dimension: "COLUMNS", startIndex: 0, endIndex: 51 }, properties: { pixelSize: 160 }, fields: "pixelSize" } });
    expect(format).toContainEqual({ updateDimensionProperties: { range: { sheetId: summaryId, dimension: "COLUMNS", startIndex: 0, endIndex: 1 }, properties: { pixelSize: 220 }, fields: "pixelSize" } });
    expect(format).toContainEqual({ updateDimensionProperties: { range: { sheetId: summaryId, dimension: "COLUMNS", startIndex: 1, endIndex: 2 }, properties: { pixelSize: 720 }, fields: "pixelSize" } });
    expect(format).toContainEqual({
      repeatCell: { range: { sheetId: summaryId, startColumnIndex: 0, endColumnIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat.bold" },
    });
    expect(format).toContainEqual({ repeatCell: { range: { sheetId: summaryId }, cell: { userEnteredFormat: { wrapStrategy: "WRAP" } }, fields: "userEnteredFormat.wrapStrategy" } });

    // RAW only, the Summary in the first request, the header and the rows after it.
    const write = google.sent[5].body as { valueInputOption: string; data: Array<{ range: string; majorDimension: string; values: unknown[][] }> };
    expect(write.valueInputOption).toBe("RAW");
    expect(write.data.map((data) => data.range)).toEqual([`Summary!A1:B${write.data[0].values.length}`, "Payments!A1:AY4"]);
    expect(write.data[1].values[0]).toEqual([...CLOSE_PACK_COLUMNS]);
    expect(write.data[1].values[1][amountPaid]).toBe(100);
    expect(JSON.stringify(google.sent.map((one) => [one.url.toString(), one.body]))).not.toContain("USER_ENTERED");
    expect(google.files[0].values.get("Summary")?.[0]).toEqual(["Vestiarion monthly close pack", ""]);
    // The read back: unformatted, by rows.
    expect(google.sent[6].url.searchParams.get("valueRenderOption")).toBe("UNFORMATTED_VALUE");
    expect(google.sent[6].url.searchParams.get("majorDimension")).toBe("ROWS");

    // close_pack_exported, its hash the Payments tab's, the same the Summary names.
    expect(entries()).toHaveLength(1);
    const [entry] = entries();
    const sha256 = google.files[0].values.get("Summary")!.find((row) => row[0] === "Payments tab SHA-256")![1];
    expect(entry).toMatchObject({ actor: "human", domain: "system", action: "close_pack_exported", summary: "Close pack for October 2026 exported to Google Sheets: 3 payments settled, 1 not settled" });
    expect(entry.detail).toEqual({ by: USER, month: "2026-10", ended: true, format: "google_sheets", payments: 3, notSettled: 1, sha256, headSeq: 99, connectionId: CONNECTION, spreadsheetId: id, created: true });
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("asks for the pack with members' emails, for this month and workspace", async () => {
    const { run } = workspace();
    const { readPack, deps } = exporter();
    await run(() => exportClosePackToSheet(USER_INPUT, deps));
    expect(readPack).toHaveBeenCalledWith(OCTOBER);
  });
});

describe("the month's spreadsheet found again (close pack Sheets GS7)", () => {
  it("is renamed, so far dropped once the month has ended, and nothing new is made", async () => {
    const { run } = workspace();
    const google = fakeGoogle();
    const now = new Date("2026-10-25T14:03:00Z");
    const soFar = samplePack({ now, month: closePackMonth("2026-10", now)! });
    const first = await run(() => exportClosePackToSheet(USER_INPUT, exporter({ google, pack: soFar }).deps));
    expect(google.files[0].name).toBe("Vestiarion close pack · Pinecrest Studio · October 2026 so far · Arc testnet");
    google.sent.length = 0;
    appendEntryMock.mockClear();
    const second = await run(() => exportClosePackToSheet(USER_INPUT, exporter({ google }).deps));
    expect(second).toMatchObject({ ok: true, created: false, spreadsheetId: (first as { spreadsheetId: string }).spreadsheetId });
    expect(google.files).toHaveLength(1);
    expect(google.files[0].name).toBe("Vestiarion close pack · Pinecrest Studio · October 2026 · Arc testnet");
    expect(google.calls().slice(0, 2)).toEqual(["GET drive /drive/v3/files", "PATCH drive /drive/v3/files/<id>"]);
    expect(google.calls()).not.toContain("POST drive /drive/v3/files");
    expect(google.sent[1].body).toEqual({ name: "Vestiarion close pack · Pinecrest Studio · October 2026 · Arc testnet" });
    // Its tabs are there: nothing renamed, nothing added.
    const format = (google.sent.find((one) => one.url.pathname.endsWith(":batchUpdate") && !one.url.pathname.includes("values"))!.body as { requests: SheetRequest[] }).requests;
    expect(format.some((request) => request.addSheet || request.updateSheetProperties?.properties?.title)).toBe(false);
    expect(entries()[0].detail).toMatchObject({ created: false });
  });

  it("is made again when the one found is gone: deleted, or out of this grant's reach", async () => {
    for (const refusal of [
      new Response(JSON.stringify({ error: { code: 404, errors: [{ reason: "notFound" }] } }), { status: 404 }),
      new Response(JSON.stringify({ error: { code: 403, errors: [{ reason: "insufficientFilePermissions" }] } }), { status: 403 }),
    ]) {
      const { run } = workspace();
      let old = "";
      const google = fakeGoogle({ fail: (one) => (one.method === "PATCH" && one.url.pathname.endsWith(old) ? refusal.clone() : null) });
      old = google.addFile({ tag: TAG, name: "old" }).id;
      appendEntryMock.mockClear();
      const outcome = await run(() => exportClosePackToSheet(USER_INPUT, exporter({ google }).deps));
      expect(outcome).toMatchObject({ ok: true, created: true });
      expect((outcome as { spreadsheetId: string }).spreadsheetId).not.toBe(old);
      expect(google.files).toHaveLength(2);
      expect(google.calls().filter((call) => call === "POST drive /drive/v3/files")).toHaveLength(1);
      // The one out of reach is never trashed by this export, nor written to.
      expect(google.sent.filter((one) => one.url.pathname.includes(old) && one.url.hostname === "sheets.googleapis.com")).toEqual([]);
      expect(entries()[0].detail).toMatchObject({ created: true, spreadsheetId: (outcome as { spreadsheetId: string }).spreadsheetId });
    }
  });

  it("keeps the oldest when two exports raced and both made one, trashing the one it made itself", async () => {
    const { run } = workspace();
    let other = "";
    const google = fakeGoogle({
      afterCreate: (fake) => {
        // Another export made the month's file a moment before this one.
        if (other) return;
        const file = fake.addFile({ tag: TAG, name: "theirs", createdTime: "2026-10-25T09:59:59.000Z" });
        other = file.id;
      },
    });
    const outcome = await run(() => exportClosePackToSheet(USER_INPUT, exporter({ google }).deps));
    expect(outcome).toMatchObject({ ok: true, spreadsheetId: other, created: false });
    const mine = google.files.find((file) => file.id !== other)!;
    expect(mine.trashed).toBe(true);
    expect(google.sent.find((one) => one.method === "PATCH")?.body).toEqual({ trashed: true });
    expect(google.sent.find((one) => one.method === "PATCH")?.url.pathname).toBe(`/drive/v3/files/${mine.id}`);
    expect(google.files.find((file) => file.id === other)!.values.get("Payments")).toHaveLength(4);
  });

  it("adds the tabs someone deleted or renamed, and leaves every other tab alone", async () => {
    const { run } = workspace();
    const google = fakeGoogle();
    google.addFile({ tag: TAG, tabs: [{ sheetId: 0, title: "My notes" }, { sheetId: 7, title: "Payments (old)" }] });
    await run(() => exportClosePackToSheet(USER_INPUT, exporter({ google }).deps));
    const format = (google.sent.find((one) => one.url.pathname.endsWith(":batchUpdate") && !one.url.pathname.includes("values"))!.body as { requests: SheetRequest[] }).requests;
    const added = format.filter((request) => request.addSheet).map((request) => request.addSheet!.properties);
    expect(added.map((tab) => tab.title)).toEqual(["Payments", "Summary"]);
    for (const tab of added) expect([0, 7]).not.toContain(tab.sheetId);
    expect(JSON.stringify(format)).not.toMatch(/"sheetId":(0|7)\b/);
    expect(google.files[0].tabs.map((tab) => tab.title)).toEqual(["My notes", "Payments (old)", "Payments", "Summary"]);
  });

  it("takes back a tab whose name differs only in case, rather than adding a second Payments", async () => {
    const { run } = workspace();
    const google = fakeGoogle();
    google.addFile({ tag: TAG, tabs: [{ sheetId: 3, title: "payments" }, { sheetId: 4, title: "Summary" }] });
    await run(() => exportClosePackToSheet(USER_INPUT, exporter({ google }).deps));
    const format = (google.sent.find((one) => one.url.pathname.endsWith(":batchUpdate") && !one.url.pathname.includes("values"))!.body as { requests: SheetRequest[] }).requests;
    expect(format.some((request) => request.addSheet)).toBe(false);
    expect(format[0]).toEqual({ updateSheetProperties: { properties: { sheetId: 3, title: "Payments" }, fields: "title" } });
  });
});

describe("the values (close pack Sheets GS8)", () => {
  it("go in requests of 500 rows: four for 2,000 payments, the header and the Summary in the first", async () => {
    const { run } = workspace();
    const base = samplePack();
    const pack = { ...base, cut: true, rows: Array.from({ length: 2000 }, (_, index) => ({ ...base.rows[0], paymentId: `pay-${index}` })) };
    const google = fakeGoogle();
    const outcome = await run(() => exportClosePackToSheet(USER_INPUT, exporter({ google, pack }).deps));
    expect(outcome).toMatchObject({ ok: true, payments: 2000 });
    const sent = writes(google).map((one) => (one.body as { data: Array<{ range: string; values: unknown[][] }> }).data);
    expect(sent).toHaveLength(4);
    expect(sent.map((data) => data.map((part) => part.range))).toEqual([
      [expect.stringMatching(/^Summary!A1:B\d+$/), "Payments!A1:AY501"],
      ["Payments!A502:AY1001"],
      ["Payments!A1002:AY1501"],
      ["Payments!A1502:AY2001"],
    ]);
    expect(sent.map((data) => data[data.length - 1].values.length)).toEqual([501, 500, 500, 500]);
    const format = (google.sent.find((one) => one.url.pathname.endsWith(":batchUpdate") && !one.url.pathname.includes("values"))!.body as { requests: SheetRequest[] }).requests;
    expect(format).toContainEqual(expect.objectContaining({ updateSheetProperties: expect.objectContaining({ properties: { sheetId: 0, gridProperties: { rowCount: 2001, columnCount: 51, frozenRowCount: 1 } } }) }));
    expect(google.files[0].values.get("Summary")!.some((row) => row[0] === "Cut")).toBe(true);
  });

  it("writes the header alone for a month with no payment, in a grid of two rows", async () => {
    const { run } = workspace();
    const pack = { ...samplePack(), rows: [] };
    const google = fakeGoogle();
    expect(await run(() => exportClosePackToSheet(USER_INPUT, exporter({ google, pack }).deps))).toMatchObject({ ok: true, payments: 0 });
    expect(writes(google)).toHaveLength(1);
    expect((writes(google)[0].body as { data: Array<{ range: string }> }).data[1].range).toBe("Payments!A1:AY1");
    const format = (google.sent.find((one) => one.url.pathname.endsWith(":batchUpdate") && !one.url.pathname.includes("values"))!.body as { requests: SheetRequest[] }).requests;
    expect(format).toContainEqual(expect.objectContaining({ updateSheetProperties: expect.objectContaining({ properties: { sheetId: 0, gridProperties: { rowCount: 2, columnCount: 51, frozenRowCount: 1 } } }) }));
  });
});

describe("a failure after rows may have reached Google (close pack Sheets GS10, GS11)", () => {
  it("records close_pack_export_failed at the read back when it differs, and no close_pack_exported", async () => {
    const { run } = workspace();
    const google = fakeGoogle({
      fail: (one) =>
        one.url.pathname.includes("/values/Payments")
          ? new Response(JSON.stringify({ values: [[...CLOSE_PACK_COLUMNS], ["someone else's row"]] }), { status: 200, headers: { "content-type": "application/json" } })
          : null,
    });
    expect(await run(() => exportClosePackToSheet(USER_INPUT, exporter({ google }).deps))).toEqual({ ok: false, reason: "mismatch" });
    expect(entries().map((entry) => entry.action)).toEqual(["close_pack_export_failed"]);
    expect(entries()[0]).toMatchObject({ summary: "Close pack for October 2026 not fully exported to Google Sheets" });
    expect(entries()[0].detail).toEqual({ by: USER, month: "2026-10", ended: true, format: "google_sheets", connectionId: CONNECTION, spreadsheetId: google.files[0].id, stage: "read_back", reason: "mismatch" });
  });

  it("records it at the write when the values write is answered 503 twice", async () => {
    const { run } = workspace();
    const google = fakeGoogle({ fail: (one) => (one.url.pathname.endsWith("/values:batchUpdate") ? new Response("{}", { status: 503 }) : null) });
    expect(await run(() => exportClosePackToSheet(USER_INPUT, exporter({ google }).deps))).toEqual({ ok: false, reason: "unavailable" });
    expect(writes(google)).toHaveLength(2);
    expect(entries().map((entry) => entry.action)).toEqual(["close_pack_export_failed"]);
    expect(entries()[0].detail).toMatchObject({ stage: "write", reason: "unavailable", spreadsheetId: google.files[0].id });
  });

  it("goes on when the values write is answered 503 once", async () => {
    const { run } = workspace();
    let failed = false;
    const google = fakeGoogle({
      fail: (one) => {
        if (!one.url.pathname.endsWith("/values:batchUpdate") || failed) return null;
        failed = true;
        return new Response("{}", { status: 503 });
      },
    });
    expect(await run(() => exportClosePackToSheet(USER_INPUT, exporter({ google }).deps))).toMatchObject({ ok: true });
    expect(writes(google)).toHaveLength(2);
    expect(entries().map((entry) => entry.action)).toEqual(["close_pack_exported"]);
  });

  it("says a full Drive at the write in words, and records it", async () => {
    const { run } = workspace();
    const google = fakeGoogle({
      fail: (one) => (one.url.pathname.endsWith("/values:batchUpdate") ? new Response(JSON.stringify({ error: { code: 403, errors: [{ reason: "storageQuotaExceeded" }] } }), { status: 403 }) : null),
    });
    expect(await run(() => exportClosePackToSheet(USER_INPUT, exporter({ google }).deps))).toEqual({ ok: false, reason: "drive_full" });
    expect(entries()[0].detail).toMatchObject({ stage: "write", reason: "drive_full" });
  });
});

describe("rate limits (close pack Sheets GS12)", () => {
  const limited = (seconds: number) => new Response(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } }), { status: 429, headers: { "retry-after": String(seconds) } });

  it("waits once when Google asks for 2 seconds, and goes on", async () => {
    const { run } = workspace();
    let once = false;
    const google = fakeGoogle({
      fail: (one) => {
        if (one.method !== "GET" || !one.url.pathname.endsWith("/drive/v3/files") || once) return null;
        once = true;
        return limited(2);
      },
    });
    const { deps, sleep } = exporter({ google });
    expect(await run(() => exportClosePackToSheet(USER_INPUT, deps))).toMatchObject({ ok: true });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("answers rate_limited, with no entry, when Google asks for 30 seconds before anything was written", async () => {
    const { run } = workspace();
    const google = fakeGoogle({ fail: (one) => (one.url.pathname.endsWith("/drive/v3/files") ? limited(30) : null) });
    const { deps, sleep } = exporter({ google });
    expect(await run(() => exportClosePackToSheet(USER_INPUT, deps))).toEqual({ ok: false, reason: "rate_limited" });
    expect(sleep).not.toHaveBeenCalled();
    expect(google.sent).toHaveLength(1);
    expect(entries()).toEqual([]);
  });

  it("reads Drive's 403 userRateLimitExceeded as a rate limit, and 403 storageQuotaExceeded as a full Drive", async () => {
    const { run } = workspace();
    const drive = (reason: string) => () => new Response(JSON.stringify({ error: { code: 403, errors: [{ domain: "usageLimits", reason }] } }), { status: 403 });
    const rate = fakeGoogle({ fail: (one) => (one.url.pathname.endsWith("/drive/v3/files") ? drive("userRateLimitExceeded")() : null) });
    expect(await run(() => exportClosePackToSheet(USER_INPUT, exporter({ google: rate }).deps))).toEqual({ ok: false, reason: "rate_limited" });
    const full = fakeGoogle({ fail: (one) => (one.method === "POST" && one.url.pathname === "/drive/v3/files" ? drive("storageQuotaExceeded")() : null) });
    expect(await run(() => exportClosePackToSheet(USER_INPUT, exporter({ google: full }).deps))).toEqual({ ok: false, reason: "drive_full" });
    const off = fakeGoogle({ fail: (one) => (one.method === "POST" && one.url.pathname === "/drive/v3/files" ? drive("domainPolicy")() : null) });
    expect(await run(() => exportClosePackToSheet(USER_INPUT, exporter({ google: off }).deps))).toEqual({ ok: false, reason: "forbidden" });
    expect(entries()).toEqual([]);
  });
});

describe("tokens (close pack Sheets GS12, GS13)", () => {
  it("refreshes once on a 401, with the refused token, and sends the call again", async () => {
    const { run } = workspace();
    let refused = false;
    const google = fakeGoogle({
      fail: (one) => {
        if (refused || one.url.hostname === "oauth2.googleapis.com") return null;
        refused = true;
        return new Response(JSON.stringify({ error: { code: 401, status: "UNAUTHENTICATED" } }), { status: 401 });
      },
    });
    const { deps, tokens } = exporter({ google });
    expect(await run(() => exportClosePackToSheet(USER_INPUT, deps))).toMatchObject({ ok: true });
    const refreshes = google.sent.filter((one) => one.url.hostname === "oauth2.googleapis.com");
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0].body).toMatchObject({ grant_type: "refresh_token", refresh_token: REFRESH });
    expect(tokens.stored).toHaveLength(1);
    const api = google.sent.filter((one) => one.url.hostname !== "oauth2.googleapis.com");
    expect(api[0].token).toBe(ACCESS);
    expect(api.slice(1).every((one) => one.token === "ya29.refreshed-token")).toBe(true);
    expect(api[1].url.pathname).toBe(api[0].url.pathname);
  });

  it("asks for a reconnect after a second 401, marking the connection with Google's words", async () => {
    const { run, fake } = workspace();
    const google = fakeGoogle({ fail: (one) => (one.url.hostname === "oauth2.googleapis.com" ? null : new Response(JSON.stringify({ error: { code: 401 } }), { status: 401 })) });
    expect(await run(() => exportClosePackToSheet(USER_INPUT, exporter({ google }).deps))).toEqual({ ok: false, reason: "reconnect" });
    expect(google.sent.filter((one) => one.url.hostname !== "oauth2.googleapis.com")).toHaveLength(2);
    const marked = fake.requests.filter((request) => request.path === "/rest/v1/accounting_connections" && request.method === "PATCH");
    expect(marked).toHaveLength(1);
    expect(marked[0].body).toMatchObject({ status: "needs_reconnect", last_error: RECONNECT_WORDS });
    expect(typeof (marked[0].body as { last_error_at: string }).last_error_at).toBe("string");
    expect(marked[0].params.get("id")).toBe(`eq.${CONNECTION}`);
    expect(marked[0].params.get("status")).toBe("eq.connected");
    expect(entries()).toEqual([]);
  });

  it("asks for a reconnect when the refresh says so, and never calls Drive or Sheets", async () => {
    const { run, fake } = workspace();
    const google = fakeGoogle({ fail: (one) => (one.url.hostname === "oauth2.googleapis.com" ? new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }) : null) });
    const tokens = tokenStore({ expiresAt: NOW - 1000 });
    expect(await run(() => exportClosePackToSheet(USER_INPUT, exporter({ google, tokens }).deps))).toEqual({ ok: false, reason: "reconnect" });
    expect(google.calls()).toEqual([]);
    expect(fake.requests.filter((request) => request.method === "PATCH")).toHaveLength(1);
  });

  it("asks for a reconnect when Google says the grant lacks the Drive permission", async () => {
    const { run, fake } = workspace();
    const google = fakeGoogle({
      fail: (one) => (one.url.pathname.endsWith("/drive/v3/files") ? new Response(JSON.stringify({ error: { code: 403, errors: [{ reason: "insufficientPermissions" }] } }), { status: 403 }) : null),
    });
    expect(await run(() => exportClosePackToSheet(USER_INPUT, exporter({ google }).deps))).toEqual({ ok: false, reason: "reconnect" });
    expect(fake.requests.filter((request) => request.method === "PATCH")).toHaveLength(1);
  });

  it("asks for a reconnect, marked, when the connection has no tokens", async () => {
    const { run, fake } = workspace();
    const google = fakeGoogle();
    const empty: TokenStore = { read: async () => null, lease: async () => null, store: async () => false, release: async () => {} };
    expect(await run(() => exportClosePackToSheet(USER_INPUT, exporter({ google, deps: { tokens: empty } }).deps))).toEqual({ ok: false, reason: "reconnect" });
    expect(google.sent).toEqual([]);
    expect(fake.requests.filter((request) => request.method === "PATCH")).toHaveLength(1);
  });

  it("is unavailable when the refresh is, and the token row is left as it was", async () => {
    const { run, fake } = workspace();
    const google = fakeGoogle({ fail: (one) => (one.url.hostname === "oauth2.googleapis.com" ? new Response("{}", { status: 503 }) : null) });
    expect(await run(() => exportClosePackToSheet(USER_INPUT, exporter({ google, tokens: tokenStore({ expiresAt: NOW - 1000 }) }).deps))).toEqual({ ok: false, reason: "unavailable" });
    expect(google.calls()).toEqual([]);
    expect(fake.requests.filter((request) => request.method === "PATCH")).toEqual([]);
  });
});

describe("a create that times out (close pack Sheets GS7, GS12)", () => {
  it("is unavailable with no entry and no second create; the next export finds the file by its tag", async () => {
    const { run } = workspace();
    let timedOut = false;
    const google = fakeGoogle({
      fail: (one, fake) => {
        if (timedOut || one.method !== "POST" || one.url.pathname !== "/drive/v3/files") return null;
        timedOut = true;
        // Google made the file, but its answer never came.
        fake.addFile({ name: (one.body as { name: string }).name, tag: TAG });
        return "throw";
      },
    });
    expect(await run(() => exportClosePackToSheet(USER_INPUT, exporter({ google }).deps))).toEqual({ ok: false, reason: "unavailable" });
    expect(google.calls().filter((call) => call === "POST drive /drive/v3/files")).toHaveLength(1);
    expect(entries()).toEqual([]);
    const next = await run(() => exportClosePackToSheet(USER_INPUT, exporter({ google }).deps));
    expect(next).toMatchObject({ ok: true, created: false, spreadsheetId: google.files[0].id });
    expect(google.files).toHaveLength(1);
  });

  it("never sends a rename or a format again after a 5xx", async () => {
    const { run } = workspace();
    const google = fakeGoogle({ fail: (one) => (one.url.pathname.endsWith(":batchUpdate") && !one.url.pathname.includes("values") ? new Response("{}", { status: 500 }) : null) });
    expect(await run(() => exportClosePackToSheet(USER_INPUT, exporter({ google }).deps))).toEqual({ ok: false, reason: "unavailable" });
    expect(google.calls().filter((call) => call.endsWith(":batchUpdate"))).toHaveLength(1);
    expect(entries()).toEqual([]);
  });

  it("starts no call after 90 seconds, and answers unavailable", async () => {
    const { run } = workspace();
    let at = NOW;
    const google = fakeGoogle();
    const { deps } = exporter({
      google,
      now: () => at,
      deps: {},
    });
    const original = google.fetchImpl;
    deps.http = {
      ...deps.http,
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const answer = await original(input, init);
        // Each call takes 40 seconds.
        at += 40_000;
        return answer;
      }) as typeof fetch,
    };
    expect(await run(() => exportClosePackToSheet(USER_INPUT, deps))).toEqual({ ok: false, reason: "unavailable" });
    // List, create, list again: 120 seconds by then, so the tabs are never read.
    expect(google.calls()).toEqual(["GET drive /drive/v3/files", "POST drive /drive/v3/files", "GET drive /drive/v3/files"]);
    expect(entries()).toEqual([]);
  });
});

describe("before any call (close pack Sheets GS2, GS11)", () => {
  it("refuses the eleventh export in ten minutes before the pack is read or Google is called; failed ones count", async () => {
    const { run, fake } = workspace({ recent: 10 });
    const { google, readPack, deps } = exporter();
    expect(await run(() => exportClosePackToSheet(USER_INPUT, deps))).toEqual({ ok: false, reason: "limited" });
    expect(readPack).not.toHaveBeenCalled();
    expect(google.sent).toEqual([]);
    const brake = fake.requests.find((request) => request.path === "/rest/v1/ledger_entries");
    expect(brake?.params.get("action")).toBe("in.(close_pack_exported,close_pack_export_failed)");
    expect(brake?.params.get("detail->>by")).toBe(`eq.${USER}`);
    const nine = workspace({ recent: 9 });
    expect(await nine.run(() => exportClosePackToSheet(USER_INPUT, exporter().deps))).toMatchObject({ ok: true });
  });

  it("answers off, not set up, not connected, revoked and reconnect before any call", async () => {
    const cases: Array<[ReturnType<typeof workspace>, Partial<SheetExportDeps>, string]> = [
      [workspace(), { provider: null }, "off"],
      [workspace({ ready: false }), {}, "not_set_up"],
      [workspace({ connection: null }), {}, "not_connected"],
      [workspace({ connection: connectionRow("revoked") }), {}, "not_connected"],
      [workspace({ connection: connectionRow("needs_reconnect") }), {}, "reconnect"],
    ];
    for (const [scope, override, reason] of cases) {
      const { google, readPack, deps } = exporter({ deps: override });
      expect(await scope.run(() => exportClosePackToSheet(USER_INPUT, deps)), reason).toEqual({ ok: false, reason });
      expect(google.sent, reason).toEqual([]);
      expect(readPack, reason).not.toHaveBeenCalled();
      expect(scope.fake.requests.filter((request) => request.method === "PATCH"), reason).toEqual([]);
    }
    expect(entries()).toEqual([]);
  });

  it("answers read_failed when the pack does not read, and logs no detail", async () => {
    const { run } = workspace();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { google, deps } = exporter({ deps: { readPack: async () => Promise.reject(new Error("payee Harbor Print at owner@pinecrest.test")) } });
    expect(await run(() => exportClosePackToSheet(USER_INPUT, deps))).toEqual({ ok: false, reason: "read_failed" });
    expect(google.sent).toEqual([]);
    expect(JSON.stringify(logged.mock.calls)).not.toMatch(/Harbor|pinecrest\.test/);
  });
});

describe("what leaves and what is kept (close pack Sheets GS11, GS12, GS17)", () => {
  it("sends nothing to a host but Google's, keeps no email, token or link in the ledger, and writes nothing else to the database", async () => {
    const { run, fake } = workspace();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { google, deps } = exporter();
    const outcome = await run(() => exportClosePackToSheet(USER_INPUT, deps));
    expect(outcome).toMatchObject({ ok: true });
    for (const one of google.sent) expect(GOOGLE_HOSTS).toContain(one.url.hostname);
    const ledger = JSON.stringify(entries());
    for (const secret of ["@", ACCESS, REFRESH, "https://", "docs.google.com"]) expect(ledger).not.toContain(secret);
    expect(fake.requests.filter((request) => request.method !== "GET" && request.path !== "/rest/v1/rpc/googlesheets_connector_ready")).toEqual([]);
    expect(JSON.stringify(outcome)).not.toContain(ACCESS);
    const logs = JSON.stringify(logged.mock.calls);
    for (const secret of [ACCESS, REFRESH, "accountant@firm.test", "Northwind", "Vestiarion close pack ·"]) expect(logs).not.toContain(secret);
  });

  it("names the exporter on the Summary by email, or as a member when no email is known", async () => {
    const { run } = workspace();
    const google = fakeGoogle();
    await run(() => exportClosePackToSheet({ ...USER_INPUT, user: { id: USER, email: null } }, exporter({ google }).deps));
    expect(google.files[0].values.get("Summary")!.find((row) => row[0] === "Exported by")![1]).toBe("a member (0b6c1c9e)");
  });
});
