import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FOUNDING_ORG_ID as A, applyMigrations, createDatabase, createOrg, seedOrgRows, type SeededRows } from "./support/pglite";

/**
 * Foreign-key checks bypass row-level security, so a row of organization A
 * could otherwise point at organization B's counterparty or account. Composite
 * keys make the database refuse that link.
 */

let db: PGlite;
let B: string;
let rowsA: SeededRows;
let rowsB: SeededRows;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  B = await createOrg(db, "northstar");
  rowsA = await seedOrgRows(db, A, "a");
  rowsB = await seedOrgRows(db, B, "b");
}, 60_000);

afterAll(async () => {
  await db.close();
});

const CROSS: Array<[string, (b: SeededRows) => [string, unknown[]]]> = [
  ["invoices → another organization's counterparty", (b) => [
    "insert into invoices (org_id, direction, counterparty_id, amount, due_date) values ($1, 'payable', $2, 1, now())", [A, b.counterpartyId]]],
  ["milestones → another organization's contractor", (b) => [
    "insert into milestones (org_id, contractor_id, title, amount) values ($1, $2, 'x', 1)", [A, b.counterpartyId]]],
  ["compliance_checks → another organization's counterparty", (b) => [
    "insert into compliance_checks (org_id, counterparty_id, risk_level, source) values ($1, $2, 'clear', 'x')", [A, b.counterpartyId]]],
  ["treasury_actions.from_account → another organization's account", (b) => [
    "insert into treasury_actions (org_id, action, amount, from_account) values ($1, 'rebalance', 1, $2)", [A, b.accountId]]],
  ["treasury_actions.to_account → another organization's account", (b) => [
    "insert into treasury_actions (org_id, action, amount, to_account) values ($1, 'rebalance', 1, $2)", [A, b.accountId]]],
  ["cycle_snapshots → another organization's cycle run", (b) => [
    `insert into cycle_snapshots (org_id, cycle_run_id, captured_at, account_balances, total_liquid, open_payables,
       open_receivables, obligations_due_7d, obligations_due_14d, reserve_position, chain_mode)
     values ($1, $2, now(), '{}'::jsonb, 0, 0, 0, 0, 0, 0, 'simulate')`, [A, b.cycleRunId]]],
];

describe("a link to another organization's row", () => {
  it.each(CROSS)("is refused: %s", async (_label, build) => {
    const [sql, params] = build(rowsB);
    await expect(db.query(sql, params)).rejects.toThrow(/foreign key/);
  });
});

describe("a link within the organization", () => {
  it("is accepted, as every seeded row already shows", async () => {
    const n = (await db.query<{ n: number }>("select count(*)::int as n from invoices where org_id = $1 and counterparty_id = $2", [A, rowsA.counterpartyId])).rows[0].n;
    expect(n).toBe(1);
  });
});

describe("delete rules survive the change", () => {
  it("deleting an account clears the treasury action's reference and keeps the row's organization", async () => {
    const acct = (await db.query<{ id: string }>("insert into accounts (org_id, name, kind, chain) values ($1, 'gone', 'operating', 'ARC-TESTNET') returning id", [A])).rows[0].id;
    const action = (await db.query<{ id: string }>("insert into treasury_actions (org_id, action, amount, from_account) values ($1, 'rebalance', 1, $2) returning id", [A, acct])).rows[0].id;
    await db.query("delete from accounts where id = $1", [acct]);
    const row = (await db.query<{ from_account: string | null; org_id: string }>("select from_account, org_id from treasury_actions where id = $1", [action])).rows[0];
    expect(row).toEqual({ from_account: null, org_id: A });
  });

  it("deleting a counterparty still removes its invoices", async () => {
    const cp = (await db.query<{ id: string }>("insert into counterparties (org_id, name, role) values ($1, 'short-lived', 'vendor') returning id", [A])).rows[0].id;
    await db.query("insert into invoices (org_id, direction, counterparty_id, amount, due_date) values ($1, 'payable', $2, 1, now())", [A, cp]);
    await db.query("delete from counterparties where id = $1", [cp]);
    expect((await db.query<{ n: number }>("select count(*)::int as n from invoices where counterparty_id = $1", [cp])).rows[0].n).toBe(0);
  });
});

describe("PostgREST still sees one relationship per column", () => {
  it.each([
    ["invoices", "counterparties"], ["milestones", "counterparties"], ["compliance_checks", "counterparties"],
    ["cycle_snapshots", "cycle_runs"],
  ])("%s has exactly one foreign key to %s", async (child, parent) => {
    const n = (await db.query<{ n: number }>(
      `select count(*)::int as n from pg_constraint
        where contype = 'f' and conrelid = $1::regclass and confrelid = $2::regclass`, [`public.${child}`, `public.${parent}`])).rows[0].n;
    expect(n).toBe(1);
  });

  it("treasury_actions has exactly two foreign keys to accounts, one per column", async () => {
    const n = (await db.query<{ n: number }>(
      "select count(*)::int as n from pg_constraint where contype = 'f' and conrelid = 'public.treasury_actions'::regclass and confrelid = 'public.accounts'::regclass")).rows[0].n;
    expect(n).toBe(2);
  });
});

describe("0019 is idempotent", () => {
  it("replays twice without error or duplicate keys", async () => {
    await applyMigrations(db);
    await applyMigrations(db);
    const n = (await db.query<{ n: number }>(
      "select count(*)::int as n from pg_constraint where contype = 'f' and conrelid = 'public.invoices'::regclass and confrelid = 'public.counterparties'::regclass")).rows[0].n;
    expect(n).toBe(1);
  });
});
