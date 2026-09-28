import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyChain, type LedgerEntryInput, type LedgerRow } from "@/lib/ledger";
import {
  FOUNDING_ORG_ID,
  appendSigned,
  appendSignedForOrg,
  applyMigrations,
  createDatabase,
  createOrg,
} from "./support/pglite";

/**
 * Migration 0016: one ledger chain, one simulated clock, and one set of
 * payment intents per organization — added beside the old functions, which
 * the code deployed before this change still calls.
 */

const THROUGH_0016 = (file: string) => file <= "0016_org_scoped_rpcs.sql";
const GENESIS = "0".repeat(64);
const key = crypto.generateKeyPairSync("ed25519");
const ring = { active: key.publicKey, retired: [] };

function entry(summary: string): LedgerEntryInput {
  return { actor: "agent", domain: "system", action: "note", summary, detail: { summary } };
}

let db: PGlite;
let other: string;

async function chainOf(orgId: string): Promise<LedgerRow[]> {
  return (await db.query<LedgerRow>("select * from ledger_entries where org_id = $1 order by seq", [orgId])).rows;
}

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db, THROUGH_0016);
  other = await createOrg(db, "northstar");
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("append_ledger_entry(p_org_id, …)", () => {
  it("keeps one chain per organization when appends interleave", async () => {
    await appendSignedForOrg(db, FOUNDING_ORG_ID, entry("f1"), key.privateKey);
    const firstOther = await appendSignedForOrg(db, other, entry("o1"), key.privateKey);
    await appendSignedForOrg(db, FOUNDING_ORG_ID, entry("f2"), key.privateKey);
    await appendSignedForOrg(db, other, entry("o2"), key.privateKey);

    expect(firstOther.prev_hash).toBe(GENESIS);
    expect(verifyChain(await chainOf(FOUNDING_ORG_ID), ring)).toEqual({ valid: true, checkedEntries: 2 });
    expect(verifyChain(await chainOf(other), ring)).toEqual({ valid: true, checkedEntries: 2 });
  });

  it("never changes another organization's chain", async () => {
    const before = await chainOf(other);
    await appendSignedForOrg(db, FOUNDING_ORG_ID, entry("f3"), key.privateKey);
    expect(await chainOf(other)).toEqual(before);
  });

  it("records the organization it was given", async () => {
    const row = await appendSignedForOrg(db, other, entry("o3"), key.privateKey);
    expect((row as LedgerRow & { org_id: string }).org_id).toBe(other);
  });

  it("refuses a null organization", async () => {
    await expect(appendSignedForOrg(db, null as unknown as string, entry("x"), key.privateKey)).rejects.toThrow(/p_org_id is required/);
  });

  it("links an old-code append and a new-code append into the same founding chain", async () => {
    // The deploy window: old code still calls the 8-argument function, which
    // links to the newest entry of the whole table. That is correct only while
    // the founding organization is the only one — production's state during
    // the window — so the table's newest entry is made a founding one first.
    await appendSignedForOrg(db, FOUNDING_ORG_ID, entry("new code, before"), key.privateKey);
    await appendSigned(db, entry("old code"), key.privateKey);
    await appendSignedForOrg(db, FOUNDING_ORG_ID, entry("new code"), key.privateKey);
    const chain = await chainOf(FOUNDING_ORG_ID);
    expect(verifyChain(chain, ring)).toEqual({ valid: true, checkedEntries: chain.length });
  });
});

describe("advance_sim_day(p_org_id)", () => {
  it("keeps one clock per organization", async () => {
    const founding = (await db.query<{ d: number }>("select advance_sim_day($1::uuid) as d", [FOUNDING_ORG_ID])).rows[0].d;
    const first = (await db.query<{ d: number }>("select advance_sim_day($1::uuid) as d", [other])).rows[0].d;
    const second = (await db.query<{ d: number }>("select advance_sim_day($1::uuid) as d", [other])).rows[0].d;
    expect(first).toBe(1);
    expect(second).toBe(2);
    const foundingNow = (await db.query<{ current_day: number }>("select current_day from sim_clock where org_id = $1", [FOUNDING_ORG_ID])).rows[0].current_day;
    expect(foundingNow).toBe(founding);
  });

  it("leaves the old signature working for the founding clock, and never touches a new organization's clock", async () => {
    // Ruling R1, revised for R5: R5 gave every new organization's sim_clock
    // row id = null (a unique constraint permits any number of nulls; only
    // the founding row, written by 0001 before this migration ever ran,
    // still has id = 1). The old advance_sim_day()'s `where id = 1` can
    // therefore only ever match the founding row — there is no second row
    // for its return value to be ambiguous with anymore — so this also
    // pins that a new organization's clock is left alone by the old call.
    const before = (await db.query<{ current_day: number }>("select current_day from sim_clock where org_id = $1", [FOUNDING_ORG_ID])).rows[0].current_day;
    const otherBefore = (await db.query<{ current_day: number }>("select current_day from sim_clock where org_id = $1", [other])).rows[0].current_day;

    const returned = (await db.query<{ d: number }>("select advance_sim_day() as d")).rows[0].d;

    const after = (await db.query<{ current_day: number }>("select current_day from sim_clock where org_id = $1", [FOUNDING_ORG_ID])).rows[0].current_day;
    const otherAfter = (await db.query<{ current_day: number }>("select current_day from sim_clock where org_id = $1", [other])).rows[0].current_day;

    expect(after).toBe(before + 1);
    expect(returned).toBe(after);
    expect(otherAfter).toBe(otherBefore);
  });
});

describe("claim_payment_intent(p_org_id, p_idempotency_key)", () => {
  it("does not claim another organization's intent", async () => {
    await db.query(
      `insert into payment_intents (org_id, source_type, source_id, idempotency_key, provider, provider_mode, amount, destination)
       values ($1, 'invoice', gen_random_uuid(), 'k-founding', 'simulate', 'simulate', 1, 'sim:x')`,
      [FOUNDING_ORG_ID]
    );
    const stolen = await db.query("select * from claim_payment_intent($1::uuid, 'k-founding')", [other]);
    expect(stolen.rows[0] ?? null).toMatchObject({ id: null });
    const own = await db.query<{ status: string }>("select * from claim_payment_intent($1::uuid, 'k-founding')", [FOUNDING_ORG_ID]);
    expect(own.rows[0].status).toBe("submitting");
  });
});

describe("ledger_entries_for_targets(p_org_id, …)", () => {
  it("returns only the organization's own entries for a shared target id", async () => {
    const target = crypto.randomUUID();
    const withTarget = { actor: "agent" as const, domain: "ap" as const, action: "pay", summary: "t", detail: { invoiceId: target } };
    await appendSignedForOrg(db, FOUNDING_ORG_ID, withTarget, key.privateKey);
    await appendSignedForOrg(db, other, withTarget, key.privateKey);
    const rows = (await db.query<{ org_id: string }>("select * from ledger_entries_for_targets($1::uuid, array[$2::text])", [other, target])).rows;
    expect(rows.map((row) => row.org_id)).toEqual([other]);
  });
});

describe("function privileges", () => {
  it("keeps every append_ledger_entry, advance_sim_day, claim_payment_intent and ledger_entries_for_targets away from anon and authenticated", async () => {
    // The browser has no legitimate direct RPC access to any of these — 0003
    // and 0004/0007 lock the old signatures down, and 0016 must do the same
    // for every signature it touches or leaves behind, old and new alike.
    const functions = await db.query<{ fn: string; anon_exec: boolean; auth_exec: boolean }>(
      `select p.oid::regprocedure::text as fn,
              has_function_privilege('anon', p.oid, 'execute') as anon_exec,
              has_function_privilege('authenticated', p.oid, 'execute') as auth_exec
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('append_ledger_entry', 'advance_sim_day', 'claim_payment_intent', 'ledger_entries_for_targets')`
    );

    expect(functions.rows.length).toBeGreaterThan(0);
    for (const row of functions.rows) {
      expect(row, row.fn).toMatchObject({ anon_exec: false, auth_exec: false });
    }
  });
});

describe("0016 is idempotent", () => {
  it("re-runs without error and without changing any chain", async () => {
    const before = await chainOf(FOUNDING_ORG_ID);
    await applyMigrations(db, THROUGH_0016);
    expect(await chainOf(FOUNDING_ORG_ID)).toEqual(before);
  });

  it("replays every migration through 0016 twice on a fresh database without error", async () => {
    // 0001's bootstrap insert into sim_clock uses `on conflict (id)`, and
    // scripts/migrate.ts replays every migration from 0001 on each
    // invocation — a fresh database is what a real second `db:migrate` run
    // sees. This is what would have caught the id/org_id primary-key hazard.
    const fresh = await createDatabase();
    await applyMigrations(fresh, THROUGH_0016);
    await applyMigrations(fresh, THROUGH_0016);

    const clock = await fresh.query<{ id: number | null; current_day: number }>(
      "select id, current_day from sim_clock where org_id = $1",
      [FOUNDING_ORG_ID]
    );
    expect(clock.rows).toEqual([{ id: 1, current_day: 0 }]);

    await fresh.close();
  }, 60_000);
});

describe("0017: the transitional parts are gone", () => {
  let contracted: PGlite;
  let northstar: string;
  const TENANT = [
    "accounts", "counterparties", "invoices", "milestones", "treasury_actions", "compliance_checks",
    "forecasts", "ledger_entries", "payment_intents", "cycle_runs", "cycle_snapshots", "sim_clock",
  ];

  beforeAll(async () => {
    contracted = await createDatabase();
    await applyMigrations(contracted, THROUGH_0016);
    await appendSigned(contracted, entry("before 0017"), key.privateKey);
    await contracted.query("select advance_sim_day($1::uuid)", [FOUNDING_ORG_ID]);
    await applyMigrations(contracted);
    northstar = await createOrg(contracted, "northstar");
  }, 60_000);

  afterAll(async () => {
    await contracted.close();
  });

  it("no tenant table defaults org_id any more, except sim_clock's bootstrap row (Ruling R13)", async () => {
    const rows = (await contracted.query<{ table_name: string; column_default: string | null }>(
      `select table_name, column_default from information_schema.columns
        where table_schema = 'public' and column_name = 'org_id' and table_name = any($1)`,
      [TENANT]
    )).rows;
    expect(rows.map((row) => row.table_name).sort()).toEqual([...TENANT].sort());
    expect(rows.filter((row) => row.column_default !== null).map((row) => row.table_name)).toEqual(["sim_clock"]);
  });

  it("an insert that does not name its organization fails", async () => {
    await expect(contracted.query("insert into counterparties (name, role) values ('No Org', 'vendor')")).rejects.toThrow(/org_id/);
  });

  it("keeps exactly one signature of each tenant function, all taking p_org_id", async () => {
    const rows = (await contracted.query<{ proname: string; args: string }>(
      `select p.proname, pg_get_function_identity_arguments(p.oid) as args
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('append_ledger_entry', 'advance_sim_day', 'claim_payment_intent', 'ledger_entries_for_targets')
        order by p.proname`
    )).rows;
    expect(rows.map((row) => row.proname)).toEqual(["advance_sim_day", "append_ledger_entry", "claim_payment_intent", "ledger_entries_for_targets"]);
    for (const row of rows) expect(row.args).toMatch(/^p_org_id uuid/);
  });

  it("keeps the founding chain and clock through the contraction", async () => {
    await appendSignedForOrg(contracted, FOUNDING_ORG_ID, entry("after 0017"), key.privateKey);
    const chain = (await contracted.query<LedgerRow>("select * from ledger_entries where org_id = $1 order by seq", [FOUNDING_ORG_ID])).rows;
    expect(verifyChain(chain, ring)).toEqual({ valid: true, checkedEntries: 2 });
    const day = (await contracted.query<{ d: number }>("select advance_sim_day($1::uuid) as d", [FOUNDING_ORG_ID])).rows[0].d;
    expect(day).toBe(2);
  });

  it("gives a new organization its own clock", async () => {
    expect((await contracted.query<{ d: number }>("select advance_sim_day($1::uuid) as d", [northstar])).rows[0].d).toBe(1);
  });

  it("re-runs without error", async () => {
    await applyMigrations(contracted);
    await applyMigrations(contracted);
  });

  it("keeps the per-organization-only lock body after a full replay", async () => {
    // Replaying 0001-0016 re-creates 0016's dual-lock append (the transitional
    // global lock plus the per-org one) under the very signature 0017 also
    // uses; only 0017's own create-or-replace overwrites that body again.
    // Without this, deleting 0017's create-or-replace would leave 0016's body
    // in place — the global lock back in production — and every other test
    // here would still pass, since none of them inspects the function body.
    const def = (await contracted.query<{ def: string }>(
      `select pg_get_functiondef('public.append_ledger_entry(uuid,text,text,text,text,jsonb,text,text,text)'::regprocedure) as def`
    )).rows[0].def;
    expect(def).toContain("'vestiarion_ledger:' || p_org_id");
    expect(def).not.toContain("hashtext('vestiarion_ledger')");
  });

  it("still defaults only sim_clock's org_id after a full replay", async () => {
    const rows = (await contracted.query<{ table_name: string; column_default: string | null }>(
      `select table_name, column_default from information_schema.columns
        where table_schema = 'public' and column_name = 'org_id' and table_name = any($1)`,
      [TENANT]
    )).rows;
    expect(rows.filter((row) => row.column_default !== null).map((row) => row.table_name)).toEqual(["sim_clock"]);
  });

  it("leaves no tenant function executable by the browser roles, even after a full replay", async () => {
    // Replaying 0001–0014 re-creates the old signatures for a moment; 0017 drops
    // them again, and the surviving ones must still refuse anon and authenticated.
    const rows = (await contracted.query<{ fn: string; anon: boolean; auth: boolean }>(
      `select p.oid::regprocedure::text as fn,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('append_ledger_entry', 'advance_sim_day', 'claim_payment_intent', 'ledger_entries_for_targets')`
    )).rows;
    expect(rows).toHaveLength(4);
    expect(rows.filter((row) => row.anon || row.auth)).toEqual([]);
  });
});
