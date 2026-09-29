import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bodyHashOf, type LedgerEntryInput } from "@/lib/ledger";
import { ledgerKeyId } from "@/lib/ledger-keys";
import {
  appendSignedForOrg, applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg, createUser, seedOrgRows,
} from "./support/pglite";

/**
 * Migration 0028 (webhooks design §3, W2, W7): webhook endpoints and a
 * delivery queue, both platform tables closed to every role but the service
 * role. An `after insert` trigger on ledger_entries enqueues one delivery per
 * active endpoint of the entry's organization, and can never fail the append.
 * `create_webhook_endpoint` holds each organization to 5 active endpoints, and
 * `claim_webhook_deliveries` moves due rows into `sending`.
 */

let db: PGlite;
let owner: string;
let orgId: string;
const key = crypto.generateKeyPairSync("ed25519");
const ENVELOPE = { v: 1, iv: "x", tag: "y", data: "z" };

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  owner = await createUser(db, "owner@example.com");
  orgId = await createOrg(db, "hooks-co");
}, 60_000);

afterAll(async () => {
  await db.close();
});

const entry = (tag: string): LedgerEntryInput => ({ actor: "system", domain: "system", action: "note", summary: tag, detail: { tag } });

/** Appends as the superuser, the way the other migration tests do. */
const append = (org: string, tag: string) => appendSignedForOrg(db, org, entry(tag), key.privateKey);

/** Appends the way production does: as the tenant role, under the organization's token. */
const appendAsTenant = (org: string, tag: string, onNotice?: (message: string) => void) =>
  asTenant(db, org, async (tx) => {
    const input = entry(tag);
    const bodyHash = bodyHashOf(input);
    const signature = crypto.sign(null, Buffer.from(bodyHash, "hex"), key.privateKey).toString("hex");
    const result = await (tx as PGlite).query<{ id: string }>(
      "select * from append_ledger_entry($1::uuid, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)",
      [org, input.actor, input.domain, input.action, input.summary, JSON.stringify(input.detail), bodyHash, signature,
        ledgerKeyId(key.privateKey)],
      onNotice ? { onNotice: (notice) => onNotice(notice.message ?? "") } : undefined
    );
    return result.rows[0];
  });

const createEndpoint = (org: string, url = "https://hooks.example.com/in", id: string = crypto.randomUUID(), by: string | null = owner) =>
  asServiceRole(db, async (tx) =>
    (await tx.query<Record<string, unknown> & { id: string }>(
      "select * from public.create_webhook_endpoint($1, $2, $3, $4::jsonb, $5)", [id, org, url, JSON.stringify(ENVELOPE), by]
    )).rows[0]);

const claim = (limit: number, only: string | null = null) =>
  asServiceRole(db, async (tx) =>
    (await tx.query<{ id: string; status: string; claimed_at: Date | null; attempts: number }>(
      only === null
        ? "select * from public.claim_webhook_deliveries($1)"
        : "select * from public.claim_webhook_deliveries($1, $2::uuid)",
      only === null ? [limit] : [limit, only])).rows);

const recordFailure = (endpoint: string, disableAfter = 20) =>
  asServiceRole(db, async (tx) =>
    (await tx.query<{ n: number | null }>(
      "select public.record_webhook_failure($1, $2) as n", [endpoint, disableAfter])).rows[0].n);

const deliveriesOf = async (org: string) =>
  (await db.query<{ endpoint_id: string; ledger_entry_id: string | null; event_type: string; status: string; attempts: number; org_id: string }>(
    "select endpoint_id, ledger_entry_id, event_type, status, attempts, org_id from public.webhook_deliveries where org_id = $1", [org])).rows;

describe("the webhook tables", () => {
  it("refuses a URL that is not https", async () => {
    await expect(createEndpoint(await createOrg(db, "http-co"), "http://hooks.example.com/in")).rejects.toThrow(/webhook_endpoints_url_check/);
  });

  it("refuses a URL longer than 500 characters, and accepts 500", async () => {
    const org = await createOrg(db, "long-co");
    const base = "https://hooks.example.com/";
    await expect(createEndpoint(org, base + "a".repeat(501 - base.length))).rejects.toThrow(/webhook_endpoints_url_check/);
    await expect(createEndpoint(org, base + "a".repeat(500 - base.length))).resolves.toBeTruthy();
  });

  it("refuses an unknown event type or status", async () => {
    const org = await createOrg(db, "enum-co");
    const endpoint = await createEndpoint(org);
    await expect(db.query(
      "insert into public.webhook_deliveries (org_id, endpoint_id, event_type) values ($1, $2, 'ledger.deleted')", [org, endpoint.id]
    )).rejects.toThrow(/webhook_deliveries_event_type_check/);
    await expect(db.query(
      "insert into public.webhook_deliveries (org_id, endpoint_id, event_type, status) values ($1, $2, 'webhook.test', 'lost')", [org, endpoint.id]
    )).rejects.toThrow(/webhook_deliveries_status_check/);
  });

  it("is indexed for the claim, the endpoint and the ledger entry cascade", async () => {
    const { rows } = await db.query<{ indexname: string; indexdef: string }>(
      "select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'webhook_deliveries'");
    const defs = rows.map((row) => row.indexdef);
    expect(defs.some((def) => /\(status, next_attempt_at\)/.test(def))).toBe(true);
    expect(defs.some((def) => /\(endpoint_id\)/.test(def))).toBe(true);
    expect(defs.some((def) => /\(ledger_entry_id\)/.test(def))).toBe(true);
  });

  it("keeps the endpoint when its creator's account is deleted", async () => {
    const creator = await createUser(db, "creator@example.com");
    const endpoint = await createEndpoint(await createOrg(db, "creator-co"), undefined, undefined, creator);
    await db.query("delete from auth.users where id = $1", [creator]);
    const { rows } = await db.query("select created_by from public.webhook_endpoints where id = $1", [endpoint.id]);
    expect(rows).toEqual([{ created_by: null }]);
  });
});

describe("enqueueing on append", () => {
  it("enqueues one delivery per active endpoint of the entry's organization, and none for a removed, disabled or foreign one", async () => {
    const org = await createOrg(db, "enqueue-co");
    const other = await createOrg(db, "enqueue-other-co");
    const a = await createEndpoint(org, "https://a.example.com/");
    const b = await createEndpoint(org, "https://b.example.com/");
    const removed = await createEndpoint(org, "https://removed.example.com/");
    const disabled = await createEndpoint(org, "https://disabled.example.com/");
    await db.query("update public.webhook_endpoints set removed_at = now() where id = $1", [removed.id]);
    await db.query("update public.webhook_endpoints set disabled_at = now() where id = $1", [disabled.id]);
    await createEndpoint(other, "https://other.example.com/");

    const row = await append(org, "enqueue");

    const rows = await deliveriesOf(org);
    expect(rows.map((r) => r.endpoint_id).sort()).toEqual([a.id, b.id].sort());
    for (const r of rows) {
      expect(r).toEqual({
        endpoint_id: r.endpoint_id, ledger_entry_id: row.id, event_type: "ledger.appended", status: "pending", attempts: 0, org_id: org,
      });
    }
    expect(await deliveriesOf(other)).toEqual([]);
  });

  it("enqueues for an append made by the tenant role, which cannot reach the table itself", async () => {
    const org = await createOrg(db, "tenant-append-co");
    const endpoint = await createEndpoint(org);
    const row = await appendAsTenant(org, "as tenant");
    expect(await deliveriesOf(org)).toEqual([
      { endpoint_id: endpoint.id, ledger_entry_id: row.id, event_type: "ledger.appended", status: "pending", attempts: 0, org_id: org },
    ]);
  });

  it("enqueues nothing for an organization without endpoints", async () => {
    const org = await createOrg(db, "quiet-co");
    await append(org, "quiet");
    expect(await deliveriesOf(org)).toEqual([]);
  });

  it("never fails the append: a failing enqueue raises a warning and the entry is still appended", async () => {
    const org = await createOrg(db, "broken-co");
    await createEndpoint(org);
    await db.query("alter table public.webhook_deliveries add constraint webhook_deliveries_test_break check (false) not valid");
    const notices: string[] = [];
    try {
      const row = await appendAsTenant(org, "survives", (message) => notices.push(message));
      expect(row.id).toBeTruthy();
      const { rows } = await db.query("select summary from public.ledger_entries where id = $1", [row.id]);
      expect(rows).toEqual([{ summary: "survives" }]);
      expect(await deliveriesOf(org)).toEqual([]);
      expect(notices.some((message) => /webhook enqueue failed: .*webhook_deliveries_test_break/.test(message))).toBe(true);
    } finally {
      await db.query("alter table public.webhook_deliveries drop constraint if exists webhook_deliveries_test_break");
    }
  });

  it("runs as security definer with an empty search_path", async () => {
    const { rows } = await db.query<{ proname: string; prosecdef: boolean; proconfig: string[] | null }>(
      `select p.proname, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('enqueue_webhook_deliveries', 'create_webhook_endpoint', 'claim_webhook_deliveries',
                            'record_webhook_failure')
        order by p.proname`);
    expect(rows.map((row) => row.proname)).toEqual([
      "claim_webhook_deliveries", "create_webhook_endpoint", "enqueue_webhook_deliveries", "record_webhook_failure",
    ]);
    for (const row of rows) {
      expect(row.prosecdef, row.proname).toBe(true);
      expect(row.proconfig, row.proname).toEqual(['search_path=""']);
    }
  });
});

describe("claim_webhook_deliveries", () => {
  let endpointId: string;
  let claimOrg: string;

  beforeAll(async () => {
    claimOrg = await createOrg(db, "claim-co");
    endpointId = (await createEndpoint(claimOrg)).id;
  });

  beforeEach(async () => {
    await db.query("delete from public.webhook_deliveries");
  });

  const insertDelivery = async (values: { status?: string; next?: string; claimed?: string | null; attempts?: number }) =>
    (await db.query<{ id: string }>(
      `insert into public.webhook_deliveries (org_id, endpoint_id, event_type, status, next_attempt_at, claimed_at, attempts)
       values ($1, $2, 'webhook.test', $3, now() + $4::interval, case when $5::text is null then null else now() + $5::interval end, $6)
       returning id`,
      [claimOrg, endpointId, values.status ?? "pending", values.next ?? "-1 minute", values.claimed ?? null, values.attempts ?? 0]
    )).rows[0].id;

  it("claims only due pending rows, up to the limit, oldest due first, and marks them sending", async () => {
    const oldest = await insertDelivery({ next: "-3 minutes" });
    const older = await insertDelivery({ next: "-2 minutes" });
    const due = await insertDelivery({ next: "-1 minute" });
    await insertDelivery({ next: "5 minutes" });
    await insertDelivery({ status: "delivered" });
    await insertDelivery({ status: "failed" });

    const first = await claim(2);
    expect(first.map((row) => row.id)).toEqual([oldest, older]);
    for (const row of first) {
      expect(row.status).toBe("sending");
      expect(Date.now() - new Date(row.claimed_at as Date).getTime()).toBeLessThan(60_000);
    }
    const stored = await db.query<{ status: string }>(
      "select status from public.webhook_deliveries where id = any($1::uuid[])", [[oldest, older]]);
    expect(stored.rows.map((row) => row.status)).toEqual(["sending", "sending"]);

    expect((await claim(10)).map((row) => row.id)).toEqual([due]);
    expect(await claim(10)).toEqual([]);
  });

  it("claims a sending row again once its claim is more than 5 minutes old, and not before", async () => {
    const stale = await insertDelivery({ status: "sending", claimed: "-6 minutes" });
    await insertDelivery({ status: "sending", claimed: "-4 minutes" });

    const claimed = await claim(10);
    expect(claimed.map((row) => row.id)).toEqual([stale]);
    expect(Date.now() - new Date(claimed[0].claimed_at as Date).getTime()).toBeLessThan(60_000);
    expect(await claim(10)).toEqual([]);
  });

  it("claims a sending row that has no claimed_at at all", async () => {
    const orphan = await insertDelivery({ status: "sending", claimed: null });

    const claimed = await claim(10);
    expect(claimed.map((row) => row.id)).toEqual([orphan]);
    expect(claimed[0].claimed_at).not.toBeNull();
    expect(await claim(10)).toEqual([]);
  });

  it("counts taking over a stale or orphaned sending row as one attempt, and a pending claim as none", async () => {
    const pending = await insertDelivery({ attempts: 2 });
    const stale = await insertDelivery({ status: "sending", claimed: "-6 minutes", attempts: 3 });
    const orphan = await insertDelivery({ status: "sending", claimed: null, attempts: 0 });

    const claimed = await claim(10);
    const attempts = Object.fromEntries(claimed.map((row) => [row.id, row.attempts]));
    expect(attempts).toEqual({ [pending]: 2, [stale]: 4, [orphan]: 1 });
    const stored = await db.query<{ id: string; attempts: number }>(
      "select id, attempts from public.webhook_deliveries where id = any($1::uuid[])", [[pending, stale, orphan]]);
    expect(Object.fromEntries(stored.rows.map((row) => [row.id, row.attempts]))).toEqual(attempts);
  });

  it("claims only the named delivery when one is given, and only while it is due", async () => {
    const older = await insertDelivery({ next: "-3 minutes" });
    const named = await insertDelivery({ next: "-1 minute" });
    const later = await insertDelivery({ next: "5 minutes" });

    expect((await claim(10, named)).map((row) => row.id)).toEqual([named]);
    expect(await claim(10, named)).toEqual([]);
    expect(await claim(10, later)).toEqual([]);
    expect((await claim(10)).map((row) => row.id)).toEqual([older]);
  });

  it("claims nothing for a limit of zero", async () => {
    await insertDelivery({});
    expect(await claim(0)).toEqual([]);
  });
});

describe("record_webhook_failure", () => {
  const endpointState = async (id: string) =>
    (await db.query<{ consecutive_failures: number; last_failure_at: Date | null; disabled_at: Date | null }>(
      "select consecutive_failures, last_failure_at, disabled_at from public.webhook_endpoints where id = $1", [id])).rows[0];

  const deliveries = async (endpoint: string) =>
    (await db.query<{ status: string; last_error: string | null }>(
      "select status, last_error from public.webhook_deliveries where endpoint_id = $1 order by status", [endpoint])).rows;

  it("counts one failure, stamps last_failure_at and returns the new count, below the threshold", async () => {
    const org = await createOrg(db, "fail-count-co");
    const endpoint = await createEndpoint(org);

    expect(await recordFailure(endpoint.id, 3)).toBe(1);
    expect(await recordFailure(endpoint.id, 3)).toBe(2);
    const state = await endpointState(endpoint.id);
    expect(state.consecutive_failures).toBe(2);
    expect(state.last_failure_at).not.toBeNull();
    expect(state.disabled_at).toBeNull();
  });

  it("disables the endpoint at the threshold and fails its pending deliveries, and no one else's", async () => {
    const org = await createOrg(db, "fail-disable-co");
    const endpoint = await createEndpoint(org);
    const other = await createEndpoint(org, "https://other.example.com/");
    for (const status of ["pending", "sending", "delivered"]) {
      await db.query(
        "insert into public.webhook_deliveries (org_id, endpoint_id, event_type, status) values ($1, $2, 'webhook.test', $3)",
        [org, endpoint.id, status]);
    }
    await db.query(
      "insert into public.webhook_deliveries (org_id, endpoint_id, event_type) values ($1, $2, 'webhook.test')", [org, other.id]);
    await db.query("update public.webhook_endpoints set consecutive_failures = 19 where id = $1", [endpoint.id]);

    expect(await recordFailure(endpoint.id, 20)).toBe(20);

    expect((await endpointState(endpoint.id)).disabled_at).not.toBeNull();
    expect(await deliveries(endpoint.id)).toEqual([
      { status: "delivered", last_error: null },
      { status: "failed", last_error: "endpoint disabled" },
      { status: "sending", last_error: null },
    ]);
    expect(await deliveries(other.id)).toEqual([{ status: "pending", last_error: null }]);
    expect((await endpointState(other.id)).disabled_at).toBeNull();
  });

  it("keeps the first disabled_at when failures keep arriving after the endpoint is disabled", async () => {
    const org = await createOrg(db, "fail-again-co");
    const endpoint = await createEndpoint(org);
    await recordFailure(endpoint.id, 1);
    const first = (await endpointState(endpoint.id)).disabled_at;
    expect(first).not.toBeNull();
    await db.query("select pg_sleep(0.01)");
    expect(await recordFailure(endpoint.id, 1)).toBe(2);
    expect((await endpointState(endpoint.id)).disabled_at).toEqual(first);
  });

  it("returns null for an unknown endpoint", async () => {
    expect(await recordFailure(crypto.randomUUID())).toBeNull();
  });
});

describe("create_webhook_endpoint", () => {
  it("inserts the endpoint under the caller's id and returns the row", async () => {
    const org = await createOrg(db, "create-co");
    const id = crypto.randomUUID();
    const row = await createEndpoint(org, "https://hooks.example.com/x", id);
    expect(row).toMatchObject({
      id, org_id: org, url: "https://hooks.example.com/x", secret_enc: ENVELOPE, created_by: owner,
      disabled_at: null, removed_at: null, consecutive_failures: 0, last_success_at: null, last_failure_at: null,
    });
    expect(row.created_at).toBeTruthy();
  });

  it("refuses the 6th active endpoint, and a removed or disabled one frees a slot", async () => {
    const org = await createOrg(db, "limit-co");
    const made = [];
    for (let i = 0; i < 5; i++) made.push(await createEndpoint(org, `https://h${i}.example.com/`));
    await expect(createEndpoint(org, "https://six.example.com/")).rejects.toThrow(
      /webhook_limit_reached: at most 5 active webhook endpoints per organization/);

    await db.query("update public.webhook_endpoints set removed_at = now() where id = $1", [made[0].id]);
    await expect(createEndpoint(org, "https://replacement.example.com/")).resolves.toMatchObject({ org_id: org });
    await expect(createEndpoint(org, "https://no-more.example.com/")).rejects.toThrow(/webhook_limit_reached/);

    await db.query("update public.webhook_endpoints set disabled_at = now() where id = $1", [made[1].id]);
    await expect(createEndpoint(org, "https://after-disable.example.com/")).resolves.toMatchObject({ org_id: org });
    await expect(createEndpoint(org, "https://still-no-more.example.com/")).rejects.toThrow(/webhook_limit_reached/);
  });

  it("counts each organization's endpoints separately", async () => {
    const full = await createOrg(db, "full-co");
    for (let i = 0; i < 5; i++) await createEndpoint(full, `https://f${i}.example.com/`);
    const empty = await createOrg(db, "empty-co");
    await expect(createEndpoint(empty)).resolves.toMatchObject({ org_id: empty });
  });
});

describe("who may read the tables or call the functions", () => {
  const tables = ["webhook_endpoints", "webhook_deliveries"];
  const calls: [string, string, () => unknown[]][] = [
    ["create_webhook_endpoint", "select * from public.create_webhook_endpoint($1, $2, $3, $4::jsonb, $5)",
      () => [crypto.randomUUID(), orgId, "https://x.example.com/", JSON.stringify(ENVELOPE), owner]],
    ["claim_webhook_deliveries", "select * from public.claim_webhook_deliveries($1)", () => [10]],
    ["record_webhook_failure", "select public.record_webhook_failure($1, $2)", () => [crypto.randomUUID(), 20]],
  ];

  for (const table of tables) {
    it.each(["anon", "authenticated"] as const)(`%s cannot select from ${table}`, async (role) => {
      await expect(asRole(db, role, (tx) => tx.query(`select * from public.${table}`))).rejects.toThrow(/permission denied/);
    });

    it(`the tenant role cannot select from ${table}`, async () => {
      await expect(asTenant(db, orgId, (tx) => tx.query(`select * from public.${table}`))).rejects.toThrow(/permission denied/);
    });

    it(`the service role can read ${table}`, async () => {
      await expect(asServiceRole(db, (tx) => tx.query(`select id from public.${table}`))).resolves.toBeTruthy();
    });
  }

  for (const [fn, sql, args] of calls) {
    it.each(["anon", "authenticated"] as const)(`%s cannot execute ${fn}`, async (role) => {
      await expect(asRole(db, role, (tx) => tx.query(sql, args()))).rejects.toThrow(/permission denied/);
    });

    it(`the tenant role cannot execute ${fn}`, async () => {
      await expect(asTenant(db, orgId, (tx) => tx.query(sql, args()))).rejects.toThrow(/permission denied/);
    });
  }

  it("no browser or tenant role holds execute on any of the four functions", async () => {
    const { rows } = await db.query<{ fn: string; anon: boolean; auth: boolean; tenant: boolean }>(
      `select p.oid::regprocedure::text as fn,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('vestiarion_tenant', p.oid, 'execute') as tenant
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('enqueue_webhook_deliveries', 'create_webhook_endpoint', 'claim_webhook_deliveries',
                            'record_webhook_failure')`);
    expect(rows).toHaveLength(4);
    expect(rows.filter((row) => row.anon || row.auth || row.tenant)).toEqual([]);
  });
});

describe("deleting an organization", () => {
  it("cascades to its endpoints and deliveries", async () => {
    const org = await createOrg(db, "cascade-co");
    const endpoint = await createEndpoint(org);
    await db.query(
      "insert into public.webhook_deliveries (org_id, endpoint_id, event_type) values ($1, $2, 'webhook.test')", [org, endpoint.id]);
    await db.query("delete from public.orgs where id = $1", [org]);
    expect((await db.query("select 1 from public.webhook_endpoints where org_id = $1", [org])).rows).toEqual([]);
    expect(await deliveriesOf(org)).toEqual([]);
  });

  it("delete_sandbox_org still deletes a sandbox that has endpoints and deliveries", async () => {
    const doomed = await createOrg(db, "doomed-hooks-co");
    const endpoint = await createEndpoint(doomed);
    await seedOrgRows(db, doomed, "doomed-hooks");
    await db.query(
      "insert into public.webhook_deliveries (org_id, endpoint_id, event_type) values ($1, $2, 'webhook.test')", [doomed, endpoint.id]);
    const before = await deliveriesOf(doomed);
    expect(before.map((row) => row.event_type).sort()).toEqual(["ledger.appended", "webhook.test"]);
    await db.query("update public.orgs set last_active_at = now() - interval '61 days' where id = $1", [doomed]);

    const deleted = await asServiceRole(db, async (tx) =>
      (await tx.query<{ deleted: boolean }>("select public.delete_sandbox_org($1, now() - interval '60 days') as deleted", [doomed])).rows[0].deleted);

    expect(deleted).toBe(true);
    expect((await db.query("select 1 from public.orgs where id = $1", [doomed])).rows).toEqual([]);
    expect((await db.query("select 1 from public.webhook_endpoints where org_id = $1", [doomed])).rows).toEqual([]);
    expect(await deliveriesOf(doomed)).toEqual([]);
  });
});

describe("replaying 0028", () => {
  it("replays every migration twice without error, leaving one trigger on ledger_entries", async () => {
    const fresh = await createDatabase();
    try {
      await applyMigrations(fresh);
      await applyMigrations(fresh);
      const { rows } = await fresh.query<{ tgname: string }>(
        "select tgname from pg_trigger where tgrelid = 'public.ledger_entries'::regclass and not tgisinternal");
      expect(rows).toEqual([{ tgname: "ledger_entries_enqueue_webhooks" }]);
    } finally {
      await fresh.close();
    }
  }, 60_000);
});
