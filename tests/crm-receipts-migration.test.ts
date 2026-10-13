import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asTenant, createDatabase, createOrg, createUser } from "./support/pglite";

/**
 * Migration 0107 (docs/superpowers/specs/2026-10-13-crm-receipts-design.md R4, R5, R7): the switch that turns writing
 * receipts to HubSpot on, which only a HubSpot connection takes and which a disconnect turns off; and the outbox of
 * writes, each for the CRM deal its Vestiarion deal was planned from, with what it writes fixed once queued, its state
 * moving only along the outbox's transitions, one in hand per deal, and the reality rule held by the database itself.
 */

let db: PGlite;
let person: string;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  // Re-runnable, as scripts/migrate.ts re-runs every file.
  await applyMigrations(db, (file) => file.startsWith("0107_"));
  person = await createUser(db, "owner-receipts@example.com");
}, 60_000);

afterAll(async () => {
  await db.close();
});

const FIELDS = JSON.stringify({ vestiarion_collected: "2000.00", vestiarion_still_owed: "3000.00", vestiarion_currency: "USDC" });

interface World {
  orgId: string;
  connectionId: string;
  crmDealId: string;
  dealId: string;
}

async function world(slug: string, options: { network?: "arc-testnet" | "arc-mainnet" } = {}): Promise<World> {
  const orgId = await createOrg(db, slug);
  if (options.network === "arc-mainnet") await db.query("update public.orgs set network = 'arc-mainnet' where id = $1", [orgId]);
  const connectionId = (
    await db.query<{ id: string }>(
      `insert into public.accounting_connections (org_id, provider, external_org_id, external_org_name, consent_version, consented_at, window_from, scopes)
       values ($1, 'hubspot', $2, 'northstar.example', 'hubspot-2026-10-13', now(), '2026-07-14', '{crm.objects.deals.write,crm.schemas.deals.write}') returning id`,
      [orgId, `hub-${slug}`]
    )
  ).rows[0].id;
  const counterpartyId = (await db.query<{ id: string }>("insert into public.counterparties (org_id, name, role) values ($1, 'Northwind', 'client') returning id", [orgId])).rows[0].id;
  const dealId = (
    await db.query<{ id: string }>(
      `select (public.create_deal($1, jsonb_build_object('counterpartyId', $2::text, 'title', 'Website rebuild', 'currency', 'USDC', 'minorDigits', 2,
         'totalMinor', 500000, 'startsOn', '2026-10-12', 'termsDays', 14, 'template', 'custom', 'idempotencyKey', $3::text, 'externalRef', '9001'),
         '[{"position": 1, "label": "All", "invoiceOn": "2026-10-12", "dueOn": "2026-10-26", "amountMinor": 500000}]'::jsonb) ->> 'id')::uuid as id`,
      [orgId, counterpartyId, `deal-key-${slug}`]
    )
  ).rows[0].id;
  const crmDealId = (
    await db.query<{ id: string }>(
      "insert into public.crm_deals (org_id, connection_id, external_id, name, amount, currency, stage_state, deal_id) values ($1, $2, '9001', 'Website rebuild', 5000, 'USD', 'won', $3) returning id",
      [orgId, connectionId, dealId]
    )
  ).rows[0].id;
  return { orgId, connectionId, crmDealId, dealId };
}

async function queue(w: World, fields: { network?: string; shadow?: boolean; state?: string; externalDealId?: string; dealId?: string } = {}): Promise<string> {
  return (
    await db.query<{ id: string }>(
      `insert into public.crm_receipt_writes (org_id, connection_id, crm_deal_id, deal_id, provider, external_org_id, external_deal_id, fields, network, shadow, state)
       values ($1, $2, $3, $4, 'hubspot', 'hub', $5, $6::jsonb, $7, $8, $9) returning id`,
      [w.orgId, w.connectionId, w.crmDealId, fields.dealId ?? w.dealId, fields.externalDealId ?? "9001", FIELDS, fields.network ?? "arc-testnet", fields.shadow ?? false, fields.state ?? "queued"]
    )
  ).rows[0].id;
}

const claim = (id: string, test: boolean | null = null) =>
  db.query(
    `update public.crm_receipt_writes set state = 'sending', sending_until = now() + interval '2 minutes', attempts = attempts + 1,
       account_type = case when $2::boolean then 'DEVELOPER_TEST' else 'STANDARD' end, account_test = $2 where id = $1`,
    [id, test]
  );

const stateOf = async (id: string) => (await db.query<{ state: string }>("select state from public.crm_receipt_writes where id = $1", [id])).rows[0].state;

describe("accounting_connections.writes_on", () => {
  it("is taken by a HubSpot connection only, and goes off when the connection is disconnected", async () => {
    const w = await world("receipts-switch");
    await db.query("update public.accounting_connections set writes_on = true, writes_by = $2, writes_at = now() where id = $1", [w.connectionId, person]);
    await db.query("update public.accounting_connections set status = 'revoked', revoked_at = now() where id = $1", [w.connectionId]);
    expect((await db.query<{ writes_on: boolean }>("select writes_on from public.accounting_connections where id = $1", [w.connectionId])).rows[0].writes_on).toBe(false);
    await expect(db.query("update public.accounting_connections set writes_on = true where id = $1", [w.connectionId])).resolves.toBeTruthy();
    expect((await db.query<{ writes_on: boolean }>("select writes_on from public.accounting_connections where id = $1", [w.connectionId])).rows[0].writes_on).toBe(false);
    const xero = (
      await db.query<{ id: string }>(
        `insert into public.accounting_connections (org_id, provider, external_org_id, consent_version, consented_at, window_from)
         values ($1, 'xero', 'tenant-1', 'xero-2026-10-12.2', now(), '2026-07-14') returning id`,
        [w.orgId]
      )
    ).rows[0].id;
    await expect(db.query("update public.accounting_connections set writes_on = true where id = $1", [xero])).rejects.toThrow(/accounting_connections_writes_check/);
  });
});

describe("crm_receipt_writes", () => {
  it("is queued, never inserted further along", async () => {
    const w = await world("receipts-insert");
    await expect(queue(w, { state: "written" })).rejects.toThrow(/crm_receipt_write_insert/);
    expect(await queue(w)).toBeTruthy();
  });

  it("writes only to the CRM deal its deal was planned from", async () => {
    const w = await world("receipts-deal");
    await expect(queue(w, { externalDealId: "9002" })).rejects.toThrow(/crm_receipt_write_deal/);
    const other = await world("receipts-deal-other");
    await expect(queue({ ...w, dealId: other.dealId })).rejects.toThrow(/crm_receipt_writes_deal_fkey|crm_receipt_write_deal/);
  });

  it("keeps one write in hand per deal: a newer one supersedes it first", async () => {
    const w = await world("receipts-one-open");
    const first = await queue(w);
    await expect(queue(w)).rejects.toThrow(/crm_receipt_writes_one_open/);
    await db.query("update public.crm_receipt_writes set state = 'superseded' where id = $1", [first]);
    expect(await queue(w)).toBeTruthy();
  });

  it("keeps what a write writes fixed once queued", async () => {
    const w = await world("receipts-fixed");
    const id = await queue(w);
    for (const change of [`fields = '{"vestiarion_collected": "1"}'::jsonb`, "network = 'arc-mainnet'", "shadow = true", "external_deal_id = '9002'"]) {
      await expect(db.query(`update public.crm_receipt_writes set ${change} where id = $1`, [id]), change).rejects.toThrow(/crm_receipt_write_fixed/);
    }
  });

  it("holds the reality rule: payments on Arc testnet reach only a test account", async () => {
    const w = await world("receipts-reality");
    const id = await queue(w);
    await expect(claim(id, false)).rejects.toThrow(/crm_receipt_writes_reality_check/);
    await claim(id, true);
    expect(await stateOf(id)).toBe("sending");
  });

  it("lets payments on Arc mainnet outside shadow mode go to any account, and refuses shadow mode's", async () => {
    const w = await world("receipts-mainnet", { network: "arc-mainnet" });
    const id = await queue(w, { network: "arc-mainnet" });
    await claim(id, false);
    await db.query("update public.crm_receipt_writes set state = 'sent', sent_at = now() where id = $1", [id]);
    await db.query(`update public.crm_receipt_writes set state = 'written', written_at = now(), read_back = '{"vestiarion_collected": "2000"}'::jsonb where id = $1`, [id]);
    expect(await stateOf(id)).toBe("written");
    const shadow = await world("receipts-mainnet-shadow", { network: "arc-mainnet" });
    await db.query("insert into public.shadow_modes (org_id, currency) values ($1, 'USDC')", [shadow.orgId]);
    const shadowId = await queue(shadow, { network: "arc-mainnet" });
    expect((await db.query<{ shadow: boolean }>("select shadow from public.crm_receipt_writes where id = $1", [shadowId])).rows[0].shadow).toBe(true);
    await expect(claim(shadowId, false)).rejects.toThrow(/crm_receipt_writes_reality_check/);
  });

  it("takes the network from the workspace, never from what the row says", async () => {
    const w = await world("receipts-network");
    const id = await queue(w, { network: "arc-mainnet" });
    expect((await db.query<{ network: string }>("select network from public.crm_receipt_writes where id = $1", [id])).rows[0].network).toBe("arc-testnet");
    await expect(claim(id, false)).rejects.toThrow(/crm_receipt_writes_reality_check/);
    // As the app queues it, in its workspace's own scope: a workspace on Arc mainnet keeps it.
    const onMainnet = await world("receipts-network-mainnet", { network: "arc-mainnet" });
    const queued = await asTenant(db, onMainnet.orgId, (tx) =>
      tx.query<{ network: string; shadow: boolean }>(
        `insert into public.crm_receipt_writes (org_id, connection_id, crm_deal_id, deal_id, provider, external_org_id, external_deal_id, fields, network, shadow)
         values ($1, $2, $3, $4, 'hubspot', 'hub', '9001', $5::jsonb, 'arc-mainnet', false) returning network, shadow`,
        [onMainnet.orgId, onMainnet.connectionId, onMainnet.crmDealId, onMainnet.dealId, FIELDS]
      )
    );
    expect(queued.rows[0]).toEqual({ network: "arc-mainnet", shadow: false });
  });

  it("moves only along the outbox's transitions, and never out of written, refused or superseded", async () => {
    const w = await world("receipts-transitions");
    const id = await queue(w);
    await expect(db.query("update public.crm_receipt_writes set state = 'written', written_at = now(), read_back = '{}'::jsonb where id = $1", [id])).rejects.toThrow(
      /crm_receipt_write_transition/
    );
    await claim(id, true);
    // A run that cannot send now gives it back.
    await db.query("update public.crm_receipt_writes set state = 'queued', sending_until = null where id = $1", [id]);
    await claim(id, true);
    await db.query("update public.crm_receipt_writes set state = 'failed', reason = 'no_answer', message = 'HubSpot did not answer.', next_attempt_at = now(), sending_until = null where id = $1", [id]);
    await claim(id, true);
    await expect(db.query("update public.crm_receipt_writes set state = 'conflict' where id = $1", [id])).rejects.toThrow(/crm_receipt_writes_conflict_check/);
    await db.query(`update public.crm_receipt_writes set state = 'conflict', conflicts = '[{"field": "vestiarion_collected", "ours": "1", "theirs": "2", "next": "3"}]'::jsonb where id = $1`, [id]);
    await expect(db.query("update public.crm_receipt_writes set state = 'sending', sending_until = now() where id = $1", [id])).rejects.toThrow(/crm_receipt_write_transition/);
    // A person chose to write Vestiarion's figures: queued again, with what they saw.
    await db.query(`update public.crm_receipt_writes set state = 'queued', overwrite = '{"vestiarion_collected": "2"}'::jsonb, overwrite_by = $2, overwrite_at = now() where id = $1`, [id, person]);
    await claim(id, true);
    await expect(db.query("update public.crm_receipt_writes set state = 'written' where id = $1", [id])).rejects.toThrow(/crm_receipt_writes_written_check/);
    await db.query(`update public.crm_receipt_writes set state = 'written', written_at = now(), read_back = $2::jsonb where id = $1`, [id, FIELDS]);
    await expect(db.query("update public.crm_receipt_writes set message = 'changed' where id = $1", [id])).rejects.toThrow(/crm_receipt_write_final/);
    // The person's account may go from it.
    await db.query("update public.crm_receipt_writes set overwrite_by = null where id = $1", [id]);
    const refused = await queue(w);
    await db.query("update public.crm_receipt_writes set state = 'refused', reason = 'reality', message = 'Not written.' where id = $1", [refused]);
    await expect(db.query("update public.crm_receipt_writes set state = 'queued' where id = $1", [refused])).rejects.toThrow(/crm_receipt_write_final/);
  });

  it("is read and written by its own workspace only, never deleted by the tenant role, and closed to the browser roles", async () => {
    const a = await world("receipts-tenant-a");
    const b = await world("receipts-tenant-b");
    await queue(a);
    const theirs = await queue(b);
    const seen = await asTenant(db, a.orgId, async (tx) => (await tx.query<{ org_id: string }>("select org_id from public.crm_receipt_writes")).rows);
    expect(seen.map((row) => row.org_id)).toEqual([a.orgId]);
    const updated = await asTenant(db, a.orgId, (tx) => tx.query("update public.crm_receipt_writes set message = 'x' where id = $1", [theirs]));
    expect(updated.affectedRows ?? 0).toBe(0);
    await expect(asTenant(db, a.orgId, (tx) => tx.query("delete from public.crm_receipt_writes where org_id = $1", [a.orgId]))).rejects.toThrow(/permission denied/);
    await expect(asRole(db, "authenticated", (tx) => tx.query("select 1 from public.crm_receipt_writes"))).rejects.toThrow(/permission denied/);
  });

  it("goes with its connection and with its CRM deal", async () => {
    const byConnection = await world("receipts-cascade-connection");
    await queue(byConnection);
    await db.query("delete from public.accounting_connections where id = $1", [byConnection.connectionId]);
    expect((await db.query("select 1 from public.crm_receipt_writes where org_id = $1", [byConnection.orgId])).rows).toHaveLength(0);
    const byDeal = await world("receipts-cascade-deal");
    await queue(byDeal);
    await db.query("delete from public.crm_deals where id = $1", [byDeal.crmDealId]);
    expect((await db.query("select 1 from public.crm_receipt_writes where org_id = $1", [byDeal.orgId])).rows).toHaveLength(0);
  });
});
