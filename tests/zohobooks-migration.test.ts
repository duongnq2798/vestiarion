import { readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asTenant, createDatabase, createOrg, createUser, MIGRATIONS_DIR } from "./support/pglite";

/**
 * Migration 0122 (docs/superpowers/specs/2026-10-16-zoho-books-connector-design.md Z12): the core's tables take
 * Zoho Books beside every provider they took; a re-run never narrows a later widening, and the earlier migrations, run
 * again after it, leave it; several workspaces may connect one organization; and the readiness probe answers the
 * tenant role only.
 */

let db: PGlite;
let person: string;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  // Re-runnable, as scripts/migrate.ts re-runs every file: the earlier widenings, then this one, again.
  await applyMigrations(db, (file) => ["0101_", "0105_", "0115_", "0116_", "0122_"].some((prefix) => file.startsWith(prefix)));
  person = await createUser(db, "owner-zoho@example.com");
}, 60_000);

afterAll(async () => {
  await db.close();
});

async function connection(orgId: string, provider = "zohobooks", externalOrgId = "60012345678"): Promise<string> {
  return (
    await db.query<{ id: string }>(
      `insert into public.accounting_connections (org_id, provider, external_org_id, external_org_name, status, connected_by, consent_version, consented_at, window_from, scopes)
       values ($1, $2, $3, 'Lumen Print Co.', 'connected', $4, 'zohobooks-2026-10-16', now(), '2026-07-18', '{ZohoBooks.bills.READ}') returning id`,
      [orgId, provider, externalOrgId, person]
    )
  ).rows[0].id;
}

const definition = async (name: string) =>
  (await db.query<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conname = $1", [name])).rows[0]?.def ?? "";

describe("the core's tables take Zoho Books", () => {
  it("accepts zohobooks beside every provider taken before, after every earlier migration ran again", async () => {
    const orgId = await createOrg(db, "zoho-checks");
    expect(await connection(orgId)).toBeTruthy();
    for (const name of ["accounting_connections_provider_check", "accounting_tokens_provider_check", "external_links_provider_check"]) {
      const def = await definition(name);
      for (const provider of ["xero", "quickbooks", "hubspot", "asana", "pipedrive", "zohobooks"]) expect(def, name).toContain(`'${provider}'`);
    }
    await expect(connection(await createOrg(db, "zoho-checks-unknown"), "zoho", "x")).rejects.toThrow(/accounting_connections_provider_check/);
  });

  it("lets two workspaces connect the same organization, as with Xero", async () => {
    const first = await createOrg(db, "zoho-shared-1");
    const second = await createOrg(db, "zoho-shared-2");
    expect(await connection(first, "zohobooks", "60099999999")).toBeTruthy();
    expect(await connection(second, "zohobooks", "60099999999")).toBeTruthy();
  });

  it("never narrows a later widening when it runs again", async () => {
    await db.query("alter table public.accounting_connections drop constraint accounting_connections_provider_check");
    await db.query(
      "alter table public.accounting_connections add constraint accounting_connections_provider_check check (provider in ('xero', 'quickbooks', 'hubspot', 'asana', 'pipedrive', 'zohobooks', 'sage'))"
    );
    await db.exec(readFileSync(path.join(MIGRATIONS_DIR, "0122_zoho_books_connections.sql"), "utf8"));
    expect(await definition("accounting_connections_provider_check")).toContain("'sage'");
  });
});

describe("zohobooks_connector_ready(p_org_id)", () => {
  it("answers true to the tenant role, and to no one signed in", async () => {
    const orgId = await createOrg(db, "zoho-ready");
    // With the workspace as p_org_id, as the data layer calls every tenant function (0117's lesson for Pipedrive).
    const ready = await asTenant(db, orgId, async (tx) =>
      (await tx.query<{ ready: boolean }>("select public.zohobooks_connector_ready(p_org_id => $1::uuid) as ready", [orgId])).rows[0].ready
    );
    expect(ready).toBe(true);
    await expect(asRole(db, "anon", (tx) => tx.query("select public.zohobooks_connector_ready(p_org_id => $1::uuid)", [orgId]))).rejects.toThrow(/permission denied/);
  });
});
