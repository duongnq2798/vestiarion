import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyChain, type LedgerEntryInput, type LedgerRow } from "@/lib/ledger";
import { FOUNDING_ORG_ID, appendSigned, applyMigrations, createDatabase } from "./support/pglite";

/**
 * Migration 0015 against a database shaped like production just before it:
 * every earlier migration applied, then representative rows — including a
 * signed ledger chain and an append-only cycle snapshot — then 0015.
 *
 * What must hold afterwards: every row belongs to the founding organization,
 * the chain is byte-for-byte what it was, the snapshot trigger never fired,
 * and running 0015 again (as `npm run db:migrate` does every time) changes
 * nothing.
 */

const TENANCY = "0015_tenancy.sql";
const TENANT_TABLES = [
  "accounts", "counterparties", "invoices", "milestones", "treasury_actions", "compliance_checks",
  "forecasts", "ledger_entries", "payment_intents", "cycle_runs", "cycle_snapshots",
] as const;
const CHAIN_FIELDS = ["seq", "body_hash", "signature", "prev_hash", "hash", "signing_key_id"] as const;

const key = crypto.generateKeyPairSync("ed25519");
const ENTRIES: LedgerEntryInput[] = [
  { actor: "agent", domain: "compliance", action: "compliance_sweep", summary: "Re-screened 7 of 7", detail: { changed: 0 } },
  { actor: "agent", domain: "treasury", action: "hold", summary: "Treasury: hold 0 USDC", detail: { amount: 0 } },
  { actor: "system", domain: "system", action: "cycle_complete", summary: "Agent cycle complete", detail: {} },
];

let db: PGlite;
let chainBefore: LedgerRow[];
let countsBefore: Record<string, number>;

async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of TENANT_TABLES) {
    out[table] = (await db.query<{ n: number }>(`select count(*)::int as n from public.${table}`)).rows[0].n;
  }
  return out;
}

async function chain(): Promise<LedgerRow[]> {
  return (await db.query<LedgerRow>("select * from ledger_entries order by seq")).rows;
}

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db, (file) => file < TENANCY);

  const counterparty = await db.query<{ id: string }>(
    "insert into counterparties (name, role) values ('Meridian Works', 'vendor') returning id"
  );
  await db.query(
    "insert into invoices (direction, counterparty_id, amount, due_date) values ('payable', $1, 12.5, now() + interval '7 days')",
    [counterparty.rows[0].id]
  );
  const run = await db.query<{ id: string }>(
    `insert into cycle_runs (started_at, finished_at, duration_ms, clock_mode, decision_count, chain_mode, screening_mode, status)
     values (now(), now(), 10, 'real', 1, 'live', 'simulate', 'completed') returning id`
  );
  await db.query(
    `insert into cycle_snapshots (cycle_run_id, captured_at, account_balances, total_liquid, open_payables,
       open_receivables, obligations_due_7d, obligations_due_14d, reserve_position, chain_mode)
     values ($1, now(), '{}'::jsonb, 1, 0, 0, 0, 0, 0, 'live')`,
    [run.rows[0].id]
  );
  for (const entry of ENTRIES) await appendSigned(db, entry, key.privateKey);

  chainBefore = await chain();
  countsBefore = await counts();

  await applyMigrations(db, (file) => file === TENANCY);
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("migration 0015", () => {
  it("creates the founding organization, live", async () => {
    const orgs = await db.query<{ id: string; slug: string; name: string; mode: string }>("select id, slug, name, mode from orgs");
    expect(orgs.rows).toEqual([{ id: FOUNDING_ORG_ID, slug: "founding", name: "Vestiarion workspace", mode: "live" }]);
  });

  it("gives every existing row to the founding organization", async () => {
    for (const table of TENANT_TABLES) {
      const stray = await db.query<{ n: number }>(
        `select count(*)::int as n from public.${table} where org_id is distinct from $1`,
        [FOUNDING_ORG_ID]
      );
      expect(stray.rows[0].n, table).toBe(0);
    }
    expect(await counts()).toEqual(countsBefore);
  });

  it("leaves the founding chain byte for byte as it was, and still verifying", async () => {
    const after = await chain();
    const pick = (rows: LedgerRow[]) =>
      rows.map((row) => Object.fromEntries(CHAIN_FIELDS.map((field) => [field, row[field]])));

    expect(pick(after)).toEqual(pick(chainBefore));
    expect(verifyChain(after, { active: key.publicKey, retired: [] })).toEqual({ valid: true, checkedEntries: 3 });
  });

  it("never fired the snapshot trigger, which still rejects updates", async () => {
    // Backfilling with UPDATE would have been refused by this trigger; the
    // column default fills existing rows without one.
    await expect(db.query("update cycle_snapshots set total_liquid = 2")).rejects.toThrow(/append-only/);
  });

  it("is safe to run again, as npm run db:migrate does on every invocation", async () => {
    await applyMigrations(db, (file) => file === TENANCY);

    expect((await db.query<{ n: number }>("select count(*)::int as n from orgs")).rows[0].n).toBe(1);
    expect(await counts()).toEqual(countsBefore);
  });

  it("files a legacy insert under the founding organization until Plan 2 removes the default", async () => {
    const row = await db.query<{ org_id: string }>(
      "insert into counterparties (name, role) values ('Legacy insert', 'client') returning org_id"
    );
    expect(row.rows[0].org_id).toBe(FOUNDING_ORG_ID);
    await db.query("delete from counterparties where name = 'Legacy insert'");
  });

  it("records who created invoices and milestones", async () => {
    const columns = await db.query<{ table_name: string }>(
      `select table_name from information_schema.columns
        where table_schema = 'public' and column_name = 'created_by' order by table_name`
    );
    expect(columns.rows.map((row) => row.table_name)).toEqual(["invoices", "milestones", "orgs"]);
  });

  it("keeps the new tables away from the public API roles", async () => {
    for (const table of ["orgs", "memberships", "invitations"]) {
      const privileges = await db.query<{ anon: boolean; authed: boolean; service: boolean }>(
        `select has_table_privilege('anon', 'public.${table}', 'select') as anon,
                has_table_privilege('authenticated', 'public.${table}', 'select') as authed,
                has_table_privilege('service_role', 'public.${table}', 'select') as service`
      );
      expect(privileges.rows[0], table).toEqual({ anon: false, authed: false, service: true });
    }
  });

  it("refuses a slug that is not lowercase letters, digits and inner hyphens", async () => {
    await expect(db.query("insert into orgs (slug, name) values ('Founding-2', 'x')")).rejects.toThrow();
    await expect(db.query("insert into orgs (slug, name) values ('-ab', 'x')")).rejects.toThrow();
  });

  it("allows at most one membership per person per organization", async () => {
    const user = "22222222-2222-4222-8222-222222222222";
    await db.query("insert into auth.users (id, email) values ($1, 'a@example.com')", [user]);
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')", [FOUNDING_ORG_ID, user]);
    await expect(
      db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer')", [FOUNDING_ORG_ID, user])
    ).rejects.toThrow();
    await expect(
      db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'superuser')", [FOUNDING_ORG_ID, crypto.randomUUID()])
    ).rejects.toThrow();
  });
});
