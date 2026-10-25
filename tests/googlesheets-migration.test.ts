import { readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg, createUser, migrationFiles, MIGRATIONS_DIR } from "./support/pglite";

/**
 * Migration 0145 (docs/superpowers/specs/2026-10-25-close-pack-google-sheets-design.md GS1, GS2, GS15): the connector
 * core's tables take Google Sheets beside every provider they took; a re-run never narrows a later widening, and the
 * earlier widenings, run again after it, leave it; nothing links to Google Sheets, so external_links still refuses it;
 * the readiness probe answers the tenant role only; and the sweeper never picks a Sheets connection, whose next sync is
 * never due, without this migration redefining the sweeper's function.
 */

const FILE = "0145_google_sheets_connector.sql";
const sql = () => readFileSync(path.join(MIGRATIONS_DIR, FILE), "utf8");
const PROVIDERS_BEFORE = ["xero", "quickbooks", "hubspot", "asana", "pipedrive", "zohobooks", "zohocrm"];

let db: PGlite;
let person: string;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  // Re-runnable, as scripts/migrate.ts re-runs every file: the earlier widenings, then this one, again.
  await applyMigrations(db, (file) => ["0101_", "0105_", "0115_", "0116_", "0122_", "0123_", "0145_"].some((prefix) => file.startsWith(prefix)));
  person = await createUser(db, "owner-googlesheets@example.com");
}, 60_000);

afterAll(async () => {
  await db.close();
});

async function connection(orgId: string, input: { provider?: string; externalOrgId?: string; nextSyncAfter?: string | null } = {}): Promise<string> {
  return (
    await db.query<{ id: string }>(
      `insert into public.accounting_connections (org_id, provider, external_org_id, external_org_name, status, connected_by, consent_version, consented_at, window_from, scopes, next_sync_after)
       values ($1, $2, $3, 'du***@gmail.com', 'connected', $4, 'googlesheets-2026-10-25', now(), '2026-07-27', '{https://www.googleapis.com/auth/drive.file}', $5) returning id`,
      [orgId, input.provider ?? "googlesheets", input.externalOrgId ?? "07623471185212345678", person, input.nextSyncAfter === undefined ? "9999-12-31T00:00:00Z" : input.nextSyncAfter]
    )
  ).rows[0].id;
}

const definition = async (name: string) =>
  (await db.query<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conname = $1", [name])).rows[0]?.def ?? "";

describe("the core's tables take Google Sheets (close pack Sheets GS1)", () => {
  it("accepts googlesheets beside every provider taken before, after 0101, 0105, 0115, 0116, 0122, 0123 and 0145 ran again", async () => {
    const orgId = await createOrg(db, "googlesheets-checks");
    const id = await connection(orgId);
    expect(id).toBeTruthy();
    await db.query(
      `insert into public.accounting_tokens (id, org_id, provider, connection_id, authorized_by, access_token_enc, refresh_token_enc, access_expires_at)
       values (gen_random_uuid(), $1, 'googlesheets', $2, $3, '{"v":1}', '{"v":1}', now())`,
      [orgId, id, person]
    );
    for (const name of ["accounting_connections_provider_check", "accounting_tokens_provider_check"]) {
      const def = await definition(name);
      for (const provider of [...PROVIDERS_BEFORE, "googlesheets"]) expect(def, name).toContain(`'${provider}'`);
    }
  });

  it("lets two workspaces connect the same Google account, each with its own spreadsheets (GS4)", async () => {
    const first = await createOrg(db, "googlesheets-shared-1");
    const second = await createOrg(db, "googlesheets-shared-2");
    expect(await connection(first, { externalOrgId: "11111111111111111111" })).toBeTruthy();
    expect(await connection(second, { externalOrgId: "11111111111111111111" })).toBeTruthy();
  });

  it("keeps one live Google account per workspace (GS4)", async () => {
    const orgId = await createOrg(db, "googlesheets-one-active");
    await connection(orgId, { externalOrgId: "22222222222222222222" });
    await expect(connection(orgId, { externalOrgId: "33333333333333333333" })).rejects.toThrow(/accounting_connections_one_active/);
  });

  it("leaves external_links refusing googlesheets: nothing links to Google Sheets", async () => {
    expect(await definition("external_links_provider_check")).not.toContain("googlesheets");
    const orgId = await createOrg(db, "googlesheets-links");
    const id = await connection(orgId, { externalOrgId: "44444444444444444444" });
    await expect(
      db.query(
        `insert into public.external_links (org_id, connection_id, provider, external_org_id, object_type, external_id)
         values ($1, $2, 'googlesheets', '44444444444444444444', 'bill', 'sheet-1')`,
        [orgId, id]
      )
    ).rejects.toThrow(/external_links_provider_check/);
  });

  it("never narrows a later widening when it runs again", async () => {
    for (const [table, name] of [
      ["accounting_connections", "accounting_connections_provider_check"],
      ["accounting_tokens", "accounting_tokens_provider_check"],
    ] as const) {
      await db.query(`alter table public.${table} drop constraint ${name}`);
      await db.query(`alter table public.${table} add constraint ${name} check (provider in (${[...PROVIDERS_BEFORE, "googlesheets", "sage"].map((id) => `'${id}'`).join(", ")}))`);
    }
    await db.exec(sql());
    await db.exec(readFileSync(path.join(MIGRATIONS_DIR, "0123_zoho_crm_connections.sql"), "utf8"));
    await db.exec(readFileSync(path.join(MIGRATIONS_DIR, "0101_accounting_connectors.sql"), "utf8"));
    expect(await definition("accounting_connections_provider_check")).toContain("'sage'");
    expect(await definition("accounting_tokens_provider_check")).toContain("'sage'");
  });

  it("says in its header that a later widening keeps googlesheets, and how to undo it by hand", () => {
    expect(sql()).toMatch(/later widening must keep googlesheets/i);
    expect(sql()).toMatch(/-- Down \(by hand/);
    expect(sql().trim().split("\n").filter((line) => !line.startsWith("--")).join("\n").trim().endsWith("notify pgrst, 'reload schema';")).toBe(true);
  });
});

describe("googlesheets_connector_ready(p_org_id) (GS2)", () => {
  it("answers true to the tenant role, and to no one signed in", async () => {
    const orgId = await createOrg(db, "googlesheets-ready");
    const ready = await asTenant(db, orgId, async (tx) =>
      (await tx.query<{ ready: boolean }>("select public.googlesheets_connector_ready(p_org_id => $1::uuid) as ready", [orgId])).rows[0].ready
    );
    expect(ready).toBe(true);
    await expect(asRole(db, "anon", (tx) => tx.query("select public.googlesheets_connector_ready(p_org_id => $1::uuid)", [orgId]))).rejects.toThrow(/permission denied/);
    await expect(asRole(db, "authenticated", (tx) => tx.query("select public.googlesheets_connector_ready(p_org_id => $1::uuid)", [orgId]))).rejects.toThrow(
      /permission denied/
    );
  });
});

describe("the sweeper never picks a Sheets connection (GS15)", () => {
  it("never returns a googlesheets row whose next sync is 9999-12-31 from accounting_connections_due(50)", async () => {
    const orgId = await createOrg(db, "googlesheets-due");
    const sheets = await connection(orgId, { externalOrgId: "55555555555555555555" });
    const due = await asServiceRole(db, async (tx) => (await tx.query<{ connection_id: string; provider: string }>("select * from public.accounting_connections_due(50)")).rows);
    expect(due.map((row) => row.connection_id)).not.toContain(sheets);
    expect(due.filter((row) => row.provider === "googlesheets")).toEqual([]);
  });

  it("redefines no function or view an earlier migration made: its one function is its own", () => {
    const functions = [...sql().matchAll(/create or replace function public\.(\w+)/g)].map((match) => match[1]);
    expect(functions).toEqual(["googlesheets_connector_ready"]);
    const earlier = migrationFiles()
      .filter((file) => file < FILE)
      .map((file) => readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"))
      .join("\n");
    expect(earlier).not.toContain("googlesheets_connector_ready");
    const statements = sql()
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(statements).not.toMatch(/accounting_connections_due/);
    expect(statements).not.toMatch(/create (?:or replace )?(?:view|table|index|unique index)/i);
  });
});
