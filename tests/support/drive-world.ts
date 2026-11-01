import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { StoredTokens, TokenStore } from "@/lib/connectors/tokens";
import { withOrg } from "@/lib/dal/scope";
import { googleDriveProvider, type GoogleDriveProvider } from "@/lib/googledrive/provider";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeDrive, type FakeDrive, type FakeDriveFile } from "./fake-google-drive";
import type { FakeReply, RecordedRequest } from "./fake-supabase";
import { memoryPostgrest, type MemoryPostgrest, type Row } from "./memory-postgrest";
import { APPENDED_LEDGER_ROW } from "./signed-org";

/**
 * One workspace with Google Drive connected, for the Google Drive intake's flow tests
 * (docs/superpowers/specs/2026-11-01-google-drive-intake-design.md): a PostgREST in memory whose `inbox_emails`,
 * `google_drive_folders` and `accounting_connections` refuse what migrations 0068, 0101 and 0148 refuse (their checks,
 * their unique keys, an upsert's conflict key), a fake Drive holding the folder "Bills to pay", the connection's token
 * row, a clock, and what Slack was sent. The caller mocks `connectionTokenStore` to answer `world.tokens`.
 */

export const DRIVE_ORG = "0b6c1c9e-4a4f-4a7e-9b1e-0000000d7f01";
export const OTHER_ORG = "0b6c1c9e-4a4f-4a7e-9b1e-0000000d7f02";
export const OWNER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000d7f11";
export const CONNECTION = "0b6c1c9e-4a4f-4a7e-9b1e-0000000d7f21";
export const FOLDER = "1FoLdErAbCdEfGhIjKlMnOpQrStUvWxYz";
export const ACCOUNT = "07623471185212345678";
export const NORTHWIND = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de";
export const DRIVE_SETTINGS = { clientId: "1234567890-abc123def456.apps.googleusercontent.com", clientSecret: "GOCSPX-the-drive-secret" };
export const HOOK = "https://hooks.slack.com/services/T0TEAM/B0HOOK/abcdefghijklmnopqrstuvwx";
export const START = Date.parse("2026-11-01T09:00:00Z");

export const INVOICE_PDF = readFileSync(path.join(process.cwd(), "tests", "fixtures", "invoice-document", "northwind-inv-2207.pdf"));
export const SCAN_PDF = readFileSync(path.join(process.cwd(), "tests", "fixtures", "invoice-document", "scan.pdf"));

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

const STATUSES = ["received", "ready", "needs_details", "unreadable", "added", "dismissed"];
/** `char_length`, as the checks count: in characters (code points), not in UTF-16 units, so an emoji is one. */
const length = (value: unknown, min: number, max: number) => typeof value === "string" && Array.from(value).length >= min && Array.from(value).length <= max;
const nullOr = (value: unknown, test: (value: unknown) => boolean) => value === null || value === undefined || test(value);

/** inbox_emails as 0068 and 0148 hold it. */
const INBOX_CHECKS = [
  { name: "inbox_emails_status_check", holds: (row: Row) => STATUSES.includes(String(row.status)) },
  { name: "inbox_emails_resend_email_id_check", holds: (row: Row) => nullOr(row.resend_email_id, (value) => length(value, 1, 100)) },
  { name: "inbox_emails_from_address_check", holds: (row: Row) => nullOr(row.from_address, (value) => length(value, 0, 320)) },
  { name: "inbox_emails_subject_check", holds: (row: Row) => nullOr(row.subject, (value) => length(value, 0, 300)) },
  { name: "inbox_emails_source_check", holds: (row: Row) => row.source === "email" || row.source === "google_drive" },
  { name: "inbox_emails_drive_file_id_check", holds: (row: Row) => nullOr(row.drive_file_id, (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value)) },
  { name: "inbox_emails_file_name_check", holds: (row: Row) => nullOr(row.file_name, (value) => length(value, 1, 255)) },
  {
    name: "inbox_emails_source_fields_check",
    holds: (row: Row) =>
      (row.source === "email" && row.resend_email_id != null && row.drive_file_id == null && row.file_name == null) ||
      (row.source === "google_drive" && row.drive_file_id != null && row.file_name != null && row.resend_email_id == null),
  },
];

/** google_drive_folders as 0148 holds it. */
const FOLDER_CHECKS = [
  { name: "google_drive_folders_folder_id_check", holds: (row: Row) => typeof row.folder_id === "string" && /^[A-Za-z0-9_-]{10,200}$/.test(row.folder_id) },
  { name: "google_drive_folders_folder_name_check", holds: (row: Row) => length(row.folder_name, 1, 255) },
  { name: "google_drive_folders_baseline_check", holds: (row: Row) => Array.isArray(row.baseline) && row.baseline.length <= 1000 },
  { name: "google_drive_folders_last_error_check", holds: (row: Row) => nullOr(row.last_error, (value) => length(value, 1, 300)) },
  { name: "google_drive_folders_last_error_kind_check", holds: (row: Row) => nullOr(row.last_error_kind, (value) => ["folder_gone", "rate_limited", "unavailable", "failed"].includes(String(value))) },
  { name: "google_drive_folders_error_check", holds: (row: Row) => (row.last_error == null) === (row.last_error_kind == null) },
];

export function connectionRow(fields: Row = {}): Row {
  return {
    id: CONNECTION, org_id: DRIVE_ORG, provider: "googledrive", external_org_id: ACCOUNT, external_org_name: "la***@pinecrest.example", status: "connected",
    scopes: ["https://www.googleapis.com/auth/drive.readonly"], connected_by: OWNER, connected_at: "2026-11-01T08:00:00Z", consent_version: "googledrive-2026-11-01",
    consented_at: "2026-11-01T08:00:00Z", revoked_at: null, revoked_by: null, window_from: "2026-08-03", last_synced_at: null, last_error: null, last_error_at: null, failures: 0,
    next_sync_after: null, sync_lease_until: null, payment_account: null, payment_account_at: null, created_at: "2026-11-01T08:00:00Z",
    ...fields,
  };
}

export interface DriveWorld {
  drive: FakeDrive;
  db: MemoryPostgrest;
  provider: GoogleDriveProvider;
  tokens: TokenStore & { row: StoredTokens };
  clock: { now: number };
  slack: Array<{ url: string; body: { text: string; blocks: unknown[] } }>;
  /** The signed entries appended, in order. */
  ledger: () => Array<{ action: string; detail: Record<string, unknown>; summary: string; actor: string; domain: string }>;
  run<T>(fn: () => Promise<T>, orgId?: string): Promise<T>;
  /** A file added to the folder (or another parent) now. */
  drop(file: Partial<FakeDriveFile> & { id: string; name: string }): FakeDriveFile;
  slackFetch: typeof fetch;
  /**
   * Runs before the database answers a request: a test's way to let something else happen at that moment, or, by
   * returning a reply, to have one write refused.
   */
  answer: { current: ((request: RecordedRequest) => Promise<FakeReply | void> | FakeReply | void) | null };
}

/** inbox_emails' columns before migration 0148 added a Drive file's. */
const INBOX_COLUMNS_0068 = new Set([
  "id", "org_id", "resend_email_id", "from_address", "subject", "received_at", "status", "reasons", "read", "draft", "authentication", "invoice_id", "decided_by", "decided_at",
]);

/**
 * `ready: false`: the database before migration 0148, whose readiness probe is not there yet; with `before0148`, its
 * inbox_emails has none of 0148's columns either, and refuses a request that names one.
 */
export function driveWorld(input: { orgRow: (orgId: string, fields?: Record<string, unknown>) => Row; slack?: boolean; seed?: Record<string, Row[]>; ready?: boolean; before0148?: boolean }): DriveWorld {
  const clock = { now: START };
  const drive = fakeDrive();
  drive.add({ id: FOLDER, name: "Bills to pay", mimeType: "application/vnd.google-apps.folder", parents: ["root"], createdTime: "2026-09-01T00:00:00.000Z" });
  const keys = parseMasterKeys(process.env.VESTIARION_MASTER_KEYS);
  const envelope = encryptSecret(HOOK, { orgId: DRIVE_ORG, column: "slack_installs.webhook_url_enc" }, keys);
  const answer: DriveWorld["answer"] = { current: null };
  const db = memoryPostgrest({
    before: (request) => answer.current?.(request),
    specs: {
      inbox_emails: input.before0148
        ? {
            defaults: () => ({ id: crypto.randomUUID(), from_address: null, subject: null, received_at: new Date(clock.now).toISOString(), status: "received", reasons: [], read: null, draft: null, authentication: null, invoice_id: null, decided_by: null, decided_at: null }),
            unique: [["org_id", "resend_email_id"], ["id"]],
            checks: INBOX_CHECKS.slice(0, 4),
            columns: INBOX_COLUMNS_0068,
          }
        : {
            defaults: () => ({ id: crypto.randomUUID(), source: "email", resend_email_id: null, drive_file_id: null, file_name: null, from_address: null, subject: null, received_at: new Date(clock.now).toISOString(), status: "received", reasons: [], read: null, draft: null, authentication: null, invoice_id: null, decided_by: null, decided_at: null }),
            unique: [["org_id", "resend_email_id"], ["org_id", "drive_file_id"], ["id"]],
            checks: INBOX_CHECKS,
          },
      google_drive_folders: {
        defaults: () => ({ id: crypto.randomUUID(), shared_drive_id: null, baseline: [], chosen_by: null, chosen_at: new Date(clock.now).toISOString(), last_read_at: null, last_error: null, last_error_kind: null, last_error_at: null }),
        unique: [["org_id"], ["id"]],
        checks: FOLDER_CHECKS,
      },
      accounting_connections: {
        unique: [["id"]],
        checks: [{ name: "accounting_connections_status_check", holds: (row) => ["connected", "needs_reconnect", "revoked"].includes(String(row.status)) }],
      },
      invoices: { defaults: () => ({ id: crypto.randomUUID(), created_at: new Date(clock.now).toISOString() }) },
    },
    rpc: {
      ...(input.ready === false || input.before0148 ? {} : { googledrive_connector_ready: () => ({ body: true }) }),
      append_ledger_entry: () => ({ body: APPENDED_LEDGER_ROW }),
      accounting_connections_by_external: (args) => ({
        body: db
          .rows("accounting_connections")
          .filter((row) => row.provider === args.p_provider && (args.p_external_org_ids as string[]).includes(String(row.external_org_id)) && row.status !== "revoked")
          .map((row) => ({ org_id: row.org_id, connection_id: row.id, external_org_id: row.external_org_id, status: row.status, next_sync_after: row.next_sync_after })),
      }),
      accounting_connections_due: () => ({
        body: db
          .rows("accounting_connections")
          .filter((row) => row.status === "connected" && (row.next_sync_after == null || Date.parse(String(row.next_sync_after)) <= clock.now) && (row.sync_lease_until == null || Date.parse(String(row.sync_lease_until)) <= clock.now))
          .map((row) => ({ org_id: row.org_id, connection_id: row.id, provider: row.provider })),
      }),
    },
    seed: {
      orgs: [input.orgRow(DRIVE_ORG, { slug: "pinecrest", name: "Pinecrest Studio", mode: "live" }), input.orgRow(OTHER_ORG, { slug: "fernhill", name: "Fernhill" })],
      accounting_connections: [connectionRow()],
      counterparties: [{ id: NORTHWIND, org_id: DRIVE_ORG, name: "Northwind Hosting", role: "vendor", address: null, notice_email: "billing@northwind.example" }],
      slack_installs: input.slack
        ? [{ id: "inst-1", org_id: DRIVE_ORG, team_id: "T0TEAM", app_id: "A0APP", channel_id: "C0FIN", channel_name: "#finance", installed_at: "2026-10-03T08:00:00Z", notified_seq: 1, decisions_limit_usdc: null, scopes: [], team_name: null, installed_by: null, bot_user_id: null, bot_token_enc: envelope, webhook_url_enc: envelope }]
        : [],
      ...input.seed,
    },
  });

  const tokens = {
    row: { id: "tok-1", version: 1, accessToken: drive.accessToken, refreshToken: "1//0g-refresh", expiresAt: START + 3_000_000, scopes: ["https://www.googleapis.com/auth/drive.readonly"] } as StoredTokens,
    holder: null as string | null,
    async read() {
      return { ...tokens.row };
    },
    async lease(holder: string) {
      if (tokens.holder) return null;
      tokens.holder = holder;
      return { ...tokens.row };
    },
    async store(holder: string, version: number, next: { accessToken: string; refreshToken: string; expiresAt: number; scopes: string[] }) {
      if (tokens.holder !== holder || tokens.row.version !== version) return false;
      tokens.row = { ...tokens.row, ...next, version: version + 1 };
      tokens.holder = null;
      return true;
    },
    async release(holder: string) {
      if (tokens.holder === holder) tokens.holder = null;
    },
  };

  const slack: DriveWorld["slack"] = [];
  const slackFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    slack.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("ok");
  }) as typeof fetch;

  return {
    drive,
    db,
    provider: googleDriveProvider(DRIVE_SETTINGS, { fetchImpl: drive.fetch, now: () => clock.now, sleep: async () => {} }),
    tokens,
    clock,
    slack,
    slackFetch,
    answer,
    ledger: () =>
      db.requests
        .filter((request) => request.path === "/rest/v1/rpc/append_ledger_entry")
        .map((request) => {
          const body = request.body as Record<string, unknown>;
          return { action: String(body.p_action), detail: body.p_detail as Record<string, unknown>, summary: String(body.p_summary), actor: String(body.p_actor), domain: String(body.p_domain) };
        }),
    run: <T,>(fn: () => Promise<T>, orgId: string = DRIVE_ORG) => runWith({ config, db: db.client, fetch: db.fetch }, () => withOrg(orgId, fn, { userId: OWNER })),
    drop: (file) =>
      drive.add({ mimeType: "application/pdf", parents: [FOLDER], createdTime: new Date(clock.now).toISOString(), bytes: INVOICE_PDF, ...file }),
  };
}
