import { readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asTenant, createDatabase, createOrg, createUser, MIGRATIONS_DIR } from "./support/pglite";

/**
 * Migration 0116 (docs/superpowers/specs/2026-10-14-pipedrive-connector-design.md P2, P12): the core's tables take
 * Pipedrive beside every provider they took and Asana's (0115); a re-run never narrows a later widening; one workspace
 * per Pipedrive company; the receipts switch and outbox take it; and the reality rule is held by the database: a Pipedrive
 * write is never a test account's, so payments on Arc testnet or in shadow mode never reach sending. Tenancy as 0105.
 */

let db: PGlite;
let person: string;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  // Re-runnable, as scripts/migrate.ts re-runs every file.
  await applyMigrations(db, (file) => file.startsWith("0105_") || file.startsWith("0107_") || file.startsWith("0116_"));
  person = await createUser(db, "owner-pipedrive@example.com");
}, 60_000);

afterAll(async () => {
  await db.close();
});

async function connection(orgId: string, provider = "pipedrive", externalOrgId = "13013937", status = "connected"): Promise<string> {
  return (
    await db.query<{ id: string }>(
      `insert into public.accounting_connections (org_id, provider, external_org_id, external_org_name, status, connected_by, consent_version, consented_at, window_from, revoked_at, scopes)
       values ($1, $2, $3, 'Cedar & Co', $4, $5, 'pipedrive-2026-10-14', now(), '2026-07-16', case when $4 = 'revoked' then now() end, '{base,deals:full,deal-fields:full}') returning id`,
      [orgId, provider, externalOrgId, status, person]
    )
  ).rows[0].id;
}

const definition = async (name: string) =>
  (await db.query<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conname = $1", [name])).rows[0]?.def ?? "";

describe("the core's tables take Pipedrive", () => {
  it("accepts pipedrive and asana beside every provider taken before, and refuses an unknown one", async () => {
    const orgId = await createOrg(db, "pipedrive-checks");
    expect(await connection(orgId)).toBeTruthy();
    for (const name of ["accounting_connections_provider_check", "accounting_tokens_provider_check", "external_links_provider_check"]) {
      const def = await definition(name);
      for (const provider of ["xero", "quickbooks", "hubspot", "asana", "pipedrive"]) expect(def, name).toContain(`'${provider}'`);
    }
    expect(await definition("crm_receipt_writes_provider_check")).toMatch(/'hubspot'.*'pipedrive'/);
    expect(await definition("accounting_connections_writes_check")).toContain("'pipedrive'");
    const other = await createOrg(db, "pipedrive-checks-unknown");
    await expect(connection(other, "salesforce", "x")).rejects.toThrow(/accounting_connections_provider_check/);
  });

  it("never narrows a later widening when it runs again", async () => {
    await db.query("alter table public.accounting_connections drop constraint accounting_connections_provider_check");
    await db.query("alter table public.accounting_connections add constraint accounting_connections_provider_check check (provider in ('xero', 'quickbooks', 'hubspot', 'asana', 'pipedrive', 'zoho'))");
    await db.exec(readFileSync(path.join(MIGRATIONS_DIR, "0116_pipedrive_connector.sql"), "utf8"));
    expect(await definition("accounting_connections_provider_check")).toContain("'zoho'");
  });

  it("connects a Pipedrive company, not revoked, to one workspace at a time", async () => {
    const a = await createOrg(db, "pipedrive-one-a");
    const b = await createOrg(db, "pipedrive-one-b");
    const first = await connection(a, "pipedrive", "777001");
    await expect(connection(b, "pipedrive", "777001")).rejects.toThrow(/accounting_connections_pipedrive_one_workspace/);
    await db.query("update public.accounting_connections set status = 'revoked', revoked_at = now() where id = $1", [first]);
    expect(await connection(b, "pipedrive", "777001")).toBeTruthy();
  });

  it("answers whether it has run, to the tenant role, and to no one signed out", async () => {
    const orgId = await createOrg(db, "pipedrive-ready");
    expect(await asTenant(db, orgId, async (tx) => (await tx.query<{ ready: boolean }>("select public.pipedrive_connector_ready() as ready")).rows[0].ready)).toBe(true);
    await expect(asRole(db, "anon", (tx) => tx.query("select public.pipedrive_connector_ready()"))).rejects.toThrow(/permission denied/);
  });
});

describe("Pipedrive's deals and receipts", () => {
  async function world(slug: string, network: "arc-testnet" | "arc-mainnet") {
    const orgId = await createOrg(db, slug);
    if (network === "arc-mainnet") await db.query("update public.orgs set network = 'arc-mainnet' where id = $1", [orgId]);
    const connectionId = await connection(orgId, "pipedrive", `co-${slug}`);
    const counterpartyId = (await db.query<{ id: string }>("insert into public.counterparties (org_id, name, role) values ($1, 'Cedar & Co', 'client') returning id", [orgId])).rows[0].id;
    const dealId = (
      await db.query<{ id: string }>(
        `select (public.create_deal($1, jsonb_build_object('counterpartyId', $2::text, 'title', 'Spring campaign', 'currency', 'USDC', 'minorDigits', 2,
           'totalMinor', 20000, 'startsOn', '2026-10-14', 'termsDays', 14, 'template', 'custom', 'idempotencyKey', $3::text, 'externalRef', 'pipedrive-42'),
           '[{"position": 1, "label": "All", "invoiceOn": "2026-10-14", "dueOn": "2026-10-28", "amountMinor": 20000}]'::jsonb) ->> 'id')::uuid as id`,
        [orgId, counterpartyId, `deal-key-${slug}`]
      )
    ).rows[0].id;
    const crmDealId = (
      await db.query<{ id: string }>(
        "insert into public.crm_deals (org_id, connection_id, external_id, name, amount, currency, stage_state, deal_id, company_external_id, company_name) values ($1, $2, '42', 'Spring campaign', 200, 'USD', 'won', $3, '501', 'Cedar & Co') returning id",
        [orgId, connectionId, dealId]
      )
    ).rows[0].id;
    const writeId = (
      await db.query<{ id: string }>(
        `insert into public.crm_receipt_writes (org_id, connection_id, crm_deal_id, deal_id, provider, external_org_id, external_deal_id, fields, network, shadow)
         values ($1, $2, $3, $4, 'pipedrive', $5, '42', '{"vestiarion_collected": "20"}'::jsonb, $6, false) returning id`,
        [orgId, connectionId, crmDealId, dealId, `co-${slug}`, network]
      )
    ).rows[0].id;
    return { orgId, connectionId, crmDealId, dealId, writeId };
  }

  const claim = (id: string, test: boolean) =>
    db.query(
      `update public.crm_receipt_writes set state = 'sending', sending_until = now() + interval '2 minutes', attempts = attempts + 1, account_type = 'COMPANY', account_test = $2 where id = $1`,
      [id, test]
    );

  it("takes the receipts switch on a Pipedrive connection, off again when it is disconnected", async () => {
    const w = await world("pipedrive-switch", "arc-mainnet");
    await db.query("update public.accounting_connections set writes_on = true, writes_by = $2, writes_at = now() where id = $1", [w.connectionId, person]);
    await db.query("update public.accounting_connections set status = 'revoked', revoked_at = now() where id = $1", [w.connectionId]);
    expect((await db.query<{ writes_on: boolean }>("select writes_on from public.accounting_connections where id = $1", [w.connectionId])).rows[0].writes_on).toBe(false);
  });

  it("never lets a Pipedrive write claim a test account, so testnet payments never reach sending", async () => {
    const w = await world("pipedrive-testnet", "arc-testnet");
    await expect(claim(w.writeId, true)).rejects.toThrow(/crm_receipt_writes_account_test_check/);
    await expect(claim(w.writeId, false)).rejects.toThrow(/crm_receipt_writes_reality_check/);
    expect((await db.query<{ state: string }>("select state from public.crm_receipt_writes where id = $1", [w.writeId])).rows[0].state).toBe("queued");
  });

  it("sends a Pipedrive write of Arc mainnet payments outside shadow mode", async () => {
    const w = await world("pipedrive-mainnet", "arc-mainnet");
    await claim(w.writeId, false);
    expect((await db.query<{ state: string }>("select state from public.crm_receipt_writes where id = $1", [w.writeId])).rows[0].state).toBe("sending");
  });

  it("keeps a workspace's Pipedrive deals its own, and the tenant role never deletes one", async () => {
    const a = await world("pipedrive-tenant-a", "arc-testnet");
    const b = await world("pipedrive-tenant-b", "arc-testnet");
    const seen = await asTenant(db, a.orgId, async (tx) => (await tx.query<{ org_id: string }>("select org_id from public.crm_deals")).rows);
    expect(seen.map((row) => row.org_id)).toEqual([a.orgId]);
    const updated = await asTenant(db, a.orgId, (tx) => tx.query("update public.crm_deals set name = 'x' where id = $1", [b.crmDealId]));
    expect(updated.affectedRows ?? 0).toBe(0);
    await expect(asTenant(db, a.orgId, (tx) => tx.query("delete from public.crm_deals where id = $1", [a.crmDealId]))).rejects.toThrow(/permission denied/);
    const writes = await asTenant(db, a.orgId, async (tx) => (await tx.query<{ org_id: string }>("select org_id from public.crm_receipt_writes")).rows);
    expect(writes.map((row) => row.org_id)).toEqual([a.orgId]);
  });
});
