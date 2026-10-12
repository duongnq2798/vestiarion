import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg, createUser } from "./support/pglite";

/**
 * Migration 0105 (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H2, H4): HubSpot on the connector
 * core's tables, one workspace per HubSpot account, and the deals read from it (`crm_deals`), which the tenant role
 * reads and writes in its own workspace and never deletes.
 */

let db: PGlite;
let person: string;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  // Re-runnable, as scripts/migrate.ts re-runs every file.
  await applyMigrations(db, (file) => file.startsWith("0101_") || file.startsWith("0105_"));
  person = await createUser(db, "owner-hubspot@example.com");
}, 60_000);

afterAll(async () => {
  await db.close();
});

async function connection(orgId: string, provider = "hubspot", externalOrgId = "1234567", status = "connected"): Promise<string> {
  return (
    await db.query<{ id: string }>(
      `insert into public.accounting_connections (org_id, provider, external_org_id, external_org_name, status, connected_by, consent_version, consented_at, window_from, revoked_at)
       values ($1, $2, $3, 'example.com', $4, $5, 'hubspot-2026-10-12', now(), '2026-07-14', case when $4 = 'revoked' then now() end) returning id`,
      [orgId, provider, externalOrgId, status, person]
    )
  ).rows[0].id;
}

async function crmDeal(orgId: string, connectionId: string, externalId = "9001", fields: Record<string, unknown> = {}): Promise<string> {
  const row = { name: "Website rebuild", amount: 12500, currency: "USD", close_on: "2026-10-01", stage_state: "won", ...fields };
  return (
    await db.query<{ id: string }>(
      `insert into public.crm_deals (org_id, connection_id, external_id, name, amount, currency, close_on, stage_state, company_external_id, company_name, external_version)
       values ($1, $2, $3, $4, $5, $6, $7, $8, '501', 'Northwind Labs', '2026-10-01T09:00:00.000Z') returning id`,
      [orgId, connectionId, externalId, row.name, row.amount, row.currency, row.close_on, row.stage_state]
    )
  ).rows[0].id;
}

describe("the core's tables take HubSpot", () => {
  it("accepts hubspot as a provider, and companies and deals as linked objects and cursors", async () => {
    const orgId = await createOrg(db, "hubspot-checks");
    const connectionId = await connection(orgId);
    await db.query(
      `insert into public.accounting_tokens (id, org_id, provider, connection_id, authorized_by, access_token_enc, refresh_token_enc, access_expires_at)
       values (gen_random_uuid(), $1, 'hubspot', $2, $3, '{}'::jsonb, '{}'::jsonb, now())`,
      [orgId, connectionId, person]
    );
    await db.query(
      `insert into public.external_links (org_id, connection_id, provider, external_org_id, object_type, external_id, label) values ($1, $2, 'hubspot', '1234567', 'company', '501', 'Northwind Labs')`,
      [orgId, connectionId]
    );
    await db.query("insert into public.accounting_sync_cursors (org_id, connection_id, object_type) values ($1, $2, 'deal')", [orgId, connectionId]);
    await expect(
      db.query(
        `insert into public.external_links (org_id, connection_id, provider, external_org_id, object_type, external_id) values ($1, $2, 'hubspot', '1234567', 'ticket', '1')`,
        [orgId, connectionId]
      )
    ).rejects.toThrow(/external_links_object_type_check/);
    await expect(connection(orgId, "pipedrive", "x")).rejects.toThrow(/accounting_connections_provider_check/);
    // Xero's and QuickBooks' values stay accepted.
    const other = await createOrg(db, "hubspot-checks-xero");
    expect(await connection(other, "xero", "tenant-1")).toBeTruthy();
    expect(await connection(other, "quickbooks", "realm-1")).toBeTruthy();
  });

  it("connects a HubSpot account to one workspace at a time, while Xero organisations may still be shared", async () => {
    const a = await createOrg(db, "hubspot-one-a");
    const b = await createOrg(db, "hubspot-one-b");
    const first = await connection(a, "hubspot", "7654321");
    await expect(connection(b, "hubspot", "7654321")).rejects.toThrow(/accounting_connections_hubspot_one_workspace/);
    await db.query("update public.accounting_connections set status = 'revoked', revoked_at = now() where id = $1", [first]);
    expect(await connection(b, "hubspot", "7654321")).toBeTruthy();
    expect(await connection(a, "xero", "shared-tenant")).toBeTruthy();
    expect(await connection(b, "xero", "shared-tenant")).toBeTruthy();
  });

  it("finds the connections of a HubSpot account across workspaces for the service role only", async () => {
    const orgId = await createOrg(db, "hubspot-by-external");
    const connectionId = await connection(orgId, "hubspot", "5550001");
    const rows = await asServiceRole(
      db,
      async (tx) => (await tx.query<{ org_id: string; connection_id: string }>("select org_id, connection_id from public.accounting_connections_by_external('hubspot', array['5550001'])")).rows
    );
    expect(rows).toEqual([{ org_id: orgId, connection_id: connectionId }]);
    await expect(asTenant(db, orgId, (tx) => tx.query("select * from public.accounting_connections_by_external('hubspot', array['5550001'])"))).rejects.toThrow(
      /permission denied/
    );
    await expect(asRole(db, "authenticated", (tx) => tx.query("select * from public.accounting_connections_by_external('hubspot', array['5550001'])"))).rejects.toThrow(
      /permission denied/
    );
  });
});

describe("crm_deals", () => {
  it("keeps one row per connection and HubSpot deal, with an open, won or lost stage", async () => {
    const orgId = await createOrg(db, "crm-deals-unique");
    const connectionId = await connection(orgId, "hubspot", "8880001");
    await crmDeal(orgId, connectionId, "9001");
    await expect(crmDeal(orgId, connectionId, "9001")).rejects.toThrow(/crm_deals_external_key/);
    await expect(crmDeal(orgId, connectionId, "9002", { stage_state: "paused" })).rejects.toThrow(/crm_deals_stage_state_check/);
    await expect(crmDeal(orgId, connectionId, "9003", { currency: "usd" })).rejects.toThrow(/crm_deals_currency_check/);
    expect(await crmDeal(orgId, connectionId, "9004", { amount: null, currency: null, close_on: null, stage_state: "open" })).toBeTruthy();
  });

  it("is read and written by its own workspace only, and never deleted by the tenant role", async () => {
    const a = await createOrg(db, "crm-deals-tenant-a");
    const b = await createOrg(db, "crm-deals-tenant-b");
    await crmDeal(a, await connection(a, "hubspot", "8880002"));
    const theirs = await crmDeal(b, await connection(b, "hubspot", "8880003"));
    const seen = await asTenant(db, a, async (tx) => (await tx.query<{ org_id: string }>("select org_id from public.crm_deals")).rows);
    expect(seen.map((row) => row.org_id)).toEqual([a]);
    const updated = await asTenant(db, a, (tx) => tx.query("update public.crm_deals set name = 'x' where id = $1", [theirs]));
    expect(updated.affectedRows ?? 0).toBe(0);
    await expect(asTenant(db, a, (tx) => tx.query("delete from public.crm_deals"))).rejects.toThrow(/permission denied/);
    await expect(asRole(db, "authenticated", (tx) => tx.query("select 1 from public.crm_deals"))).rejects.toThrow(/permission denied/);
  });

  it("names a deal of its own workspace only, once, and forgets it when the deal goes", async () => {
    const orgId = await createOrg(db, "crm-deals-link");
    const connectionId = await connection(orgId, "hubspot", "8880004");
    const counterpartyId = (
      await db.query<{ id: string }>("insert into public.counterparties (org_id, name, role) values ($1, 'Northwind Labs', 'client') returning id", [orgId])
    ).rows[0].id;
    const dealId = (
      await db.query<{ id: string }>(
        `select (public.create_deal($1, jsonb_build_object('counterpartyId', $2::text, 'title', 'Website rebuild', 'currency', 'USDC', 'minorDigits', 2, 'totalMinor', 100,
           'startsOn', '2026-10-01', 'termsDays', 14, 'template', 'custom', 'idempotencyKey', 'crm-link-key', 'externalRef', '9001'),
           '[{"position": 1, "label": "All", "invoiceOn": "2026-10-01", "dueOn": "2026-10-15", "amountMinor": 100}]'::jsonb) ->> 'id') as id`,
        [orgId, counterpartyId]
      )
    ).rows[0].id;
    const row = await crmDeal(orgId, connectionId, "9001");
    await db.query("update public.crm_deals set deal_id = $2, linked_at = now() where id = $1", [row, dealId]);
    const second = await crmDeal(orgId, connectionId, "9002");
    await expect(db.query("update public.crm_deals set deal_id = $2, linked_at = now() where id = $1", [second, dealId])).rejects.toThrow(/crm_deals_deal_key/);
    const elsewhere = await createOrg(db, "crm-deals-link-other");
    const otherRow = await crmDeal(elsewhere, await connection(elsewhere, "hubspot", "8880005"));
    await expect(db.query("update public.crm_deals set deal_id = $2 where id = $1", [otherRow, dealId])).rejects.toThrow(/crm_deals_deal_fkey/);
  });

  it("goes with its connection and its workspace", async () => {
    const orgId = await createOrg(db, "crm-deals-cascade");
    await crmDeal(orgId, await connection(orgId, "hubspot", "8880006"));
    await db.query("delete from public.orgs where id = $1", [orgId]);
    expect((await db.query("select 1 from public.crm_deals where org_id = $1", [orgId])).rows).toHaveLength(0);
  });
});
