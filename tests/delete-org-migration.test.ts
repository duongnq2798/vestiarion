import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ledgerKeyId } from "@/lib/ledger-keys";
import {
  appendSignedForOrg, applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg, createUser,
  FOUNDING_ORG_ID, seedOrgRows, TENANT_TABLES,
} from "./support/pglite";

/**
 * Migration 0031 (docs/superpowers/specs/2026-09-30-workspace-delete-footer-screenshots-design.md
 * §1, W3–W5): `delete_org(p_org_id, p_by)` deletes a workspace whole, owner
 * initiated, after writing a tombstone to the service-role-only
 * `deleted_orgs`.
 *
 * - It refuses an unknown org, the founding workspace, a live workspace whose
 *   agent is not paused, and one with a cycle in progress.
 * - The tombstone keeps the ledger's length, head hash and head signing key id.
 * - Every row of the org goes, in every table, including the platform tables
 *   that cascade (memberships, invitations, API keys, webhooks); another org
 *   is untouched.
 */

let db: PGlite;
let owner: string;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  owner = await createUser(db, "owner@example.com");
}, 60_000);

afterAll(async () => {
  await db.close();
});

const ENVELOPE = { v: 1, iv: "x", tag: "y", data: "z" };
const PLATFORM_TABLES = ["memberships", "invitations", "api_keys", "webhook_endpoints", "webhook_deliveries"] as const;

const deleteOrg = (orgId: string, by: string | null = owner) =>
  asServiceRole(db, (tx) => tx.query("select public.delete_org($1, $2)", [orgId, by]));

/** A workspace whose owner is `owner`, the person every delete below is made by. */
async function ownedOrg(slug: string): Promise<string> {
  const orgId = await createOrg(db, slug);
  await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'owner')", [orgId, owner]);
  return orgId;
}

const exists = async (orgId: string) =>
  (await db.query("select 1 from public.orgs where id = $1", [orgId])).rows.length === 1;

interface Tombstone {
  org_id: string;
  slug: string;
  name: string;
  deleted_by: string | null;
  deleted_at: Date;
  ledger_entries: number;
  ledger_head_hash: string | null;
  ledger_signing_key_id: string | null;
}

const tombstoneOf = async (orgId: string) =>
  (await db.query<Tombstone>("select * from public.deleted_orgs where org_id = $1", [orgId])).rows[0];

/**
 * Every base table in `public` with an `org_id` column, but the tombstones:
 * read from the schema, so a table added later is covered without anyone
 * remembering to list it here.
 */
async function orgScopedTables(): Promise<string[]> {
  const { rows } = await db.query<{ table_name: string }>(
    `select c.table_name from information_schema.columns c
       join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'public' and c.column_name = 'org_id' and t.table_type = 'BASE TABLE'
        and c.table_name <> 'deleted_orgs'
      order by c.table_name`
  );
  return rows.map((row) => row.table_name);
}

/** Every row of `orgId`, table by table, where any remains. */
async function remaining(orgId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of await orgScopedTables()) {
    const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from public.${table} where org_id = $1`, [orgId]);
    if (rows[0].n > 0) counts[table] = rows[0].n;
  }
  if (await exists(orgId)) counts.orgs = 1;
  return counts;
}

/** Closes every cycle run of the org, so the cycle_running refusal does not apply. */
const closeCycles = (orgId: string) =>
  db.query("update public.cycle_runs set status = 'completed', finished_at = now(), duration_ms = 0 where org_id = $1", [orgId]);

let prefixCounter = 0;
function nextPrefix(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let n = prefixCounter++;
  let out = "";
  for (let i = 0; i < 8; i++) {
    out = alphabet[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return out;
}

/** A workspace with a row in every table the org owns, platform tables included. */
async function populated(slug: string): Promise<string> {
  const orgId = await ownedOrg(slug);
  const member = await createUser(db, `${slug}-member@example.com`);
  await db.query("insert into public.memberships (org_id, user_id, role, invited_by) values ($1, $2, 'viewer', $3)", [orgId, member, owner]);
  await db.query(
    `insert into public.invitations (org_id, email, role, token_hash, invited_by, expires_at)
     values ($1, $2, 'approver', $3, $4, now() + interval '7 days')`,
    [orgId, `${slug}-invitee@example.com`, crypto.randomBytes(32).toString("hex"), owner]
  );
  await db.query(
    "insert into public.api_keys (org_id, name, prefix, secret_hash, created_by) values ($1, 'ci', $2, $3, $4)",
    [orgId, nextPrefix(), "a".repeat(64), owner]
  );
  const endpoint = (await db.query<{ id: string }>(
    "insert into public.webhook_endpoints (org_id, url, secret_enc, created_by) values ($1, 'https://example.com/hook', $2::jsonb, $3) returning id",
    [orgId, JSON.stringify(ENVELOPE), owner]
  )).rows[0].id;
  // The endpoint exists first, so the seeded ledger entry enqueues a delivery (0028's trigger).
  await seedOrgRows(db, orgId, slug);
  await db.query(
    "insert into public.webhook_deliveries (org_id, endpoint_id, event_type) values ($1, $2, 'webhook.test')",
    [orgId, endpoint]
  );
  await closeCycles(orgId);
  return orgId;
}

describe("delete_org refusals (0031, W3)", () => {
  it("refuses an organization that does not exist", async () => {
    await expect(deleteOrg("5d0f3a2e-8c1b-4f7a-9e6d-000000000000")).rejects.toThrow(/org_not_found/);
  });

  it("refuses the founding workspace, and leaves it and its rows alone", async () => {
    await db.query("update public.orgs set agent_paused_at = now() where id = $1", [FOUNDING_ORG_ID]);
    await expect(deleteOrg(FOUNDING_ORG_ID)).rejects.toThrow(/founding_org/);
    expect(await exists(FOUNDING_ORG_ID)).toBe(true);
    expect(await tombstoneOf(FOUNDING_ORG_ID)).toBeUndefined();
    await db.query("update public.orgs set agent_paused_at = null where id = $1", [FOUNDING_ORG_ID]);
  });

  it("refuses a live workspace whose agent is running (pause first)", async () => {
    const orgId = await ownedOrg("live-running-co");
    await db.query("update public.orgs set mode = 'live' where id = $1", [orgId]);

    await expect(deleteOrg(orgId)).rejects.toThrow(/pause_first/);
    expect(await exists(orgId)).toBe(true);
    expect(await tombstoneOf(orgId)).toBeUndefined();
  });

  it("deletes a live workspace once its agent is paused", async () => {
    const orgId = await ownedOrg("live-paused-co");
    await db.query("update public.orgs set mode = 'live', agent_paused_at = now(), agent_paused_by = $2 where id = $1", [orgId, owner]);

    await deleteOrg(orgId);

    expect(await exists(orgId)).toBe(false);
  });

  it("deletes a sandbox without a pause: only a live workspace runs on the schedule", async () => {
    const orgId = await ownedOrg("sandbox-unpaused-co");

    await deleteOrg(orgId);

    expect(await exists(orgId)).toBe(false);
  });

  it("refuses while a cycle run is in progress, even for a paused workspace", async () => {
    const orgId = await ownedOrg("cycling-co");
    await db.query("update public.orgs set mode = 'live', agent_paused_at = now() where id = $1", [orgId]);
    await db.query(
      "insert into public.cycle_runs (org_id, started_at, status, clock_mode, chain_mode, screening_mode) values ($1, now(), 'running', 'real', 'simulate', 'simulate')",
      [orgId]
    );

    await expect(deleteOrg(orgId)).rejects.toThrow(/cycle_running/);
    expect(await exists(orgId)).toBe(true);
    expect(await tombstoneOf(orgId)).toBeUndefined();
  });

  it("does not wait forever on a crashed cycle: a run left running past the longest a cycle can take no longer counts", async () => {
    const orgId = await ownedOrg("crashed-cycle-co");
    await db.query(
      "insert into public.cycle_runs (org_id, started_at, status, clock_mode, chain_mode, screening_mode) values ($1, now() - interval '1 hour', 'running', 'real', 'simulate', 'simulate')",
      [orgId]
    );

    await deleteOrg(orgId);

    expect(await exists(orgId)).toBe(false);
  });

  it("ignores finished runs", async () => {
    const orgId = await ownedOrg("finished-cycle-co");
    for (const status of ["completed", "partial", "failed"]) {
      await db.query(
        "insert into public.cycle_runs (org_id, started_at, finished_at, duration_ms, status, clock_mode, chain_mode, screening_mode) values ($1, now(), now(), 0, $2, 'real', 'simulate', 'simulate')",
        [orgId, status]
      );
    }

    await deleteOrg(orgId);

    expect(await exists(orgId)).toBe(false);
  });

  it("refuses anyone but an owner of the workspace: no actor, an admin, or an owner since removed", async () => {
    const orgId = await ownedOrg("owners-only-co");
    const admin = await createUser(db, "owners-only-admin@example.com");
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'admin')", [orgId, admin]);
    const former = await createUser(db, "owners-only-former@example.com");
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'owner')", [orgId, former]);
    // Another owner remains, so the last-owner trigger lets this one go.
    await db.query("delete from public.memberships where org_id = $1 and user_id = $2", [orgId, former]);
    const stranger = await createUser(db, "owners-only-stranger@example.com");

    for (const by of [null, admin, former, stranger]) {
      await expect(deleteOrg(orgId, by)).rejects.toThrow(/not_owner/);
    }
    expect(await exists(orgId)).toBe(true);
    expect(await tombstoneOf(orgId)).toBeUndefined();
  });

  it("refuses an owner of another workspace", async () => {
    const orgId = await createOrg(db, "someone-elses-co");
    await expect(deleteOrg(orgId)).rejects.toThrow(/not_owner/);
    expect(await exists(orgId)).toBe(true);
  });

  it("refuses while a person's approval holds an invoice (processing, inside the 10-minute claim window)", async () => {
    const orgId = await ownedOrg("approving-co");
    const rows = await seedOrgRows(db, orgId, "approving-co");
    await closeCycles(orgId);
    await db.query("update public.invoices set status = 'processing', reviewed_by = $2, reviewed_at = now() - interval '9 minutes' where id = $1", [rows.invoiceId, owner]);

    await expect(deleteOrg(orgId)).rejects.toThrow(/payment_in_progress/);
    expect(await exists(orgId)).toBe(true);
    expect(await tombstoneOf(orgId)).toBeUndefined();
  });

  it("refuses while a payment is being submitted (submitting, inside the 2-minute claim window)", async () => {
    const orgId = await ownedOrg("submitting-co");
    const rows = await seedOrgRows(db, orgId, "submitting-co");
    await closeCycles(orgId);
    await db.query("update public.payment_intents set status = 'submitting', updated_at = now() - interval '90 seconds' where org_id = $1 and idempotency_key = $2", [orgId, rows.idempotencyKey]);

    await expect(deleteOrg(orgId)).rejects.toThrow(/payment_in_progress/);
    expect(await exists(orgId)).toBe(true);
  });

  it("is not blocked by a stale claim: one the claim functions would take over", async () => {
    const orgId = await ownedOrg("stale-claims-co");
    const rows = await seedOrgRows(db, orgId, "stale-claims-co");
    await closeCycles(orgId);
    await db.query("update public.invoices set status = 'processing', reviewed_at = now() - interval '11 minutes' where id = $1", [rows.invoiceId]);
    await db.query("update public.payment_intents set status = 'submitting', updated_at = now() - interval '3 minutes' where org_id = $1", [orgId]);
    // A processing invoice with no review time at all is stale too (claim_invoice_decision's coalesce).
    const second = (await db.query<{ id: string }>(
      "insert into public.invoices (org_id, direction, counterparty_id, amount, due_date, status) values ($1, 'payable', $2, 1, now(), 'processing') returning id",
      [orgId, rows.counterpartyId]
    )).rows[0].id;
    expect(second).toBeTruthy();

    await deleteOrg(orgId);

    expect(await exists(orgId)).toBe(false);
  });

  it("checks the refusals in order: the founding workspace before anything else", async () => {
    // The founding workspace is live and not paused: it is still refused as the founding one.
    await expect(deleteOrg(FOUNDING_ORG_ID)).rejects.toThrow(/founding_org/);
  });
});

describe("the tombstone (0031, W4)", () => {
  it("keeps the slug, name, who deleted it, the ledger's length, and its head's hash and signing key id", async () => {
    const orgId = await ownedOrg("tombstone-co");
    await db.query("update public.orgs set name = 'Tombstone Co' where id = $1", [orgId]);
    const key = crypto.generateKeyPairSync("ed25519");
    await appendSignedForOrg(db, orgId, { actor: "system", domain: "system", action: "note", summary: "one", detail: {} }, key.privateKey);
    await appendSignedForOrg(db, orgId, { actor: "system", domain: "system", action: "note", summary: "two", detail: {} }, key.privateKey);
    const head = await appendSignedForOrg(db, orgId, { actor: "human", domain: "system", action: "note", summary: "three", detail: {} }, key.privateKey);
    // Another org's later entry is not this org's head.
    const other = await ownedOrg("tombstone-neighbour-co");
    await appendSignedForOrg(db, other, { actor: "system", domain: "system", action: "note", summary: "x", detail: {} }, crypto.generateKeyPairSync("ed25519").privateKey);

    const before = Date.now();
    await deleteOrg(orgId);

    const tombstone = await tombstoneOf(orgId);
    expect(tombstone).toMatchObject({
      org_id: orgId,
      slug: "tombstone-co",
      name: "Tombstone Co",
      deleted_by: owner,
      ledger_entries: 3,
      ledger_head_hash: head.hash,
      ledger_signing_key_id: ledgerKeyId(key.privateKey),
    });
    expect(tombstone.ledger_head_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(tombstone.deleted_at.getTime()).toBeGreaterThanOrEqual(before - 60_000);
  });

  it("records an empty ledger as zero entries and no head", async () => {
    const orgId = await ownedOrg("empty-ledger-co");

    await deleteOrg(orgId);

    expect(await tombstoneOf(orgId)).toMatchObject({
      org_id: orgId, ledger_entries: 0, ledger_head_hash: null, ledger_signing_key_id: null,
    });
  });


  it("writes no tombstone when the delete is refused", async () => {
    const orgId = await ownedOrg("refused-tombstone-co");
    await db.query("update public.orgs set mode = 'live' where id = $1", [orgId]);
    await expect(deleteOrg(orgId)).rejects.toThrow(/pause_first/);
    expect(await tombstoneOf(orgId)).toBeUndefined();
  });
});

describe("the cascade (0031, W5)", () => {
  it("leaves no row of the org in any table, webhooks, API keys, memberships and invitations included", async () => {
    const orgId = await populated("cascade-co");
    const before = await remaining(orgId);
    for (const table of [...TENANT_TABLES, ...PLATFORM_TABLES, "orgs"]) {
      expect(before[table], `${table} was seeded`).toBeGreaterThan(0);
    }
    // At least one delivery for a ledger entry, and the test event.
    expect(before.webhook_deliveries).toBeGreaterThanOrEqual(2);

    await deleteOrg(orgId);

    expect(await remaining(orgId)).toEqual({});
    expect((await tombstoneOf(orgId)).ledger_entries).toBe(1);
  });

  it("covers every org-scoped table in the schema: a new one fails here until it is seeded and deleted", async () => {
    expect(await orgScopedTables()).toEqual([...TENANT_TABLES, ...PLATFORM_TABLES].sort());
  });

  it("leaves another org's rows untouched", async () => {
    const kept = await populated("kept-co");
    const doomed = await populated("doomed-co");
    const before = await remaining(kept);

    await deleteOrg(doomed);

    expect(await remaining(kept)).toEqual(before);
    expect(await tombstoneOf(kept)).toBeUndefined();
    // The owner's other memberships survive: the last-owner trigger let only the deleted org's go.
    expect((await db.query("select 1 from public.memberships where org_id = $1 and user_id = $2", [kept, owner])).rows).toHaveLength(1);
  });

  it("clears the purge flag, so cycle snapshots are append-only again in the same transaction", async () => {
    const survivor = await populated("purge-flag-survivor-co");
    const doomed = await ownedOrg("purge-flag-doomed-co");

    await expect(
      asServiceRole(db, async (tx) => {
        await tx.query("select public.delete_org($1, $2)", [doomed, owner]);
        // Even had the flag named the survivor, it must now be empty.
        const flag = (await tx.query<{ flag: string | null }>("select current_setting('vestiarion.purging_org', true) as flag")).rows[0].flag;
        expect(flag ?? "").toBe("");
        await tx.query("delete from public.cycle_snapshots where org_id = $1", [survivor]);
      })
    ).rejects.toThrow(/append-only/);
  });
});

describe("grants (0031)", () => {
  it("delete_org can be executed by the service role only", async () => {
    const orgId = await ownedOrg("guarded-co");
    await expect(
      asTenant(db, orgId, (tx) => tx.query("select public.delete_org($1, $2)", [orgId, owner]))
    ).rejects.toThrow(/permission denied/);
    await expect(
      asRole(db, "authenticated", (tx) => tx.query("select public.delete_org($1, $2)", [orgId, owner]))
    ).rejects.toThrow(/permission denied/);
    await expect(
      asRole(db, "anon", (tx) => tx.query("select public.delete_org($1, $2)", [orgId, owner]))
    ).rejects.toThrow(/permission denied/);
    expect(await exists(orgId)).toBe(true);
  });

  it("deleted_orgs is closed to the tenant and browser roles", async () => {
    const orgId = await ownedOrg("closed-table-co");
    await expect(asTenant(db, orgId, (tx) => tx.query("select * from public.deleted_orgs"))).rejects.toThrow(/permission denied/);
    await expect(asRole(db, "authenticated", (tx) => tx.query("select * from public.deleted_orgs"))).rejects.toThrow(/permission denied/);
    await expect(asRole(db, "anon", (tx) => tx.query("select * from public.deleted_orgs"))).rejects.toThrow(/permission denied/);
    await expect(
      asRole(db, "authenticated", (tx) =>
        tx.query("insert into public.deleted_orgs (org_id, slug, name, ledger_entries) values (gen_random_uuid(), 'x', 'x', 0)"))
    ).rejects.toThrow(/permission denied/);
  });

  it("deleted_orgs has RLS on and no policy", async () => {
    const rls = await db.query<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_catalog.pg_class where oid = 'public.deleted_orgs'::regclass"
    );
    expect(rls.rows[0].relrowsecurity).toBe(true);
    const policies = await db.query("select 1 from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'deleted_orgs'");
    expect(policies.rows).toHaveLength(0);
  });

  it("the service role reads deleted_orgs", async () => {
    const rows = await asServiceRole(db, async (tx) => (await tx.query("select org_id from public.deleted_orgs")).rows);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("delete_org is a definer function with an empty search_path", async () => {
    const fn = await db.query<{ prosecdef: boolean; proconfig: string[] | null }>(
      "select prosecdef, proconfig from pg_catalog.pg_proc where oid = 'public.delete_org(uuid, uuid)'::regprocedure"
    );
    expect(fn.rows[0].prosecdef).toBe(true);
    expect(fn.rows[0].proconfig).toContain('search_path=""');
  });
});

describe("replay (0031)", () => {
  it("is idempotent: tombstones survive, the grants stay closed, and deleting still works", async () => {
    const orgId = await ownedOrg("replay-doomed-co");
    await deleteOrg(orgId);
    const tombstone = await tombstoneOf(orgId);

    await applyMigrations(db);
    await applyMigrations(db);

    expect(await tombstoneOf(orgId)).toEqual(tombstone);
    const next = await ownedOrg("replay-next-co");
    await expect(
      asRole(db, "authenticated", (tx) => tx.query("select public.delete_org($1, $2)", [next, owner]))
    ).rejects.toThrow(/permission denied/);
    await expect(asRole(db, "anon", (tx) => tx.query("select * from public.deleted_orgs"))).rejects.toThrow(/permission denied/);
    await deleteOrg(next);
    expect(await exists(next)).toBe(false);
  });
});
