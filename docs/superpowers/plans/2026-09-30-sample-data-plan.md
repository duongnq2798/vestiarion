# Sample Data Loader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One click fills a simulated sandbox with example counterparties, invoices and milestones that make one agent cycle show every outcome; a second click removes exactly those rows.

**Architecture:** A `sample` flag on `counterparties` (migration 0034) marks what was loaded; invoices and milestones are sample through their counterparty and leave with it through the existing `on delete cascade`. `src/lib/sample-data.ts` holds the fixture and the load/remove logic, run inside the workspace's scope through the tenant client. Server actions gate on `records.write`; the console renders an offer card or a "loaded" callout; go-live refuses to connect Circle while sample data exists.

**Tech Stack:** Next.js 16 (App Router, server actions), Supabase/PostgREST via supabase-js, Postgres migrations, Vitest (+ PGlite for migrations, `tests/support/fake-supabase.ts` for library code), React server rendering tests with `renderToStaticMarkup`.

**Spec:** `docs/superpowers/specs/2026-09-30-sample-data-design.md`

## Global Constraints

- Read the relevant guide in `node_modules/next/dist/docs/` before writing Next.js code (AGENTS.md); this Next.js differs from training data.
- Sample counterparties are fictional and have no address (S6). Every outcome must come from invoice facts and limits, never from the watchlist.
- Loading is refused unless `orgs.mode = 'sandbox'`, `orgs.wallet_host is null` and no Circle API key is stored (S1).
- Connecting Circle and choosing a hosted wallet are refused while any sample counterparty exists, with exactly: `Remove the sample data first. It exists only to try the agent with simulated payments.`
- `/api/v1` payloads do not change (S7); no changelog entry.
- Ledger actions: `system/sample_data_loaded` and `system/sample_data_removed`, `actor: "human"`, detail holds ids and counts only (`by`, counts). Never emails or names of people.
- Product copy names "Arc testnet" plainly; no "fictional money"/"not real" disclaimers.
- Every exported server action awaits `authorize(...)` first and does its work inside `inOrg(auth, …)` (`tests/access-gates.test.ts` enforces this).
- UI uses only `src/components/ui/*` primitives for interactive elements and design tokens for colour (`tests/ui-consistency.test.ts`).
- Commit messages are neutral project history, and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Subagents never touch production (no `db:migrate`, no probes against the live database).
- Run the full suite with `npm run verify` before the final commit of each task that changes types shared with other files; single test files with `npx vitest run tests/<file>`.

## Review Focus

1. **A cycle starting during removal** — removal checks for a running cycle and in-flight intents first; a cycle that starts between the check and the delete could write an intent for a sample invoice that the cascade then orphans. Expect the removal to delete intents *before* counterparties and to refuse when any intent is `submitting` or `pending` (Task 2 tests pin the order and the refusal).
2. **Double-click on "Load sample data"** — two concurrent loads must not produce two sets. Expect the second to fail on the partial unique index and to answer "Sample data is already loaded." (Task 1 PGlite test pins the index; Task 2 pins the error mapping.)
3. **A load that fails halfway** — counterparties inserted, invoices refused. Expect the just-inserted counterparties to be deleted before the error surfaces, so a retry works (Task 2 pins the compensating delete by id).
4. **A person adds their own counterparty named like a sample one** — the index covers sample rows only, so a real "Northwind Hosting" must still insert, and the checklist must count it (Task 1 and Task 4 pin both).
5. **A hosted or connected sandbox** — the offer card must not show, and the server must refuse even if the form is posted directly (Task 2 pins the server refusal; Task 6 pins the card's visibility condition).

---

### Task 1: Migration 0034 — `counterparties.sample` and one sample set per workspace

**Files:**
- Create: `supabase/migrations/0034_sample_data.sql`
- Test: `tests/sample-data-migration.test.ts`

**Interfaces:**
- Produces: column `public.counterparties.sample boolean not null default false`; unique index `counterparties_one_sample_set` on `(org_id, name) where sample`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/sample-data-migration.test.ts
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asTenant, createDatabase, createOrg } from "./support/pglite";

/**
 * Migration 0034: `counterparties.sample` marks a counterparty loaded as an
 * example (sample-data design S2), and a partial unique index allows one
 * sample set per workspace (S3). The loader and the removal run as the tenant
 * role, so it must be able to insert and delete sample rows of its own
 * organization, and the removal's cascade must take the invoices and
 * milestones with them.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
}, 60_000);

afterAll(async () => {
  await db.close();
});

const insertSample = (orgId: string, name: string) =>
  asTenant(db, orgId, (tx) =>
    tx.query<{ id: string }>(
      "insert into public.counterparties (name, role, chain, sample) values ($1, 'vendor', 'ARC-TESTNET', true) returning id",
      [name]
    )
  );

describe("counterparties.sample (0034)", () => {
  it("is a boolean, not null, false by default", async () => {
    const column = await db.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
      "select data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = 'counterparties' and column_name = 'sample'"
    );
    expect(column.rows).toEqual([{ data_type: "boolean", is_nullable: "NO", column_default: "false" }]);

    const orgId = await createOrg(db, "sample-default");
    const row = await asTenant(db, orgId, (tx) =>
      tx.query<{ sample: boolean }>("insert into public.counterparties (name, role) values ('Acme', 'vendor') returning sample")
    );
    expect(row.rows).toEqual([{ sample: false }]);
  });

  it("refuses a second sample counterparty with the same name in the same workspace", async () => {
    const orgId = await createOrg(db, "sample-twice");
    await insertSample(orgId, "Northwind Hosting");
    await expect(insertSample(orgId, "Northwind Hosting")).rejects.toThrow(/counterparties_one_sample_set/);
  });

  it("allows the same sample name in another workspace, and a person's own counterparty of that name", async () => {
    const first = await createOrg(db, "sample-a");
    const second = await createOrg(db, "sample-b");
    await insertSample(first, "Northwind Hosting");
    await expect(insertSample(second, "Northwind Hosting")).resolves.toBeDefined();
    const own = await asTenant(db, first, (tx) =>
      tx.query<{ id: string }>("insert into public.counterparties (name, role) values ('Northwind Hosting', 'vendor') returning id")
    );
    expect(own.rows).toHaveLength(1);
  });

  it("lets the tenant delete its sample counterparties, taking their invoices and milestones with them", async () => {
    const orgId = await createOrg(db, "sample-remove");
    const vendor = (await insertSample(orgId, "Kestrel Print Co")).rows[0].id;
    const contractor = (
      await asTenant(db, orgId, (tx) =>
        tx.query<{ id: string }>(
          "insert into public.counterparties (name, role, sample) values ('Priya Shah — Backend Contractor', 'contractor', true) returning id"
        )
      )
    ).rows[0].id;
    await asTenant(db, orgId, async (tx) => {
      await tx.query(
        "insert into public.invoices (direction, counterparty_id, amount, due_date) values ('payable', $1, 180, now())",
        [vendor]
      );
      await tx.query("insert into public.milestones (contractor_id, title, amount) values ($1, 'API module', 1200)", [contractor]);
    });

    const removed = await asTenant(db, orgId, (tx) =>
      tx.query<{ id: string }>("delete from public.counterparties where sample returning id")
    );
    expect(removed.rows).toHaveLength(2);

    const left = await db.query<{ invoices: number; milestones: number }>(
      "select (select count(*)::int from public.invoices where org_id = $1) as invoices, (select count(*)::int from public.milestones where org_id = $1) as milestones",
      [orgId]
    );
    expect(left.rows).toEqual([{ invoices: 0, milestones: 0 }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/sample-data-migration.test.ts`
Expected: FAIL — `column "sample" of relation "counterparties" does not exist`.

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/0034_sample_data.sql
-- Sample data (docs/superpowers/specs/2026-09-30-sample-data-design.md).
--
-- A counterparty loaded as an example is marked, so removing the sample removes
-- exactly what was loaded (S2). Its invoices, milestones and compliance checks
-- are sample because it is, and leave with it through the existing cascades.
-- Additive: the default keeps every existing counterparty a real one, and code
-- that does not know the column never reads it.
--
-- Grants: 0018 grants vestiarion_tenant select, insert, update and delete on
-- counterparties at table level, which covers the new column.
alter table public.counterparties add column if not exists sample boolean not null default false;

-- One sample set per workspace (S3): a second load, however concurrent, fails
-- on the counterparty insert instead of doubling the sample. A person's own
-- counterparty is outside the index, so any name stays free for real use.
create unique index if not exists counterparties_one_sample_set
  on public.counterparties (org_id, name)
  where sample;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/sample-data-migration.test.ts tests/composite-fks.test.ts tests/rls.test.ts`
Expected: PASS (the last two confirm the new column breaks no existing migration assertion).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0034_sample_data.sql tests/sample-data-migration.test.ts
git commit -m "Mark sample counterparties and allow one sample set per workspace"
```

---

### Task 2: `src/lib/sample-data.ts` — the fixture, loading and removal

**Files:**
- Create: `src/lib/sample-data.ts`
- Test: `tests/sample-data.test.ts`

**Interfaces:**
- Consumes: migration 0034 (Task 1); `CYCLE_IN_PROGRESS_MS` from `src/lib/agent/balances.ts`; `db`, `platformDb`, `unwrap` from `src/lib/dal`; `currentOrgId` from `src/lib/context`; `appendLedgerEntryBestEffort(orgId, entry)` from `src/lib/ledger-best-effort.ts`.
- Produces:
  - `type SampleKey = "northwind" | "harbor" | "kestrel" | "lumen" | "priya" | "diego"`
  - `sampleFixture(now: Date): SampleFixture`
  - `interface SampleDataCounts { counterparties: number; invoices: number; milestones: number }`
  - `loadSampleData(input: { actorId: string; now?: Date }): Promise<SampleDataCounts>` — must run inside an organization scope
  - `removeSampleData(input: { actorId: string }): Promise<SampleDataCounts & { paymentIntents: number }>` — must run inside an organization scope
  - `hasSampleData(): Promise<boolean>` — must run inside an organization scope
  - `class SampleDataError extends Error { code: SampleDataErrorCode }` with codes `not_sandbox | connected | already_loaded | not_loaded | cycle_running | payment_in_flight`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/sample-data.test.ts
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import { hasSampleData, loadSampleData, removeSampleData, SampleDataError, sampleFixture } from "@/lib/sample-data";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * `src/lib/sample-data.ts` against a real supabase-js client whose network is
 * a recorder, inside a real organization scope with a real ledger key, as
 * tests/counterparty-limit.test.ts does.
 */

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000a5a5";
const ACTOR = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000a5";
const NOW = new Date("2026-09-30T12:00:00.000Z");

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

const MASTER_KEYS = `t1:${crypto.randomBytes(32).toString("base64")}`;
const LEDGER_PEM = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const savedMasterKeys = process.env.VESTIARION_MASTER_KEYS;
beforeEach(() => {
  process.env.VESTIARION_MASTER_KEYS = MASTER_KEYS;
});
afterEach(() => {
  if (savedMasterKeys === undefined) delete process.env.VESTIARION_MASTER_KEYS;
  else process.env.VESTIARION_MASTER_KEYS = savedMasterKeys;
});

interface OrgState {
  mode: "sandbox" | "live";
  wallet_host: "own" | "hosted" | null;
  api_key_iv: string | null;
}

function orgRow(state: OrgState) {
  return {
    id: ORG,
    slug: "northstar",
    name: "Northstar",
    mode: state.mode,
    wallet_host: state.wallet_host,
    api_key_iv: state.api_key_iv,
    ledger_signing_key_enc: encryptSecret(LEDGER_PEM, { orgId: ORG, column: "ledger_signing_key_enc" }, parseMasterKeys(MASTER_KEYS)),
    circle_api_key_enc: null,
    circle_entity_secret_enc: null,
  };
}

const LEDGER_REPLY: FakeReply = {
  body: {
    seq: 1, id: "e1", ts: "2026-09-30T00:00:00Z", actor: "human", domain: "system", action: "x",
    summary: "", detail: {}, body_hash: "00", signature: "00", prev_hash: null, hash: "00", signing_key_id: null,
  },
};

function sampleFake(options: {
  org?: Partial<OrgState>;
  counterpartyInsert?: (request: RecordedRequest) => FakeReply | undefined;
  invoiceInsert?: (request: RecordedRequest) => FakeReply | undefined;
  sampleCounterparties?: Array<{ id: string }>;
  invoices?: Array<{ id: string }>;
  milestones?: Array<{ id: string }>;
  intents?: Array<{ id: string; status: string }>;
  runningCycles?: Array<{ id: string }>;
} = {}) {
  const org: OrgState = { mode: "sandbox", wallet_host: null, api_key_iv: null, ...options.org };
  const fake = fakeSupabase((request) => {
    const { path, method } = request;
    if (path === "/rest/v1/orgs") return { body: orgRow(org) };
    if (path === "/rest/v1/cycle_runs") return { body: options.runningCycles ?? [] };
    if (path === "/rest/v1/counterparties" && method === "POST") {
      const custom = options.counterpartyInsert?.(request);
      if (custom) return custom;
      const rows = request.body as Array<{ name: string }>;
      return { status: 201, body: rows.map((row, index) => ({ id: `cp-${index}`, name: row.name })) };
    }
    if (path === "/rest/v1/counterparties" && method === "GET") return { body: options.sampleCounterparties ?? [] };
    if (path === "/rest/v1/counterparties" && method === "DELETE") return { body: options.sampleCounterparties ?? [] };
    if (path === "/rest/v1/invoices" && method === "POST") return options.invoiceInsert?.(request) ?? { status: 201, body: null };
    if (path === "/rest/v1/invoices" && method === "GET") return { body: options.invoices ?? [] };
    if (path === "/rest/v1/milestones" && method === "POST") return { status: 201, body: null };
    if (path === "/rest/v1/milestones" && method === "GET") return { body: options.milestones ?? [] };
    if (path === "/rest/v1/payment_intents" && method === "GET") return { body: options.intents ?? [] };
    if (path === "/rest/v1/payment_intents" && method === "DELETE") return { body: null };
    if (path === "/rest/v1/rpc/append_ledger_entry") return LEDGER_REPLY;
    throw new Error(`unexpected request ${method} ${path}`);
  });
  return { fake, run: <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, fn)) };
}

const requestsTo = (requests: RecordedRequest[], path: string, method: string) =>
  requests.filter((request) => request.path === path && request.method === method);
const ledgerBodies = (requests: RecordedRequest[]) =>
  requestsTo(requests, "/rest/v1/rpc/append_ledger_entry", "POST").map((request) => request.body as Record<string, unknown>);

async function refusal(work: Promise<unknown>): Promise<SampleDataError> {
  const error = await work.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(SampleDataError);
  return error as SampleDataError;
}

describe("sampleFixture", () => {
  const fixture = sampleFixture(NOW);

  it("has six fictional counterparties with no address, and limits on everyone the agent pays", () => {
    expect(fixture.counterparties.map((row) => row.name)).toEqual([
      "Northwind Hosting",
      "Harbor Office Supply",
      "Kestrel Print Co",
      "Lumen Retail Co",
      "Priya Shah — Backend Contractor",
      "Diego Ramirez — Design Contractor",
    ]);
    for (const row of fixture.counterparties) {
      expect(row).not.toHaveProperty("address");
      if (row.role !== "client") expect(row.limit).toBeGreaterThan(0);
    }
  });

  it("stays inside the 10,000 USDC a new sandbox starts with", () => {
    const outgoing =
      fixture.invoices.filter((row) => row.direction === "payable" && row.status !== "paid").reduce((sum, row) => sum + row.amount, 0) +
      fixture.milestones.reduce((sum, row) => sum + row.amount, 0);
    expect(outgoing).toBeLessThan(10_000);
  });

  it("dates everything from the moment it is loaded", () => {
    const due = (memo: string, status?: string) =>
      fixture.invoices.find((row) => row.memo === memo && row.status === status)?.due_date;
    expect(due("Hosting — September")).toBe("2026-10-03T12:00:00.000Z");
    expect(due("Brochure print run", "paid")).toBe("2026-09-10T12:00:00.000Z");
    expect(due("Brochure print run")).toBe("2026-10-02T12:00:00.000Z");
  });

  it("sets up each outcome from the invoice facts and the limits alone", () => {
    const byMemo = (memo: string) => fixture.invoices.filter((row) => row.memo === memo);
    // Paid: a full three-way match under the limit.
    expect(byMemo("Hosting — September")[0]).toMatchObject({ counterparty: "northwind", amount: 240, po_reference: "PO-1042", goods_received: true });
    // Awaiting information: no purchase order, nothing received.
    expect(byMemo("Bandwidth overage")[0]).toMatchObject({ po_reference: null, goods_received: false });
    // Held: over Harbor's 500 limit.
    expect(byMemo("Standing desks")[0]).toMatchObject({ counterparty: "harbor", amount: 1200 });
    expect(fixture.counterparties.find((row) => row.key === "harbor")?.limit).toBe(500);
    // Flagged: the same purchase order and amount as one already paid.
    const [paid, repeat] = byMemo("Brochure print run");
    expect(paid).toMatchObject({ status: "paid", po_reference: "PO-3307", amount: 180 });
    expect(repeat).toMatchObject({ po_reference: "PO-3307", amount: 180 });
    expect(repeat.status).toBeUndefined();
    // Milestones: one verified to release, one waiting.
    expect(fixture.milestones.map((row) => [row.contractor, row.verified])).toEqual([["priya", true], ["diego", false]]);
  });
});

describe("loadSampleData", () => {
  it("inserts marked counterparties, then their invoices and milestones by id, and records counts only", async () => {
    const { fake, run } = sampleFake();

    const counts = await run(() => loadSampleData({ actorId: ACTOR, now: NOW }));

    expect(counts).toEqual({ counterparties: 6, invoices: 6, milestones: 2 });
    const [counterparties] = requestsTo(fake.requests, "/rest/v1/counterparties", "POST");
    const rows = counterparties.body as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.sample).toBe(true);
      expect(row.chain).toBe("ARC-TESTNET");
      expect(row.payment_limit).toBe(row.baseline_payment_limit);
      expect(row).not.toHaveProperty("address");
    }
    const [invoices] = requestsTo(fake.requests, "/rest/v1/invoices", "POST");
    const invoiceRows = invoices.body as Array<Record<string, unknown>>;
    expect(invoiceRows).toHaveLength(6);
    // Harbor is the second counterparty inserted, so its invoice points at the id the insert returned for it.
    expect(invoiceRows.find((row) => row.memo === "Standing desks")?.counterparty_id).toBe("cp-1");
    expect(invoiceRows.every((row) => !("counterparty" in row))).toBe(true);
    const [milestones] = requestsTo(fake.requests, "/rest/v1/milestones", "POST");
    expect((milestones.body as Array<Record<string, unknown>>).map((row) => row.contractor_id)).toEqual(["cp-4", "cp-5"]);

    const [entry] = ledgerBodies(fake.requests);
    expect(entry.p_action).toBe("sample_data_loaded");
    expect(entry.p_domain).toBe("system");
    expect(entry.p_actor).toBe("human");
    expect(entry.p_detail).toEqual({ by: ACTOR, counterparties: 6, invoices: 6, milestones: 2 });
  });

  it.each([
    [{ mode: "live" as const }, "not_sandbox"],
    [{ wallet_host: "hosted" as const }, "connected"],
    [{ wallet_host: "own" as const }, "connected"],
    [{ api_key_iv: "iv-1" }, "connected"],
  ])("refuses a workspace that is %j, before writing anything", async (org, code) => {
    const { fake, run } = sampleFake({ org });

    const error = await refusal(run(() => loadSampleData({ actorId: ACTOR, now: NOW })));

    expect(error.code).toBe(code);
    expect(fake.requests.filter((request) => request.method !== "GET" && request.path !== "/rest/v1/orgs")).toEqual([]);
  });

  it("answers already_loaded when the one-sample-set index refuses the insert", async () => {
    const { fake, run } = sampleFake({
      counterpartyInsert: () => ({
        status: 409,
        body: { code: "23505", message: 'duplicate key value violates unique constraint "counterparties_one_sample_set"', details: null, hint: null },
      }),
    });

    const error = await refusal(run(() => loadSampleData({ actorId: ACTOR, now: NOW })));

    expect(error.code).toBe("already_loaded");
    expect(error.message).toBe("Sample data is already loaded.");
    expect(ledgerBodies(fake.requests)).toEqual([]);
  });

  it("removes the counterparties it just inserted when the invoices are refused, then reports the failure", async () => {
    const { fake, run } = sampleFake({
      invoiceInsert: () => ({ status: 400, body: { code: "23514", message: "invoices_status_check", details: null, hint: null } }),
    });

    await expect(run(() => loadSampleData({ actorId: ACTOR, now: NOW }))).rejects.toThrow("invoices_status_check");

    const [cleanup] = requestsTo(fake.requests, "/rest/v1/counterparties", "DELETE");
    expect(cleanup.params.get("id")).toBe("in.(cp-0,cp-1,cp-2,cp-3,cp-4,cp-5)");
    expect(ledgerBodies(fake.requests)).toEqual([]);
  });
});

describe("removeSampleData", () => {
  it("deletes the sample obligations' payment intents, then the sample counterparties, and records counts only", async () => {
    const { fake, run } = sampleFake({
      sampleCounterparties: [{ id: "cp-0" }, { id: "cp-1" }],
      invoices: [{ id: "inv-0" }],
      milestones: [{ id: "ms-0" }],
      intents: [{ id: "pi-0", status: "confirmed" }],
    });

    const result = await run(() => removeSampleData({ actorId: ACTOR }));

    expect(result).toEqual({ counterparties: 2, invoices: 1, milestones: 1, paymentIntents: 1 });
    const [intentLookup] = requestsTo(fake.requests, "/rest/v1/payment_intents", "GET");
    expect(intentLookup.params.get("source_id")).toBe("in.(inv-0,ms-0)");
    const deletes = fake.requests.filter((request) => request.method === "DELETE").map((request) => request.path);
    // Intents first: once the counterparties go, nothing would name those intents any more.
    expect(deletes).toEqual(["/rest/v1/payment_intents", "/rest/v1/counterparties"]);
    const [counterpartyDelete] = requestsTo(fake.requests, "/rest/v1/counterparties", "DELETE");
    expect(counterpartyDelete.params.get("sample")).toBe("eq.true");

    const [entry] = ledgerBodies(fake.requests);
    expect(entry.p_action).toBe("sample_data_removed");
    expect(entry.p_detail).toEqual({ by: ACTOR, counterparties: 2, invoices: 1, milestones: 1, paymentIntents: 1 });
  });

  it("skips the intent delete when no sample obligation has one", async () => {
    const { fake, run } = sampleFake({ sampleCounterparties: [{ id: "cp-0" }] });

    await run(() => removeSampleData({ actorId: ACTOR }));

    expect(requestsTo(fake.requests, "/rest/v1/payment_intents", "GET")).toEqual([]);
    expect(requestsTo(fake.requests, "/rest/v1/payment_intents", "DELETE")).toEqual([]);
  });

  it("refuses when there is nothing to remove", async () => {
    const { run } = sampleFake();
    expect((await refusal(run(() => removeSampleData({ actorId: ACTOR })))).code).toBe("not_loaded");
  });

  it("refuses while a cycle is running, and deletes nothing", async () => {
    const { fake, run } = sampleFake({ sampleCounterparties: [{ id: "cp-0" }], runningCycles: [{ id: "run-1" }] });

    const error = await refusal(run(() => removeSampleData({ actorId: ACTOR })));

    expect(error.code).toBe("cycle_running");
    expect(fake.requests.filter((request) => request.method === "DELETE")).toEqual([]);
    const [lookup] = requestsTo(fake.requests, "/rest/v1/cycle_runs", "GET");
    expect(lookup.params.get("status")).toBe("eq.running");
    expect(lookup.params.get("started_at")).toMatch(/^gt\./);
  });

  it.each(["submitting", "pending"])("refuses while a sample payment is %s, and deletes nothing", async (status) => {
    const { fake, run } = sampleFake({
      sampleCounterparties: [{ id: "cp-0" }],
      invoices: [{ id: "inv-0" }],
      intents: [{ id: "pi-0", status }],
    });

    expect((await refusal(run(() => removeSampleData({ actorId: ACTOR })))).code).toBe("payment_in_flight");
    expect(fake.requests.filter((request) => request.method === "DELETE")).toEqual([]);
  });
});

describe("hasSampleData", () => {
  it("asks for one sample counterparty", async () => {
    const loaded = sampleFake({ sampleCounterparties: [{ id: "cp-0" }] });
    await expect(loaded.run(() => hasSampleData())).resolves.toBe(true);
    const [lookup] = requestsTo(loaded.fake.requests, "/rest/v1/counterparties", "GET");
    expect(lookup.params.get("sample")).toBe("eq.true");
    expect(lookup.params.get("limit")).toBe("1");

    await expect(sampleFake().run(() => hasSampleData())).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sample-data.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/sample-data"`.

- [ ] **Step 3: Write the module**

```ts
// src/lib/sample-data.ts
import { CYCLE_IN_PROGRESS_MS } from "./agent/balances";
import { currentOrgId } from "./context";
import { db, platformDb, unwrap } from "./dal";
import { appendLedgerEntryBestEffort } from "./ledger-best-effort";

/**
 * Sample data (docs/superpowers/specs/2026-09-30-sample-data-design.md): one
 * click fills a simulated sandbox with example counterparties, invoices and
 * milestones chosen so that one cycle shows every outcome, and a second click
 * removes exactly those rows. Every export that touches the database runs
 * inside an organization scope.
 *
 * Only counterparties carry the `sample` mark (S2): an invoice or milestone is
 * sample because its counterparty is, and leaves with it through the
 * `on delete cascade` the tables already have. Payment intents name their
 * invoice or milestone without a foreign key, so removal deletes them first.
 *
 * Sample data lives only where payments are simulated (S1). A sample
 * counterparty has no address, and a workspace that holds Circle credentials
 * pays for real whatever its mode, so loading is refused unless the workspace
 * is a sandbox that has neither connected Circle nor chosen a hosted wallet,
 * and go-live refuses to connect while sample data exists (`hasSampleData`).
 */

export type SampleDataErrorCode = "not_sandbox" | "connected" | "already_loaded" | "not_loaded" | "cycle_running" | "payment_in_flight";

const MESSAGES: Record<SampleDataErrorCode, string> = {
  not_sandbox: "Sample data can only be loaded into a sandbox workspace.",
  connected: "This workspace pays through Circle, so it cannot hold sample data: sample data is only for trying the agent with simulated payments.",
  already_loaded: "Sample data is already loaded.",
  not_loaded: "There is no sample data to remove.",
  cycle_running: "A cycle is running. Try again in a minute, once it has finished.",
  payment_in_flight: "A payment to a sample counterparty is still being sent. Try again in a minute.",
};

export class SampleDataError extends Error {
  constructor(readonly code: SampleDataErrorCode) {
    super(MESSAGES[code]);
    this.name = "SampleDataError";
  }
}

export type SampleKey = "northwind" | "harbor" | "kestrel" | "lumen" | "priya" | "diego";

export interface SampleFixture {
  counterparties: Array<{ key: SampleKey; name: string; role: "vendor" | "client" | "contractor"; limit: number | null }>;
  invoices: Array<{
    counterparty: SampleKey;
    direction: "payable" | "receivable";
    amount: number;
    memo: string;
    po_reference: string | null;
    goods_received: boolean;
    due_date: string;
    status?: "paid";
    decided_at?: string;
    settled_at?: string;
    agent_reasoning?: string;
  }>;
  milestones: Array<{
    contractor: SampleKey;
    title: string;
    amount: number;
    verification_source: string;
    verified: boolean;
    status: "verified" | "pending";
    verification_method: "seed";
    verification_status: "verified" | "unverified";
    verified_at?: string;
    verification_detail: { sample: true };
  }>;
}

export interface SampleDataCounts {
  counterparties: number;
  invoices: number;
  milestones: number;
}

const DAY_MS = 86_400_000;

/**
 * The rows to insert, dated from `now` (spec §3). Every outcome follows from
 * the invoice facts and the limits alone, never from the watchlist, so the
 * sample behaves the same whether screening is bundled or OpenSanctions (S6).
 * Amounts fit inside the 10,000 simulated USDC every new sandbox starts with.
 */
export function sampleFixture(now: Date): SampleFixture {
  const at = (days: number) => new Date(now.getTime() + days * DAY_MS).toISOString();
  return {
    counterparties: [
      { key: "northwind", name: "Northwind Hosting", role: "vendor", limit: 2000 },
      { key: "harbor", name: "Harbor Office Supply", role: "vendor", limit: 500 },
      { key: "kestrel", name: "Kestrel Print Co", role: "vendor", limit: 1500 },
      { key: "lumen", name: "Lumen Retail Co", role: "client", limit: null },
      { key: "priya", name: "Priya Shah — Backend Contractor", role: "contractor", limit: 4000 },
      { key: "diego", name: "Diego Ramirez — Design Contractor", role: "contractor", limit: 2500 },
    ],
    invoices: [
      // Paid: a full three-way match, well under the limit.
      { counterparty: "northwind", direction: "payable", amount: 240, memo: "Hosting — September", po_reference: "PO-1042", goods_received: true, due_date: at(3) },
      // Awaiting information: no purchase order and nothing received.
      { counterparty: "northwind", direction: "payable", amount: 95, memo: "Bandwidth overage", po_reference: null, goods_received: false, due_date: at(4) },
      // Held: a clean invoice over Harbor's 500 USDC limit.
      { counterparty: "harbor", direction: "payable", amount: 1200, memo: "Standing desks", po_reference: "PO-2210", goods_received: true, due_date: at(6) },
      // History for the next row: already paid, last month.
      {
        counterparty: "kestrel",
        direction: "payable",
        amount: 180,
        memo: "Brochure print run",
        po_reference: "PO-3307",
        goods_received: true,
        due_date: at(-20),
        status: "paid",
        decided_at: at(-21),
        settled_at: at(-20),
        agent_reasoning: "Sample history: paid last month against PO-3307.",
      },
      // Flagged: the same purchase order and amount as the paid invoice above.
      { counterparty: "kestrel", direction: "payable", amount: 180, memo: "Brochure print run", po_reference: "PO-3307", goods_received: true, due_date: at(2) },
      // Money coming in, for the forecast.
      { counterparty: "lumen", direction: "receivable", amount: 3000, memo: "Q4 platform retainer", po_reference: "SO-771", goods_received: true, due_date: at(10) },
    ],
    milestones: [
      {
        contractor: "priya",
        title: "API rate-limiting module shipped",
        amount: 1200,
        verification_source: "timesheet:kimai",
        verified: true,
        status: "verified",
        verification_method: "seed",
        verification_status: "verified",
        verified_at: at(0),
        verification_detail: { sample: true },
      },
      {
        contractor: "diego",
        title: "Landing page redesign — milestone 2",
        amount: 900,
        verification_source: "timesheet:kimai",
        verified: false,
        status: "pending",
        verification_method: "seed",
        verification_status: "unverified",
        verification_detail: { sample: true },
      },
    ],
  };
}

async function requireSimulatedSandbox(orgId: string): Promise<void> {
  const org = unwrap(
    await platformDb().from("orgs").select("mode, wallet_host, api_key_iv:circle_api_key_enc->>iv").eq("id", orgId).single()
  ) as { mode: "sandbox" | "live"; wallet_host: "own" | "hosted" | null; api_key_iv: string | null };
  if (org.mode !== "sandbox") throw new SampleDataError("not_sandbox");
  if (org.wallet_host !== null || org.api_key_iv !== null) throw new SampleDataError("connected");
}

function isSampleSetClash(error: { code?: string; message: string }): boolean {
  return error.code === "23505" && error.message.includes("counterparties_one_sample_set");
}

export async function loadSampleData(input: { actorId: string; now?: Date }): Promise<SampleDataCounts> {
  const orgId = currentOrgId();
  await requireSimulatedSandbox(orgId);
  const fixture = sampleFixture(input.now ?? new Date());

  // One statement, so the counterparties arrive together or not at all (S3).
  const inserted = await db()
    .from("counterparties")
    .insert(
      fixture.counterparties.map((row) => ({
        name: row.name,
        role: row.role,
        chain: "ARC-TESTNET",
        payment_limit: row.limit,
        baseline_payment_limit: row.limit,
        sample: true,
      }))
    )
    .select("id, name");
  if (inserted.error) {
    if (isSampleSetClash(inserted.error)) throw new SampleDataError("already_loaded");
    throw new Error(inserted.error.message);
  }
  const rows = inserted.data as Array<{ id: string; name: string }>;
  const idOf = (key: SampleKey): string => {
    const name = fixture.counterparties.find((row) => row.key === key)?.name;
    const match = rows.find((row) => row.name === name);
    if (!match) throw new Error(`sample data: no counterparty inserted for ${key}`);
    return match.id;
  };

  try {
    const invoices = await db()
      .from("invoices")
      .insert(fixture.invoices.map(({ counterparty, ...invoice }) => ({ ...invoice, counterparty_id: idOf(counterparty) })));
    if (invoices.error) throw new Error(invoices.error.message);
    const milestones = await db()
      .from("milestones")
      .insert(fixture.milestones.map(({ contractor, ...milestone }) => ({ ...milestone, contractor_id: idOf(contractor) })));
    if (milestones.error) throw new Error(milestones.error.message);
  } catch (error) {
    // Half a sample would block the next load on the index while showing no outcomes;
    // taking the counterparties back (their cascades take anything inserted) leaves nothing behind.
    const cleanup = await db().from("counterparties").delete().in("id", rows.map((row) => row.id));
    if (cleanup.error) console.error("sample data: cleanup after a failed load failed", orgId, cleanup.error.message);
    throw error;
  }

  const counts: SampleDataCounts = {
    counterparties: rows.length,
    invoices: fixture.invoices.length,
    milestones: fixture.milestones.length,
  };
  await appendLedgerEntryBestEffort(orgId, {
    actor: "human",
    domain: "system",
    action: "sample_data_loaded",
    summary: `Sample data loaded: ${counts.counterparties} counterparties, ${counts.invoices} invoices and ${counts.milestones} milestones`,
    detail: { by: input.actorId, ...counts },
  });
  return counts;
}

export async function removeSampleData(input: { actorId: string }): Promise<SampleDataCounts & { paymentIntents: number }> {
  const orgId = currentOrgId();
  const running = unwrap(
    await db()
      .from("cycle_runs")
      .select("id")
      .eq("status", "running")
      .gt("started_at", new Date(Date.now() - CYCLE_IN_PROGRESS_MS).toISOString())
      .limit(1)
  ) as Array<{ id: string }>;
  if (running.length > 0) throw new SampleDataError("cycle_running");

  const counterparties = unwrap(await db().from("counterparties").select("id").eq("sample", true)) as Array<{ id: string }>;
  if (counterparties.length === 0) throw new SampleDataError("not_loaded");
  const counterpartyIds = counterparties.map((row) => row.id);

  const invoices = unwrap(await db().from("invoices").select("id").in("counterparty_id", counterpartyIds)) as Array<{ id: string }>;
  const milestones = unwrap(await db().from("milestones").select("id").in("contractor_id", counterpartyIds)) as Array<{ id: string }>;
  const sources = [...invoices, ...milestones].map((row) => row.id);

  const intents =
    sources.length === 0
      ? []
      : (unwrap(await db().from("payment_intents").select("id, status").in("source_id", sources)) as Array<{ id: string; status: string }>);
  if (intents.some((intent) => intent.status === "submitting" || intent.status === "pending")) {
    throw new SampleDataError("payment_in_flight");
  }
  if (intents.length > 0) {
    const deleted = await db().from("payment_intents").delete().in("id", intents.map((intent) => intent.id));
    if (deleted.error) throw new Error(deleted.error.message);
  }

  const removed = unwrap(await db().from("counterparties").delete().eq("sample", true).select("id")) as Array<{ id: string }>;
  const result = {
    counterparties: removed.length,
    invoices: invoices.length,
    milestones: milestones.length,
    paymentIntents: intents.length,
  };
  await appendLedgerEntryBestEffort(orgId, {
    actor: "human",
    domain: "system",
    action: "sample_data_removed",
    summary: `Sample data removed: ${result.counterparties} counterparties, with ${result.invoices} invoices and ${result.milestones} milestones`,
    detail: { by: input.actorId, ...result },
  });
  return result;
}

/** Whether any sample counterparty exists in the workspace in scope. */
export async function hasSampleData(): Promise<boolean> {
  const rows = unwrap(await db().from("counterparties").select("id").eq("sample", true).limit(1)) as Array<{ id: string }>;
  return rows.length > 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/sample-data.test.ts`
Expected: PASS. If the fake's DELETE reply for counterparties needs `select("id")` rows, it already returns `sampleCounterparties`.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add src/lib/sample-data.ts tests/sample-data.test.ts
git commit -m "Load and remove a workspace's sample data"
```

---

### Task 3: Go-live refuses to connect Circle while sample data exists

**Files:**
- Modify: `src/lib/platform/go-live.ts` (error codes near line 57; `connectCircle` near line 259; `chooseHostedWallet` near line 516)
- Test: `tests/go-live-lib.test.ts`

**Interfaces:**
- Consumes: `hasSampleData()` from `src/lib/sample-data.ts` (Task 2); `inScopeOf(orgId, actorId, fn)` already in go-live.ts.
- Produces: `GoLiveErrorCode` gains `"sample_data_loaded"` with message `Remove the sample data first. It exists only to try the agent with simulated payments.`

- [ ] **Step 1: Teach the test fake about counterparties, and write the failing tests**

In `tests/go-live-lib.test.ts`, add `sampleLoaded?: boolean` to `interface State` (after `wentLive`), and in `database()` add this branch before the final `throw`:

```ts
    if (request.path === "/rest/v1/counterparties" && request.method === "GET") {
      return { body: state.sampleLoaded ? [{ id: "cp-sample" }] : [] };
    }
```

Then add inside `describe("connectCircle", …)`:

```ts
  it("refuses while sample data is loaded, before asking Circle anything", async () => {
    const state = sandbox();
    state.sampleLoaded = true;
    const { fake, inScope } = database(state);
    const fakeCircle = circle();

    const error = await refusal(
      inScope(() => connectCircle({ orgId: ORG, actorId: ACTOR, apiKey: API_KEY, entitySecret: ENTITY_SECRET, client: fakeCircle.factory }))
    );

    expect(error.code).toBe("sample_data_loaded");
    expect(error.message).toBe("Remove the sample data first. It exists only to try the agent with simulated payments.");
    expect(fakeCircle.listWalletSets).not.toHaveBeenCalled();
    expect(orgPatches(fake)).toEqual([]);
    const [lookup] = fake.requests.filter((request) => request.path === "/rest/v1/counterparties");
    expect(lookup.params.get("sample")).toBe("eq.true");
  });
```

and inside `describe("chooseHostedWallet", …)`:

```ts
    it("refuses while sample data is loaded, and never calls choose_hosted_wallet", async () => {
      const state = sandbox();
      state.sampleLoaded = true;
      const { fake, inScope } = database(state, { platform: hostedConfig });

      const error = await refusal(inScope(() => chooseHostedWallet({ orgId: ORG, actorId: ACTOR })));

      expect(error.code).toBe("sample_data_loaded");
      expect(rpcCalls(fake)).toEqual([]);
      expect(state.org.wallet_host).toBeNull();
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/go-live-lib.test.ts`
Expected: the two new tests FAIL (no refusal); all others PASS.

- [ ] **Step 3: Implement**

In `src/lib/platform/go-live.ts`:

1. Add the import: `import { hasSampleData } from "../sample-data";`
2. Add `| "sample_data_loaded"` to `GoLiveErrorCode`, and to `MESSAGES`:
   ```ts
   sample_data_loaded: "Remove the sample data first. It exists only to try the agent with simulated payments.",
   ```
3. In `connectCircle`, directly after `if (!validSecret(apiKey) || !validSecret(entitySecret)) throw new GoLiveError("invalid");`:
   ```ts
   // A sample counterparty has no address: with credentials stored, the agent would try to pay it for real (sample-data S1).
   if (await inScopeOf(input.orgId, input.actorId, hasSampleData)) throw new GoLiveError("sample_data_loaded");
   ```
4. In `chooseHostedWallet`, directly after `if (!platform.available) throw new GoLiveError("hosted_unavailable");`:
   ```ts
   if (await inScopeOf(input.orgId, input.actorId, hasSampleData)) throw new GoLiveError("sample_data_loaded");
   ```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/go-live-lib.test.ts tests/go-live-actions.test.ts tests/go-live-panel.test.tsx`
Expected: PASS. The actions test maps `GoLiveError` messages generically; if it enumerates codes exhaustively, add `sample_data_loaded` to its list.

- [ ] **Step 5: Commit**

```bash
git add src/lib/platform/go-live.ts tests/go-live-lib.test.ts
git commit -m "Refuse to connect Circle while sample data is loaded"
```

---

### Task 4: The Get started checklist ignores sample rows

**Files:**
- Modify: `src/lib/queries.ts:40-73` (`CounterpartyRow`, `listCounterparties`)
- Modify: `src/lib/getting-started.ts`
- Modify: `src/app/o/[slug]/console/page.tsx` (the `checklist` line)
- Test: `tests/getting-started.test.ts`, `tests/getting-started-ui.test.tsx`

**Interfaces:**
- Consumes: column `counterparties.sample` (Task 1).
- Produces:
  - `CounterpartyRow.sample: boolean`
  - `GettingStartedInput.counterparties: Array<{ address: string | null; sample?: boolean }>`
  - `ownInvoiceCount(invoices: Array<{ counterparty_id: string }>, counterparties: Array<{ id: string; sample?: boolean }>): number`

- [ ] **Step 1: Write the failing tests**

Append to `tests/getting-started.test.ts` (it already defines `input(...)`, `done(...)` and `ADDRESS`; import `ownInvoiceCount` alongside `gettingStarted`):

```ts
describe("sample rows (sample-data design §1)", () => {
  it("does not tick the counterparty step for a sample counterparty, even one given an address", () => {
    expect(done(gettingStarted(input({ counterparties: [{ address: ADDRESS, sample: true }] }))).counterparty).toBe(false);
    expect(done(gettingStarted(input({ counterparties: [{ address: ADDRESS, sample: true }, { address: ADDRESS, sample: false }] }))).counterparty).toBe(true);
  });

  it("counts only the invoices of counterparties a person added", () => {
    const counterparties = [
      { id: "own", sample: false },
      { id: "sample-1", sample: true },
    ];
    expect(ownInvoiceCount([{ counterparty_id: "sample-1" }, { counterparty_id: "sample-1" }], counterparties)).toBe(0);
    expect(ownInvoiceCount([{ counterparty_id: "sample-1" }, { counterparty_id: "own" }], counterparties)).toBe(1);
    // A counterparty the page does not know (deleted meanwhile) is not a sample one.
    expect(ownInvoiceCount([{ counterparty_id: "gone" }], counterparties)).toBe(1);
  });
});
```

In `tests/getting-started-ui.test.tsx`, replace the expectation in "uses the rows the console already reads, with no extra query" with:

```ts
    expect(page).toContain(
      "gettingStarted({ mode: access.membership.mode, accounts: accountsRows, counterparties, invoiceCount: ownInvoiceCount(invoices, counterparties) })"
    );
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/getting-started.test.ts tests/getting-started-ui.test.tsx`
Expected: FAIL — `ownInvoiceCount` is not exported; the sample counterparty ticks the step; the console string differs.

- [ ] **Step 3: Implement**

`src/lib/queries.ts` — add to `CounterpartyRow` after `address_confirmed_at`:

```ts
  /** Loaded as sample data (0034): an example, removed with the rest of the sample. */
  sample: boolean;
```

and in `listCounterparties`'s mapping add `sample: r.sample === true,`.

`src/lib/getting-started.ts`:
- change `counterparties: Array<{ address: string | null }>;` to `counterparties: Array<{ address: string | null; sample?: boolean }>;`
- change the counterparty step's `done` to `input.counterparties.some((counterparty) => !counterparty.sample && Boolean(counterparty.address)),`
- add a sentence to the module comment: `Sample rows (sample-data design §1) never tick a step: they show the agent working, not the workspace set up.`
- add below `gettingStarted`:

```ts
/**
 * The invoices of counterparties a person added: sample invoices do not count
 * towards "Add an invoice". Computed from the rows the console already reads.
 */
export function ownInvoiceCount(
  invoices: Array<{ counterparty_id: string }>,
  counterparties: Array<{ id: string; sample?: boolean }>
): number {
  const sample = new Set(counterparties.filter((counterparty) => counterparty.sample).map((counterparty) => counterparty.id));
  return invoices.filter((invoice) => !sample.has(invoice.counterparty_id)).length;
}
```

`src/app/o/[slug]/console/page.tsx`: import `ownInvoiceCount` with `gettingStarted` from `@/lib/getting-started`, and change the checklist call to:

```ts
      ? gettingStarted({ mode: access.membership.mode, accounts: accountsRows, counterparties, invoiceCount: ownInvoiceCount(invoices, counterparties) })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/getting-started.test.ts tests/getting-started-ui.test.tsx && npm run typecheck`
Expected: PASS, no type errors. If any other test builds a `CounterpartyRow` literal and now fails typecheck, add `sample: false` to it.

- [ ] **Step 5: Commit**

```bash
git add src/lib/queries.ts src/lib/getting-started.ts "src/app/o/[slug]/console/page.tsx" tests/getting-started.test.ts tests/getting-started-ui.test.tsx
git commit -m "Leave sample rows out of the Get started checklist"
```

---

### Task 5: Server actions to load and remove sample data

**Files:**
- Create: `src/app/actions/sample-data.ts`
- Test: `tests/sample-data-actions.test.ts`

**Interfaces:**
- Consumes: `loadSampleData`, `removeSampleData`, `SampleDataError` (Task 2); `authorize(slug, permission)` from `src/lib/auth/authorize.ts`; `inOrg(auth, fn)` from `src/lib/dal/scope.ts`; `revalidateOrgPages()` from `src/lib/auth/revalidate.ts`.
- Produces:
  - `interface SampleDataActionResult { ok: boolean; message: string }`
  - `loadSampleDataAction(previous: SampleDataActionResult, formData: FormData): Promise<SampleDataActionResult>` — reads `orgSlug`
  - `removeSampleDataAction(previous: SampleDataActionResult, formData: FormData): Promise<SampleDataActionResult>` — reads `orgSlug`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/sample-data-actions.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { loadSampleDataAction, removeSampleDataAction, type SampleDataActionResult } from "@/app/actions/sample-data";
import { SampleDataError } from "@/lib/sample-data";
import { fakeSupabase } from "./support/fake-supabase";

/**
 * `src/app/actions/sample-data.ts` against a real `inOrg`, the same shape as
 * tests/webhooks-actions.test.ts: `server-only`, `authorize` and the library
 * calls are stand-ins, proven elsewhere.
 */

const { ORG, USER } = vi.hoisted(() => ({
  ORG: "0b6c1c9e-4a4f-4a7e-9b1e-000000000c0c",
  USER: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000fc",
}));

vi.mock("server-only", () => ({}));

const { revalidatePathMock } = vi.hoisted(() => ({ revalidatePathMock: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

const { authorizeMock } = vi.hoisted(() => ({ authorizeMock: vi.fn() }));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));

const { loadMock, removeMock } = vi.hoisted(() => ({ loadMock: vi.fn(), removeMock: vi.fn() }));
vi.mock("@/lib/sample-data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sample-data")>();
  return { ...actual, loadSampleData: loadMock, removeSampleData: removeMock };
});

beforeEach(() => {
  vi.clearAllMocks();
});

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

const allowed = () => ({
  ok: true,
  user: { id: USER, email: null },
  membership: { orgId: ORG, slug: "northstar", name: "Northstar", mode: "sandbox" as const, role: "admin" as const },
});

function run<T>(fn: () => Promise<T>): Promise<T> {
  const orgRow = { id: ORG, slug: "northstar", name: "Northstar", mode: "sandbox", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null };
  const fake = fakeSupabase((request) => (request.path === "/rest/v1/orgs" ? { body: orgRow } : { body: [] }));
  return runWith({ config, db: fake.client, fetch: fake.fetch }, fn);
}

const INITIAL: SampleDataActionResult = { ok: false, message: "" };

function form(): FormData {
  const data = new FormData();
  data.set("orgSlug", "northstar");
  return data;
}

describe.each([
  ["loadSampleDataAction", loadSampleDataAction, loadMock],
  ["removeSampleDataAction", removeSampleDataAction, removeMock],
] as const)("%s", (_name, action, work) => {
  it("asks for records.write and does nothing when refused", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "You cannot do this." });

    const result = await action(INITIAL, form());

    expect(authorizeMock).toHaveBeenCalledWith("northstar", "records.write");
    expect(result).toEqual({ ok: false, message: "You cannot do this." });
    expect(work).not.toHaveBeenCalled();
  });

  it("shows a SampleDataError's own message", async () => {
    authorizeMock.mockResolvedValueOnce(allowed());
    work.mockRejectedValueOnce(new SampleDataError("cycle_running"));

    const result = await run(() => action(INITIAL, form()));

    expect(result).toEqual({ ok: false, message: "A cycle is running. Try again in a minute, once it has finished." });
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("hides any other error behind a generic message", async () => {
    authorizeMock.mockResolvedValueOnce(allowed());
    work.mockRejectedValueOnce(new Error("relation does not exist"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await run(() => action(INITIAL, form()));

    expect(result).toEqual({ ok: false, message: "That did not work. Try again in a moment." });
    logged.mockRestore();
  });
});

describe("loadSampleDataAction", () => {
  it("loads as the signed-in person, refreshes the workspace's pages and says what to do next", async () => {
    authorizeMock.mockResolvedValueOnce(allowed());
    loadMock.mockResolvedValueOnce({ counterparties: 6, invoices: 6, milestones: 2 });

    const result = await run(() => loadSampleDataAction(INITIAL, form()));

    expect(loadMock).toHaveBeenCalledWith({ actorId: USER });
    expect(result).toEqual({
      ok: true,
      message: "Sample data loaded: 6 counterparties, 6 invoices and 2 milestones. Run a cycle to see what the agent decides.",
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/o/[slug]", "layout");
  });
});

describe("removeSampleDataAction", () => {
  it("removes as the signed-in person and says what went", async () => {
    authorizeMock.mockResolvedValueOnce(allowed());
    removeMock.mockResolvedValueOnce({ counterparties: 6, invoices: 7, milestones: 2, paymentIntents: 3 });

    const result = await run(() => removeSampleDataAction(INITIAL, form()));

    expect(removeMock).toHaveBeenCalledWith({ actorId: USER });
    expect(result).toEqual({
      ok: true,
      message: "Sample data removed: 6 counterparties, with 7 invoices and 2 milestones. The ledger keeps its entries.",
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/o/[slug]", "layout");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sample-data-actions.test.ts`
Expected: FAIL — `Failed to resolve import "@/app/actions/sample-data"`.

- [ ] **Step 3: Write the actions**

```ts
// src/app/actions/sample-data.ts
"use server";

import "server-only";

import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { inOrg } from "@/lib/dal/scope";
import { loadSampleData, removeSampleData, SampleDataError } from "@/lib/sample-data";

/**
 * Loading and removing a sandbox's sample data (sample-data design §1). Both
 * are for the people who add records; the library refuses a workspace that
 * pays through Circle, and removal while money could be moving.
 */

export interface SampleDataActionResult {
  ok: boolean;
  message: string;
}

function failure(error: unknown, what: string): SampleDataActionResult {
  if (error instanceof SampleDataError) return { ok: false, message: error.message };
  console.error(what, error instanceof Error ? error.message : "unknown error");
  return { ok: false, message: "That did not work. Try again in a moment." };
}

export async function loadSampleDataAction(_previous: SampleDataActionResult, formData: FormData): Promise<SampleDataActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const counts = await loadSampleData({ actorId: auth.user.id });
      revalidateOrgPages();
      return {
        ok: true,
        message: `Sample data loaded: ${counts.counterparties} counterparties, ${counts.invoices} invoices and ${counts.milestones} milestones. Run a cycle to see what the agent decides.`,
      };
    } catch (error) {
      return failure(error, "sample data load failed");
    }
  });
}

export async function removeSampleDataAction(_previous: SampleDataActionResult, formData: FormData): Promise<SampleDataActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const removed = await removeSampleData({ actorId: auth.user.id });
      revalidateOrgPages();
      return {
        ok: true,
        message: `Sample data removed: ${removed.counterparties} counterparties, with ${removed.invoices} invoices and ${removed.milestones} milestones. The ledger keeps its entries.`,
      };
    } catch (error) {
      return failure(error, "sample data removal failed");
    }
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/sample-data-actions.test.ts tests/access-gates.test.ts`
Expected: PASS (the access-gate test now also covers the two new actions).

- [ ] **Step 5: Commit**

```bash
git add src/app/actions/sample-data.ts tests/sample-data-actions.test.ts
git commit -m "Add server actions to load and remove sample data"
```

---

### Task 6: The console card, the loaded callout, and the Sample badge

**Files:**
- Create: `src/components/SampleDataPanel.tsx`
- Modify: `src/app/o/[slug]/console/page.tsx`
- Modify: `src/app/o/[slug]/counterparties/page.tsx:76-80`
- Test: `tests/sample-data-ui.test.tsx`

**Interfaces:**
- Consumes: `loadSampleDataAction`, `removeSampleDataAction`, `SampleDataActionResult` (Task 5); `CounterpartyRow.sample` (Task 4); UI primitives `Button`, `Card`, `Callout`, `ConfirmDialog`, `FormMessage`, `Badge`, `useActionForm`.
- Produces:
  - `SampleDataOffer({ orgSlug }: { orgSlug: string })`
  - `SampleDataLoaded({ orgSlug, canRemove }: { orgSlug: string; canRemove: boolean })`
  - `offerSampleData(input: { canWrite: boolean; mode: "sandbox" | "live"; chainMode: "live" | "simulate"; counterpartyCount: number }): boolean`, exported from `src/lib/sample-data-offer.ts`: a pure file the page and the test both import, so the client component file stays client-only.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/sample-data-ui.test.tsx
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/sample-data", () => ({
  loadSampleDataAction: vi.fn(),
  removeSampleDataAction: vi.fn(),
}));

import { SampleDataLoaded, SampleDataOffer } from "@/components/SampleDataPanel";
import { offerSampleData } from "@/lib/sample-data-offer";

/** The console's sample-data card and callout, as the markup they render on the server, and how the pages wire them. */

describe("offerSampleData", () => {
  const base = { canWrite: true, mode: "sandbox" as const, chainMode: "simulate" as const, counterpartyCount: 0 };

  it("offers the sample to someone who adds records, in an empty simulated sandbox", () => {
    expect(offerSampleData(base)).toBe(true);
  });

  it.each([
    [{ canWrite: false }],
    [{ mode: "live" as const }],
    // A sandbox that connected Circle or chose a hosted wallet pays for real (S1).
    [{ chainMode: "live" as const }],
    [{ counterpartyCount: 1 }],
  ])("does not offer it when %j", (change) => {
    expect(offerSampleData({ ...base, ...change })).toBe(false);
  });
});

describe("SampleDataOffer", () => {
  it("names the sample and the button, and posts the workspace", () => {
    const markup = renderToStaticMarkup(<SampleDataOffer orgSlug="acme" />);
    expect(markup).toContain("Try it with sample data");
    expect(markup).toContain("Load sample data");
    expect(markup).toContain('name="orgSlug" value="acme"');
  });
});

describe("SampleDataLoaded", () => {
  it("says the sample is loaded and offers removal to someone who adds records", () => {
    const markup = renderToStaticMarkup(<SampleDataLoaded orgSlug="acme" canRemove />);
    expect(markup).toContain("Sample data is loaded");
    expect(markup).toContain("Remove sample data");
  });

  it("shows no control to someone who cannot remove it", () => {
    const markup = renderToStaticMarkup(<SampleDataLoaded orgSlug="acme" canRemove={false} />);
    expect(markup).toContain("Sample data is loaded");
    expect(markup).not.toContain("Remove sample data");
    expect(markup).not.toContain("<form");
  });
});

describe("the pages", () => {
  const read = (...parts: string[]) => readFileSync(path.join(process.cwd(), "src", "app", "o", "[slug]", ...parts), "utf8");

  it("the console offers the sample from rows it already reads", () => {
    const page = read("console", "page.tsx");
    expect(page).toContain(
      "offerSampleData({ canWrite: can(role, \"records.write\"), mode: access.membership.mode, chainMode: modes.mode, counterpartyCount: counterparties.length })"
    );
    expect(page).toContain("counterparties.some((counterparty) => counterparty.sample)");
  });

  it("the counterparty book marks sample counterparties", () => {
    expect(read("counterparties", "page.tsx")).toMatch(/counterparty\.sample && <Badge[^>]*>Sample<\/Badge>/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sample-data-ui.test.tsx`
Expected: FAIL — cannot resolve `@/components/SampleDataPanel` and `@/lib/sample-data-offer`.

- [ ] **Step 3: Write the pure offer rule**

```ts
// src/lib/sample-data-offer.ts
/**
 * When the console offers sample data (sample-data design §1, S1): to someone
 * who adds records, in a sandbox whose payments are simulated, before anything
 * has been added. The server refuses the same cases on its own; this only
 * decides whether the card shows.
 */
export function offerSampleData(input: {
  canWrite: boolean;
  mode: "sandbox" | "live";
  chainMode: "live" | "simulate";
  counterpartyCount: number;
}): boolean {
  return input.canWrite && input.mode === "sandbox" && input.chainMode === "simulate" && input.counterpartyCount === 0;
}
```

- [ ] **Step 4: Write the component**

```tsx
// src/components/SampleDataPanel.tsx
"use client";

import { FlaskConical, Trash2 } from "lucide-react";
import { loadSampleDataAction, removeSampleDataAction, type SampleDataActionResult } from "@/app/actions/sample-data";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FormMessage } from "@/components/ui/FormMessage";
import { useActionForm } from "@/components/ui/useActionForm";

const INITIAL: SampleDataActionResult = { ok: false, message: "" };

/**
 * The console's sample data (sample-data design §1): an offer while a
 * simulated sandbox is empty, and a callout with removal while the sample is
 * loaded. The console decides which shows (`offerSampleData`); the server
 * actions refuse on their own whatever the page showed.
 */
export function SampleDataOffer({ orgSlug }: { orgSlug: string }) {
  const { state, pending, formProps } = useActionForm(loadSampleDataAction, INITIAL, { toastOnSuccess: true });

  return (
    <Card asChild className="mb-8 p-4 sm:p-5">
      <section aria-labelledby="sample-data-title">
        <form {...formProps} className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <input type="hidden" name="orgSlug" value={orgSlug} />
          <div className="min-w-0 space-y-1">
            <h2 id="sample-data-title" className="text-sm font-semibold text-ink">
              Try it with sample data
            </h2>
            <p className="text-sm text-ink-2">
              Six example counterparties with invoices and milestones, chosen so that one cycle shows every outcome: a payment, a hold, a flag, a question and a milestone release. Payments are simulated, and you can remove the sample at any time.
            </p>
          </div>
          <Button type="submit" variant="secondary" icon={<FlaskConical />} loading={pending} className="shrink-0">
            Load sample data
          </Button>
        </form>
        {!state.ok && state.message && (
          <FormMessage tone="error" className="mt-3">
            {state.message}
          </FormMessage>
        )}
      </section>
    </Card>
  );
}

export function SampleDataLoaded({ orgSlug, canRemove }: { orgSlug: string; canRemove: boolean }) {
  return (
    <Callout tone="agent" title="Sample data is loaded" className="mb-8">
      <p>
        The counterparties marked Sample, and everything recorded against them, are examples. Remove them before you connect Circle.
      </p>
      {canRemove && <RemoveSampleDataForm orgSlug={orgSlug} />}
    </Callout>
  );
}

function RemoveSampleDataForm({ orgSlug }: { orgSlug: string }) {
  const formId = "remove-sample-data";
  const { state, pending, formProps } = useActionForm(removeSampleDataAction, INITIAL, { toastOnSuccess: true });

  return (
    <form id={formId} {...formProps} className="mt-3 flex flex-col items-start gap-2">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <ConfirmDialog
        formId={formId}
        trigger={
          <Button variant="secondary" size="sm" icon={<Trash2 />} loading={pending}>
            Remove sample data
          </Button>
        }
        title="Remove the sample data?"
        description="The sample counterparties go, with every invoice, milestone and payment recorded against them, including any you added to them. The ledger keeps its entries."
        confirmLabel="Remove sample data"
      />
      {!state.ok && state.message && <FormMessage tone="error">{state.message}</FormMessage>}
    </form>
  );
}
```

Before writing it, check the exact props of `FormMessage` (`tone`, `className`) and `Card` (`asChild`) in `src/components/ui/`; adjust the JSX to their real prop names if they differ. Also read `node_modules/next/dist/docs/` on server actions in client components (AGENTS.md).

- [ ] **Step 5: Wire the console**

In `src/app/o/[slug]/console/page.tsx`:
- import `{ SampleDataLoaded, SampleDataOffer }` from `@/components/SampleDataPanel` and `{ offerSampleData }` from `@/lib/sample-data-offer`;
- after the `checklist` constant add:

```ts
    // Sample data (sample-data design §1): offered in an empty simulated sandbox, and called out while it is loaded.
    const sampleOffered = offerSampleData({ canWrite: can(role, "records.write"), mode: access.membership.mode, chainMode: modes.mode, counterpartyCount: counterparties.length });
    const sampleLoaded = counterparties.some((counterparty) => counterparty.sample);
```

- directly after `{checklist && <GettingStarted … />}` render:

```tsx
        {sampleOffered && <SampleDataOffer orgSlug={slug} />}
        {sampleLoaded && <SampleDataLoaded orgSlug={slug} canRemove={can(role, "records.write")} />}
```

- [ ] **Step 6: Badge on the counterparty book**

In `src/app/o/[slug]/counterparties/page.tsx`, replace the `<h3 …>{counterparty.name}</h3>` line with:

```tsx
                        <h3 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-ink">
                          <span className="truncate">{counterparty.name}</span>
                          {counterparty.sample && <Badge size="sm" tone="simulated" shape="tag">Sample</Badge>}
                        </h3>
```

(`Badge` is already imported on that page.)

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/sample-data-ui.test.tsx tests/ui-consistency.test.ts tests/getting-started-ui.test.tsx && npm run typecheck && npm run lint`
Expected: PASS, no type or lint errors.

- [ ] **Step 8: Commit**

```bash
git add src/components/SampleDataPanel.tsx src/lib/sample-data-offer.ts "src/app/o/[slug]/console/page.tsx" "src/app/o/[slug]/counterparties/page.tsx" tests/sample-data-ui.test.tsx
git commit -m "Offer, call out and mark sample data in the console"
```

---

### Task 7: The guide says how to try it with sample data

**Files:**
- Modify: `content/docs/guides/first-payment.mdx` (new section before `## 1. Add a counterparty with an Arc address`)
- Modify: `tests/docs-guides.test.ts` (`QUOTED["guides/first-payment"]`)

**Interfaces:**
- Consumes: the UI strings from Task 6 (`src/components/SampleDataPanel.tsx`) and Task 3 (`src/lib/platform/go-live.ts`).

- [ ] **Step 1: Write the failing test**

In `tests/docs-guides.test.ts` add `const SAMPLE_PANEL = "src/components/SampleDataPanel.tsx";` and `const GO_LIVE_LIBRARY = "src/lib/platform/go-live.ts";` beside the other file constants (reuse `GO_LIVE_LIBRARY` if a constant for that file already exists), then add to the `"guides/first-payment"` list:

```ts
    ["Try it with sample data", SAMPLE_PANEL],
    ["Load sample data", SAMPLE_PANEL],
    ["Sample data is loaded", SAMPLE_PANEL],
    ["Remove sample data", SAMPLE_PANEL],
    ["Remove the sample data first. It exists only to try the agent with simulated payments.", GO_LIVE_LIBRARY],
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/docs-guides.test.ts`
Expected: FAIL — the guide does not contain the new strings.

- [ ] **Step 3: Write the section**

Insert before `## 1. Add a counterparty with an Arc address` in `content/docs/guides/first-payment.mdx`:

```mdx
## Try it with sample data first

To see the agent at work before you set anything up, open the console of a new workspace. While the workspace has no counterparties and has not connected Circle, the console shows **Try it with sample data**. Choose **Load sample data**: it adds six example counterparties, marked **Sample** on the Counterparties page, with invoices and milestones chosen so that one cycle shows every outcome. Run a cycle, then read the decisions on the console and on **Approvals**:

- a hosting invoice with a purchase order and goods received is paid;
- an overage with no purchase order waits for information;
- an invoice over the counterparty's payment limit is held for a person;
- a print run billed again under a purchase order that was already paid is flagged;
- a verified contractor milestone is released, and an unverified one waits.

Sample payments are simulated. While **Sample data is loaded**, the console offers **Remove sample data**: it removes the sample counterparties and everything recorded against them, and the ledger keeps its entries. Remove the sample before you connect Circle; until then, connecting answers "Remove the sample data first. It exists only to try the agent with simulated payments."
```

Check that "Approvals" is already a quoted string elsewhere in the test's list for this guide (it is the nav label in `src/components/vx/nav.ts`); if the test requires every bolded word to be listed, add `["Approvals", APP_NAV]` and `["Sample", COUNTERPARTIES_PAGE]`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/docs-guides.test.ts tests/docs-headings.test.ts tests/docs-content.test.ts tests/docs-markdown.test.ts`
Expected: PASS.

- [ ] **Step 5: Full verification and commit**

Run: `npm run verify`
Expected: every check green (lockfile, lint, typecheck, all tests).

```bash
git add content/docs/guides/first-payment.mdx tests/docs-guides.test.ts
git commit -m "Describe sample data in the first-payment guide"
```

---

## Rollout (the controller, not a subagent)

1. `npm run db:migrate -- --through 0034` against production (additive). Probe with a scratchpad script: `counterparties.sample` exists, boolean, not null, default false; index `counterparties_one_sample_set` exists and is partial; `select count(*) from counterparties where sample` is 0.
2. Push the branch, open the PR, wait for `gh pr checks` to be green (the repo has no required checks, so `--auto` would merge at once), then merge.
3. After the Vercel deploy: in a fresh sandbox (the partner creates one, or an existing simulated sandbox with no counterparties), load, run one cycle, and compare each outcome with spec §3 through the ledger (`sample_data_loaded`, the decisions, `approval` outcomes). Remove, then check: 0 sample counterparties, 0 invoices/milestones/intents left for their ids, `/api/ledger/verify?org=<slug>` valid.
4. Record the measured outcome in spec §5, in a docs PR.
5. Post an arc-canteen `update-product` about the feature.
