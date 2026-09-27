# Identity and tenancy — Plan 2a: the Data Access Layer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every read and write of tenant data names its organization, one ledger chain per organization, per-organization secrets read from `orgs`, and no code path that can touch tenant data without an organization in scope.

**Architecture:** `VestiarionContext` gains `orgId`/`userId`; `currentOrgId()` throws outside a scope. `withOrg()` loads the organization's row, decrypts its secrets into a per-organization config, and runs work inside `AsyncLocalStorage`. `db()` in `src/lib/dal/` is the only tenant client: it adds `org_id` to every filter, insert and RPC. Two migrations: `0016` is additive (per-organization RPC overloads, `sim_clock` per organization) and ships before the code; `0017` contracts (drops the old RPCs and the transitional `org_id` defaults) after the code is live.

**Tech Stack:** Next.js 16.3.6 (App Router), `@supabase/supabase-js` 2.x (service role), Node `AsyncLocalStorage`, Postgres (Supabase), PGlite for SQL tests, Vitest, ESLint 9 flat config.

**Spec:** `docs/superpowers/specs/2026-09-27-identity-and-tenancy-design.md` — this plan is rollout step 3 (§10.3), implementing §4.2, §5.2 (`sim_clock`), §5.3, §5.4 (reading), §5.6 Line 1, and §4.4/§4.5's founding-organization bindings. Step 4 (RLS, §5.6 Line 2) is Plan 2b, written after this lands; it plugs a per-request token into the `db()` seam built here.

## Global Constraints

- Read the relevant guide in `node_modules/next/dist/docs/` before writing Next code; this Next version differs from training data (`AGENTS.md`).
- No new dependencies. `npm run verify` (check:lock, typecheck, lint, test) must be green at every commit.
- Migrations are idempotent: `scripts/migrate.ts` re-runs every file each time.
- The founding organization: id `00000000-0000-4000-8000-000000000001`, slug `founding`, ledger key id `9b03458d9a617871`.
- There is no implicit default organization inside the app (§4.2). The only founding bindings are the ones the spec names: the cron (§10.3), the v1 API (§4.5), and — ruled in this plan — the public landing page and the demo reset.
- Human actions record `detail.by = <user id>`, never an email address (§7).
- Never print a secret, a private key, or a token in test output, logs, or commit messages.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Test style: Vitest, `node` environment, real code over mocks; a fake `fetch` under a real supabase-js client is allowed because it asserts on the real requests supabase-js builds.

## Review Focus

1. **Tenant work with no organization in scope** — a child server component, a script started without a slug, `getChainProvider()` on the landing page. Expected: `NoOrgScopeError`, never the environment's secrets or every organization's rows. Pinned by Task 6's "outside a scope" table and Task 3.
2. **An id belonging to another organization** arriving in a form, a URL or an API path (`counterpartyId` in `createInvoiceAction`, `/api/v1/counterparties/[id]`). Expected: treated as not found. Pinned by Task 5's "a lookup by id still carries the organization".
3. **A row that already names a different `org_id`** (a row read elsewhere and spread into an insert). Expected: throw, never silently re-stamp. Pinned by Task 5.
4. **An organization whose secret cannot be decrypted** (wrong master key, moved ciphertext). Expected: pages still render with a warning; signing and transfers fail loudly (§8). Pinned by Task 4 and Task 6.
5. **The deploy window**: old code running against a database with `0016`, and new code before `0017`. Expected: both work, and an old-code append and a new-code append on the founding chain cannot fork it. Pinned by Task 2.

## Rulings made while writing this plan

- **Scope in React Server Components.** `AsyncLocalStorage` does not reach child components React renders after the page function returns. So pages load everything inside `inOrg(...)` and pass values down; `ProductShell` stops fetching (`stats()` fallback removed) and stops calling `getChainProvider()` (it takes `chainModes` as a prop). A miss fails closed with `NoOrgScopeError`.
- **The landing page reads the founding organization**, explicitly, through `withFoundingOrg`. It is the product's public showcase; sandbox organizations' demo data must never inflate its "live" metrics.
- **Retired ledger public keys** (`LEDGER_RETIRED_PUBLIC_KEYS`) apply to the founding organization only. They are public material. Moving them into `orgs.settings` belongs with per-organization key rotation (Plan 3).
- **`allowGeneratedLedgerKey` is false inside every organization's scope**, including in development. An organization signs only with its own persisted key (§5.4).
- **`/api/ledger/verify` becomes member-only**: `?org=<slug>` plus a session. It was public for a single-tenant demo; with several organizations, a public verify endpoint would disclose chain lengths.
- **Scripts that touch tenant data take the organization slug as a required first argument** (`npm run cycle -- founding`). The operator names the organization; nothing defaults.

---

### Task 1: Structural access-gate tests

These pin the Plan 1 access gates before anything moves. They pass on the current code. Each one is proven to bite by breaking it on purpose.

**Files:**
- Create: `tests/access-gates.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `tests/access-gates.test.ts` with describe blocks that Task 7 extends (`"every /o/[slug] page"`, `"every server action"`).

- [ ] **Step 1: Write the tests**

```ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The access gates Plan 1 put in place, pinned as source structure.
 *
 * They are structural on purpose. A layout does not gate its child segments in
 * this Next version, so the only gate is the first thing each page does; a
 * server action is a public POST endpoint, so the only gate is the first thing
 * each action does. Neither is visible to a unit test of the function behind
 * it, and both are one careless edit away from gone.
 */

const ROOT = process.cwd();

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

function rel(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

function read(file: string): string {
  return readFileSync(file, "utf8");
}

/** Names awaited in a block of source, in order: `await foo(` → "foo", `await params` → "params". */
function awaitedNames(source: string): string[] {
  return [...source.matchAll(/await\s+([A-Za-z_$][\w$]*)/g)].map((match) => match[1]);
}

function defaultExportBody(source: string): string {
  const start = source.indexOf("export default async function");
  return start >= 0 ? source.slice(start) : "";
}

/** Each top-level `export async function`, with its text up to the next top-level export. */
function exportedAsyncFunctions(source: string): Array<{ name: string; body: string }> {
  return source.split(/\n(?=export )/).flatMap((part) => {
    const match = /^export async function (\w+)/.exec(part.trimStart());
    return match ? [{ name: match[1], body: part }] : [];
  });
}

const PAGES = walk(path.join(ROOT, "src", "app", "o")).filter((file) => file.endsWith(`${path.sep}page.tsx`));
const ACTION_DIR = path.join(ROOT, "src", "app", "actions");
const ACTION_FILES = readdirSync(ACTION_DIR).filter((name) => name.endsWith(".ts")).map((name) => path.join(ACTION_DIR, name));
const V1_ROUTES = walk(path.join(ROOT, "src", "app", "api", "v1")).filter((file) => file.endsWith(`${path.sep}route.ts`));

describe("every /o/[slug] page", () => {
  it("exists — the list is not empty", () => {
    expect(PAGES.length).toBeGreaterThanOrEqual(7);
  });

  it.each(PAGES.map(rel))("%s awaits its params, then requireMembership, before anything else", (file) => {
    const names = awaitedNames(defaultExportBody(read(path.join(ROOT, file))));
    expect(names.slice(0, 2)).toEqual(["params", "requireMembership"]);
  });

  it.each(PAGES.map(rel))("%s renders per request", (file) => {
    expect(read(path.join(ROOT, file))).toContain('export const dynamic = "force-dynamic"');
  });
});

describe("every server action", () => {
  it("lives in src/app/actions, except the public sign-in action", () => {
    const withDirective = walk(path.join(ROOT, "src")).filter(
      (file) => /\.(ts|tsx)$/.test(file) && /^\s*["']use server["']/.test(read(file))
    );
    const outside = withDirective.map(rel).filter((file) => !file.startsWith("src/app/actions/"));
    expect(outside).toEqual(["src/app/login/actions.ts"]);
  });

  const actions = ACTION_FILES.flatMap((file) =>
    exportedAsyncFunctions(read(file)).map((fn) => ({ label: `${rel(file)} ${fn.name}`, body: fn.body }))
  );

  it("exists — the list is not empty", () => {
    expect(actions.length).toBeGreaterThanOrEqual(5);
  });

  it.each(actions.map((action) => [action.label, action.body]))("%s awaits authorizeMutation first", (_label, body) => {
    expect(awaitedNames(body)[0]).toBe("authorizeMutation");
  });
});

describe("the membership lookup", () => {
  const source = read(path.join(ROOT, "src", "lib", "auth", "membership.ts"));

  it("inner-joins the organization, so filtering by slug drops rows instead of nulling the join", () => {
    // Without `!inner`, `.eq("orgs.slug", slug)` only empties the embedded
    // organization; the membership row still comes back, and a member of one
    // workspace would pass the gate of every other.
    expect(source).toMatch(/const SELECT = "role, orgs!inner\(/);
    expect(source).toContain('.eq("orgs.slug", slug)');
  });
});

describe("every /api/v1 route", () => {
  it.each(V1_ROUTES.map(rel))("%s checks the bearer token before any work", (file) => {
    const source = read(path.join(ROOT, file));
    const handlers = source.split(/\n(?=export async function (?:GET|POST|PUT|PATCH|DELETE)\b)/).slice(1);
    expect(handlers.length).toBeGreaterThan(0);
    for (const handler of handlers) {
      const guard = handler.indexOf("guardApiRequest(");
      expect(guard).toBeGreaterThan(-1);
      const firstWork = Math.min(
        ...[handler.indexOf("await "), handler.indexOf("handleApiRequest(")].filter((index) => index >= 0)
      );
      expect(guard).toBeLessThan(firstWork);
    }
  });
});
```

- [ ] **Step 2: Run them**

Run: `npx vitest run tests/access-gates.test.ts`
Expected: PASS. If a page or action fails, the page is the defect, not the test: move its `requireMembership`/`authorizeMutation` call to the top, and record that in the report.

- [ ] **Step 3: Prove each block bites**

1. In `src/app/o/[slug]/console/page.tsx`, temporarily move `const query = await searchParams;` above `await requireMembership(slug);`. Run the file. Expected: FAIL on the console page. Restore it.
2. In `src/app/actions/agent.ts`, temporarily insert `await Promise.resolve();` as the first line of `runAgentCycleAction`. Expected: FAIL. Restore it.
3. In `src/lib/auth/membership.ts`, temporarily change `orgs!inner(` to `orgs(`. Expected: FAIL. Restore it.

Run `git diff --stat src` afterwards. Expected: no changes under `src`.

- [ ] **Step 4: Commit**

```bash
git add tests/access-gates.test.ts
git commit -m "test(auth): pin the page, action and membership access gates"
```

---

### Task 2: Migration 0016 — per-organization chains and clocks, additive

**Files:**
- Create: `supabase/migrations/0016_org_scoped_rpcs.sql`
- Create: `src/lib/platform/migrations.ts`
- Modify: `scripts/migrate.ts` (use `selectMigrations`)
- Modify: `tests/support/pglite.ts` (add `appendSignedForOrg`)
- Create: `tests/org-chains.test.ts`
- Create: `tests/migrations-select.test.ts`

**Interfaces:**
- Produces, in SQL (PostgREST resolves each by argument names):
  - `append_ledger_entry(p_org_id uuid, p_actor text, p_domain text, p_action text, p_summary text, p_detail jsonb, p_body_hash text, p_signature text, p_signing_key_id text default null) returns ledger_entries`
  - `advance_sim_day(p_org_id uuid) returns integer`
  - `claim_payment_intent(p_org_id uuid, p_idempotency_key text) returns payment_intents`
  - `ledger_entries_for_targets(p_org_id uuid, p_invoice_ids text[] default '{}', p_milestone_ids text[] default '{}') returns setof ledger_entries`
  - `sim_clock` keyed by `org_id` (primary key); the `id` column survives until `0017`.
- Produces, in TypeScript: `selectMigrations(files: string[], through: string | undefined): string[]`, and the test helper `appendSignedForOrg(db, orgId, input, privateKey, signingKeyId?)`.

The old signatures stay in `0016`, so code deployed before this plan keeps working until `0017` removes them. During that window, the new append also takes the old global lock, so an old-code append and a new-code append on the founding chain serialise and cannot fork it (Review Focus 5). `0017` drops that lock.

- [ ] **Step 1: Write the failing migration-selection test**

`tests/migrations-select.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { selectMigrations } from "@/lib/platform/migrations";

const FILES = ["0001_init.sql", "0015_tenancy.sql", "0016_org_scoped_rpcs.sql", "0017_org_scope_contract.sql"];

describe("selectMigrations", () => {
  it("applies everything when no bound is given", () => {
    expect(selectMigrations(FILES, undefined)).toEqual(FILES);
  });

  it("stops after the file the bound names by its number", () => {
    expect(selectMigrations(FILES, "0016")).toEqual(FILES.slice(0, 3));
  });

  it("accepts the full file name as the bound", () => {
    expect(selectMigrations(FILES, "0015_tenancy.sql")).toEqual(FILES.slice(0, 2));
  });

  it("refuses a bound that names no migration, rather than applying everything", () => {
    expect(() => selectMigrations(FILES, "0099")).toThrow(/no migration matches --through 0099/);
  });

  it("refuses a bound that names more than one migration", () => {
    expect(() => selectMigrations(FILES, "001")).toThrow(/matches more than one migration/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/migrations-select.test.ts`
Expected: FAIL — cannot resolve `@/lib/platform/migrations`.

- [ ] **Step 3: Implement `selectMigrations` and use it**

`src/lib/platform/migrations.ts`:

```ts
/**
 * Which migrations `npm run db:migrate` applies. `--through <prefix>` stops
 * after one file, so that an additive migration can go live before the code
 * that needs it, and a contracting one only after that code is deployed.
 */
export function selectMigrations(files: string[], through: string | undefined): string[] {
  const sorted = [...files].sort();
  if (!through) return sorted;
  const matches = sorted.filter((file) => file.startsWith(through));
  if (matches.length === 0) throw new Error(`no migration matches --through ${through}`);
  if (matches.length > 1) throw new Error(`--through ${through} matches more than one migration: ${matches.join(", ")}`);
  return sorted.slice(0, sorted.indexOf(matches[0]) + 1);
}
```

In `scripts/migrate.ts`, add the import next to the others and select the files:

```ts
import { selectMigrations } from "../src/lib/platform/migrations";
```

```ts
function throughArgument(argv: string[]): string | undefined {
  const index = argv.indexOf("--through");
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value) throw new Error("--through needs a migration number, e.g. --through 0016");
  return value;
}
```

Inside `main()`, replace
`const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();`
with
`const files = selectMigrations(readdirSync(dir).filter((f) => f.endsWith(".sql")), throughArgument(process.argv.slice(2)));`
and add `npm run db:migrate -- --through 0016` to the usage comment at the top of the file.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/migrations-select.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Add the PGlite helper**

Append to `tests/support/pglite.ts`:

```ts
/** As `appendSigned`, through the per-organization append that 0016 adds. */
export async function appendSignedForOrg(
  db: PGlite,
  orgId: string,
  input: LedgerEntryInput,
  privateKey: crypto.KeyObject,
  signingKeyId: string | null = ledgerKeyId(privateKey)
): Promise<LedgerRow> {
  const bodyHash = bodyHashOf(input);
  const signature = crypto.sign(null, Buffer.from(bodyHash, "hex"), privateKey).toString("hex");
  const result = await db.query<LedgerRow>(
    "select * from append_ledger_entry($1::uuid, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)",
    [orgId, input.actor, input.domain, input.action, input.summary, JSON.stringify(input.detail), bodyHash, signature, signingKeyId]
  );
  return result.rows[0];
}

/** A second organization, for isolation tests. */
export async function createOrg(db: PGlite, slug: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    "insert into orgs (slug, name, mode) values ($1, $1, 'sandbox') returning id",
    [slug]
  );
  return result.rows[0].id;
}
```

- [ ] **Step 6: Write the failing chain tests**

`tests/org-chains.test.ts`:

```ts
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

  it("leaves the old signature working for the founding clock", async () => {
    const before = (await db.query<{ current_day: number }>("select current_day from sim_clock where org_id = $1", [FOUNDING_ORG_ID])).rows[0].current_day;
    const after = (await db.query<{ d: number }>("select advance_sim_day() as d")).rows[0].d;
    expect(after).toBe(before + 1);
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
    const rows = (await db.query<{ org_id: string }>("select * from ledger_entries_for_targets($1::uuid, array[$2])", [other, target])).rows;
    expect(rows.map((row) => row.org_id)).toEqual([other]);
  });
});

describe("0016 is idempotent", () => {
  it("re-runs without error and without changing any chain", async () => {
    const before = await chainOf(FOUNDING_ORG_ID);
    await applyMigrations(db, THROUGH_0016);
    expect(await chainOf(FOUNDING_ORG_ID)).toEqual(before);
  });
});
```

The `claim_payment_intent` assertion: a `returns public.payment_intents` function that finds no row returns a single row whose columns are all null. The test asserts `id: null` for that reason. If PGlite returns zero rows instead, change that one line to `expect(stolen.rows).toEqual([])` and say so in the report.

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run tests/org-chains.test.ts`
Expected: FAIL — `function append_ledger_entry(uuid, …) does not exist`.

- [ ] **Step 8: Write migration 0016**

`supabase/migrations/0016_org_scoped_rpcs.sql`:

```sql
-- One ledger chain, one simulated clock and one set of payment intents per
-- organization.
--
-- ADDITIVE. Every function gains an overload that takes p_org_id; the old
-- signatures stay so the code deployed before this change keeps working until
-- 0017 removes them. PostgREST resolves an RPC by its argument names, so a
-- call without p_org_id reaches the old function and a call with it reaches
-- the new one; neither can reach the other by accident.
--
-- While both exist, the new append also takes the old global lock. An old
-- deployment appending to the founding chain and a new one appending at the
-- same moment therefore serialise instead of reading the same prev_hash and
-- forking the chain. 0017 drops the global lock with the old function.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

-- ------------------------------------------------------------- sim clock
alter table public.sim_clock
  add column if not exists org_id uuid not null
  default '00000000-0000-4000-8000-000000000001'
  references public.orgs(id) on delete cascade;

do $$
begin
  if exists (
    select 1
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
     where c.conrelid = 'public.sim_clock'::regclass
       and c.contype = 'p'
       and a.attname = 'id'
  ) then
    alter table public.sim_clock drop constraint sim_clock_pkey;
    alter table public.sim_clock add primary key (org_id);
  end if;
end $$;

-- ---------------------------------------------------------------- ledger
create or replace function public.append_ledger_entry(
  p_org_id         uuid,
  p_actor          text,
  p_domain         text,
  p_action         text,
  p_summary        text,
  p_detail         jsonb,
  p_body_hash      text,
  p_signature      text,
  p_signing_key_id text default null
) returns ledger_entries
language plpgsql
as $$
declare
  v_prev_hash text;
  v_hash      text;
  v_row       ledger_entries;
begin
  if p_org_id is null then
    raise exception 'append_ledger_entry: p_org_id is required';
  end if;

  -- TRANSITIONAL (dropped by 0017): the lock the old signature takes.
  perform pg_advisory_xact_lock(hashtext('vestiarion_ledger'));
  perform pg_advisory_xact_lock(hashtext('vestiarion_ledger:' || p_org_id::text));

  select hash into v_prev_hash
    from ledger_entries
   where org_id = p_org_id
   order by seq desc
   limit 1;
  v_prev_hash := coalesce(v_prev_hash, repeat('0', 64));

  v_hash := encode(digest(v_prev_hash || p_body_hash || p_signature, 'sha256'), 'hex');

  insert into ledger_entries (org_id, actor, domain, action, summary, detail,
                              body_hash, signature, prev_hash, hash, signing_key_id)
  values (p_org_id, p_actor, p_domain, p_action, p_summary, coalesce(p_detail, '{}'::jsonb),
          p_body_hash, p_signature, v_prev_hash, v_hash, p_signing_key_id)
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function public.ledger_entries_for_targets(
  p_org_id        uuid,
  p_invoice_ids   text[] default '{}'::text[],
  p_milestone_ids text[] default '{}'::text[]
) returns setof public.ledger_entries
language sql
stable
set search_path = public
as $$
  select entry.*
    from public.ledger_entries entry
   where entry.org_id = p_org_id
     and (entry.detail ->> 'invoiceId' = any(p_invoice_ids)
          or entry.detail ->> 'milestoneId' = any(p_milestone_ids))
   order by entry.seq desc;
$$;

revoke execute on function public.ledger_entries_for_targets(uuid, text[], text[])
  from public, anon, authenticated;
grant execute on function public.ledger_entries_for_targets(uuid, text[], text[])
  to service_role;

-- ----------------------------------------------------------- sim clock rpc
create or replace function public.advance_sim_day(p_org_id uuid) returns integer
language sql
as $$
  insert into public.sim_clock as clock (org_id, current_day)
  values (p_org_id, 1)
  on conflict (org_id) do update set current_day = clock.current_day + 1
  returning current_day;
$$;

-- ------------------------------------------------------- payment intents
create or replace function public.claim_payment_intent(p_org_id uuid, p_idempotency_key text)
returns public.payment_intents
language plpgsql
set search_path = ''
as $$
declare
  claimed public.payment_intents;
begin
  update public.payment_intents
     set status = 'submitting',
         attempt_count = attempt_count + 1,
         last_error = null,
         updated_at = now()
   where org_id = p_org_id
     and idempotency_key = p_idempotency_key
     and (
       status in ('created', 'failed')
       or (status = 'submitting' and updated_at < now() - interval '2 minutes')
     )
  returning * into claimed;

  return claimed;
end;
$$;

revoke execute on function public.claim_payment_intent(uuid, text)
  from public, anon, authenticated;
grant execute on function public.claim_payment_intent(uuid, text)
  to service_role;

-- Rollback (before 0017 only; the old functions are still in place):
-- drop function if exists public.append_ledger_entry(uuid, text, text, text, text, jsonb, text, text, text);
-- drop function if exists public.ledger_entries_for_targets(uuid, text[], text[]);
-- drop function if exists public.advance_sim_day(uuid);
-- drop function if exists public.claim_payment_intent(uuid, text);
-- alter table public.sim_clock drop constraint sim_clock_pkey;
-- alter table public.sim_clock add primary key (id);
-- alter table public.sim_clock drop column org_id;
```

Before running, check the `payment_intents` columns in `supabase/migrations/0004_payment_intents.sql`. The test's insert must name every `not null` column that has no default. Adjust the test's column list if 0004 requires more, and keep the test's intent.

- [ ] **Step 9: Run it to verify it passes**

Run: `npx vitest run tests/org-chains.test.ts tests/tenancy-migration.test.ts tests/ledger-parity.test.ts`
Expected: PASS. The two existing files must stay green; `ledger-parity` still uses the old 8-argument append, which 0016 keeps.

- [ ] **Step 10: Commit**

```bash
git add supabase/migrations/0016_org_scoped_rpcs.sql src/lib/platform/migrations.ts scripts/migrate.ts tests/support/pglite.ts tests/org-chains.test.ts tests/migrations-select.test.ts
git commit -m "feat(db): one ledger chain and one clock per organization (additive 0016)"
```

---

### Task 3: The organization in the context

**Files:**
- Modify: `src/lib/context.ts`
- Modify: `tests/context.test.ts`

**Interfaces:**
- Produces:
  - `interface OrgScope { orgId: string; userId?: string; secretWarnings?: string[] }`
  - `VestiarionContext` gains optional `orgId`, `userId`, `secretWarnings`
  - `createContext(config: VestiarionConfig, scope?: Partial<OrgScope>): VestiarionContext`
  - `runWithConfig<T>(config: VestiarionConfig, fn: () => T, scope?: Partial<OrgScope>): T`
  - `class NoOrgScopeError extends Error` (message `"Tenant data was touched with no organization in scope"`)
  - `currentOrgId(): string` — throws `NoOrgScopeError`
  - `currentUserId(): string | undefined`
  - `currentOrgConfig(): VestiarionConfig` — throws `NoOrgScopeError`; for anything that reads an organization's secrets
  - `currentSecretWarnings(): string[]` — throws `NoOrgScopeError`

- [ ] **Step 1: Write the failing tests**

Append to `tests/context.test.ts`, and add the new names to its import from `@/lib/context`:

```ts
const ORG_A = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const ORG_B = "0b6c1c9e-4a4f-4a7e-9b1e-000000000b0b";

describe("the organization in scope", () => {
  it("is absent outside every scope, and asking for it throws", () => {
    expect(currentContext().orgId).toBeUndefined();
    expect(() => currentOrgId()).toThrow(NoOrgScopeError);
  });

  it("is absent in a scope that names only a configuration", () => {
    runWithConfig(northstar, () => {
      expect(() => currentOrgId()).toThrow("Tenant data was touched with no organization in scope");
    });
  });

  it("is the one the scope names, and the inner scope wins", () => {
    runWithConfig(northstar, () => {
      expect(currentOrgId()).toBe(ORG_A);
      runWithConfig(meridian, () => expect(currentOrgId()).toBe(ORG_B), { orgId: ORG_B });
      expect(currentOrgId()).toBe(ORG_A);
    }, { orgId: ORG_A });
  });

  it("survives awaits without leaking between concurrent scopes", async () => {
    const seen = await Promise.all([
      runWithConfig(northstar, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return currentOrgId();
      }, { orgId: ORG_A }),
      runWithConfig(meridian, async () => currentOrgId(), { orgId: ORG_B }),
    ]);
    expect(seen).toEqual([ORG_A, ORG_B]);
  });

  it("carries the user when one is named", () => {
    runWithConfig(northstar, () => expect(currentUserId()).toBe("user-1"), { orgId: ORG_A, userId: "user-1" });
    runWithConfig(northstar, () => expect(currentUserId()).toBeUndefined(), { orgId: ORG_A });
  });

  it("guards the organization's configuration and its secret warnings", () => {
    expect(() => currentOrgConfig()).toThrow(NoOrgScopeError);
    expect(() => currentSecretWarnings()).toThrow(NoOrgScopeError);
    runWithConfig(northstar, () => {
      expect(currentOrgConfig().businessName).toBe("Northstar Studio");
      expect(currentSecretWarnings()).toEqual(["stored key could not be read"]);
    }, { orgId: ORG_A, secretWarnings: ["stored key could not be read"] });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/context.test.ts`
Expected: FAIL — `currentOrgId` and `NoOrgScopeError` are not exported.

- [ ] **Step 3: Implement**

In `src/lib/context.ts`, replace the `VestiarionContext` interface, `createContext` and `runWithConfig`, and add the new exports below `hasScope`:

```ts
/** Which organization, and for whom, the current work is being done. */
export interface OrgScope {
  orgId: string;
  /** The signed-in person; absent for the cron and for scripts. */
  userId?: string;
  /** Why some of the organization's stored secrets could not be read. */
  secretWarnings?: string[];
}

export interface VestiarionContext {
  config: VestiarionConfig;
  /** Service-role client. Bypasses row-level security; never expose to a browser. */
  db: SupabaseClient;
  /** Absent outside an organization's scope — and then no tenant data may be touched. */
  orgId?: string;
  userId?: string;
  secretWarnings?: string[];
}
```

```ts
export function createContext(config: VestiarionConfig, scope: Partial<OrgScope> = {}): VestiarionContext {
  return { config, db: createDb(config), ...scope };
}
```

```ts
/** Convenience for callers that have a config rather than a built context. */
export function runWithConfig<T>(config: VestiarionConfig, fn: () => T, scope?: Partial<OrgScope>): T {
  return runWith(createContext(config, scope), fn);
}
```

```ts
export class NoOrgScopeError extends Error {
  constructor() {
    super("Tenant data was touched with no organization in scope");
    this.name = "NoOrgScopeError";
  }
}

/**
 * The organization the current work belongs to.
 *
 * There is deliberately no fallback. The ambient, environment-derived context
 * never carries an organization, so tenant data read outside a scope is an
 * error rather than "whichever business the environment describes" — which,
 * with more than one business, is the exact failure that puts one tenant's
 * rows on another's screen.
 */
export function currentOrgId(): string {
  const orgId = storage.getStore()?.orgId;
  if (!orgId) throw new NoOrgScopeError();
  return orgId;
}

export function currentUserId(): string | undefined {
  return storage.getStore()?.userId;
}

/**
 * The configuration of the organization in scope. Anything that reads an
 * organization's secrets — its ledger key, its Circle credentials — reads
 * them through this, so that outside a scope it throws instead of quietly
 * using the environment's.
 */
export function currentOrgConfig(): VestiarionConfig {
  currentOrgId();
  return currentConfig();
}

export function currentSecretWarnings(): string[] {
  currentOrgId();
  return storage.getStore()?.secretWarnings ?? [];
}
```

Update the module's header comment: replace the paragraph starting "A process with no scope entered falls back…". The new text says the ambient fallback still serves platform configuration (LLM, compliance, database URL), but never an organization, and names `currentOrgId()`.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run tests/context.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/context.ts tests/context.test.ts
git commit -m "feat(tenancy): the organization in scope, and an error when there is none"
```

---

### Task 4: Entering an organization's scope

**Files:**
- Create: `src/lib/dal/org-config.ts`
- Create: `src/lib/dal/scope.ts`
- Create: `tests/support/fake-supabase.ts`
- Create: `tests/org-config.test.ts`
- Create: `tests/org-scope.test.ts`

**Interfaces:**
- Consumes: Task 3's `runWith`, `currentContext`, `VestiarionContext`, `OrgScope`; `decryptSecret`, `parseMasterKeys`, `encryptSecret`, `MasterKey`, `SecretEnvelope` from `src/lib/secrets.ts`.
- Produces:
  - `src/lib/dal/org-config.ts`: `FOUNDING_ORG_ID`, `interface OrgRow`, `ORG_SECRET_COLUMNS`, `orgConfig(base: VestiarionConfig, org: OrgRow, keys: MasterKey[] | null): { config: VestiarionConfig; warnings: string[] }`
  - `src/lib/dal/scope.ts`: `orgContext(orgId: string, userId?: string): Promise<VestiarionContext>`, `withOrg<T>(orgId: string, fn: () => Promise<T>, options?: { userId?: string }): Promise<T>`, `withOrgSlug<T>(slug: string, fn: () => Promise<T>): Promise<T>`, `withFoundingOrg<T>(fn: () => Promise<T>): Promise<T>`, `inOrg<T>(access: { user: { id: string }; membership: { orgId: string } }, fn: () => Promise<T>): Promise<T>`
  - `tests/support/fake-supabase.ts`: `fakeSupabase(respond?)` → `{ client, requests }`, `RecordedRequest`, `carriesOrg(request, orgId)`

Task 5 adds `platformDb()` in `src/lib/dal/index.ts`. Here, `scope.ts` reads the `orgs` row through `currentContext().db` directly. Task 5 switches that one call to `platformDb()`.

- [ ] **Step 1: Write the fake-client support file**

`tests/support/fake-supabase.ts`:

```ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * A real supabase-js client whose network is a recorder. Tests assert on the
 * requests supabase-js actually builds — the filters, bodies and RPC
 * arguments PostgREST would receive — rather than on a mock of the builder.
 */

export interface RecordedRequest {
  method: string;
  /** e.g. `/rest/v1/invoices` or `/rest/v1/rpc/append_ledger_entry` */
  path: string;
  params: URLSearchParams;
  body: unknown;
}

export interface FakeReply {
  status?: number;
  body: unknown;
}

export function fakeSupabase(respond: (request: RecordedRequest) => FakeReply = () => ({ body: [] })): {
  client: SupabaseClient;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const recordingFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const raw = init?.body;
    const request: RecordedRequest = {
      method: (init?.method ?? "GET").toUpperCase(),
      path: url.pathname,
      params: url.searchParams,
      body: typeof raw === "string" && raw ? JSON.parse(raw) : undefined,
    };
    requests.push(request);
    const reply = respond(request);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = createClient("https://tests.supabase.invalid", "test-service-role", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: recordingFetch },
  });
  return { client, requests };
}

/** Whether a request names the organization: a filter, a stamped body, or an RPC argument. */
export function carriesOrg(request: RecordedRequest, orgId: string): boolean {
  if (request.path.startsWith("/rest/v1/rpc/")) {
    return (request.body as Record<string, unknown> | undefined)?.p_org_id === orgId;
  }
  if (request.method === "POST") {
    const rows = Array.isArray(request.body) ? request.body : [request.body];
    return rows.length > 0 && rows.every((row) => (row as Record<string, unknown>)?.org_id === orgId);
  }
  return request.params.get("org_id") === `eq.${orgId}`;
}
```

- [ ] **Step 2: Write the failing `orgConfig` tests**

`tests/org-config.test.ts`:

```ts
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { FOUNDING_ORG_ID, orgConfig, type OrgRow } from "@/lib/dal/org-config";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";

const OTHER_ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000beef";
const keys = parseMasterKeys(`t1:${crypto.randomBytes(32).toString("base64")}`);
const strangerKeys = parseMasterKeys(`t9:${crypto.randomBytes(32).toString("base64")}`);
const ledgerPem = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const base = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
  BUSINESS_NAME: "From the environment",
  LEDGER_SIGNING_KEY: "env-ledger-key-must-not-leak",
  LEDGER_PUBLIC_KEY: "env-public-key",
  LEDGER_RETIRED_PUBLIC_KEYS: "-----BEGIN PUBLIC KEY-----\nretired\n-----END PUBLIC KEY-----",
  CIRCLE_API_KEY: "env-circle-key-must-not-leak",
  CIRCLE_ENTITY_SECRET: "env-circle-secret-must-not-leak",
});

function row(orgId: string, sealed: Partial<Record<"ledger" | "apiKey" | "entity", string>> = {}, sealWith = keys, sealFor = orgId): OrgRow {
  const seal = (value: string | undefined, column: string) =>
    value ? encryptSecret(value, { orgId: sealFor, column }, sealWith) : null;
  return {
    id: orgId,
    slug: orgId === FOUNDING_ORG_ID ? "founding" : "northstar",
    name: orgId === FOUNDING_ORG_ID ? "Vestiarion workspace" : "Northstar Studio",
    mode: orgId === FOUNDING_ORG_ID ? "live" : "sandbox",
    ledger_signing_key_enc: seal(sealed.ledger, "ledger_signing_key_enc"),
    circle_api_key_enc: seal(sealed.apiKey, "circle_api_key_enc"),
    circle_entity_secret_enc: seal(sealed.entity, "circle_entity_secret_enc"),
  };
}

describe("orgConfig", () => {
  it("uses the organization's own name and decrypted secrets", () => {
    const { config, warnings } = orgConfig(base, row(OTHER_ORG, { ledger: ledgerPem, apiKey: "org-key", entity: "org-secret" }), keys);
    expect(warnings).toEqual([]);
    expect(config.businessName).toBe("Northstar Studio");
    expect(config.ledgerSigningKey).toBe(ledgerPem);
    expect(config.chain.circleApiKey).toBe("org-key");
    expect(config.chain.circleEntitySecret).toBe("org-secret");
  });

  it("never falls back to the environment's secrets for an organization that has none", () => {
    const { config } = orgConfig(base, row(OTHER_ORG), keys);
    expect(config.ledgerSigningKey).toBeUndefined();
    expect(config.ledgerPublicKey).toBeUndefined();
    expect(config.chain.circleApiKey).toBeUndefined();
    expect(config.chain.circleEntitySecret).toBeUndefined();
    expect(JSON.stringify(config)).not.toContain("must-not-leak");
  });

  it("never lets an organization generate a ledger key on demand", () => {
    expect(orgConfig({ ...base, allowGeneratedLedgerKey: true }, row(OTHER_ORG), keys).config.allowGeneratedLedgerKey).toBe(false);
  });

  it("keeps the platform settings it does not own", () => {
    const { config } = orgConfig(base, row(OTHER_ORG), keys);
    expect(config.database).toEqual(base.database);
    expect(config.llm).toEqual(base.llm);
    expect(config.compliance).toEqual(base.compliance);
    expect(config.clockMode).toBe(base.clockMode);
  });

  it("gives the retired public keys to the founding organization only", () => {
    expect(orgConfig(base, row(FOUNDING_ORG_ID), keys).config.ledgerRetiredPublicKeys).toBe(base.ledgerRetiredPublicKeys);
    expect(orgConfig(base, row(OTHER_ORG), keys).config.ledgerRetiredPublicKeys).toBeUndefined();
  });

  it("reports, and leaves unset, a secret sealed under a master key it does not hold", () => {
    const { config, warnings } = orgConfig(base, row(OTHER_ORG, { ledger: ledgerPem }, strangerKeys), keys);
    expect(config.ledgerSigningKey).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("ledger_signing_key_enc");
    expect(warnings[0]).not.toContain(ledgerPem);
  });

  it("refuses a ciphertext moved from another organization's row", () => {
    const { config, warnings } = orgConfig(base, row(OTHER_ORG, { apiKey: "founding-key" }, keys, FOUNDING_ORG_ID), keys);
    expect(config.chain.circleApiKey).toBeUndefined();
    expect(warnings[0]).toContain("circle_api_key_enc");
  });

  it("reports stored secrets it cannot open because no master key is configured", () => {
    const { config, warnings } = orgConfig(base, row(OTHER_ORG, { ledger: ledgerPem }), null);
    expect(config.ledgerSigningKey).toBeUndefined();
    expect(warnings).toEqual(["ledger_signing_key_enc is stored, but VESTIARION_MASTER_KEYS is not set"]);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run tests/org-config.test.ts`
Expected: FAIL — cannot resolve `@/lib/dal/org-config`.

- [ ] **Step 4: Implement `org-config.ts`**

`src/lib/dal/org-config.ts`:

```ts
import type { VestiarionConfig } from "../config";
import { decryptSecret, type MasterKey, type SecretEnvelope } from "../secrets";

export const FOUNDING_ORG_ID = "00000000-0000-4000-8000-000000000001";

export interface OrgRow {
  id: string;
  slug: string;
  name: string;
  mode: "sandbox" | "live";
  ledger_signing_key_enc: SecretEnvelope | null;
  circle_api_key_enc: SecretEnvelope | null;
  circle_entity_secret_enc: SecretEnvelope | null;
}

export const ORG_SECRET_COLUMNS =
  "id, slug, name, mode, ledger_signing_key_enc, circle_api_key_enc, circle_entity_secret_enc";

type SecretColumn = "ledger_signing_key_enc" | "circle_api_key_enc" | "circle_entity_secret_enc";

/**
 * One organization's configuration: the platform's settings, with the
 * organization's name and its own secrets in place of the environment's.
 *
 * Every organization secret is replaced, never merged. An organization with
 * no Circle credentials gets none — not the platform's — because falling back
 * would let a sandbox move the founding organization's money. A secret that
 * cannot be opened is left unset and reported: reading carries on with a
 * warning, and signing or paying fails loudly for want of the key (§8).
 */
export function orgConfig(
  base: VestiarionConfig,
  org: OrgRow,
  keys: MasterKey[] | null
): { config: VestiarionConfig; warnings: string[] } {
  const warnings: string[] = [];
  const open = (column: SecretColumn): string | undefined => {
    const envelope = org[column];
    if (!envelope) return undefined;
    if (!keys) {
      warnings.push(`${column} is stored, but VESTIARION_MASTER_KEYS is not set`);
      return undefined;
    }
    try {
      return decryptSecret(envelope, { orgId: org.id, column }, keys);
    } catch (error) {
      warnings.push((error as Error).message);
      return undefined;
    }
  };

  return {
    config: {
      ...base,
      businessName: org.name,
      chain: {
        ...base.chain,
        circleApiKey: open("circle_api_key_enc"),
        circleEntitySecret: open("circle_entity_secret_enc"),
      },
      ledgerSigningKey: open("ledger_signing_key_enc"),
      ledgerPublicKey: undefined,
      // Public material, and only the founding chain has ever rotated.
      ledgerRetiredPublicKeys: org.id === FOUNDING_ORG_ID ? base.ledgerRetiredPublicKeys : undefined,
      allowGeneratedLedgerKey: false,
    },
    warnings,
  };
}
```

`decryptSecret`'s error messages name the column and the organization id and never the plaintext. The "moved ciphertext" test depends on that; do not change `secrets.ts`.

- [ ] **Step 5: Run them to verify they pass**

Run: `npx vitest run tests/org-config.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Write the failing scope tests**

`tests/org-scope.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { currentConfig, currentOrgId, currentSecretWarnings, currentUserId, runWith } from "@/lib/context";
import { FOUNDING_ORG_ID } from "@/lib/dal/org-config";
import { inOrg, withFoundingOrg, withOrg, withOrgSlug } from "@/lib/dal/scope";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000beef";
const base = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

function orgRow(id: string, slug: string) {
  return { id, slug, name: `Org ${slug}`, mode: "sandbox", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null };
}

function orgsTable(request: RecordedRequest) {
  if (request.path !== "/rest/v1/orgs") return { body: [] };
  const id = request.params.get("id")?.replace("eq.", "");
  const slug = request.params.get("slug")?.replace("eq.", "");
  if (id === ORG || slug === "northstar") return { body: orgRow(ORG, "northstar") };
  if (id === FOUNDING_ORG_ID) return { body: orgRow(FOUNDING_ORG_ID, "founding") };
  return { status: 406, body: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
}

function inPlatform<T>(fn: () => Promise<T>) {
  const fake = fakeSupabase(orgsTable);
  return { fake, run: () => runWith({ config: base, db: fake.client }, fn) };
}

describe("withOrg", () => {
  it("runs the work inside the organization, with its name as the business name", async () => {
    const { run } = inPlatform(() => withOrg(ORG, async () => [currentOrgId(), currentConfig().businessName, currentUserId()]));
    expect(await run()).toEqual([ORG, "Org northstar", undefined]);
  });

  it("reads the organization's row by id, and nothing else", async () => {
    const { fake, run } = inPlatform(() => withOrg(ORG, async () => null));
    await run();
    expect(fake.requests.map((request) => [request.path, request.params.get("id")])).toEqual([["/rest/v1/orgs", `eq.${ORG}`]]);
  });

  it("carries the user and the secret warnings into the scope", async () => {
    const { run } = inPlatform(() => withOrg(ORG, async () => [currentUserId(), currentSecretWarnings()], { userId: "user-1" }));
    expect(await run()).toEqual(["user-1", []]);
  });

  it("fails for an organization that does not exist, and runs nothing", async () => {
    let ran = false;
    const { run } = inPlatform(() => withOrg("5d0f3a2e-8c1b-4f7a-9e6d-000000000000", async () => { ran = true; }));
    await expect(run()).rejects.toThrow();
    expect(ran).toBe(false);
  });
});

describe("the other ways in", () => {
  it("withOrgSlug resolves the slug", async () => {
    const { run } = inPlatform(() => withOrgSlug("northstar", async () => currentOrgId()));
    expect(await run()).toBe(ORG);
  });

  it("withFoundingOrg names the founding organization", async () => {
    const { run } = inPlatform(() => withFoundingOrg(async () => currentOrgId()));
    expect(await run()).toBe(FOUNDING_ORG_ID);
  });

  it("inOrg takes what requireMembership and authorizeMutation return", async () => {
    const access = { user: { id: "user-2", email: null }, membership: { orgId: ORG } };
    const { run } = inPlatform(() => inOrg(access, async () => [currentOrgId(), currentUserId()]));
    expect(await run()).toEqual([ORG, "user-2"]);
  });
});
```

- [ ] **Step 7: Run them to verify they fail**

Run: `npx vitest run tests/org-scope.test.ts`
Expected: FAIL — cannot resolve `@/lib/dal/scope`.

- [ ] **Step 8: Implement `scope.ts`**

`src/lib/dal/scope.ts`:

```ts
import { currentContext, runWith, type VestiarionContext } from "../context";
import { parseMasterKeys, type MasterKey } from "../secrets";
import { unwrap } from "../supabase";
import { FOUNDING_ORG_ID, ORG_SECRET_COLUMNS, orgConfig, type OrgRow } from "./org-config";

/**
 * How work enters an organization. Every tenant read and write happens inside
 * one of these; outside them, `currentOrgId()` throws.
 *
 * The organization's row is read once per scope and its secrets decrypted into
 * a configuration of its own. Nested scopes are safe: the inner one replaces
 * every organization field, so nothing of the outer organization survives.
 */

/**
 * An unset master key is reported per secret by `orgConfig`, so reading keeps
 * working. A master key that is set but malformed throws: that is a broken
 * deployment, not a missing optional.
 */
function masterKeys(): MasterKey[] | null {
  const raw = process.env.VESTIARION_MASTER_KEYS;
  return raw && raw.trim() ? parseMasterKeys(raw) : null;
}

async function orgRowBy(column: "id" | "slug", value: string): Promise<OrgRow> {
  const result = await currentContext().db.from("orgs").select(ORG_SECRET_COLUMNS).eq(column, value).single<OrgRow>();
  if (result.error?.code === "PGRST116") throw new Error(`No organization with ${column} ${value}`);
  return unwrap(result);
}

function contextFor(org: OrgRow, userId: string | undefined): VestiarionContext {
  const base = currentContext();
  const { config, warnings } = orgConfig(base.config, org, masterKeys());
  return { config, db: base.db, orgId: org.id, userId, secretWarnings: warnings };
}

export async function orgContext(orgId: string, userId?: string): Promise<VestiarionContext> {
  return contextFor(await orgRowBy("id", orgId), userId);
}

export async function withOrg<T>(orgId: string, fn: () => Promise<T>, options: { userId?: string } = {}): Promise<T> {
  return runWith(await orgContext(orgId, options.userId), fn);
}

/** For operators and scripts, which name organizations by slug. */
export async function withOrgSlug<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  return runWith(contextFor(await orgRowBy("slug", slug), undefined), fn);
}

/**
 * The founding organization, for the three places the spec binds to it: the
 * cron (§10.3), the v1 API until scoped keys exist (§4.5), and the public
 * landing page. Nothing else may use it as a default.
 */
export function withFoundingOrg<T>(fn: () => Promise<T>): Promise<T> {
  return withOrg(FOUNDING_ORG_ID, fn);
}

/** What `requireMembership` and a successful `authorizeMutation` return. */
export interface OrgAccess {
  user: { id: string };
  membership: { orgId: string };
}

export function inOrg<T>(access: OrgAccess, fn: () => Promise<T>): Promise<T> {
  return withOrg(access.membership.orgId, fn, { userId: access.user.id });
}
```

- [ ] **Step 9: Run them to verify they pass**

Run: `npx vitest run tests/org-scope.test.ts tests/org-config.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/lib/dal/org-config.ts src/lib/dal/scope.ts tests/support/fake-supabase.ts tests/org-config.test.ts tests/org-scope.test.ts
git commit -m "feat(tenancy): enter an organization's scope with its own decrypted secrets"
```

---

### Task 5: `db()` — the only tenant client

**Files:**
- Create: `src/lib/dal/index.ts`
- Modify: `src/lib/dal/scope.ts` (read `orgs` through `platformDb()`; import `unwrap` from `./index`)
- Create: `tests/dal.test.ts`

**Interfaces:**
- Consumes: `currentContext`, `currentOrgId` (Task 3); `fakeSupabase`, `carriesOrg` (Task 4).
- Produces, from `@/lib/dal`:
  - `TENANT_TABLES` (the 11 tables of spec §5.2 plus `sim_clock`), `type TenantTable`
  - `TENANT_RPCS = ["append_ledger_entry", "advance_sim_day", "claim_payment_intent", "ledger_entries_for_targets"]`, `type TenantRpc`
  - `PLATFORM_TABLES = ["orgs", "memberships", "invitations"]`, `type PlatformTable`
  - `db(): OrgDb` with `orgId`, `from(table: TenantTable)` → `{ select, insert, upsert, update, delete }`, `rpc(name: TenantRpc, args?)`
  - `type OrgDb = ReturnType<typeof db>`
  - `platformDb()` with `from(table: PlatformTable)`
  - `unwrap<T>(result): T` (same behaviour as `src/lib/supabase.ts`'s)

- [ ] **Step 1: Write the failing tests**

`tests/dal.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { NoOrgScopeError, runWith } from "@/lib/context";
import { db, platformDb, TENANT_TABLES } from "@/lib/dal";
import { carriesOrg, fakeSupabase } from "./support/fake-supabase";

const ORG_A = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const ORG_B = "0b6c1c9e-4a4f-4a7e-9b1e-000000000b0b";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

/** `null` means no organization in scope (`undefined` would take the default). */
function scoped<T>(fn: () => Promise<T> | T, orgId: string | null = ORG_A) {
  const fake = fakeSupabase();
  const result = runWith({ config, db: fake.client, orgId: orgId ?? undefined }, async () => fn());
  return { fake, result };
}

describe("db() outside an organization", () => {
  it("throws before any request is made", async () => {
    const { fake, result } = scoped(() => db(), null);
    await expect(result).rejects.toThrow(NoOrgScopeError);
    expect(fake.requests).toEqual([]);
  });
});

describe("db() reads", () => {
  it.each(TENANT_TABLES)("filters %s by the organization", async (table) => {
    const { fake, result } = scoped(async () => db().from(table).select("*"));
    await result;
    expect(fake.requests).toHaveLength(1);
    expect(carriesOrg(fake.requests[0], ORG_A)).toBe(true);
  });

  it("keeps the organization on a lookup by id, so another organization's id finds nothing", async () => {
    const { fake, result } = scoped(async () => db().from("counterparties").select("id, name").eq("id", "someone-elses-id").maybeSingle());
    await result;
    expect(fake.requests[0].params.get("org_id")).toBe(`eq.${ORG_A}`);
    expect(fake.requests[0].params.get("id")).toBe("eq.someone-elses-id");
  });

  it("keeps the organization on a head-only count", async () => {
    const { fake, result } = scoped(async () => db().from("ledger_entries").select("*", { count: "exact", head: true }));
    await result;
    expect(fake.requests[0].method).toBe("HEAD");
    expect(carriesOrg(fake.requests[0], ORG_A)).toBe(true);
  });
});

describe("db() writes", () => {
  it("stamps every inserted row", async () => {
    const { fake, result } = scoped(async () => db().from("invoices").insert([{ amount: "1" }, { amount: "2" }]));
    await result;
    expect(fake.requests[0].body).toEqual([{ amount: "1", org_id: ORG_A }, { amount: "2", org_id: ORG_A }]);
  });

  it("stamps an upsert", async () => {
    const { fake, result } = scoped(async () => db().from("payment_intents").upsert({ idempotency_key: "k" }, { onConflict: "idempotency_key", ignoreDuplicates: true }));
    await result;
    expect(carriesOrg(fake.requests[0], ORG_A)).toBe(true);
  });

  it("refuses a row that already names another organization", async () => {
    const { fake, result } = scoped(async () => db().from("invoices").insert({ amount: "1", org_id: ORG_B }));
    await expect(result).rejects.toThrow(/names a different organization/);
    expect(fake.requests).toEqual([]);
  });

  it("confines an update to the organization and refuses to move a row out of it", async () => {
    const ok = scoped(async () => db().from("invoices").update({ status: "paid" }).eq("id", "i1"));
    await ok.result;
    expect(ok.fake.requests[0].method).toBe("PATCH");
    expect(ok.fake.requests[0].params.get("org_id")).toBe(`eq.${ORG_A}`);
    expect(ok.fake.requests[0].body).toEqual({ status: "paid" });

    const moved = scoped(async () => db().from("invoices").update({ org_id: ORG_B }).eq("id", "i1"));
    await expect(moved.result).rejects.toThrow(/names a different organization/);
  });

  it("confines a delete to the organization", async () => {
    const { fake, result } = scoped(async () => db().from("forecasts").delete().eq("id", "f1"));
    await result;
    expect(fake.requests[0].method).toBe("DELETE");
    expect(carriesOrg(fake.requests[0], ORG_A)).toBe(true);
  });
});

describe("db() RPCs", () => {
  it("passes the organization to every tenant function", async () => {
    const { fake, result } = scoped(async () => db().rpc("claim_payment_intent", { p_idempotency_key: "k" }));
    await result;
    expect(fake.requests[0].path).toBe("/rest/v1/rpc/claim_payment_intent");
    expect(fake.requests[0].body).toEqual({ p_idempotency_key: "k", p_org_id: ORG_A });
  });

  it("does not let a caller pass a different organization", async () => {
    const { fake, result } = scoped(async () => db().rpc("advance_sim_day", { p_org_id: ORG_B }));
    await expect(result).rejects.toThrow(/names a different organization/);
    expect(fake.requests).toEqual([]);
  });
});

describe("the table boundary", () => {
  it("keeps platform tables out of db()", async () => {
    const { result } = scoped(async () => db().from("orgs" as never).select("*"));
    await expect(result).rejects.toThrow(/orgs is not a tenant table/);
  });

  it("keeps tenant tables out of platformDb()", async () => {
    const { result } = scoped(async () => platformDb().from("invoices" as never).select("*"), null);
    await expect(result).rejects.toThrow(/invoices is not a platform table/);
  });

  it("lets platformDb() read platform tables without an organization", async () => {
    const { fake, result } = scoped(async () => platformDb().from("memberships").select("role"), null);
    await result;
    expect(fake.requests[0].path).toBe("/rest/v1/memberships");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/dal.test.ts`
Expected: FAIL — cannot resolve `@/lib/dal`.

- [ ] **Step 3: Implement**

`src/lib/dal/index.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { currentContext, currentOrgId } from "../context";

/**
 * The Data Access Layer: the only way the application reaches tenant data.
 *
 * `db()` is a service-role client narrowed to one organization. Every read,
 * update and delete it builds carries `org_id = <the organization in scope>`,
 * every insert and upsert stamps it, and every tenant RPC receives it as
 * `p_org_id`. A caller cannot widen that: a row or an argument naming another
 * organization is refused, not re-stamped, because it means some other code
 * path already crossed a tenant boundary.
 *
 * `platformDb()` reaches the three tables that exist before any organization
 * is known — organizations, memberships, invitations — and nothing else.
 *
 * ESLint forbids the raw client outside this directory. See eslint.config.mjs.
 */

export const TENANT_TABLES = [
  "accounts", "counterparties", "invoices", "milestones", "treasury_actions", "compliance_checks",
  "forecasts", "ledger_entries", "payment_intents", "cycle_runs", "cycle_snapshots", "sim_clock",
] as const;
export type TenantTable = (typeof TENANT_TABLES)[number];

export const TENANT_RPCS = [
  "append_ledger_entry", "advance_sim_day", "claim_payment_intent", "ledger_entries_for_targets",
] as const;
export type TenantRpc = (typeof TENANT_RPCS)[number];

export const PLATFORM_TABLES = ["orgs", "memberships", "invitations"] as const;
export type PlatformTable = (typeof PLATFORM_TABLES)[number];

type Row = Record<string, unknown>;
type Count = "exact" | "planned" | "estimated";

const CROSSED = "names a different organization than the one in scope";

function refuseOtherOrg(value: unknown, orgId: string, key: "org_id" | "p_org_id"): void {
  if (value && typeof value === "object" && key in value && (value as Row)[key] !== orgId) {
    throw new Error(`A ${key === "org_id" ? "row" : "call"} ${CROSSED}`);
  }
}

function stamp<T extends Row | Row[]>(values: T, orgId: string): T {
  const one = (row: Row): Row => {
    refuseOtherOrg(row, orgId, "org_id");
    return { ...row, org_id: orgId };
  };
  return (Array.isArray(values) ? values.map(one) : one(values)) as T;
}

function tenantTable(client: SupabaseClient, table: TenantTable, orgId: string) {
  const from = () => client.from(table);
  return {
    select: <Q extends string = "*">(columns?: Q, options?: { head?: boolean; count?: Count }) =>
      from().select(columns, options).eq("org_id", orgId),
    insert: (values: Row | Row[], options?: { count?: Count; defaultToNull?: boolean }) =>
      from().insert(stamp(values, orgId), options),
    upsert: (
      values: Row | Row[],
      options?: { onConflict?: string; ignoreDuplicates?: boolean; count?: Count; defaultToNull?: boolean }
    ) => from().upsert(stamp(values, orgId), options),
    update: (values: Row, options?: { count?: Count }) => {
      refuseOtherOrg(values, orgId, "org_id");
      return from().update(values, options).eq("org_id", orgId);
    },
    delete: (options?: { count?: Count }) => from().delete(options).eq("org_id", orgId),
  };
}

export function db() {
  const orgId = currentOrgId();
  const client = currentContext().db;
  return {
    orgId,
    from(table: TenantTable) {
      if (!(TENANT_TABLES as readonly string[]).includes(table)) throw new Error(`${table} is not a tenant table`);
      return tenantTable(client, table, orgId);
    },
    rpc(name: TenantRpc, args: Row = {}, options?: { head?: boolean; get?: boolean; count?: Count }) {
      if (!(TENANT_RPCS as readonly string[]).includes(name)) throw new Error(`${name} is not a tenant function`);
      refuseOtherOrg(args, orgId, "p_org_id");
      return client.rpc(name, { ...args, p_org_id: orgId }, options);
    },
  };
}

export type OrgDb = ReturnType<typeof db>;

export function platformDb() {
  const client = currentContext().db;
  return {
    from(table: PlatformTable) {
      if (!(PLATFORM_TABLES as readonly string[]).includes(table)) throw new Error(`${table} is not a platform table`);
      return client.from(table);
    },
  };
}

/** Throws with the Postgres error message attached, rather than a bare `null`. */
export function unwrap<T>(result: { data: T | null; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  if (result.data === null) throw new Error("Supabase returned no data");
  return result.data;
}
```

In `src/lib/dal/scope.ts`, change the imports to `import { platformDb, unwrap } from "./index";` (drop the `../supabase` import). Change `orgRowBy` to read through `platformDb().from("orgs")` instead of `currentContext().db.from("orgs")`.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run tests/dal.test.ts tests/org-scope.test.ts`
Expected: PASS. Then run `npm run typecheck`. If the generic `select` wrapper does not typecheck against the installed supabase-js, keep the runtime behaviour and adjust only the parameter types. Record what changed in the report.

- [ ] **Step 5: Commit**

```bash
git add src/lib/dal/index.ts src/lib/dal/scope.ts tests/dal.test.ts
git commit -m "feat(dal): db(), the organization-scoped client, and platformDb()"
```

---

### Task 6: Move the library onto the DAL

Mechanical, with three semantic changes: the `sim_clock` reads, the chain provider guard, and the ledger key guard.

**Files:**
- Modify: `src/lib/ledger.ts`, `src/lib/payments.ts`, `src/lib/queries.ts`, `src/lib/insights.ts`, `src/lib/compliance.ts`, `src/lib/milestone-verification.ts`, `src/lib/landing.ts`, `src/lib/seed.ts`, `src/lib/circle/index.ts`, `src/lib/circle/liveProvider.ts`, `src/lib/circle/simulateProvider.ts`, `src/lib/agent/orchestrator.ts`
- Create: `tests/tenant-scope-lib.test.ts`
- Modify: existing tests that call chain-provider or ledger-key functions under `runWithConfig` without an organization (the suite run in Step 5 names them)

**Interfaces:**
- Consumes: `db`, `unwrap`, `OrgDb` from `./dal` (or `../dal`); `currentOrgConfig`, `currentSecretWarnings` (Task 3).
- Produces: `chainModes(): { mode: "live" | "simulate"; earnMode: "live" | "simulate" }` exported from `src/lib/circle/index.ts` (Task 7's pages pass it to `ProductShell`). `CycleContext.db` is typed `OrgDb`.

Transformation rules, applied to every listed file:
1. `import { supabase, unwrap } from "./supabase"` → `import { db, unwrap } from "./dal"` (adjust the relative path; `src/lib/circle/*` and `src/lib/agent/*` use `../dal`).
2. `supabase()` → `db()`. `const db = supabase();` → `const client = db();`, renaming that local's uses in the function. This avoids shadowing. In `orchestrator.ts`, `CycleContext.db` keeps its name and is typed `OrgDb`.
3. RPC calls keep their arguments; `db().rpc` adds `p_org_id`.
4. `sim_clock`:
   - `queries.ts` `stats()`: `db.from("sim_clock").select("current_day").eq("id", 1).single()` becomes `client.from("sim_clock").select("current_day").maybeSingle()`. Read the day as `data?.current_day ?? 0`: an organization that has never run a simulated cycle has no row.
   - `orchestrator.ts`, real clock mode: the same change, `.maybeSingle<{ current_day: number }>()` then `?.current_day ?? 0` (no `unwrap` on a possibly-null row).
   - `seed.ts`: `db.from("sim_clock").update({ current_day: 0 }).eq("id", 1)` becomes `client.from("sim_clock").upsert({ current_day: 0 }, { onConflict: "org_id" })`.
5. `circle/index.ts` `getChainProvider()`: `const config = currentConfig();` becomes `const config = currentOrgConfig();`. Add below it:

```ts
/** What a page shows about payments and yield, computed inside the organization's scope. */
export function chainModes(): { mode: "live" | "simulate"; earnMode: "live" | "simulate" } {
  const provider = getChainProvider();
  return { mode: provider.mode, earnMode: provider.earnMode };
}
```

   Check the `ChainProvider` type's `mode`/`earnMode` member types in `src/lib/circle/types.ts` and use them if they are named types.
6. `ledger.ts`:
   - `ledgerReadKeyring()` and `appendLedgerEntry()` read `currentOrgConfig()` instead of `currentConfig()`.
   - `ledgerReadWarnings()` returns `[...currentSecretWarnings(), ...ledgerReadKeyring().warnings]`.
   - **Remove the `data/` key-file fallback**: the `localLedgerKeys` store, the `data/` branch in `ledgerReadKeyring()`, and the now-unused `fs`/`path` imports and key paths. `appendLedgerEntry()` passes a store that holds nothing and may create nothing:
     ```ts
     /** Organizations sign only with their own persisted key (spec §5.4); a key file on this machine is nobody's. */
     const NO_LOCAL_KEYS: LocalLedgerKeyStore = {
       read: () => null,
       create: () => {
         throw new Error("an organization's ledger key is created with the organization, never on demand");
       },
     };
     ```
     Why: a development checkout has `data/ledger-signing-key.pem`, and without this change any organization lacking a stored key would silently sign with that file. Its entries would be unverifiable anywhere else.
   - Leave the `WeakMap` rotation cache keyed by config. With one config per scope, that means one rotation check per request that appends, which is correct.
7. `landing.ts`: rule 2 only. The founding binding happens at the call site (Task 7).

- [ ] **Step 1: Write the failing test**

`tests/tenant-scope-lib.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { NoOrgScopeError, runWith } from "@/lib/context";
import { getChainProvider } from "@/lib/circle";
import { getInsightsData } from "@/lib/insights";
import { getLandingMetrics } from "@/lib/landing";
import {
  appendLedgerEntry,
  ledgerEntryCount,
  ledgerPublicKeyPem,
  ledgerReadWarnings,
  listLedgerEntries,
  listLedgerEntriesAfter,
  listLedgerEntriesByDomain,
  listLedgerEntriesForTargets,
  listLedgerEntryPage,
  verifyLedger,
} from "@/lib/ledger";
import { latestForecast, listAccounts, listCounterparties, listInvoices, listMilestones, listTreasuryActions, stats } from "@/lib/queries";
import { carriesOrg, fakeSupabase } from "./support/fake-supabase";

/**
 * Every library function that touches tenant data: outside an organization it
 * refuses before any request, and inside one every request it makes names that
 * organization.
 */

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

const READS: Array<[string, () => Promise<unknown>]> = [
  ["listAccounts", () => listAccounts()],
  ["listCounterparties", () => listCounterparties()],
  ["listInvoices", () => listInvoices()],
  ["listMilestones", () => listMilestones()],
  ["listTreasuryActions", () => listTreasuryActions()],
  ["latestForecast", () => latestForecast()],
  ["stats", () => stats()],
  ["listLedgerEntries", () => listLedgerEntries(5)],
  ["listLedgerEntriesAfter", () => listLedgerEntriesAfter(1)],
  ["listLedgerEntriesByDomain", () => listLedgerEntriesByDomain("treasury", 2)],
  ["listLedgerEntriesForTargets", () => listLedgerEntriesForTargets({ invoiceIds: ["i1"] })],
  ["listLedgerEntryPage", () => listLedgerEntryPage({ limit: 10 })],
  ["ledgerEntryCount", () => ledgerEntryCount()],
  ["verifyLedger", () => verifyLedger()],
  ["getInsightsData", () => getInsightsData()],
  ["getLandingMetrics", () => getLandingMetrics()],
];

describe.each(READS)("%s", (_name, read) => {
  it("refuses outside an organization, before any request", async () => {
    const fake = fakeSupabase();
    await expect(runWith({ config, db: fake.client }, read)).rejects.toThrow(NoOrgScopeError);
    expect(fake.requests).toEqual([]);
  });

  it("names the organization on every request it makes", async () => {
    const fake = fakeSupabase();
    await runWith({ config, db: fake.client, orgId: ORG }, read).catch(() => undefined);
    expect(fake.requests.length).toBeGreaterThan(0);
    for (const request of fake.requests) expect(carriesOrg(request, ORG), `${request.method} ${request.path}`).toBe(true);
  });
});

describe("an organization's secrets", () => {
  it("are never read outside its scope", () => {
    runWith({ config, db: fakeSupabase().client }, () => {
      expect(() => getChainProvider()).toThrow(NoOrgScopeError);
      expect(() => ledgerPublicKeyPem()).toThrow(NoOrgScopeError);
      expect(() => ledgerReadWarnings()).toThrow(NoOrgScopeError);
    });
  });

  it("surface a stored secret that could not be read as a ledger warning", () => {
    runWith({ config, db: fakeSupabase().client, orgId: ORG, secretWarnings: ["could not decrypt ledger_signing_key_enc"] }, () => {
      expect(ledgerReadWarnings()).toContain("could not decrypt ledger_signing_key_enc");
    });
  });

  it("make appending fail loudly when the organization has no signing key", async () => {
    const orgConfig = { ...config, ledgerSigningKey: undefined, allowGeneratedLedgerKey: false };
    await expect(
      runWith({ config: orgConfig, db: fakeSupabase().client, orgId: ORG }, () =>
        appendLedgerEntry({ actor: "system", domain: "system", action: "note", summary: "x", detail: {} })
      )
    ).rejects.toThrow();
  });
});
```

The names were checked against `src/lib/queries.ts` and `src/lib/insights.ts` when this plan was written. If one has since changed, use the current name; remove no row.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/tenant-scope-lib.test.ts`
Expected: FAIL — the "refuses outside an organization" rows fail, because `supabase()` falls back to the ambient context. The rows that name the organization also fail, because nothing adds `org_id`.

- [ ] **Step 3: Apply the transformation rules**

Apply rules 1–7 to each listed file, in this order: `ledger.ts`, `payments.ts`, `queries.ts`, `insights.ts`, `compliance.ts`, `milestone-verification.ts`, `landing.ts`, `seed.ts`, `circle/index.ts`, `circle/liveProvider.ts`, `circle/simulateProvider.ts`, `agent/orchestrator.ts`. Afterwards, `grep -rn "supabase()" src/lib` must print only `src/lib/supabase.ts` and nothing else.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/tenant-scope-lib.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite and repair tests that ran without an organization**

Run: `npm test`
Expected: tests that exercise `getChainProvider`, ledger key reads or `appendLedgerEntry` under `runWithConfig(config, fn)` now throw `NoOrgScopeError`. For each one, pass a scope: `runWithConfig(config, fn, { orgId: "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a" })`. Do not weaken any assertion. List every test file changed in the report.

- [ ] **Step 6: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint`
Expected: both exit 0. (`src/app` still calls `supabase()`; Task 7 moves it.)

```bash
git add src/lib tests
git commit -m "refactor(dal): the library reads and writes one organization at a time"
```

---

### Task 7: Enter the organization at every entry point

**Files:**
- Modify: every `src/app/o/[slug]/**/page.tsx` (7 pages)
- Modify: `src/components/vx/Shell.tsx`
- Modify: `src/app/actions/agent.ts`, `src/app/actions/intake.ts`, `src/app/actions/milestones.ts`
- Modify: `src/lib/api/guard.ts` (`handleApiRequest` enters the founding organization)
- Modify: `src/app/api/v1/**/route.ts` (the direct `supabase()` callers move to `db()`)
- Modify: `src/app/api/agent/tick/route.ts`, `src/app/api/agent/reset/route.ts`
- Modify: `src/app/api/ledger/verify/route.ts`, `src/components/VerifyLedgerBadge.tsx`
- Modify: `src/app/page.tsx` (landing)
- Modify: `src/lib/auth/membership.ts` (`platformDb()`)
- Create: `scripts/lib/org-arg.ts`; modify `scripts/run-cycle.ts`, `scripts/seed.ts`, `scripts/status.ts`, `scripts/bootstrap-circle.ts`, `scripts/circle-doctor.ts`, `scripts/guardrail-fixture.ts`, and the matching `package.json` usage comments
- Modify: `tests/access-gates.test.ts`
- Create: `tests/org-arg.test.ts`, `tests/api-founding-scope.test.ts`

**Interfaces:**
- Consumes: `inOrg`, `withFoundingOrg`, `withOrgSlug` (Task 4); `db`, `platformDb`, `unwrap` (Task 5); `chainModes` (Task 6); `requireMembership`, `membershipFor`, `getSessionUser`.
- Produces: `ProductShell` props `day: number`, `clockMode: CycleClockMode`, `lastCycleAt: string | null`, `chainModes: { mode; earnMode }`, all required. `orgSlugFromArgv(argv: string[], usage: string): string`. `GET /api/ledger/verify?org=<slug>`: 401 JSON without a session, 404 JSON for a non-member or unknown slug, else the verification result.

- [ ] **Step 1: Extend the structural tests (failing)**

In `tests/access-gates.test.ts`, add inside `describe("every /o/[slug] page", …)`:

```ts
  it.each(PAGES.map(rel))("%s loads its data inside the organization's scope", (file) => {
    const body = defaultExportBody(read(path.join(ROOT, file)));
    expect(body).toMatch(/const access = await requireMembership\(slug\);/);
    expect(body).toMatch(/return inOrg\(access, async \(\) =>/);
  });
```

inside `describe("every server action", …)`:

```ts
  it.each(actions.map((action) => [action.label, action.body]))("%s does its work inside the organization's scope", (_label, body) => {
    expect(body).toMatch(/return inOrg\(auth, async \(\) =>/);
  });
```

and a new block:

```ts
describe("the entry points bound to the founding organization", () => {
  it("the cron enters it explicitly", () => {
    expect(read(path.join(ROOT, "src", "app", "api", "agent", "tick", "route.ts"))).toContain("withFoundingOrg(");
  });

  it("the ledger verify route checks the session and the membership before verifying", () => {
    const source = read(path.join(ROOT, "src", "app", "api", "ledger", "verify", "route.ts"));
    const session = source.indexOf("getSessionUser(");
    const membership = source.indexOf("membershipFor(");
    const verify = source.indexOf("verifyLedger(");
    expect(session).toBeGreaterThan(-1);
    expect(membership).toBeGreaterThan(session);
    expect(verify).toBeGreaterThan(membership);
  });
});
```

Run: `npx vitest run tests/access-gates.test.ts`
Expected: FAIL on every page, every action, and both founding-binding tests.

- [ ] **Step 2: `ProductShell` stops fetching**

In `src/components/vx/Shell.tsx`:
- Remove the `stats` import and the `fallbackStats` lines.
- Make `day: number`, `clockMode: CycleClockMode`, `lastCycleAt: string | null` required.
- Add `chainModes: { mode: "live" | "simulate"; earnMode: "live" | "simulate" }`.
- Replace `const provider = getChainProvider();` and its uses with `chainModes.mode` / `chainModes.earnMode`.
- Remove the `getChainProvider` import.
- Keep `screeningMode()`: it reads platform configuration, not an organization's.

Then `grep -rn "getChainProvider\|currentConfig\|@/lib/queries\|@/lib/ledger\"" src/components`. Expected: only type imports remain (`import type`).

- [ ] **Step 3: The pages**

In each page under `src/app/o/[slug]/`, change the opening from

```tsx
  const { slug } = await params;
  await requireMembership(slug);
  // …the rest of the body, ending in `return (<ProductShell …>…</ProductShell>);`
```

to

```tsx
  const { slug } = await params;
  const access = await requireMembership(slug);
  return inOrg(access, async () => {
    // …the rest of the body, unchanged, ending in `return (<ProductShell … chainModes={chainModes()}>…</ProductShell>);`
  });
```

Import `inOrg` from `@/lib/dal/scope` and `chainModes` from `@/lib/circle`. Where a page already calls `getChainProvider()`, keep it inside the callback. Every call a page makes to `@/lib/ledger`, `@/lib/queries`, `@/lib/insights`, `@/lib/compliance` or `@/lib/circle` must be inside the callback.

- [ ] **Step 4: The server actions**

In each exported action, keep the guard as the first statement and wrap everything after it:

```ts
  const auth = await authorizeMutation(formData.get("orgSlug"));
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    // …the rest of the action, unchanged
  });
```

`authorizeMutation`'s success branch already returns `{ ok: true, user, membership }`, which satisfies `OrgAccess`. In `intake.ts` and `milestones.ts`, replace `supabase()` with `db()` and import `db, unwrap` from `@/lib/dal`. `createInvoiceAction`'s counterparty lookup now carries the organization, so another organization's `counterpartyId` fails there as not found (Review Focus 2). Keep the existing `catch` that turns the throw into a message.

- [ ] **Step 5: The v1 API, the cron, the reset**

`src/lib/api/guard.ts`, in `handleApiRequest`, change `return NextResponse.json(await handler());` to `return NextResponse.json(await withFoundingOrg(handler));` (import from `../dal/scope`). Update its doc comment to cite spec §4.5: the platform token reads the founding organization only, until Tier 2's scoped keys.

In each `src/app/api/v1/**/route.ts` that imports `supabase`, switch to `db` and `unwrap` from `@/lib/dal`. `/api/v1/counterparties/[id]`'s lookup by id now carries the organization.

`src/app/api/agent/tick/route.ts`: `const result = await withFoundingOrg(() => runAgentCycle());`. Add a comment: step 5 of the spec replaces this with iterating every due organization.

`src/app/api/agent/reset/route.ts`: `await withFoundingOrg(() => seedDatabase());`. The reset guard stays exactly as it is.

- [ ] **Step 6: Write the failing founding-scope test for the API**

`tests/api-founding-scope.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { currentOrgId, runWith } from "@/lib/context";
import { handleApiRequest } from "@/lib/api/guard";
import { FOUNDING_ORG_ID } from "@/lib/dal/org-config";
import { fakeSupabase } from "./support/fake-supabase";

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

describe("handleApiRequest", () => {
  it("runs the handler in the founding organization — the transitional binding of spec §4.5", async () => {
    const fake = fakeSupabase((request) =>
      request.path === "/rest/v1/orgs"
        ? { body: { id: FOUNDING_ORG_ID, slug: "founding", name: "Vestiarion workspace", mode: "live", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null } }
        : { body: [] }
    );
    const response = await runWith({ config, db: fake.client }, () => handleApiRequest("test", async () => ({ orgId: currentOrgId() })));
    expect(await response.json()).toEqual({ orgId: FOUNDING_ORG_ID });
  });
});
```

Run: `npx vitest run tests/api-founding-scope.test.ts`
Expected: PASS after Step 5 (it was written after the change; prove it bites by reverting `withFoundingOrg(handler)` to `handler()` and seeing `NoOrgScopeError` come back as a 500 body, then restore).

- [ ] **Step 7: The ledger verify route and its badge**

`src/app/api/ledger/verify/route.ts`:

```ts
import { NextResponse } from "next/server";
import { membershipFor } from "@/lib/auth/membership";
import { getSessionUser } from "@/lib/auth/session";
import { inOrg } from "@/lib/dal/scope";
import { verifyLedger } from "@/lib/ledger";

export const dynamic = "force-dynamic";

/**
 * Verifies one organization's chain for one of its members. It was public
 * while there was one business; with several, a public endpoint would tell
 * anyone how long each chain is.
 */
export async function GET(request: Request) {
  const slug = new URL(request.url).searchParams.get("org") ?? "";
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in to verify this ledger." }, { status: 401 });
  const membership = await membershipFor(user.id, slug);
  if (!membership) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    return NextResponse.json(await inOrg({ user, membership }, () => verifyLedger()));
  } catch (err) {
    console.error("ledger verification failed", err);
    return NextResponse.json({ error: "The ledger could not be verified." }, { status: 500 });
  }
}
```

The old handler returned the raw error message. The new one logs it and returns a fixed message, matching `handleApiRequest`'s rule that database errors are not echoed.

`src/components/VerifyLedgerBadge.tsx`: add an `orgSlug: string` prop and fetch `` `/api/ledger/verify?org=${encodeURIComponent(orgSlug)}` ``. Pass `orgSlug={slug}` where the audit page renders it.

In `docs/api.md`, update the paragraph about the compatibility route `GET /api/ledger/verify` (near line 135): it is now member-only and takes `?org=<slug>`.

- [ ] **Step 8: The landing page and the membership lookup**

`src/app/page.tsx`: `LiveMetrics` calls `await withFoundingOrg(() => getLandingMetrics())`. Every other use of `getChainProvider()` or ledger functions in the file moves into a `withFoundingOrg` call too, and its value is passed down. `screeningMode()` stays as is.

`src/lib/auth/membership.ts`: replace `supabase()` with `platformDb()`, and import `platformDb, unwrap` from `@/lib/dal`.

- [ ] **Step 9: Scripts name their organization**

`tests/org-arg.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { orgSlugFromArgv } from "../scripts/lib/org-arg";

describe("orgSlugFromArgv", () => {
  it("takes the first positional argument", () => {
    expect(orgSlugFromArgv(["founding"], "npm run cycle -- <org-slug>")).toBe("founding");
  });

  it("ignores flags", () => {
    expect(orgSlugFromArgv(["--verbose", "northstar"], "u")).toBe("northstar");
  });

  it("refuses to run without one, naming the usage", () => {
    expect(() => orgSlugFromArgv([], "npm run cycle -- <org-slug>")).toThrow("Usage: npm run cycle -- <org-slug>");
  });

  it("refuses a slug that could not exist", () => {
    expect(() => orgSlugFromArgv(["Not A Slug"], "u")).toThrow(/not a valid organization slug/);
  });
});
```

`scripts/lib/org-arg.ts`:

```ts
import { isValidSlug } from "../../src/lib/auth/org-paths";

/** Scripts that touch tenant data are told which organization; nothing defaults. */
export function orgSlugFromArgv(argv: string[], usage: string): string {
  const slug = argv.find((arg) => !arg.startsWith("--"));
  if (!slug) throw new Error(`Usage: ${usage}`);
  if (!isValidSlug(slug)) throw new Error(`${slug} is not a valid organization slug`);
  return slug;
}
```

Check that `src/lib/auth/org-paths.ts` has no `server-only` import, so a script can load it. If it has one, move `isValidSlug` into a new `src/lib/auth/slug.ts` that `org-paths.ts` re-exports.

In each of `run-cycle.ts`, `seed.ts`, `status.ts`, `bootstrap-circle.ts`, `circle-doctor.ts` and `guardrail-fixture.ts`:
- wrap the body of `main()` in `await withOrgSlug(orgSlugFromArgv(process.argv.slice(2), "npm run <script> -- <org-slug>"), async () => { … })`;
- replace `supabase()` with `db()` from `../src/lib/dal`;
- in `status.ts`, apply the same `sim_clock` rule 4 as Task 6 to `sim_clock`;
- update the usage line in each header comment.

Run: `npx vitest run tests/org-arg.test.ts`
Expected: FAIL before `org-arg.ts` exists, PASS after.

- [ ] **Step 10: Verify everything**

Run: `npx vitest run tests/access-gates.test.ts` → PASS.
Run: `grep -rn "supabase()" src scripts`. Expected: only `src/lib/supabase.ts`, plus the `createContext(...).db` platform uses in `scripts/org-grant.ts` and `scripts/org-adopt-env.ts`, which stay.
Run: `npm run verify` → exit 0.

- [ ] **Step 11: Check it renders**

Start the dev server with `preview_start` (name from `.claude/launch.json`; if absent, create an entry running `npm run dev` on port 3000). Sign-in is required, so check what can be checked without credentials:
- `/` renders its live metrics with no server error in `preview_logs`;
- `/o/founding/console` redirects to `/login?next=…`;
- `GET /api/ledger/verify?org=founding` without a session returns 401.

Record the results in the report. Signed-in rendering is verified on production in the rollout (Task 10).

- [ ] **Step 12: Commit**

```bash
git add src scripts tests docs/api.md package.json
git commit -m "feat(tenancy): every entry point enters its organization before touching data"
```

---

### Task 8: Only the DAL holds the raw client

**Files:**
- Delete: `src/lib/supabase.ts`
- Modify: `eslint.config.mjs`
- Modify: `tests/context.test.ts` (it imports `supabase` from `@/lib/supabase`)
- Modify: `vitest.config.ts` (coverage `exclude` names `src/lib/supabase.ts`)
- Create: `tests/lint-raw-client.test.ts`

**Interfaces:**
- Consumes: everything above; after Task 7, nothing outside `src/lib/dal` and `src/lib/context.ts` reads `currentContext().db`.
- Produces: the lint rule the spec's §9 "Build-time" test names.

- [ ] **Step 1: Write the failing lint test**

`tests/lint-raw-client.test.ts`:

```ts
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * The spec's build-time proof (§9): code outside the Data Access Layer cannot
 * reach the service-role client, so it cannot read another organization's rows
 * by forgetting a filter.
 */

const FIXTURES: Record<string, string> = {
  "reaches for the context's client": 'import { currentContext } from "@/lib/context";\nexport const leak = () => currentContext().db;\n',
  "builds its own client": 'import { createClient } from "@supabase/supabase-js";\nexport const leak = () => createClient("u", "k");\n',
  "reaches for the context relatively": 'import { createContext } from "../../lib/context";\nexport const leak = createContext;\n',
};

async function restrictedImportMessages(code: string, filePath: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: process.cwd() });
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.filter((message) => message.ruleId === "no-restricted-imports").map((message) => message.message);
}

describe("the raw database client", () => {
  it.each(Object.entries(FIXTURES))("is refused in application code that %s", async (_label, code) => {
    expect(await restrictedImportMessages(code, "src/app/fixture-raw-client.ts")).not.toEqual([]);
  }, 60_000);

  it.each(Object.entries(FIXTURES))("is allowed inside the DAL for code that %s", async (_label, code) => {
    expect(await restrictedImportMessages(code, "src/lib/dal/fixture-raw-client.ts")).toEqual([]);
  }, 60_000);

  it("leaves type-only imports alone", async () => {
    const code = 'import type { SupabaseClient } from "@supabase/supabase-js";\nexport type Client = SupabaseClient;\n';
    expect(await restrictedImportMessages(code, "src/app/fixture-types.ts")).toEqual([]);
  }, 60_000);
});
```

Run: `npx vitest run tests/lint-raw-client.test.ts`
Expected: FAIL — the first three cases report no restricted-import messages.

- [ ] **Step 2: Add the rule**

In `eslint.config.mjs`, add this object to the `defineConfig([...])` array after `...nextTs`:

```js
  {
    // The Data Access Layer is the only code that may hold the service-role
    // client (spec §5.6, Line 1). Everything else goes through db(), which
    // cannot forget an organization.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/dal/**", "src/lib/context.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [
          {
            name: "@supabase/supabase-js",
            importNames: ["createClient"],
            allowTypeImports: true,
            message: "Use db() or platformDb() from @/lib/dal; the raw client can read every organization.",
          },
          {
            name: "@/lib/context",
            importNames: ["currentContext", "createContext"],
            message: "The context's client bypasses organization scoping. Use db() or platformDb() from @/lib/dal.",
          },
        ],
        patterns: [
          {
            group: ["**/context"],
            importNames: ["currentContext", "createContext"],
            message: "The context's client bypasses organization scoping. Use db() or platformDb() from @/lib/dal.",
          },
        ],
      }],
    },
  },
```

- [ ] **Step 3: Delete `src/lib/supabase.ts` and repoint its last users**

- `git rm src/lib/supabase.ts`.
- Any remaining `import … from "./supabase"`, `"../supabase"` or `"@/lib/supabase"` becomes `@/lib/dal` (or the relative path). `unwrap` lives there now.
- In `tests/context.test.ts`, the tests that compare `supabase()` clients compare `currentContext().db` instead; keep what they assert.
- In `vitest.config.ts`, drop `src/lib/supabase.ts` from the coverage `exclude`.

Run: `grep -rn "lib/supabase\"\|/supabase\"" src tests scripts`
Expected: no matches (the `@supabase/…` package imports are not matched by the pattern; if the grep finds them, refine it to `lib/supabase"`).

- [ ] **Step 4: Verify**

Run: `npx vitest run tests/lint-raw-client.test.ts` → PASS.
Run: `npm run verify` → exit 0. `npm run lint` passing means no file under `src` outside the DAL imports the raw client.

- [ ] **Step 5: Commit**

```bash
git add -A eslint.config.mjs src tests vitest.config.ts
git commit -m "build(dal): only the Data Access Layer may hold the raw database client"
```

---

### Task 9: Migration 0017 — contract

It ships in this branch and runs on production only after the new code is live (Task 10).

**Files:**
- Create: `supabase/migrations/0017_org_scope_contract.sql`
- Modify: `tests/org-chains.test.ts` (a `0017` block)
- Modify: `tests/ledger-parity.test.ts` (use `appendSignedForOrg`)
- Modify: `tests/support/pglite.ts` (`appendSigned` documents that it is pre-0017 only)

**Interfaces:**
- Produces: `org_id` without a default on all 12 tenant tables; the old RPC signatures dropped; `append_ledger_entry(p_org_id, …)` taking only the per-organization lock; `sim_clock.id` dropped.

- [ ] **Step 1: Write the failing tests**

Append to `tests/org-chains.test.ts`:

```ts
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
    await appendSignedForOrg(contracted, FOUNDING_ORG_ID, entry("before 0017"), key.privateKey);
    await contracted.query("select advance_sim_day($1::uuid)", [FOUNDING_ORG_ID]);
    await applyMigrations(contracted);
    northstar = await createOrg(contracted, "northstar");
  }, 60_000);

  afterAll(async () => {
    await contracted.close();
  });

  it("no tenant table defaults org_id any more", async () => {
    const rows = (await contracted.query<{ table_name: string; column_default: string | null }>(
      `select table_name, column_default from information_schema.columns
        where table_schema = 'public' and column_name = 'org_id' and table_name = any($1)`,
      [TENANT]
    )).rows;
    expect(rows.map((row) => row.table_name).sort()).toEqual([...TENANT].sort());
    expect(rows.filter((row) => row.column_default !== null)).toEqual([]);
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
    expect(day).toBeGreaterThanOrEqual(2);
  });

  it("gives a new organization its own clock", async () => {
    expect((await contracted.query<{ d: number }>("select advance_sim_day($1::uuid) as d", [northstar])).rows[0].d).toBe(1);
  });

  it("re-runs without error", async () => {
    await applyMigrations(contracted);
    await applyMigrations(contracted);
  });
});
```

Run: `npx vitest run tests/org-chains.test.ts`
Expected: FAIL — `0017` does not exist, so defaults remain and old signatures are still listed.

- [ ] **Step 2: Write migration 0017**

`supabase/migrations/0017_org_scope_contract.sql`:

```sql
-- Contract: every write now names its organization, so the transitional parts
-- of 0015 and 0016 go.
--
-- RUN ONLY AFTER the code that passes p_org_id is live. Before that, this
-- breaks every append, every simulated day and every payment claim.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

drop function if exists public.append_ledger_entry(text, text, text, text, jsonb, text, text, text);
drop function if exists public.advance_sim_day();
drop function if exists public.claim_payment_intent(text);
drop function if exists public.ledger_entries_for_targets(text[], text[]);

-- The per-organization append, without the global lock that protected the
-- deploy window. Two organizations now append concurrently.
create or replace function public.append_ledger_entry(
  p_org_id         uuid,
  p_actor          text,
  p_domain         text,
  p_action         text,
  p_summary        text,
  p_detail         jsonb,
  p_body_hash      text,
  p_signature      text,
  p_signing_key_id text default null
) returns ledger_entries
language plpgsql
as $$
declare
  v_prev_hash text;
  v_hash      text;
  v_row       ledger_entries;
begin
  if p_org_id is null then
    raise exception 'append_ledger_entry: p_org_id is required';
  end if;

  perform pg_advisory_xact_lock(hashtext('vestiarion_ledger:' || p_org_id::text));

  select hash into v_prev_hash
    from ledger_entries
   where org_id = p_org_id
   order by seq desc
   limit 1;
  v_prev_hash := coalesce(v_prev_hash, repeat('0', 64));

  v_hash := encode(digest(v_prev_hash || p_body_hash || p_signature, 'sha256'), 'hex');

  insert into ledger_entries (org_id, actor, domain, action, summary, detail,
                              body_hash, signature, prev_hash, hash, signing_key_id)
  values (p_org_id, p_actor, p_domain, p_action, p_summary, coalesce(p_detail, '{}'::jsonb),
          p_body_hash, p_signature, v_prev_hash, v_hash, p_signing_key_id)
  returning * into v_row;

  return v_row;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'accounts', 'counterparties', 'invoices', 'milestones', 'treasury_actions', 'compliance_checks',
    'forecasts', 'ledger_entries', 'payment_intents', 'cycle_runs', 'cycle_snapshots', 'sim_clock'
  ]
  loop
    execute format('alter table public.%I alter column org_id drop default', t);
  end loop;
end $$;

alter table public.sim_clock drop column if exists id;

-- Rollback (restores the defaults and the old signatures; run before reverting the code):
-- do $$ declare t text; begin foreach t in array array['accounts','counterparties','invoices','milestones',
--   'treasury_actions','compliance_checks','forecasts','ledger_entries','payment_intents','cycle_runs',
--   'cycle_snapshots','sim_clock'] loop execute format('alter table public.%I alter column org_id set default '
--   '''00000000-0000-4000-8000-000000000001''', t); end loop; end $$;
-- then re-create the four old functions from 0014 (append), 0001 (advance_sim_day), 0004 (claim) and 0007 (targets).
```

- [ ] **Step 3: Move the parity test to the per-organization append**

In `tests/ledger-parity.test.ts`, which applies every migration, replace each `appendSigned(db, …)` with `appendSignedForOrg(db, FOUNDING_ORG_ID, …)` (import both from `./support/pglite`). Keep every argument after `db`, and keep every assertion. Its chain queries read the whole table, which only ever holds the founding organization's rows, so they stay as they are.

In `tests/support/pglite.ts`, add a line to `appendSigned`'s doc comment: it calls the pre-0017 signature and is for tests of migrations before 0017 only.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/org-chains.test.ts tests/ledger-parity.test.ts tests/tenancy-migration.test.ts`
Expected: PASS.
Run: `npm run verify` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0017_org_scope_contract.sql tests/org-chains.test.ts tests/ledger-parity.test.ts tests/support/pglite.ts
git commit -m "feat(db): drop the transitional org defaults and the unscoped RPCs (0017)"
```

---

### Task 10: Documentation and the rollout record

**Files:**
- Modify: `docs/api.md` ("gap-free `seq`" → monotonic with gaps; continuity is proven by hash links — spec §5.3)
- Modify: `README.md`:
  - `LEDGER_SIGNING_KEY`, `LEDGER_PUBLIC_KEY`, `CIRCLE_API_KEY` and `CIRCLE_ENTITY_SECRET` are read by the app only through `org:adopt-env`; organizations read theirs from `orgs`.
  - `VESTIARION_MASTER_KEYS` is required wherever the app runs.
  - Scripts take `-- <org-slug>`.
  - `db:migrate -- --through`.
- Modify: `docs/superpowers/specs/2026-09-27-identity-and-tenancy-design.md` §10 step 3 — add the shipped record *after* production is measured (below).

**Interfaces:** none.

- [ ] **Step 1: Update `docs/api.md` and `README.md` as listed, then commit**

```bash
git add docs/api.md README.md
git commit -m "docs: per-organization data access, secrets and scripts"
```

- [ ] **Step 2: Rollout. The controller runs it with the human partner after the pull request is approved. It is not part of any subagent's task.**

1. **Before anything:** the partner confirms `VESTIARION_MASTER_KEYS` is set for Production on Vercel. Without it, the founding organization cannot open its ledger key, and every cycle fails loudly.
2. `npm run db:migrate -- --through 0016` against production. Verify with SQL: `sim_clock` has `org_id` as its primary key and the founding row kept its `current_day`; each of the four functions has two signatures.
3. Merge (the partner's explicit word), then wait for the Vercel deployment to be Ready.
4. Measure on production. The partner signs in; I verify through the API, the database and the GitHub workflow:
   - the console, invoices and audit pages render for the owner;
   - a UI cycle completes, and its ledger entries carry `org_id` = founding;
   - `workflow_dispatch` of `agent-cycle.yml` succeeds and the ledger height grows;
   - `/api/v1/status` returns 200 with `businessName` "Vestiarion workspace";
   - `/api/ledger/verify?org=founding` returns `valid: true` for the owner and 404 for the non-member account `liohio3012@gmail.com`;
   - signed out, it returns 401.
5. `npm run db:migrate` (through 0017). Repeat step 4's cycle and verify checks.
6. The partner removes `LEDGER_SIGNING_KEY`, `LEDGER_PUBLIC_KEY`, `CIRCLE_API_KEY` and `CIRCLE_ENTITY_SECRET` from Vercel and redeploys. Measure:
   - `/api/v1/status` still reports `payments: "live"`, so Circle credentials come from `orgs`;
   - a cycle's new entries carry `signing_key_id = 9b03458d9a617871`;
   - the ledger stays `valid: true`.
7. Record the outcome under §10 step 3 of the spec, in the style of step 2's record, then commit it on `main` via a docs pull request.
