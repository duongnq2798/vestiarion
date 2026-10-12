import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg, createUser } from "./support/pglite";

/**
 * Migration 0102 (docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md Q5, Q11): a QuickBooks company is
 * connected to one workspace at a time, while a Xero organisation may still be shared; and the service role alone finds
 * the connections of a company across workspaces, answering ids, a status and a time.
 */

let db: PGlite;
let person: string;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  // Re-runnable, as scripts/migrate.ts re-runs every file.
  await applyMigrations(db, (file) => file.startsWith("0102_"));
  person = await createUser(db, "owner-quickbooks@example.com");
}, 60_000);

afterAll(async () => {
  await db.close();
});

async function connection(orgId: string, provider: "xero" | "quickbooks", externalOrgId: string, status = "connected"): Promise<string> {
  return (
    await db.query<{ id: string }>(
      `insert into public.accounting_connections (org_id, provider, external_org_id, external_org_name, status, connected_by, consent_version, consented_at, window_from, revoked_at)
       values ($1, $2, $3, 'Sandbox Company_US_1', $4, $5, $2 || '-2026-10-12', now(), '2026-07-14', case when $4 = 'revoked' then now() end) returning id`,
      [orgId, provider, externalOrgId, status, person]
    )
  ).rows[0].id;
}

describe("one workspace per QuickBooks company", () => {
  it("refuses a second workspace on a company another holds, and lets it in once that one is revoked", async () => {
    const first = await createOrg(db, "qb-first");
    const second = await createOrg(db, "qb-second");
    const held = await connection(first, "quickbooks", "9341455327810551");
    await expect(connection(second, "quickbooks", "9341455327810551")).rejects.toThrow(/accounting_connections_quickbooks_one_workspace/);
    // A connection that needs reconnecting still holds the company.
    await db.query("update public.accounting_connections set status = 'needs_reconnect' where id = $1", [held]);
    await expect(connection(second, "quickbooks", "9341455327810551")).rejects.toThrow(/one_workspace/);
    await db.query("update public.accounting_connections set status = 'revoked', revoked_at = now() where id = $1", [held]);
    expect(await connection(second, "quickbooks", "9341455327810551")).toBeTruthy();
  });

  it("still lets two workspaces share a Xero organisation", async () => {
    const one = await createOrg(db, "xero-share-one");
    const two = await createOrg(db, "xero-share-two");
    await connection(one, "xero", "70784a63-d24b-46a9-a4db-0e70a274b056");
    expect(await connection(two, "xero", "70784a63-d24b-46a9-a4db-0e70a274b056")).toBeTruthy();
  });
});

describe("accounting_connections_by_external", () => {
  it("finds the connections of a company in every workspace, never a revoked one, and only for the service role", async () => {
    const live = await createOrg(db, "qb-by-external-live");
    const gone = await createOrg(db, "qb-by-external-gone");
    const other = await createOrg(db, "qb-by-external-other");
    const liveId = await connection(live, "quickbooks", "123145812345678");
    await connection(gone, "quickbooks", "123145899999999", "revoked");
    await connection(other, "xero", "123145812345678");
    await db.query("update public.accounting_connections set next_sync_after = '2026-10-12T15:00:00Z' where id = $1", [liveId]);
    const rows = await asServiceRole(db, async (tx) =>
      (
        await tx.query<{ org_id: string; connection_id: string; external_org_id: string; status: string; next_sync_after: Date | null }>(
          "select * from public.accounting_connections_by_external('quickbooks', array['123145812345678', '123145899999999', 'nobody'])"
        )
      ).rows
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ org_id: live, connection_id: liveId, external_org_id: "123145812345678", status: "connected" });
    expect(new Date(rows[0].next_sync_after as Date).toISOString()).toBe("2026-10-12T15:00:00.000Z");
    expect(Object.keys(rows[0]).sort()).toEqual(["connection_id", "external_org_id", "next_sync_after", "org_id", "status"]);
    const none = await asServiceRole(db, async (tx) => (await tx.query("select * from public.accounting_connections_by_external('quickbooks', null)")).rows);
    expect(none).toEqual([]);
  });

  it("is closed to the tenant role and the browser roles", async () => {
    const orgId = await createOrg(db, "qb-by-external-closed");
    await expect(
      asTenant(db, orgId, (tx) => tx.query("select * from public.accounting_connections_by_external('quickbooks', array['1'])"))
    ).rejects.toThrow(/permission denied/);
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select * from public.accounting_connections_by_external('quickbooks', array['1'])"))).rejects.toThrow(
        /permission denied/
      );
    }
  });
});
