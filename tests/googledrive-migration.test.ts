import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg, createUser, migrationFiles, MIGRATIONS_DIR } from "./support/pglite";

/**
 * Migration 0148 (docs/superpowers/specs/2026-11-01-google-drive-intake-design.md GD1, GD3, GD5, GD6, GD13): Google
 * Drive on the connector core's tables beside every provider they took; inbox_emails holding a file from Google Drive
 * beside the emails, every email already there still valid, a row that mixes the two refused, and one row per Drive
 * file and workspace; the folder a workspace reads (`google_drive_folders`); and the readiness probe. Re-runnable, and
 * never narrowing a check a later migration widened. Its Drive connections are due every 15 minutes, unlike Sheets'.
 */

const FILE = "0148_google_drive_intake.sql";
const sql = () => readFileSync(path.join(MIGRATIONS_DIR, FILE), "utf8");
const PROVIDERS_BEFORE = ["xero", "quickbooks", "hubspot", "asana", "pipedrive", "zohobooks", "zohocrm", "googlesheets", "linear"];
const FILE_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const FOLDER_ID = "1FoLdErAbCdEfGhIjKlMnOpQrStUvWxYz";

let db: PGlite;
let person: string;
/** A workspace with an email in its review list from before 0148, and that email's row. */
let before: { orgId: string; emailId: string };

beforeAll(async () => {
  db = await createDatabase();
  // The database as it was before 0148, with an email in a workspace's review list.
  await applyMigrations(db, (file) => file < FILE);
  const orgId = await createOrg(db, "googledrive-before");
  const emailId = (
    await db.query<{ id: string }>(
      "insert into public.inbox_emails (org_id, resend_email_id, from_address, subject, status) values ($1, '4ef9a417-02e9-4d39-ad75-9611e0fcc33c', 'billing@northwind.example', 'Invoice INV-2207', 'ready') returning id",
      [orgId]
    )
  ).rows[0].id;
  before = { orgId, emailId };
  await applyMigrations(db, (file) => file >= FILE);
  // Re-runnable, as scripts/migrate.ts re-runs every file: the earlier widenings, then this one, again.
  await applyMigrations(db, (file) => ["0101_", "0105_", "0115_", "0116_", "0122_", "0123_", "0145_", "0147_", "0148_"].some((prefix) => file.startsWith(prefix)));
  person = await createUser(db, "owner-googledrive@example.com");
}, 60_000);

afterAll(async () => {
  await db.close();
});

const definition = async (name: string) =>
  (await db.query<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conname = $1", [name])).rows[0]?.def ?? "";

async function connection(orgId: string, provider = "googledrive", externalOrgId = `0762${crypto.randomInt(10 ** 9, 10 ** 10 - 1)}`): Promise<string> {
  return (
    await db.query<{ id: string }>(
      `insert into public.accounting_connections (org_id, provider, external_org_id, external_org_name, status, connected_by, consent_version, consented_at, window_from, scopes)
       values ($1, $2, $3, 'du***@gmail.com', 'connected', $4, $5, now(), '2026-08-03', '{https://www.googleapis.com/auth/drive.readonly}') returning id`,
      [orgId, provider, externalOrgId, person, `${provider}-2026-11-01`]
    )
  ).rows[0].id;
}

async function driveRow(orgId: string, fields: Record<string, unknown> = {}): Promise<string> {
  const row = { source: "google_drive", drive_file_id: FILE_ID, file_name: "northwind-inv-2207.pdf", resend_email_id: null, status: "received", ...fields };
  return (
    await db.query<{ id: string }>(
      "insert into public.inbox_emails (org_id, source, drive_file_id, file_name, resend_email_id, status) values ($1, $2, $3, $4, $5, $6) returning id",
      [orgId, row.source, row.drive_file_id, row.file_name, row.resend_email_id, row.status]
    )
  ).rows[0].id;
}

async function folder(orgId: string, connectionId: string, fields: { baseline?: string[]; folderId?: string; lastError?: string | null; lastErrorKind?: string | null } = {}): Promise<string> {
  return (
    await db.query<{ id: string }>(
      `insert into public.google_drive_folders (org_id, connection_id, folder_id, folder_name, baseline, chosen_by, last_error, last_error_kind)
       values ($1, $2, $3, 'Bills to pay', $4, $5, $6, $7) returning id`,
      [orgId, connectionId, fields.folderId ?? FOLDER_ID, fields.baseline ?? [FILE_ID], person, fields.lastError ?? null, fields.lastErrorKind ?? null]
    )
  ).rows[0].id;
}

describe("the core's tables take Google Drive (Google Drive intake GD3)", () => {
  it("accepts googledrive beside every provider taken before, after 0101 to 0147 and 0148 ran again", async () => {
    const orgId = await createOrg(db, "googledrive-checks");
    const id = await connection(orgId);
    await db.query(
      `insert into public.accounting_tokens (id, org_id, provider, connection_id, authorized_by, access_token_enc, refresh_token_enc, access_expires_at)
       values (gen_random_uuid(), $1, 'googledrive', $2, $3, '{"v":1}', '{"v":1}', now())`,
      [orgId, id, person]
    );
    for (const name of ["accounting_connections_provider_check", "accounting_tokens_provider_check"]) {
      const def = await definition(name);
      for (const provider of [...PROVIDERS_BEFORE, "googledrive"]) expect(def, `${name} ${provider}`).toContain(`'${provider}'`);
    }
    await expect(connection(await createOrg(db, "googledrive-checks-dropbox"), "dropbox")).rejects.toThrow(/accounting_connections_provider_check/);
  });

  it("lets two workspaces connect the same Google account, and keeps one live Google Drive connection per workspace (GD2)", async () => {
    const shared = "07623471185200000001";
    expect(await connection(await createOrg(db, "googledrive-shared-1"), "googledrive", shared)).toBeTruthy();
    expect(await connection(await createOrg(db, "googledrive-shared-2"), "googledrive", shared)).toBeTruthy();
    const orgId = await createOrg(db, "googledrive-one-active");
    await connection(orgId);
    await expect(connection(orgId)).rejects.toThrow(/accounting_connections_one_active/);
  });

  it("leaves external_links as it was: nothing links a bill to Google Drive", async () => {
    expect(await definition("external_links_provider_check")).not.toContain("googledrive");
  });

  it("never narrows a later widening when it runs again, and 0145 and 0147 run after it keep googledrive", async () => {
    for (const [table, name] of [
      ["accounting_connections", "accounting_connections_provider_check"],
      ["accounting_tokens", "accounting_tokens_provider_check"],
    ] as const) {
      await db.query(`alter table public.${table} drop constraint ${name}`);
      await db.query(`alter table public.${table} add constraint ${name} check (provider in (${[...PROVIDERS_BEFORE, "googledrive", "dropbox"].map((id) => `'${id}'`).join(", ")}))`);
    }
    await db.exec(sql());
    for (const file of ["0147_linear_acceptance.sql", "0145_google_sheets_connector.sql", "0123_zoho_crm_connections.sql", "0101_accounting_connectors.sql"]) {
      await db.exec(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
    }
    for (const name of ["accounting_connections_provider_check", "accounting_tokens_provider_check"]) {
      expect(await definition(name)).toContain("'dropbox'");
      expect(await definition(name)).toContain("'googledrive'");
    }
  });

  it("says in its header that a later widening keeps googledrive, and how to undo it by hand", () => {
    expect(sql()).toMatch(/later widening must keep googledrive/i);
    expect(sql()).toMatch(/-- Down \(by hand/);
    expect(sql().trim().split("\n").filter((line) => !line.startsWith("--")).join("\n").trim().endsWith("notify pgrst, 'reload schema';")).toBe(true);
  });

  it("redefines no function an earlier migration made, never the sweeper's, and adds one table", () => {
    const functions = [...sql().matchAll(/create or replace function public\.(\w+)/g)].map((match) => match[1]);
    expect(functions).toEqual(["googledrive_connector_ready"]);
    const earlier = migrationFiles()
      .filter((file) => file < FILE)
      .map((file) => readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"))
      .join("\n");
    expect(earlier).not.toContain("googledrive_connector_ready");
    const statements = sql()
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(statements).not.toMatch(/accounting_connections_due/);
    expect([...sql().matchAll(/create table if not exists public\.(\w+)/g)].map((match) => match[1])).toEqual(["google_drive_folders"]);
  });
});

describe("inbox_emails takes a file from Google Drive beside the emails (GD3, GD6)", () => {
  it("keeps every email already there as an email, valid under every new check", async () => {
    const row = (
      await db.query<{ source: string; resend_email_id: string; drive_file_id: string | null; file_name: string | null; status: string }>(
        "select source, resend_email_id, drive_file_id, file_name, status from public.inbox_emails where id = $1",
        [before.emailId]
      )
    ).rows[0];
    expect(row).toEqual({ source: "email", resend_email_id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c", drive_file_id: null, file_name: null, status: "ready" });
    // Every check holds for the rows already there: validated, as a check added to a table with rows is.
    const unvalidated = await db.query("select conname from pg_constraint where conrelid = 'public.inbox_emails'::regclass and not convalidated");
    expect(unvalidated.rows).toEqual([]);
  });

  it("accepts an email as before, its source email by default, and a Drive file with its id and name", async () => {
    const orgId = await createOrg(db, "googledrive-rows");
    const email = await db.query<{ source: string }>(
      "insert into public.inbox_emails (org_id, resend_email_id, status) values ($1, 'a7d0d7f8-0b1c-4b39-9f3f-1d2a3b4c5d6e', 'received') returning source",
      [orgId]
    );
    expect(email.rows[0].source).toBe("email");
    expect(await driveRow(orgId)).toBeTruthy();
  });

  it("refuses a row that mixes the two sources, or leaves out what its source needs", async () => {
    const orgId = await createOrg(db, "googledrive-mixed");
    const insert = (values: { source: string; resend: string | null; drive: string | null; name: string | null }) =>
      db.query("insert into public.inbox_emails (org_id, source, resend_email_id, drive_file_id, file_name) values ($1, $2, $3, $4, $5)", [
        orgId,
        values.source,
        values.resend,
        values.drive,
        values.name,
      ]);
    const RESEND = "b1d0d7f8-0b1c-4b39-9f3f-1d2a3b4c5d6e";
    // An email that names a Drive file, or a file name; an email without its Resend id.
    await expect(insert({ source: "email", resend: RESEND, drive: FILE_ID, name: null })).rejects.toThrow(/inbox_emails_source_fields_check/);
    await expect(insert({ source: "email", resend: RESEND, drive: null, name: "inv.pdf" })).rejects.toThrow(/inbox_emails_source_fields_check/);
    await expect(insert({ source: "email", resend: null, drive: null, name: null })).rejects.toThrow(/inbox_emails_source_fields_check/);
    // A Drive file with a Resend id, without its id, or without its name.
    await expect(insert({ source: "google_drive", resend: RESEND, drive: FILE_ID, name: "inv.pdf" })).rejects.toThrow(/inbox_emails_source_fields_check/);
    await expect(insert({ source: "google_drive", resend: null, drive: null, name: "inv.pdf" })).rejects.toThrow(/inbox_emails_source_fields_check/);
    await expect(insert({ source: "google_drive", resend: null, drive: FILE_ID, name: null })).rejects.toThrow(/inbox_emails_source_fields_check/);
    // Another source, a Drive id that is not one, and a name past 255 characters.
    await expect(insert({ source: "dropbox", resend: null, drive: FILE_ID, name: "inv.pdf" })).rejects.toThrow(/inbox_emails_source_check/);
    await expect(insert({ source: "google_drive", resend: null, drive: "1Ab/../etc", name: "inv.pdf" })).rejects.toThrow(/inbox_emails_drive_file_id_check/);
    await expect(insert({ source: "google_drive", resend: null, drive: "x".repeat(201), name: "inv.pdf" })).rejects.toThrow(/inbox_emails_drive_file_id_check/);
    await expect(insert({ source: "google_drive", resend: null, drive: FILE_ID, name: "n".repeat(256) })).rejects.toThrow(/inbox_emails_file_name_check/);
  });

  it("keeps one row per Drive file and workspace, and another workspace its own", async () => {
    const orgId = await createOrg(db, "googledrive-once");
    await driveRow(orgId);
    await expect(driveRow(orgId)).rejects.toThrow(/inbox_emails_drive_file_key/);
    expect(await driveRow(await createOrg(db, "googledrive-once-other"))).toBeTruthy();
  });

  it("answers no row to the insert that ignores a duplicate, as PostgREST's upsert with ignoreDuplicates sends it", async () => {
    const orgId = await createOrg(db, "googledrive-ignore");
    const insert = () =>
      db.query<{ id: string }>(
        `insert into public.inbox_emails (org_id, source, drive_file_id, file_name, status) values ($1, 'google_drive', $2, 'inv.pdf', 'received')
         on conflict (org_id, drive_file_id) do nothing returning id`,
        [orgId, FILE_ID]
      );
    expect((await insert()).rows).toHaveLength(1);
    expect((await insert()).rows).toEqual([]);
    // An email's own upsert still finds its key.
    const email = () =>
      db.query<{ id: string }>(
        `insert into public.inbox_emails (org_id, resend_email_id, status) values ($1, 'c1d0d7f8-0b1c-4b39-9f3f-1d2a3b4c5d6e', 'received')
         on conflict (org_id, resend_email_id) do nothing returning id`,
        [orgId]
      );
    expect((await email()).rows).toHaveLength(1);
    expect((await email()).rows).toEqual([]);
  });
});

describe("google_drive_folders (GD3, GD4, GD5, GD13)", () => {
  it("keeps one folder per workspace, read with that workspace's own connection, and goes with the connection", async () => {
    const orgId = await createOrg(db, "googledrive-folder");
    const connectionId = await connection(orgId);
    const id = await folder(orgId, connectionId);
    expect(id).toBeTruthy();
    await expect(folder(orgId, connectionId, { folderId: "1AnOtHeRfOlDeRaBcDeFgHiJkLmNoPqRs" })).rejects.toThrow(/google_drive_folders_org_id_key/);
    // Another workspace's connection is not this workspace's to read with.
    const other = await createOrg(db, "googledrive-folder-other");
    await expect(folder(other, connectionId)).rejects.toThrow(/google_drive_folders_connection_fkey/);
    await db.query("delete from public.accounting_connections where id = $1", [connectionId]);
    expect((await db.query("select id from public.google_drive_folders where id = $1", [id])).rows).toEqual([]);
  });

  it("takes a baseline of at most 1,000 files (GD5), a folder id that is Drive's, and an error with its kind", async () => {
    const orgId = await createOrg(db, "googledrive-folder-checks");
    const connectionId = await connection(orgId);
    const ids = (count: number) => Array.from({ length: count }, (_, at) => `1File${String(at).padStart(28, "0")}`);
    await expect(folder(orgId, connectionId, { baseline: ids(1001) })).rejects.toThrow(/google_drive_folders_baseline_check/);
    await expect(folder(orgId, connectionId, { folderId: "../folders" })).rejects.toThrow(/google_drive_folders_folder_id_check/);
    await expect(folder(orgId, connectionId, { lastError: "Google Drive did not answer.", lastErrorKind: null })).rejects.toThrow(/google_drive_folders_error_check/);
    await expect(folder(orgId, connectionId, { lastError: "Gone.", lastErrorKind: "vanished" })).rejects.toThrow(/google_drive_folders_last_error_kind_check/);
    const id = await folder(orgId, connectionId, { baseline: ids(1000), lastError: "The folder was deleted.", lastErrorKind: "folder_gone" });
    const row = (await db.query<{ count: number }>("select cardinality(baseline) as count from public.google_drive_folders where id = $1", [id])).rows[0];
    expect(row.count).toBe(1000);
  });

  it("shows a workspace its own folder only, and lets it replace and forget it", async () => {
    const orgId = await createOrg(db, "googledrive-folder-rls");
    const other = await createOrg(db, "googledrive-folder-rls-other");
    await folder(orgId, await connection(orgId));
    await folder(other, await connection(other));
    const seen = await asTenant(db, orgId, async (tx) => (await tx.query<{ org_id: string }>("select org_id from public.google_drive_folders")).rows);
    expect(seen).toEqual([{ org_id: orgId }]);
    await asTenant(db, orgId, (tx) => tx.query("update public.google_drive_folders set folder_name = 'Bills 2027', baseline = '{}' where org_id = $1", [orgId]));
    const gone = await asTenant(db, orgId, (tx) => tx.query("delete from public.google_drive_folders where org_id = $1", [other]));
    expect(gone.affectedRows ?? 0).toBe(0);
    await asTenant(db, orgId, (tx) => tx.query("delete from public.google_drive_folders where org_id = $1", [orgId]));
    expect((await db.query("select org_id from public.google_drive_folders where org_id = any($1::uuid[])", [[orgId, other]])).rows).toEqual([{ org_id: other }]);
    await expect(asRole(db, "anon", (tx) => tx.query("select * from public.google_drive_folders"))).rejects.toThrow(/permission denied/);
  });
});

describe("googledrive_connector_ready(p_org_id) (GD3)", () => {
  it("answers true to the tenant role, and to no one signed in", async () => {
    const orgId = await createOrg(db, "googledrive-ready");
    const ready = await asTenant(db, orgId, async (tx) =>
      (await tx.query<{ ready: boolean }>("select public.googledrive_connector_ready(p_org_id => $1::uuid) as ready", [orgId])).rows[0].ready
    );
    expect(ready).toBe(true);
    await expect(asRole(db, "anon", (tx) => tx.query("select public.googledrive_connector_ready(p_org_id => $1::uuid)", [orgId]))).rejects.toThrow(/permission denied/);
    await expect(asRole(db, "authenticated", (tx) => tx.query("select public.googledrive_connector_ready(p_org_id => $1::uuid)", [orgId]))).rejects.toThrow(/permission denied/);
  });
});

describe("the sweeper reads a Drive connection every 15 minutes (GD3, GD7)", () => {
  it("returns a connected googledrive row whose next sync is unset from accounting_connections_due(50), as Linear's", async () => {
    const orgId = await createOrg(db, "googledrive-due");
    const drive = await connection(orgId);
    const due = await asServiceRole(db, async (tx) => (await tx.query<{ connection_id: string; provider: string }>("select * from public.accounting_connections_due(500)")).rows);
    expect(due.find((row) => row.connection_id === drive)).toMatchObject({ provider: "googledrive" });
  });
});
