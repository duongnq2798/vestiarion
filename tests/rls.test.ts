import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bodyHashOf } from "@/lib/ledger";
import { ledgerKeyId } from "@/lib/ledger-keys";
import {
  FOUNDING_ORG_ID as A, TENANT_TABLES, applyMigrations, asRole, asTenant, createDatabase, createOrg, seedOrgRows,
  type SeededRows,
} from "./support/pglite";

/**
 * Row-level security as PostgREST applies it: the role `vestiarion_tenant`,
 * with the request's claims in `request.jwt.claims`. Organization A is the
 * founding organization; B is a second one. Every table holds one row of each.
 */

let db: PGlite;
let B: string;
let rowsB: SeededRows;

const count = async (tx: { query: PGlite["query"] }, table: string) =>
  (await tx.query<{ n: number }>(`select count(*)::int as n from public.${table}`)).rows[0].n;

/**
 * For each of the ten CRUD tenant tables (everything but the two append-only
 * ones), a real, non-trivial column update to try against another
 * organization's rows — `org_id = org_id` is a no-op RLS cannot meaningfully
 * block, so this picks a column that would visibly change.
 */
const CRUD_UPDATE: Record<string, { column: string; expr: string }> = {
  accounts: { column: "name", expr: "name || '-changed'" },
  counterparties: { column: "name", expr: "name || '-changed'" },
  invoices: { column: "memo", expr: "coalesce(memo, '') || '-changed'" },
  milestones: { column: "title", expr: "title || '-changed'" },
  treasury_actions: { column: "reasoning", expr: "coalesce(reasoning, '') || '-changed'" },
  compliance_checks: { column: "notes", expr: "coalesce(notes, '') || '-changed'" },
  forecasts: { column: "recommendation", expr: "coalesce(recommendation, '') || '-changed'" },
  payment_intents: { column: "last_error", expr: "coalesce(last_error, '') || '-changed'" },
  cycle_runs: { column: "sim_day", expr: "coalesce(sim_day, 0) + 1" },
  sim_clock: { column: "current_day", expr: "current_day + 1" },
  gateway_signers: { column: "delegate_tx_id", expr: "coalesce(delegate_tx_id, '') || '-changed'" },
};

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  B = await createOrg(db, "northstar");
  await seedOrgRows(db, A, "a");
  rowsB = await seedOrgRows(db, B, "b");
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("request_org_id()", () => {
  it("is the claim's org_id, and null without one", async () => {
    expect(await asTenant(db, A, async (tx) => (await tx.query<{ v: string }>("select public.request_org_id() as v")).rows[0].v)).toBe(A);
    expect(await asTenant(db, null, async (tx) => (await tx.query<{ v: string | null }>("select public.request_org_id() as v")).rows[0].v)).toBeNull();
  });

  it("fails rather than silently matching when the claim's org_id is malformed", async () => {
    await expect(asTenant(db, "nope", (tx) => tx.query("select public.request_org_id()"))).rejects.toThrow(/invalid input syntax for type uuid/);
  });

  it("is not executable by the browser roles", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select public.request_org_id()"))).rejects.toThrow(/permission denied/);
    }
  });
});

describe("extensions schema", () => {
  it("grants the tenant role USAGE, so digest() (used by append_ledger_entry) resolves in production", async () => {
    const result = await db.query<{ ok: boolean }>(
      "select has_schema_privilege('vestiarion_tenant', 'extensions', 'USAGE') as ok"
    );
    expect(result.rows[0].ok).toBe(true);
  });
});

describe("0018's self-checks", () => {
  // A GRANT run by a role without the grant option only raises a WARNING,
  // not an error, when it doesn't take — PGlite always applies migrations as
  // a superuser, so the GRANT itself can never actually fail to take here,
  // and there's no clean way on PGlite to reproduce the privilege-less role
  // that would make it warn instead of grant in production. What can be
  // proven on PGlite is that the guard clauses 0018 adds — copied verbatim
  // below — correctly raise when the privilege they check for is absent,
  // which is the only thing standing between a silent WARNING and a failed
  // migration.
  // Each builds a fresh database and replays every migration, which can take longer than the default timeout when the whole suite runs in parallel.
  it("the extensions-USAGE guard raises when the grant did not take", async () => {
    const fresh = await createDatabase();
    await applyMigrations(fresh);
    await fresh.exec("revoke usage on schema extensions from vestiarion_tenant");
    await expect(fresh.exec(`
      do $$
      begin
        if not has_schema_privilege('vestiarion_tenant', 'extensions', 'USAGE') then
          raise exception 'vestiarion_tenant has no USAGE on schema extensions, so digest() would not resolve for tenant requests';
        end if;
      end $$;
    `)).rejects.toThrow(/vestiarion_tenant has no USAGE on schema extensions/);
    await fresh.close();
  }, 60_000);

  it("the authenticator-membership guard raises when the grant did not take", async () => {
    const fresh = await createDatabase();
    await applyMigrations(fresh);
    await fresh.exec("revoke vestiarion_tenant from authenticator");
    await expect(fresh.exec(`
      do $$
      begin
        if not pg_has_role('authenticator', 'vestiarion_tenant', 'MEMBER') then
          raise exception 'authenticator could not be granted vestiarion_tenant membership, so PostgREST could not switch to the role';
        end if;
      end $$;
    `)).rejects.toThrow(/authenticator could not be granted vestiarion_tenant membership/);
    await fresh.close();
  }, 60_000);
});

describe.each(TENANT_TABLES)("%s", (table) => {
  it("shows a tenant its own rows and none of another organization's", async () => {
    expect(await asTenant(db, A, (tx) => count(tx, table))).toBeGreaterThan(0);
    const seen = await asTenant(db, A, async (tx) =>
      (await tx.query<{ org_id: string }>(`select distinct org_id from public.${table}`)).rows.map((row) => row.org_id));
    expect(seen).toEqual([A]);
  });

  it("shows a request whose token names no organization nothing", async () => {
    expect(await asTenant(db, null, (tx) => count(tx, table))).toBe(0);
  });

  it("gives the browser roles no access at all", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => count(tx, table))).rejects.toThrow(/permission denied/);
    }
  });

  it("cannot change or remove another organization's rows", async () => {
    if (table === "ledger_entries" || table === "cycle_snapshots") {
      // Append-only tables: the tenant role holds no UPDATE/DELETE privilege
      // at all, cross-org or not, so each statement is refused on its own —
      // the first failure would abort the transaction before the second ran.
      await expect(asTenant(db, A, (tx) => tx.query(`update public.${table} set org_id = org_id where org_id = $1`, [B]))).rejects.toThrow(/permission denied/);
      await expect(asTenant(db, A, (tx) => tx.query(`delete from public.${table} where org_id = $1`, [B]))).rejects.toThrow(/permission denied/);
      return;
    }
    const { column, expr } = CRUD_UPDATE[table];
    const updated = await asTenant(db, A, (tx) => tx.query(`update public.${table} set ${column} = ${expr} where org_id = $1`, [B]));
    expect(updated.affectedRows ?? 0).toBe(0);
    const deleted = await asTenant(db, A, (tx) => tx.query(`delete from public.${table} where org_id = $1`, [B]));
    expect(deleted.affectedRows ?? 0).toBe(0);
  });
});

describe("history is append-only for the tenant role", () => {
  it.each(["ledger_entries", "cycle_snapshots"])("%s refuses UPDATE and DELETE even on the tenant's own rows", async (table) => {
    await expect(asTenant(db, A, (tx) => tx.query(`update public.${table} set org_id = org_id`))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, A, (tx) => tx.query(`delete from public.${table}`))).rejects.toThrow(/permission denied/);
  });
});

describe("writes name the tenant's own organization", () => {
  it("refuses a row for another organization", async () => {
    await expect(asTenant(db, A, (tx) =>
      tx.query("insert into counterparties (org_id, name, role) values ($1, 'x', 'vendor')", [B]))).rejects.toThrow(/row-level security/);
  });

  it("refuses moving a row to another organization", async () => {
    await expect(asTenant(db, A, (tx) =>
      tx.query("update counterparties set org_id = $1 where org_id = $2", [B, A]))).rejects.toThrow(/row-level security/);
  });

  it("accepts a row for its own organization, for every CRUD table plus a cycle_snapshots insert", async () => {
    // A dedicated organization, so this test's own inserts can't collide with
    // what beforeAll already seeded for A (sim_clock in particular holds one
    // row per organization).
    const C = await createOrg(db, "acceptco");

    // Column shapes copied from seedOrgRows: each insert both proves RLS
    // accepts an own-organization row for that table, and — for the tables
    // whose FK another entry below needs — supplies a same-organization row
    // for the composite foreign key to hold.
    const ids: Record<string, string> = {};
    const insertReturningId = async (table: string, sql: string, params: unknown[]) => {
      const row = (await asTenant(db, C, (tx) => tx.query<{ id: string }>(sql, params))).rows[0];
      expect(row?.id).toBeTruthy();
      ids[table] = row.id;
    };
    const insertRow = async (table: string, sql: string, params: unknown[]) => {
      await asTenant(db, C, (tx) => tx.query(sql, params));
    };

    await insertReturningId("counterparties",
      "insert into counterparties (org_id, name, role) values ($1, 'own-cp', 'vendor') returning id", [C]);
    await insertReturningId("accounts",
      "insert into accounts (org_id, name, kind, chain) values ($1, 'own-acct', 'operating', 'ARC-TESTNET') returning id", [C]);
    await insertReturningId("invoices",
      "insert into invoices (org_id, direction, counterparty_id, amount, due_date) values ($1, 'payable', $2, 1, now()) returning id",
      [C, ids.counterparties]);
    await insertRow("milestones",
      "insert into milestones (org_id, contractor_id, title, amount) values ($1, $2, 'own-ms', 1)", [C, ids.counterparties]);
    await insertRow("treasury_actions",
      "insert into treasury_actions (org_id, action, amount, from_account) values ($1, 'rebalance', 1, $2)", [C, ids.accounts]);
    await insertRow("compliance_checks",
      "insert into compliance_checks (org_id, counterparty_id, risk_level, source) values ($1, $2, 'clear', 'test')", [C, ids.counterparties]);
    await insertRow("forecasts",
      "insert into forecasts (org_id, as_of, horizon_days, projected_inflow, projected_outflow, liquid_balance) values ($1, now(), 7, 0, 0, 0)", [C]);
    await insertRow("payment_intents",
      `insert into payment_intents (org_id, source_type, source_id, idempotency_key, provider, amount, destination)
       values ($1, 'invoice', $2, 'k-own-insert', 'simulate', 1, 'sim:x')`, [C, ids.invoices]);
    await insertReturningId("cycle_runs",
      "insert into cycle_runs (org_id, started_at, clock_mode, chain_mode, screening_mode) values ($1, now(), 'real', 'simulate', 'simulate') returning id",
      [C]);
    await insertRow("sim_clock", "insert into sim_clock (org_id, current_day) values ($1, 0)", [C]);
    await insertReturningId("cycle_snapshots",
      `insert into cycle_snapshots (org_id, cycle_run_id, captured_at, account_balances, total_liquid, open_payables,
         open_receivables, obligations_due_7d, obligations_due_14d, reserve_position, chain_mode)
       values ($1, $2, now(), '{}'::jsonb, 0, 0, 0, 0, 0, 0, 'simulate') returning id`,
      [C, ids.cycle_runs]);
  });
});

describe("the tenant RPCs under the tenant role", () => {
  function signed(summary: string) {
    const key = crypto.generateKeyPairSync("ed25519");
    const input = { actor: "system" as const, domain: "system" as const, action: "note", summary, detail: { summary } };
    const bodyHash = bodyHashOf(input);
    const signature = crypto.sign(null, Buffer.from(bodyHash, "hex"), key.privateKey).toString("hex");
    return [input.actor, input.domain, input.action, input.summary, JSON.stringify(input.detail), bodyHash, signature, ledgerKeyId(key.privateKey)];
  }
  const append = "select * from append_ledger_entry($1::uuid, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)";

  it("appends to the tenant's own chain", async () => {
    const row = await asTenant(db, A, async (tx) => (await tx.query<{ org_id: string }>(append, [A, ...signed("own")])).rows[0]);
    expect(row.org_id).toBe(A);
  });

  it("refuses appending to another organization's chain", async () => {
    await expect(asTenant(db, A, (tx) => tx.query(append, [B, ...signed("theirs")]))).rejects.toThrow(/row-level security/);
  });

  it("refuses advancing another organization's clock", async () => {
    await expect(asTenant(db, A, (tx) => tx.query("select advance_sim_day($1::uuid)", [B]))).rejects.toThrow(/row-level security/);
  });

  it("cannot claim another organization's payment", async () => {
    const claimed = await asTenant(db, A, async (tx) =>
      (await tx.query<{ id: string | null }>("select * from claim_payment_intent($1::uuid, $2)", [B, rowsB.idempotencyKey])).rows[0]);
    expect(claimed?.id ?? null).toBeNull();
  });

  it("reads no ledger entry of another organization by target", async () => {
    const rows = await asTenant(db, A, async (tx) =>
      (await tx.query("select * from ledger_entries_for_targets($1::uuid, array[$2::text])", [B, rowsB.invoiceId])).rows);
    expect(rows).toEqual([]);
  });

  it("stays closed to the browser roles", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select advance_sim_day($1::uuid)", [A]))).rejects.toThrow(/permission denied/);
    }
  });
});

describe("platform tables", () => {
  it.each(["orgs", "memberships", "invitations", "api_keys", "webhook_endpoints", "webhook_deliveries"])("%s is closed to the tenant role", async (table) => {
    await expect(asTenant(db, A, (tx) => count(tx, table))).rejects.toThrow(/permission denied/);
  });
});

describe("0018 is idempotent", () => {
  it("replays twice without error", async () => {
    await applyMigrations(db);
    await applyMigrations(db);
  });
});

describe("0001's replay never reopens public reads", () => {
  // scripts/migrate.ts replays 0001 on every run, including a run that stops
  // early or a `--through` run that never reaches 0003. 0001's policy loop
  // must therefore only ever drop `<table>_public_read`, never recreate it.
  it("leaves no _public_read policy behind, and tenant visibility unchanged", async () => {
    await applyMigrations(db, (file) => file === "0001_init.sql");

    const stray = await db.query<{ policyname: string }>(
      "select policyname from pg_policies where schemaname = 'public' and policyname like '%_public_read'"
    );
    expect(stray.rows).toEqual([]);

    for (const table of TENANT_TABLES) {
      const seen = await asTenant(db, A, async (tx) =>
        (await tx.query<{ org_id: string }>(`select distinct org_id from public.${table}`)).rows.map((row) => row.org_id));
      expect(seen).toEqual([A]);
    }
  });

  // Even if some future migration adds a stray permissive policy for the
  // tenant role (by mistake, or by forgetting `to vestiarion_tenant`), the
  // restrictive tenant_isolation_guard from 0018 must still hold the line:
  // a restrictive policy is AND-combined with every permissive one.
  it("a stray permissive policy cannot widen what a tenant sees", async () => {
    await db.query("create policy stray_open on public.forecasts for select using (true)");
    try {
      const seen = await asTenant(db, A, async (tx) =>
        (await tx.query<{ org_id: string }>("select distinct org_id from public.forecasts")).rows.map((row) => row.org_id));
      expect(seen).toEqual([A]);
    } finally {
      await db.query("drop policy if exists stray_open on public.forecasts");
    }
  });
});
