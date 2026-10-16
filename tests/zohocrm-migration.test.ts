import { readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asTenant, createDatabase, createOrg, createUser, MIGRATIONS_DIR } from "./support/pglite";

/**
 * Migration 0123 (docs/superpowers/specs/2026-10-16-zoho-crm-connector-design.md C14, C17): the core's tables take
 * Zoho CRM beside every provider they took; a re-run never narrows a later widening, and the earlier migrations, run
 * again after it, leave it; several workspaces may connect one organization; a Zoho CRM connection can never turn
 * writing on; and the readiness probe answers the tenant role only.
 */

let db: PGlite;
let person: string;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  // Re-runnable, as scripts/migrate.ts re-runs every file: the earlier widenings, then this one, again.
  await applyMigrations(db, (file) => ["0101_", "0105_", "0115_", "0116_", "0122_", "0123_"].some((prefix) => file.startsWith(prefix)));
  person = await createUser(db, "owner-zohocrm@example.com");
}, 60_000);

afterAll(async () => {
  await db.close();
});

async function connection(orgId: string, provider = "zohocrm", externalOrgId = "71234567"): Promise<string> {
  return (
    await db.query<{ id: string }>(
      `insert into public.accounting_connections (org_id, provider, external_org_id, external_org_name, status, connected_by, consent_version, consented_at, window_from, scopes)
       values ($1, $2, $3, 'Lumen Holdings', 'connected', $4, 'zohocrm-2026-10-16', now(), '2026-07-18', '{ZohoCRM.modules.deals.READ}') returning id`,
      [orgId, provider, externalOrgId, person]
    )
  ).rows[0].id;
}

const definition = async (name: string) =>
  (await db.query<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conname = $1", [name])).rows[0]?.def ?? "";

describe("the core's tables take Zoho CRM", () => {
  it("accepts zohocrm beside every provider taken before, after every earlier migration ran again", async () => {
    const orgId = await createOrg(db, "zohocrm-checks");
    expect(await connection(orgId)).toBeTruthy();
    for (const name of ["accounting_connections_provider_check", "accounting_tokens_provider_check", "external_links_provider_check"]) {
      const def = await definition(name);
      for (const provider of ["xero", "quickbooks", "hubspot", "asana", "pipedrive", "zohobooks", "zohocrm"]) expect(def, name).toContain(`'${provider}'`);
    }
  });

  it("lets two workspaces connect the same organization: nothing is written there for them to contend over", async () => {
    const first = await createOrg(db, "zohocrm-shared-1");
    const second = await createOrg(db, "zohocrm-shared-2");
    expect(await connection(first, "zohocrm", "79999999")).toBeTruthy();
    expect(await connection(second, "zohocrm", "79999999")).toBeTruthy();
  });

  it("never lets a Zoho CRM connection turn writing on, nor queue a write for it", async () => {
    const id = await connection(await createOrg(db, "zohocrm-writes"), "zohocrm", "75555555");
    await expect(db.query("update public.accounting_connections set writes_on = true where id = $1", [id])).rejects.toThrow(/accounting_connections_writes_check/);
    expect(await definition("crm_receipt_writes_provider_check")).not.toContain("zohocrm");
  });

  it("never narrows a later widening when it runs again", async () => {
    await db.query("alter table public.accounting_connections drop constraint accounting_connections_provider_check");
    await db.query(
      "alter table public.accounting_connections add constraint accounting_connections_provider_check check (provider in ('xero', 'quickbooks', 'hubspot', 'asana', 'pipedrive', 'zohobooks', 'zohocrm', 'sage'))"
    );
    await db.exec(readFileSync(path.join(MIGRATIONS_DIR, "0123_zoho_crm_connections.sql"), "utf8"));
    await db.exec(readFileSync(path.join(MIGRATIONS_DIR, "0122_zoho_books_connections.sql"), "utf8"));
    expect(await definition("accounting_connections_provider_check")).toContain("'sage'");
  });
});

describe("zohocrm_connector_ready(p_org_id)", () => {
  it("answers true to the tenant role, and to no one signed in", async () => {
    const orgId = await createOrg(db, "zohocrm-ready");
    const ready = await asTenant(db, orgId, async (tx) =>
      (await tx.query<{ ready: boolean }>("select public.zohocrm_connector_ready(p_org_id => $1::uuid) as ready", [orgId])).rows[0].ready
    );
    expect(ready).toBe(true);
    await expect(asRole(db, "anon", (tx) => tx.query("select public.zohocrm_connector_ready(p_org_id => $1::uuid)", [orgId]))).rejects.toThrow(/permission denied/);
  });
});
