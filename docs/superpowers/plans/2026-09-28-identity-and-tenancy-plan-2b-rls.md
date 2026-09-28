# Identity and tenancy — Plan 2b: row-level security

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Postgres itself refuses one organization's rows to another. Every tenant request runs as the role `vestiarion_tenant` with a server-minted token naming its organization. Row-level security policies and composite foreign keys enforce the boundary even when application code gets it wrong.

**Architecture:**
- Migration `0018` creates `vestiarion_tenant`, `public.request_org_id()`, least-privilege grants and one `tenant_isolation` policy per tenant table.
- Migration `0019` replaces every tenant-to-tenant foreign key with a composite `(org_id, …)` key.
- `mintRequestToken` signs an HS256 token per request.
- `contextFor` gives each scope a tenant client (anon key plus that token, through supabase-js's `accessToken` option), and `db()` uses it. `platformDb()` keeps the service role.
- Both migrations change nothing for the service role the deployed code uses, so rollout is one phase.

**Tech Stack:** Next.js 16.3.6, `@supabase/supabase-js` 2.117 (`accessToken` option), Postgres (Supabase), PGlite for SQL tests, Vitest, Node `crypto` (HMAC-SHA256).

**Spec:** `docs/superpowers/specs/2026-09-27-identity-and-tenancy-design.md` — rollout step 4 (§10). Design in §5.6 ("Line 2" and "Line 2 as built", including the 2026-09-28 spike), §8 (error row for a missing secret), §9 ("RLS, for real").

## Global Constraints

- Read the relevant guide in `node_modules/next/dist/docs/` before writing Next code (`AGENTS.md`).
- No new dependencies. `npm run verify` (check:lock, typecheck, lint, test) must be green at every commit.
- Migrations are idempotent: `scripts/migrate.ts` re-runs every file from `0001` on every run, each in its own transaction.
- The founding organization: id `00000000-0000-4000-8000-000000000001`, slug `founding`, ledger key id `9b03458d9a617871`.
- The tenant role is exactly `vestiarion_tenant`; the policy name is exactly `tenant_isolation`; the claim is exactly `org_id`.
- Token claims: `role: "vestiarion_tenant"`, `aud: "authenticated"`, `iss: "vestiarion"`, `sub` (user id, or `"system"`), `org_id`, `iat`, `exp = iat + 300`. HS256 signed with `SUPABASE_JWT_SECRET`.
- `anon` and `authenticated` keep no table or tenant-RPC privileges (as since `0003`).
- Never print a secret, a private key or a token in test output, logs or commit messages.
- Never run `db:migrate`, `cycle`, `seed` or any script against the Supabase project in `.env.local` — it is production. SQL is tested on PGlite only.
- Commit messages: subject line, blank line, `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, via `git commit -F <file>`.
- If `npm run typecheck` ever runs out of heap, delete any `tsconfig.tsbuildinfo` (incremental is now off, so it should not appear).

## Review Focus

1. **A long agent cycle outliving its token.** Expected: a fresh token per request, never one per scope. Pinned by Task 4 (the token minter runs once per request).
2. **`SUPABASE_JWT_SECRET` or the anon key missing where the app runs.** Expected: entering a scope fails with a message naming the setting, and the service role is never used as a fallback (§8). Pinned by Task 4.
3. **A foreign key pointing at another organization's row.** Examples: an invoice on another organization's counterparty, a treasury action on another's account. Expected: the database refuses it. Pinned by Task 2.
4. **PostgREST embedding after the foreign keys change.** `invoices → counterparties(name)` and similar must still resolve to exactly one relationship. Pinned by Task 2 (one foreign key per child column).
5. **The demo reset with an append-only ledger.** Expected: the reset works without deleting ledger entries, and records itself in the ledger. Pinned by Task 5.

## Rulings made while writing this plan

- **Least privilege per table.** `ledger_entries` and `cycle_snapshots` get SELECT and INSERT only, so the tenant role cannot rewrite history. Every other tenant table gets SELECT, INSERT, UPDATE and DELETE; the app deletes from them only in the demo reset.
- **The demo reset keeps the ledger** and appends a `demo_reset` entry. An audit chain that a reset could erase is not an audit chain, and the tenant role no longer has DELETE on it.
- **`request_org_id()` casts the claim to `uuid`.** A malformed claim therefore makes the request fail rather than match nothing. Both outcomes refuse access; failing is louder.
- **Tests inject their fetch through the base context** (`fetch` on `VestiarionContext`). `contextFor` builds the tenant client with it, so every existing fake-fetch test keeps observing real supabase-js requests.

---

### Task 1: Migration 0018 — the tenant role, `request_org_id()`, grants and policies

**Files:**
- Create: `supabase/migrations/0018_tenant_role_rls.sql`
- Modify: `tests/support/pglite.ts` (baseline role `authenticator`; helpers `seedOrgRows`, `asTenant`, `asRole`)
- Create: `tests/rls.test.ts`

**Interfaces:**
- Produces (SQL):
  - role `vestiarion_tenant` (nologin, noinherit), granted to `authenticator`;
  - `public.request_org_id() returns uuid`, executable by `vestiarion_tenant` only;
  - policy `tenant_isolation` on the 12 tenant tables;
  - EXECUTE on the four tenant RPCs for `vestiarion_tenant`.
- Produces (tests):
  - `seedOrgRows(db, orgId, tag): Promise<SeededRows>`;
  - `asTenant<T>(db, orgId: string | null, fn: (tx) => Promise<T>): Promise<T>`;
  - `asRole<T>(db, role: "anon" | "authenticated", fn): Promise<T>`.

- [ ] **Step 1: Extend the PGlite baseline and add the helpers**

In `tests/support/pglite.ts`, add `create role authenticator;` to `SUPABASE_BASELINE`, after `create role service_role;`. Then append:

```ts
export const TENANT_TABLES = [
  "accounts", "counterparties", "invoices", "milestones", "treasury_actions", "compliance_checks",
  "forecasts", "ledger_entries", "payment_intents", "cycle_runs", "cycle_snapshots", "sim_clock",
] as const;

export interface SeededRows {
  counterpartyId: string;
  accountId: string;
  invoiceId: string;
  cycleRunId: string;
  idempotencyKey: string;
}

type Queryable = Pick<PGlite, "query">;

/** One row in every tenant table for `orgId`, written as the superuser (the service role's stand-in). */
export async function seedOrgRows(db: PGlite, orgId: string, tag: string): Promise<SeededRows> {
  const one = async (sql: string, params: unknown[]) => (await db.query<{ id: string }>(sql, params)).rows[0]?.id;
  const counterpartyId = await one(
    "insert into counterparties (org_id, name, role) values ($1, $2, 'vendor') returning id", [orgId, `cp-${tag}`]);
  const accountId = await one(
    "insert into accounts (org_id, name, kind, chain) values ($1, $2, 'operating', 'ARC-TESTNET') returning id", [orgId, `acct-${tag}`]);
  const invoiceId = await one(
    "insert into invoices (org_id, direction, counterparty_id, amount, due_date) values ($1, 'payable', $2, 1, now()) returning id",
    [orgId, counterpartyId]);
  await db.query("insert into milestones (org_id, contractor_id, title, amount) values ($1, $2, $3, 1)", [orgId, counterpartyId, `m-${tag}`]);
  await db.query("insert into treasury_actions (org_id, action, amount, from_account) values ($1, 'rebalance', 1, $2)", [orgId, accountId]);
  await db.query("insert into compliance_checks (org_id, counterparty_id, risk_level, source) values ($1, $2, 'clear', 'test')", [orgId, counterpartyId]);
  await db.query(
    "insert into forecasts (org_id, as_of, horizon_days, projected_inflow, projected_outflow, liquid_balance) values ($1, now(), 7, 0, 0, 0)", [orgId]);
  const idempotencyKey = `k-${tag}`;
  await db.query(
    `insert into payment_intents (org_id, source_type, source_id, idempotency_key, provider, amount, destination)
     values ($1, 'invoice', $2, $3, 'simulate', 1, 'sim:x')`, [orgId, invoiceId, idempotencyKey]);
  const cycleRunId = await one(
    "insert into cycle_runs (org_id, started_at, clock_mode, chain_mode, screening_mode) values ($1, now(), 'real', 'simulate', 'simulate') returning id",
    [orgId]);
  await db.query(
    `insert into cycle_snapshots (org_id, cycle_run_id, captured_at, account_balances, total_liquid, open_payables,
       open_receivables, obligations_due_7d, obligations_due_14d, reserve_position, chain_mode)
     values ($1, $2, now(), '{}'::jsonb, 0, 0, 0, 0, 0, 0, 'simulate')`, [orgId, cycleRunId]);
  await db.query("select advance_sim_day($1::uuid)", [orgId]);
  const key = crypto.generateKeyPairSync("ed25519");
  await appendSignedForOrg(db, orgId, { actor: "system", domain: "system", action: "note", summary: tag, detail: { tag } }, key.privateKey);
  return { counterpartyId, accountId, invoiceId, cycleRunId, idempotencyKey };
}

/**
 * Runs `fn` the way PostgREST runs a request made with a tenant token: as the
 * role `vestiarion_tenant`, with `request.jwt.claims` holding the token's
 * claims. `null` means a request whose token names no organization.
 */
export async function asTenant<T>(db: PGlite, orgId: string | null, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    const claims = orgId ? { role: "vestiarion_tenant", org_id: orgId } : { role: "vestiarion_tenant" };
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    await tx.query("set local role vestiarion_tenant");
    return fn(tx);
  });
}

/** Runs `fn` as one of the browser roles, which must have no access at all. */
export async function asRole<T>(db: PGlite, role: "anon" | "authenticated", fn: (tx: Queryable) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query(`set local role ${role}`);
    return fn(tx);
  });
}
```

If PGlite's `transaction` callback type differs, adjust the `Queryable` type, not the behaviour.

- [ ] **Step 2: Write the failing isolation tests**

`tests/rls.test.ts`:

```ts
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
    const before = (await db.query<{ n: number }>(`select count(*)::int as n from public.${table} where org_id = $1`, [B])).rows[0].n;
    await asTenant(db, A, async (tx) => {
      await tx.query(`update public.${table} set org_id = org_id where org_id = $1`, [B]).catch(() => undefined);
      await tx.query(`delete from public.${table} where org_id = $1`, [B]).catch(() => undefined);
    });
    const after = (await db.query<{ n: number }>(`select count(*)::int as n from public.${table} where org_id = $1`, [B])).rows[0].n;
    expect(after).toBe(before);
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

  it("accepts a row for its own organization", async () => {
    await asTenant(db, A, (tx) => tx.query("insert into forecasts (org_id, as_of, horizon_days, projected_inflow, projected_outflow, liquid_balance) values ($1, now(), 7, 0, 0, 0)", [A]));
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
    await expect(asTenant(db, A, (tx) => tx.query(append, [B, ...signed("theirs")]))).rejects.toThrow();
  });

  it("refuses advancing another organization's clock", async () => {
    await expect(asTenant(db, A, (tx) => tx.query("select advance_sim_day($1::uuid)", [B]))).rejects.toThrow();
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
  it.each(["orgs", "memberships", "invitations"])("%s is closed to the tenant role", async (table) => {
    await expect(asTenant(db, A, (tx) => count(tx, table))).rejects.toThrow(/permission denied/);
  });
});

describe("0018 is idempotent", () => {
  it("replays twice without error", async () => {
    await applyMigrations(db);
    await applyMigrations(db);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/rls.test.ts`
Expected: FAIL — `role "vestiarion_tenant" does not exist` (or `function public.request_org_id() does not exist`).

- [ ] **Step 4: Write the migration**

`supabase/migrations/0018_tenant_role_rls.sql`:

```sql
-- Row-level security that actually applies (spec §5.6, Line 2 as built).
--
-- Every tenant request runs as vestiarion_tenant, with a server-minted token
-- whose org_id claim PostgREST puts in request.jwt.claims. The browser roles
-- keep no privileges, as since 0003; only this role gets any, and every policy
-- is written for it. The service role bypasses RLS and is untouched, so code
-- that still uses it works exactly as before.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'vestiarion_tenant') then
    create role vestiarion_tenant nologin noinherit;
  end if;
end $$;

-- PostgREST connects as authenticator and switches to the role a valid token names.
grant vestiarion_tenant to authenticator;
grant usage on schema public to vestiarion_tenant;

-- The organization the request's token names; null when it names none. A
-- custom role cannot use the auth schema on Supabase, so this reads the same
-- setting auth.jwt() does.
create or replace function public.request_org_id() returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'org_id', '')::uuid;
$$;

revoke execute on function public.request_org_id() from public, anon, authenticated;
grant execute on function public.request_org_id() to vestiarion_tenant;

do $$
declare
  t text;
begin
  foreach t in array array[
    'accounts', 'counterparties', 'invoices', 'milestones', 'treasury_actions', 'compliance_checks',
    'forecasts', 'ledger_entries', 'payment_intents', 'cycle_runs', 'cycle_snapshots', 'sim_clock'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all privileges on table public.%I from vestiarion_tenant', t);
    -- History is append-only for tenants: the ledger and the cycle snapshots
    -- can be read and added to, never rewritten.
    if t in ('ledger_entries', 'cycle_snapshots') then
      execute format('grant select, insert on table public.%I to vestiarion_tenant', t);
    else
      execute format('grant select, insert, update, delete on table public.%I to vestiarion_tenant', t);
    end if;
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format(
      'create policy tenant_isolation on public.%I for all to vestiarion_tenant '
      'using (org_id = public.request_org_id()) with check (org_id = public.request_org_id())',
      t
    );
  end loop;
end $$;

grant execute on function public.append_ledger_entry(uuid, text, text, text, text, jsonb, text, text, text) to vestiarion_tenant;
grant execute on function public.advance_sim_day(uuid) to vestiarion_tenant;
grant execute on function public.claim_payment_intent(uuid, text) to vestiarion_tenant;
grant execute on function public.ledger_entries_for_targets(uuid, text[], text[]) to vestiarion_tenant;

-- Rollback (the app must be using the service role again first):
-- do $$ declare t text; begin foreach t in array array['accounts','counterparties','invoices','milestones',
--   'treasury_actions','compliance_checks','forecasts','ledger_entries','payment_intents','cycle_runs',
--   'cycle_snapshots','sim_clock'] loop
--   execute format('drop policy if exists tenant_isolation on public.%I', t);
--   execute format('revoke all privileges on table public.%I from vestiarion_tenant', t); end loop; end $$;
-- revoke execute on all functions in schema public from vestiarion_tenant;
-- revoke usage on schema public from vestiarion_tenant;
-- revoke vestiarion_tenant from authenticator;
-- drop role vestiarion_tenant;
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run tests/rls.test.ts tests/org-chains.test.ts tests/ledger-parity.test.ts tests/tenancy-migration.test.ts`
Expected: PASS.
- If the tenant's own append fails with `permission denied for sequence ledger_entries_seq_seq`, add `grant usage on sequence public.ledger_entries_seq_seq to vestiarion_tenant;` after the table grants, and say so in the report.
- If `claim_payment_intent` returns zero rows instead of one all-null row, the test's `claimed?.id ?? null` already covers both.
- If a table's test in the `describe.each` fails because PGlite's error text differs (e.g. no "permission denied"), fix the regex to PGlite's actual text and name the text in the report. Never weaken a test from "refused" to "anything".

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0018_tenant_role_rls.sql tests/support/pglite.ts tests/rls.test.ts
git commit -F <message file>   # subject: "feat(db): a tenant role and row-level security on every tenant table (0018)"
```

---

### Task 2: Migration 0019 — composite foreign keys

**Files:**
- Create: `supabase/migrations/0019_org_composite_fks.sql`
- Create: `tests/composite-fks.test.ts`

**Interfaces:**
- Consumes: `seedOrgRows`, `createOrg`, `FOUNDING_ORG_ID` (Task 1).
- Produces:
  - `unique (org_id, id)` on `counterparties`, `accounts` and `cycle_runs`;
  - composite foreign keys named `<child>_<column>_org_fkey`, each replacing the single-column key on the same column.

- [ ] **Step 1: Write the failing tests**

`tests/composite-fks.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/composite-fks.test.ts`
Expected: FAIL — the cross-organization inserts succeed.

- [ ] **Step 3: Write the migration**

`supabase/migrations/0019_org_composite_fks.sql`:

```sql
-- Composite foreign keys (spec §5.6, Line 2 as built).
--
-- Foreign-key checks bypass row-level security, so a single-column key lets a
-- row of one organization point at another organization's counterparty,
-- account or cycle run. Each such key becomes (org_id, column) → (org_id, id),
-- and the single-column key it replaces is dropped, so PostgREST still sees
-- exactly one relationship to embed.
--
-- Every existing row belongs to the founding organization, so every existing
-- link already satisfies the composite key.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

do $$
declare
  parent text;
begin
  foreach parent in array array['counterparties', 'accounts', 'cycle_runs']
  loop
    if not exists (select 1 from pg_constraint where conname = parent || '_org_id_id_key') then
      execute format('alter table public.%I add constraint %I unique (org_id, id)', parent, parent || '_org_id_id_key');
    end if;
  end loop;
end $$;

do $$
declare
  spec record;
  old  record;
begin
  for spec in
    select * from (values
      ('invoices',          'counterparty_id', 'counterparties', 'cascade'),
      ('milestones',        'contractor_id',   'counterparties', 'cascade'),
      ('compliance_checks', 'counterparty_id', 'counterparties', 'cascade'),
      ('treasury_actions',  'from_account',    'accounts',       'set null (from_account)'),
      ('treasury_actions',  'to_account',      'accounts',       'set null (to_account)'),
      ('cycle_snapshots',   'cycle_run_id',    'cycle_runs',     'restrict')
    ) as s(child, col, parent, on_delete)
  loop
    -- Drop the single-column key on this column, whatever it is named.
    for old in
      select c.conname
        from pg_constraint c
       where c.contype = 'f'
         and c.conrelid = format('public.%I', spec.child)::regclass
         and c.confrelid = format('public.%I', spec.parent)::regclass
         and c.conkey = array[(select attnum from pg_attribute
                                where attrelid = format('public.%I', spec.child)::regclass and attname = spec.col)]::int2[]
    loop
      execute format('alter table public.%I drop constraint %I', spec.child, old.conname);
    end loop;

    if not exists (select 1 from pg_constraint where conname = spec.child || '_' || spec.col || '_org_fkey') then
      execute format(
        'alter table public.%I add constraint %I foreign key (org_id, %I) references public.%I (org_id, id) on delete %s',
        spec.child, spec.child || '_' || spec.col || '_org_fkey', spec.col, spec.parent, spec.on_delete
      );
    end if;
  end loop;
end $$;

-- Rollback: for each (child, col, parent, on_delete) above, drop <child>_<col>_org_fkey and
-- add back `foreign key (col) references public.<parent>(id) on delete <rule without the column list>`;
-- then drop the three <parent>_org_id_id_key constraints.
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/composite-fks.test.ts tests/rls.test.ts tests/org-chains.test.ts tests/tenancy-migration.test.ts`
Expected: PASS. `on delete set null (column)` needs Postgres 15 or later; PGlite and Supabase both qualify. If PGlite rejects the syntax, stop and report NEEDS_CONTEXT; do not change the delete rule.

- [ ] **Step 5: Commit**

Subject: `feat(db): a foreign key can only point within its own organization (0019)`.

---

### Task 3: `mintRequestToken` and its configuration

**Files:**
- Create: `src/lib/dal/request-token.ts`
- Modify: `src/lib/config.ts` (`DatabaseConfig.anonKey`, `DatabaseConfig.requestTokenSecret`, `describeConfig`)
- Modify: `tests/setup.ts` (placeholder anon key and token secret)
- Create: `tests/request-token.test.ts`
- Modify: `tests/config.test.ts`

**Interfaces:**
- Produces:
  - `TENANT_ROLE = "vestiarion_tenant"` and `REQUEST_TOKEN_TTL_SECONDS = 300`;
  - `mintRequestToken(input: { orgId: string; userId?: string; secret: string; now?: number }): string`;
  - `DatabaseConfig` gains `anonKey?: string` (from `NEXT_PUBLIC_SUPABASE_ANON_KEY`) and `requestTokenSecret?: string` (from `SUPABASE_JWT_SECRET`);
  - `describeConfig(config).database.tenantAccessConfigured: boolean`.

- [ ] **Step 1: Write the failing tests**

`tests/request-token.test.ts`:

```ts
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { REQUEST_TOKEN_TTL_SECONDS, TENANT_ROLE, mintRequestToken } from "@/lib/dal/request-token";

const SECRET = "test-request-token-secret-at-least-32-characters";
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);

function parts(token: string) {
  const [header, payload, signature] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(header, "base64url").toString()),
    payload: JSON.parse(Buffer.from(payload, "base64url").toString()),
    signed: `${header}.${payload}`,
    signature,
  };
}

describe("mintRequestToken", () => {
  it("is an HS256 JWT signed with the project secret", () => {
    const token = parts(mintRequestToken({ orgId: ORG, secret: SECRET, now: NOW }));
    expect(token.header).toEqual({ alg: "HS256", typ: "JWT" });
    expect(token.signature).toBe(crypto.createHmac("sha256", SECRET).update(token.signed).digest("base64url"));
  });

  it("names the tenant role and the organization, and expires in five minutes", () => {
    const { payload } = parts(mintRequestToken({ orgId: ORG, userId: "user-1", secret: SECRET, now: NOW }));
    expect(payload).toEqual({
      role: TENANT_ROLE,
      aud: "authenticated",
      iss: "vestiarion",
      sub: "user-1",
      org_id: ORG,
      iat: NOW / 1000,
      exp: NOW / 1000 + REQUEST_TOKEN_TTL_SECONDS,
    });
    expect(REQUEST_TOKEN_TTL_SECONDS).toBe(300);
  });

  it("names the system as subject when no person is behind the request", () => {
    expect(parts(mintRequestToken({ orgId: ORG, secret: SECRET, now: NOW })).payload.sub).toBe("system");
  });

  it("does not verify under another secret", () => {
    const token = parts(mintRequestToken({ orgId: ORG, secret: SECRET, now: NOW }));
    expect(token.signature).not.toBe(crypto.createHmac("sha256", "another-secret").update(token.signed).digest("base64url"));
  });

  it("refuses to mint without a secret, naming the setting", () => {
    expect(() => mintRequestToken({ orgId: ORG, secret: "", now: NOW })).toThrow(/SUPABASE_JWT_SECRET/);
  });

  it("refuses to mint without an organization", () => {
    expect(() => mintRequestToken({ orgId: "", secret: SECRET, now: NOW })).toThrow(/organization/);
  });
});
```

Add to `tests/config.test.ts`:
- `configFromEnv` reads `NEXT_PUBLIC_SUPABASE_ANON_KEY` into `database.anonKey` and `SUPABASE_JWT_SECRET` into `database.requestTokenSecret` (trimmed; absent → undefined).
- `describeConfig` reports `database.tenantAccessConfigured` as true only when both are set.
- `JSON.stringify(describeConfig(config))` contains neither value. Use distinctive placeholder values and assert they are absent.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/request-token.test.ts tests/config.test.ts`
Expected: FAIL — module `@/lib/dal/request-token` not found; the config fields are absent.

- [ ] **Step 3: Implement**

`src/lib/dal/request-token.ts`:

```ts
import crypto from "node:crypto";

/**
 * The token every tenant request carries (spec §5.6, Line 2 as built).
 *
 * PostgREST verifies it with the project's JWT secret, switches to the role it
 * names, and puts its claims in `request.jwt.claims`, where every row-level
 * policy reads `org_id` through `public.request_org_id()`.
 *
 * This is the only module that knows the algorithm and the secret. Moving to
 * an imported asymmetric key, together with Supabase's newer API keys, is a
 * change to this file and one environment variable.
 */

export const TENANT_ROLE = "vestiarion_tenant";
export const REQUEST_TOKEN_TTL_SECONDS = 300;

export interface RequestTokenInput {
  orgId: string;
  /** The signed-in person; absent for the cron and scripts, which act as the system. */
  userId?: string;
  secret: string;
  now?: number;
}

const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

export function mintRequestToken({ orgId, userId, secret, now = Date.now() }: RequestTokenInput): string {
  if (!secret) throw new Error("SUPABASE_JWT_SECRET is not set, so no request can be authorised for an organization");
  if (!orgId) throw new Error("A request token must name an organization");
  const iat = Math.floor(now / 1000);
  const signed = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    role: TENANT_ROLE,
    aud: "authenticated",
    iss: "vestiarion",
    sub: userId ?? "system",
    org_id: orgId,
    iat,
    exp: iat + REQUEST_TOKEN_TTL_SECONDS,
  })}`;
  return `${signed}.${crypto.createHmac("sha256", secret).update(signed).digest("base64url")}`;
}
```

In `src/lib/config.ts`:
- Add to `DatabaseConfig`:
  - `/** The public anon key; tenant requests present it alongside their own token. */ anonKey?: string;`
  - `/** Signs each tenant request's token (SUPABASE_JWT_SECRET). As powerful as the service role key. */ requestTokenSecret?: string;`
- In `configFromEnv`: `database: { url, serviceRoleKey, anonKey: trimmed(env.NEXT_PUBLIC_SUPABASE_ANON_KEY), requestTokenSecret: trimmed(env.SUPABASE_JWT_SECRET) }`.
- In `describeConfig`: `database: { host: safeHost(config.database.url), tenantAccessConfigured: !!(config.database.anonKey && config.database.requestTokenSecret) }`.

In `tests/setup.ts`, beside the existing placeholders:

```ts
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
process.env.SUPABASE_JWT_SECRET ??= "test-request-token-secret-at-least-32-characters";
```

Add a comment in the file's existing style saying why: entering an organization builds a tenant client, which needs both.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run tests/request-token.test.ts tests/config.test.ts`, then `npm test`.
Expected: PASS. The status route's `configuration` gains `database.tenantAccessConfigured`. Update `docs/api.md`'s status example if it lists `database`.

- [ ] **Step 5: Commit**

Subject: `feat(dal): mint a per-request token naming the organization`.

---

### Task 4: Every scope gets a tenant client; `db()` uses it

**Files:**
- Create: `src/lib/dal/tenant-client.ts`
- Modify: `src/lib/context.ts` (`VestiarionContext.tenantDb`, `VestiarionContext.fetch`)
- Modify: `src/lib/dal/scope.ts` (`contextFor` builds `tenantDb`)
- Modify: `src/lib/dal/index.ts` (`db()` uses `tenantDb` and refuses without it)
- Modify: `tests/support/fake-supabase.ts` (return the recording `fetch`; add `orgTestContext`)
- Modify: every test that hand-builds an organization context (the full `npm test` run shows them: `tests/dal.test.ts`, `chain-provider`, `orchestrator`, `payments`, `tenant-scope-lib`, `context`, and any other)
- Create: `tests/tenant-client.test.ts`

**Interfaces:**
- Consumes: `mintRequestToken`, `DatabaseConfig.anonKey`, `DatabaseConfig.requestTokenSecret` (Task 3).
- Produces:
  - `tenantClient(database: DatabaseConfig, orgId: string, userId?: string, options?: { fetch?: typeof fetch; mint?: typeof mintRequestToken }): SupabaseClient`;
  - `VestiarionContext.tenantDb?: SupabaseClient`;
  - `VestiarionContext.fetch?: typeof fetch` (the fetch both clients use; tests pass a recorder);
  - `fakeSupabase()` also returns `fetch`;
  - `orgTestContext(input: { config; client; orgId; secretWarnings?; userId? }): VestiarionContext`.

- [ ] **Step 1: Write the failing tests**

`tests/tenant-client.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { currentContext, runWith } from "@/lib/context";
import { db, platformDb } from "@/lib/dal";
import { mintRequestToken } from "@/lib/dal/request-token";
import { tenantClient } from "@/lib/dal/tenant-client";
import { withOrg } from "@/lib/dal/scope";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000beef";
const SERVICE = "test-service-role-key-value";
const ANON = "test-anon-key-value";
const SECRET = "test-request-token-secret-at-least-32-characters";
const env = { NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: SERVICE, NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON, SUPABASE_JWT_SECRET: SECRET };
const config = configFromEnv(env);

function claimsOf(request: RecordedRequest) {
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString() || "null");
}

function orgsReply(request: RecordedRequest) {
  return request.path === "/rest/v1/orgs"
    ? { body: { id: ORG, slug: "northstar", name: "Northstar", mode: "sandbox", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null } }
    : { body: [] };
}

describe("tenantClient", () => {
  it("presents the anon key and a token for the organization, never the service role key", async () => {
    const fake = fakeSupabase();
    await tenantClient(config.database, ORG, "user-1", { fetch: fake.fetch }).from("invoices").select("id");
    const [request] = fake.requests;
    expect(request.headers.get("apikey")).toBe(ANON);
    expect(claimsOf(request)).toMatchObject({ role: "vestiarion_tenant", org_id: ORG, sub: "user-1" });
    expect(JSON.stringify([...request.headers])).not.toContain(SERVICE);
  });

  it("mints a fresh token for every request, so a long cycle never outlives one", async () => {
    const fake = fakeSupabase();
    let minted = 0;
    const mint: typeof mintRequestToken = (input) => { minted += 1; return mintRequestToken(input); };
    const client = tenantClient(config.database, ORG, undefined, { fetch: fake.fetch, mint });
    await client.from("invoices").select("id");
    await client.from("accounts").select("id");
    expect(minted).toBe(2);
  });

  it("refuses to exist without the token secret, naming it, rather than falling back", () => {
    expect(() => tenantClient({ ...config.database, requestTokenSecret: undefined }, ORG)).toThrow(/SUPABASE_JWT_SECRET/);
  });

  it("refuses to exist without the anon key, naming it", () => {
    expect(() => tenantClient({ ...config.database, anonKey: undefined }, ORG)).toThrow(/NEXT_PUBLIC_SUPABASE_ANON_KEY/);
  });
});

describe("a scope entered through the DAL", () => {
  it("sends tenant reads with the organization's token and platform reads with the service role", async () => {
    const fake = fakeSupabase(orgsReply);
    await runWith({ config, db: fake.client, fetch: fake.fetch }, () =>
      withOrg(ORG, async () => {
        await db().from("invoices").select("id");
      }, { userId: "user-2" })
    );
    const orgs = fake.requests.find((request) => request.path === "/rest/v1/orgs")!;
    const invoices = fake.requests.find((request) => request.path === "/rest/v1/invoices")!;
    // fakeSupabase() builds its service client with the key "test-service-role".
    expect(orgs.headers.get("authorization")).toBe("Bearer test-service-role");
    expect(claimsOf(invoices)).toMatchObject({ role: "vestiarion_tenant", org_id: ORG, sub: "user-2" });
    expect(invoices.params.get("org_id")).toBe(`eq.${ORG}`);
  });

  it("cannot be entered when the token secret is missing", async () => {
    const fake = fakeSupabase(orgsReply);
    const broken = configFromEnv({ ...env, SUPABASE_JWT_SECRET: "" });
    await expect(runWith({ config: broken, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, async () => null))).rejects.toThrow(/SUPABASE_JWT_SECRET/);
  });

  it("keeps platformDb on the service role inside an organization", async () => {
    const fake = fakeSupabase(orgsReply);
    await runWith({ config, db: fake.client, fetch: fake.fetch }, () =>
      withOrg(ORG, async () => {
        await platformDb().from("memberships").select("role");
        expect(currentContext().tenantDb).toBeDefined();
      })
    );
    const memberships = fake.requests.find((request) => request.path === "/rest/v1/memberships")!;
    expect(memberships.headers.get("authorization")).toBe("Bearer test-service-role");
  });
});

describe("db()", () => {
  it("refuses a context without a tenant client instead of using the service role", async () => {
    const fake = fakeSupabase();
    await expect(runWith({ config, db: fake.client, orgId: ORG, platformConfig: config }, async () => db().from("invoices").select("id"))).rejects.toThrow(/tenant client/);
    expect(fake.requests).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/tenant-client.test.ts`
Expected: FAIL — module `@/lib/dal/tenant-client` not found.

- [ ] **Step 3: Implement**

`src/lib/dal/tenant-client.ts`:

```ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { DatabaseConfig } from "../config";
import { mintRequestToken } from "./request-token";

/**
 * The client an organization's scope uses for its own data. Every request
 * authenticates as `vestiarion_tenant` with a token naming the organization,
 * so row-level security confines it even if the DAL's own filters were wrong.
 *
 * A fresh token is minted per request (supabase-js calls `accessToken` for
 * each one), so no cycle, however long, outlives its token. There is no
 * fallback to the service role: a missing setting is a broken deployment and
 * says so (§8).
 */
export function tenantClient(
  database: DatabaseConfig,
  orgId: string,
  userId?: string,
  options: { fetch?: typeof fetch; mint?: typeof mintRequestToken } = {}
): SupabaseClient {
  if (!database.anonKey) throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY is not set, so no organization's data can be reached");
  const secret = database.requestTokenSecret;
  if (!secret) throw new Error("SUPABASE_JWT_SECRET is not set, so no request can be authorised for an organization");
  const mint = options.mint ?? mintRequestToken;
  return createClient(database.url, database.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    accessToken: async () => mint({ orgId, userId, secret }),
    ...(options.fetch ? { global: { fetch: options.fetch } } : {}),
  });
}
```

`src/lib/context.ts`:
- Add to `VestiarionContext`:
  - `/** The organization's own client: every request runs as vestiarion_tenant for orgId. Set only by the DAL. */ tenantDb?: SupabaseClient;`
  - `/** The fetch both clients use. Production leaves it unset; tests pass a recorder. */ fetch?: typeof fetch;`
- In `createDb(config, fetchImpl?)`, pass `global: { fetch }` when given. `createContext` keeps its signature.

`src/lib/dal/scope.ts` `contextFor`: build

```ts
tenantDb: tenantClient(platformConfig.database, org.id, userId, { fetch: current.fetch }),
fetch: current.fetch,
```

into the returned context. Use `platformConfig.database`, never the organization's config: database settings are platform settings.

`src/lib/dal/index.ts` `db()`: replace `const client = currentContext().db;` with:

```ts
  const client = currentContext().tenantDb;
  // No fallback to the service role: a scope the DAL did not build has no
  // tenant client, and reaching tenant data without one is the failure this
  // whole layer exists to prevent.
  if (!client) throw new Error("This organization's scope has no tenant client; enter it through withOrg or inOrg");
```

`platformDb()` is unchanged (`currentContext().db`, the service role).

`tests/support/fake-supabase.ts`:
- return `{ client, requests, fetch: recordingFetch }`;
- add:

```ts
/** An organization context as the DAL builds it, over one recorded fake client. */
export function orgTestContext(input: {
  config: VestiarionConfig; client: SupabaseClient; orgId: string; secretWarnings?: string[]; userId?: string;
}): VestiarionContext {
  return {
    config: input.config, db: input.client, tenantDb: input.client, orgId: input.orgId,
    platformConfig: input.config, secretWarnings: input.secretWarnings, userId: input.userId,
  };
}
```

Then repair every test that builds an organization context by hand. Run `npm test` and switch each failing site, e.g. `runWith({ config, db: fake.client, orgId: ORG, platformConfig: config }, …)`, to `runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), …)`. Keep each test's other fields: use `{ ...orgTestContext(…), config: <its own config> }` where a test's org config differs from its platform config. Where a test enters a scope through `withOrg`/`inOrg`/`handleApiRequest` on a base context `runWith({ config, db: fake.client }, …)`, add `fetch: fake.fetch` to that base context. Otherwise the tenant client would reach the real network. Never weaken an assertion; list every changed file in the report.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run tests/tenant-client.test.ts`, then `npm test`, then `npm run verify`.
Expected: all green. `grep -rn "currentContext().db" src` prints only `platformDb()` in src/lib/dal/index.ts and the `contextFor` read of `current.db` in src/lib/dal/scope.ts.

- [ ] **Step 5: Commit**

Subject: `feat(dal): tenant reads and writes run as vestiarion_tenant with a per-request token`.

---

### Task 5: The demo reset keeps the ledger

**Files:**
- Modify: `src/lib/seed.ts`
- Create or modify: `tests/seed.test.ts` (fake-fetch, as the other library tests)

**Interfaces:**
- Consumes: `db()`, `appendLedgerEntry`, `orgTestContext`, `fakeSupabase`.
- Produces: the reset deletes no ledger rows, and appends one `system`/`system`/`demo_reset` entry describing what it cleared.

- [ ] **Step 1: Write the failing test**

With a fake client (`orgTestContext`, with a config holding a throwaway Ed25519 `ledgerSigningKey` so the append can sign), run the module's reset function. Read `src/lib/seed.ts` for its exported name: `resetDatabase` or `seedDatabase`, whichever performs the deletes. Assert:
- no `DELETE` request has path `/rest/v1/ledger_entries`;
- a `POST /rest/v1/rpc/append_ledger_entry` is made whose body has `p_action: "demo_reset"`, `p_actor: "system"`, `p_domain: "system"`, and a `p_detail.cleared` array naming the tables it emptied;
- every DELETE request still carries `org_id=eq.<org>`.

- [ ] **Step 2: Run it to verify it fails**

Expected: FAIL — a DELETE to `ledger_entries` is made, and no `demo_reset` append.

- [ ] **Step 3: Implement**

In `src/lib/seed.ts`:
- remove `"ledger_entries"` from the reset's table list;
- after the deletes, append:

```ts
await appendLedgerEntry({
  actor: "system",
  domain: "system",
  action: "demo_reset",
  summary: `Demo data reset: ${TABLES.length} tables cleared; the ledger keeps its history`,
  detail: { cleared: [...TABLES] },
});
```

Add a comment above the table list: the tenant role cannot delete ledger entries (0018), and an audit chain that a reset could erase would not be one. Check how `/api/agent/reset` and `scripts/seed.ts` describe the reset in their messages and header comments, and correct any that say the ledger is cleared.

- [ ] **Step 4: Run to verify it passes**

Run the new test, then `npm run verify`. Expected: green.

- [ ] **Step 5: Commit**

Subject: `feat(seed): the demo reset keeps the ledger and records itself in it`.

---

### Task 6: Documentation and the rollout record

**Files:**
- Modify:
  - `README.md`: `SUPABASE_JWT_SECRET` is required wherever the app runs; where to find it (Supabase → Project Settings → JWT Keys → legacy JWT secret); it is as powerful as the service role key; set it as a Sensitive variable on Vercel for Production and Preview.
  - `.env.example`: add `SUPABASE_JWT_SECRET=` with a one-line comment.
  - `ARCHITECTURE.md`: the two lines of isolation, the DAL plus RLS as the tenant role.
  - `docs/api.md`: any status `configuration.database` example.
- Modify: `docs/superpowers/specs/2026-09-27-identity-and-tenancy-design.md` §10 step 4, but only after production is measured (below).

- [ ] **Step 1: Update the docs above, then commit**

Subject: `docs: the tenant role, its token secret, and the demo reset`.

- [ ] **Step 2: Rollout.** The controller runs it with the partner after the pull request's checks pass. It is not part of any subagent's task.

1. The partner adds `SUPABASE_JWT_SECRET` to Vercel (Sensitive; Production and Preview), then redeploys the preview.
2. `npm run db:migrate` (applies 0018 and 0019), away from the cron's `:17` slot, because both take brief exclusive locks. Measure while the OLD code is still live:
   - read-only privilege checks: `has_schema_privilege('vestiarion_tenant', 'extensions', 'USAGE')` and `pg_has_role('authenticator', 'vestiarion_tenant', 'MEMBER')`;
   - `set role vestiarion_tenant; select extensions.digest('x', 'sha256')`;
   - token probes, which are independent of the deployed code:
     - a locally minted founding token reads `/rest/v1/ledger_entries`, and `/rest/v1/invoices?select=*,counterparties(name)` (this proves the embed works across the composite key);
     - a random-organization token reads `[]`;
     - a token with `role: authenticated` gets 403;
   - the role, the policies (12), `request_org_id()`, the composite keys, and one foreign key per embedded relationship exist;
   - the ledger still verifies;
   - a cron cycle (`workflow_dispatch`) still completes.
3. Merge, then wait for production to serve the new code. Measure:
   - a cron cycle completes, and its entries carry the founding `org_id` and key `9b03458d9a617871`;
   - `/api/v1/ledger/verify` returns `valid: true`;
   - `/api/v1/status` returns `database.tenantAccessConfigured: true`;
   - the partner's owner pages render;
   - probe with a token minted locally:
     - a token for a random organization reads `[]` from `/rest/v1/ledger_entries`;
     - a token for the founding organization reads rows;
     - a token with `role: authenticated` gets 403.
4. Record the outcome under §10 step 4 of the spec, in the style of steps 2 and 3, through a docs pull request.
5. Rollback, if pages or cycles fail after the deploy: Vercel's instant rollback to the previous deployment. The old code uses the service role, which the migrations do not affect.
