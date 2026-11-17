import { readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, createDatabase, createUser, FOUNDING_ORG_ID, MIGRATIONS_DIR } from "./support/pglite";

/**
 * Migration 0150, database hygiene: the functions Supabase's advisors flagged (a mutable search_path, SECURITY DEFINER
 * functions anon could execute), the foreign keys on org_id with no index, and cheaper reads of open_outcomes and
 * recent_team_decisions that give the same figures. The figures are read from one varied ledger before 0150 and after
 * it, twice over, and must not move.
 */

let db: PGlite;
const NOW = Date.now();
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW + days * DAY).toISOString();

/** A small deterministic generator, so a failure reproduces. */
function random(seed: number) {
  let state = seed;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)], chance: (p: number) => next() < p };
}

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.query<T>(sql, params)).rows[0];
}

interface Workspace {
  id: string;
  vendors: string[];
  contractors: string[];
  invoices: string[];
  milestones: string[];
}

async function workspace(slug: string, fields: { createdBy: string | null; mode: "live" | "sandbox"; network: string }): Promise<Workspace> {
  const { id } = await one<{ id: string }>(
    "insert into public.orgs (slug, name, mode, created_by, created_at, network) values ($1, $1, $2, $3, $4, $5) returning id",
    [slug, fields.mode, fields.createdBy, at(-60), fields.network]
  );
  return { id, vendors: [], contractors: [], invoices: [], milestones: [] };
}

const INVOICE_STATUSES = ["pending", "matched", "paid", "held", "flagged", "rejected", "awaiting_info", "scheduled"] as const;
const OUTCOMES = ["paid", "matched", "scheduled", "held", "flagged", "awaiting_info", "pending"] as const;
const AP_ACTIONS = ["ap_pay", "ap_schedule", "ap_hold", "ap_request_info", "ap_flag_fraud", "ap_wait"] as const;
const APPROVALS = ["approval_paid", "approval_rejected", "approval_returned", "approval_given"] as const;

async function fill(w: Workspace, entries: number, seed: number, reviewer: string): Promise<void> {
  const r = random(seed);
  for (const sample of [false, true]) {
    w.vendors.push((await one<{ id: string }>(
      "insert into public.counterparties (org_id, name, role, sample) values ($1, $2, 'vendor', $3) returning id",
      [w.id, `Vendor ${sample}`, sample]
    )).id);
    w.contractors.push((await one<{ id: string }>(
      "insert into public.counterparties (org_id, name, role, sample) values ($1, $2, 'contractor', $3) returning id",
      [w.id, `Contractor ${sample}`, sample]
    )).id);
  }
  for (let i = 0; i < 14; i++) {
    const status = r.pick(INVOICE_STATUSES);
    const due = at(-25 + Math.floor(r.next() * 35));
    w.invoices.push((await one<{ id: string }>(
      `insert into public.invoices (org_id, direction, counterparty_id, amount, due_date, status, reviewed_by, scheduled_for)
       values ($1, $2, $3, 1, $4, $5, $6, $7) returning id`,
      [w.id, i === 0 ? "receivable" : "payable", r.pick(w.vendors), due, status, r.chance(0.3) ? reviewer : null, status === "scheduled" ? due : null]
    )).id);
  }
  for (let i = 0; i < 4; i++) {
    w.milestones.push((await one<{ id: string }>(
      "insert into public.milestones (org_id, contractor_id, title, amount, status) values ($1, $2, 'Work', 1, $3) returning id",
      [w.id, r.pick(w.contractors), r.pick(["pending", "paid", "held"])]
    )).id);
  }
  // One payment per bill or milestone at most (payment_intents is unique on its source).
  for (const [type, source] of [...w.invoices.map((id) => ["invoice", id]), ...w.milestones.map((id) => ["milestone", id])]) {
    if (r.chance(0.35)) continue;
    const provider = r.chance(0.15) ? "simulate" : "circle";
    await db.query(
      `insert into public.payment_intents
         (org_id, source_type, source_id, idempotency_key, provider, provider_mode, amount, destination, status, executed_at, tx_hash, chain)
       values ($1, $2, $3, gen_random_uuid()::text, $4, $5, 1, '0xAAA', $6, $7, $8, 'ARC-TESTNET')`,
      [w.id, type, source, provider, provider === "circle" ? "live" : "simulate", r.pick(["confirmed", "confirmed", "failed"]),
        at(-20 + Math.floor(r.next() * 20)), `0x${seed}${source.slice(0, 8)}`]
    );
  }

  const stray = "00000000-0000-4000-8000-0000000000ff";
  const weekAgo = NOW - 7 * DAY;
  let ts = NOW - 30 * DAY;
  for (let i = 0; i < entries; i++) {
    ts = Math.min(ts + Math.floor(r.next() * ((58 * DAY) / entries)), NOW - 3_600_000);
    // Nothing within two hours of a week ago, where the two reads' now() could count it differently.
    if (Math.abs(ts - weekAgo) < 2 * 3_600_000) ts = weekAgo + 2 * 3_600_000;
    const invoiceId = r.chance(0.08) ? stray : r.pick(w.invoices);
    const kind = r.next();
    let fields: { actor: string; domain: string; action: string; detail: object };
    if (kind < 0.55) {
      const matches = r.chance(0.3)
        ? [{ otherInvoiceStatus: r.pick(["paid", "received", "pending"]), confidence: r.pick([0.95, 0.6, "high"]) }]
        : r.chance(0.1) ? "none" : [];
      fields = {
        actor: "agent", domain: "ap", action: r.pick(AP_ACTIONS),
        detail: {
          invoiceId,
          counterpartyId: r.pick(w.vendors),
          ...(r.chance(0.9) ? { decision: { action: "pay", payOn: at(1).slice(0, 10) } } : {}),
          execution: { resultingStatus: r.pick(OUTCOMES), ...(r.chance(0.15) ? { chainMode: "simulate" } : {}), txRef: "0xref" },
          ...(r.chance(0.1) ? { guardrailRule: "invoice.duplicate_of_settled", guardrailBlocked: true } : {}),
          ...(r.chance(0.1) ? { heldBecause: "over_limit" } : {}),
          observed: { amount: "1.00", duplicateCheck: { matches } },
        },
      };
    } else if (kind < 0.65) {
      fields = {
        actor: "agent", domain: "contractor", action: r.pick(["milestone_release", "milestone_hold"]),
        detail: { milestoneId: r.chance(0.1) ? stray : r.pick(w.milestones), counterpartyId: r.pick(w.contractors), decision: { action: "release" },
          execution: { resultingStatus: r.pick(OUTCOMES) } },
      };
    } else if (kind < 0.7) {
      fields = { actor: "agent", domain: "treasury", action: "hold", detail: { decision: { action: "hold" } } };
    } else if (kind < 0.92) {
      const target = r.next();
      // People act on the first bills only, so the later ones can be paid untouched.
      const approved = invoiceId === stray ? stray : w.invoices[Math.floor(r.next() * 8)];
      fields = {
        actor: "human", domain: "ap", action: r.pick(APPROVALS),
        detail: target < 0.8 ? { invoiceId: approved, ...(r.chance(0.4) ? { overrode: r.pick(["flagged", "held"]) } : {}) }
          : target < 0.9 ? { invoiceId: null } : { milestoneId: r.pick(w.milestones) },
      };
    } else {
      fields = { actor: "system", domain: "system", action: "cycle", detail: { invoiceId } };
    }
    await db.query(
      `insert into public.ledger_entries (org_id, ts, actor, domain, action, summary, detail, body_hash, signature, prev_hash, hash)
       values ($1, $2, $3, $4, $5, $5, $6, 'b', 's', 'p', gen_random_uuid()::text)`,
      [w.id, new Date(ts).toISOString(), fields.actor, fields.domain, fields.action, JSON.stringify(fields.detail)]
    );
  }
}

const SINCE = [null, at(-40), at(-15), at(-5), at(1)];
const LIMITS = [null, 0, 1, 3, 6, 12, 99];

async function figures() {
  const outcomes = [];
  for (const network of ["arc-testnet", "arc-mainnet"]) {
    for (const since of SINCE) {
      outcomes.push(
        (await one<{ v: unknown }>("select public.open_outcomes($1::timestamptz, $2) as v", [since, network])).v
      );
    }
  }
  const recent = [];
  for (const limit of LIMITS) {
    recent.push((await one<{ v: unknown }>("select public.recent_team_decisions($1::integer) as v", [limit])).v);
  }
  return { outcomes, recent };
}

let before: Awaited<ReturnType<typeof figures>>;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db, (file) => file < "0150");

  const team = await createUser(db, "team@vestiarion.test");
  await db.query("select public.set_platform_team_member('team@vestiarion.test', true)");
  const owner = await createUser(db, "owner@customer.test");

  const founding = { id: FOUNDING_ORG_ID, vendors: [], contractors: [], invoices: [], milestones: [] };
  await fill(founding, 40, 1, owner);
  await fill(await workspace("team-testnet", { createdBy: team, mode: "live", network: "arc-testnet" }), 560, 2, owner);
  await fill(await workspace("team-mainnet", { createdBy: team, mode: "live", network: "arc-mainnet" }), 90, 3, owner);
  await fill(await workspace("team-sandbox", { createdBy: team, mode: "sandbox", network: "arc-testnet" }), 40, 4, owner);
  await fill(await workspace("cust-testnet", { createdBy: owner, mode: "live", network: "arc-testnet" }), 120, 5, owner);
  await fill(await workspace("cust-mainnet", { createdBy: owner, mode: "live", network: "arc-mainnet" }), 90, 6, owner);
  await fill(await workspace("nobody", { createdBy: null, mode: "live", network: "arc-testnet" }), 40, 7, owner);

  // A stand-in for Supabase's own rls_auto_enable, executable by anon as it is on Supabase.
  await db.exec(`
    create function public.rls_auto_enable() returns event_trigger language plpgsql security definer set search_path = pg_catalog
      as $$ begin end $$;
    grant execute on function public.rls_auto_enable() to anon, authenticated;
  `);

  before = await figures();
  await applyMigrations(db, (file) => file.startsWith("0150"));
}, 180_000);

afterAll(async () => {
  await db.close();
});

describe("0150 keeps the figures", () => {
  it("reads a ledger with something in every figure", () => {
    const testnetAllTime = before.outcomes[0] as { sides: { total: Record<string, number> } };
    const empty = Object.entries(testnetAllTime.sides.total).filter(([, value]) => Number(value) === 0).map(([key]) => key);
    expect(empty).toEqual([]);
    const recent = before.recent[4] as { decisions: unknown[]; pastWeek: Record<string, number> };
    expect(recent.decisions).toHaveLength(6);
    expect(Number(recent.pastWeek["arc-testnet"])).toBeGreaterThan(0);
    expect(Number(recent.pastWeek["arc-mainnet"])).toBeGreaterThan(0);
  });

  it("gives the same open_outcomes and recent_team_decisions after it, and after it runs again", async () => {
    expect(await figures()).toEqual(before);
    await applyMigrations(db, (file) => file.startsWith("0150"));
    expect(await figures()).toEqual(before);
  });
});

describe("0150 settles the advisors' findings", () => {
  it("fixes the search_path of advance_sim_day and append_ledger_entry, which still work from an empty one", async () => {
    const configs = await db.query<{ proname: string; proconfig: string[] }>(
      "select proname, proconfig from pg_catalog.pg_proc where proname in ('advance_sim_day', 'append_ledger_entry') order by proname"
    );
    expect(configs.rows).toEqual([
      { proname: "advance_sim_day", proconfig: ['search_path=""'] },
      { proname: "append_ledger_entry", proconfig: ["search_path=public, extensions, pg_temp"] },
    ]);

    await db.exec("set search_path = pg_catalog");
    try {
      const day = await one<{ day: number }>("select public.advance_sim_day($1::uuid) as day", [FOUNDING_ORG_ID]);
      expect(day.day).toBeGreaterThan(0);
      const row = await one<{ hash: string }>(
        "select hash from public.append_ledger_entry($1::uuid, 'system', 'system', 'probe', 'probe', '{}'::jsonb, 'b', 's', null)",
        [FOUNDING_ORG_ID]
      );
      expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await db.exec("set search_path = public");
    }
  });

  it("lets no one but the owner and the service role execute the SECURITY DEFINER trigger functions", async () => {
    for (const fn of ["public.orgs_network_locked()", "public.payment_intents_network()", "public.rls_auto_enable()"]) {
      for (const role of ["public", "anon", "authenticated"]) {
        const { allowed } = await one<{ allowed: boolean }>(
          role === "public"
            ? "select exists (select 1 from pg_catalog.pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = $1::regprocedure and a.grantee = 0) as allowed"
            : "select has_function_privilege($2, $1::regprocedure, 'execute') as allowed",
          role === "public" ? [fn] : [fn, role]
        );
        expect({ fn, role, allowed }).toEqual({ fn, role, allowed: false });
      }
    }
  });

  it("holds for every function in public, not only these", async () => {
    const offending = await db.query<{ fn: string; why: string }>(`
      select p.oid::regprocedure::text as fn, why
        from pg_catalog.pg_proc p
        cross join lateral (values
          ('no search_path', not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')),
          ('public may execute', p.prosecdef and exists (
             select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')),
          ('anon may execute', p.prosecdef and has_function_privilege('anon', p.oid, 'execute')),
          ('authenticated may execute', p.prosecdef and has_function_privilege('authenticated', p.oid, 'execute'))
        ) v(why, bad)
       where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and v.bad
         and not exists (select 1 from pg_catalog.pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
       order by 1, 2`);
    expect(offending.rows).toEqual([]);
  });

  it("leaves the network triggers firing", async () => {
    const live = await one<{ id: string }>("select id from public.orgs where slug = 'cust-mainnet'");
    await expect(db.query("update public.orgs set network = 'arc-testnet' where id = $1", [live.id])).rejects.toThrow(/network_locked/);
    const intent = await one<{ network: string }>(
      `insert into public.payment_intents (org_id, source_type, source_id, idempotency_key, provider, provider_mode, amount, destination, status, network)
       values ($1, 'invoice', gen_random_uuid(), gen_random_uuid()::text, 'circle', 'live', 1, '0xAAA', 'pending', 'arc-testnet') returning network`,
      [live.id]
    );
    expect(intent.network).toBe("arc-mainnet");
    await expect(asRole(db, "anon", (tx) => tx.query("select public.payment_intents_network()"))).rejects.toThrow(/permission denied/);
  });

  it("indexes every foreign key on org_id alone with an index a workspace's delete can use", async () => {
    // A partial index counts only when its predicate is org_id IS NOT NULL, which the delete's `where org_id = $1` meets.
    const unindexed = await db.query<{ tbl: string }>(`
      select c.conrelid::regclass::text as tbl
        from pg_catalog.pg_constraint c
       where c.contype = 'f' and c.connamespace = 'public'::regnamespace
         and c.conkey = array[(select attnum from pg_catalog.pg_attribute where attrelid = c.conrelid and attname = 'org_id')]
         and not exists (
               select 1 from pg_catalog.pg_index i
                where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1]
                  and (i.indpred is null or pg_get_expr(i.indpred, i.indrelid) = '(org_id IS NOT NULL)'))
       order by 1`);
    expect(unindexed.rows).toEqual([]);
  });

  it("makes the ledger's index before any other table's, in the order a ledger append locks them", () => {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, "0150_db_hygiene.sql"), "utf8");
    const indexes = [...sql.matchAll(/^create index if not exists (\w+) on public\.(\w+)/gm)].map((match) => match[2]);
    expect(indexes[0]).toBe("ledger_entries");
    expect(indexes.slice(1)).not.toContain("ledger_entries");
    expect(indexes).toContain("webhook_deliveries");
  });

  it("holds the agent's choices on bills and milestones in a partial index of the ledger", async () => {
    const { def } = await one<{ def: string }>("select pg_get_indexdef('public.ledger_entries_agent_choice_idx'::regclass) as def");
    expect(def).toContain("(org_id, seq)");
    expect(def).toContain("actor = 'agent'");
    for (const action of ["ap_pay", "ap_schedule", "ap_hold", "ap_request_info", "ap_flag_fraud", "milestone_release", "milestone_hold"]) {
      expect(def).toContain(action);
    }
  });
});
