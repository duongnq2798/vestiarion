import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg, createUser } from "./support/pglite";

/**
 * Migration 0101 (docs/superpowers/specs/2026-10-12-xero-connector-design.md X2, X5, X7): a workspace's connection to
 * an accounting provider, the tokens only the service role reads, the links from the provider's objects to the
 * workspace's rows, the bills waiting for a person, and the sync cursors. The tenant role reads and writes its own
 * workspace's connector rows, deletes none of them, and never sees a token. A refresh is serialized by a lease and a
 * compare-and-set on the token row's version.
 */

let db: PGlite;
let person: string;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  // Re-runnable, as scripts/migrate.ts re-runs every file.
  await applyMigrations(db, (file) => file.startsWith("0101_"));
  person = await createUser(db, "owner-xero@example.com");
}, 60_000);

afterAll(async () => {
  await db.close();
});

const ENVELOPE = JSON.stringify({ k: "t1", iv: "aXY=", tag: "dGFn", ct: "Y3Q=" });

async function connection(orgId: string, tenant = "tenant-1", status = "connected"): Promise<string> {
  return (
    await db.query<{ id: string }>(
      `insert into public.accounting_connections (org_id, provider, external_org_id, external_org_name, status, connected_by, consent_version, consented_at, window_from, revoked_at)
       values ($1, 'xero', $2, 'Demo Company (Global)', $3, $4, 'xero-2026-10-12', now(), '2026-07-14', case when $3 = 'revoked' then now() end) returning id`,
      [orgId, tenant, status, person]
    )
  ).rows[0].id;
}

async function tokens(orgId: string, connectionId: string | null, id = crypto.randomUUID()): Promise<string> {
  await db.query(
    `insert into public.accounting_tokens (id, org_id, provider, connection_id, authorized_by, access_token_enc, refresh_token_enc, access_expires_at, scopes, choices, choose_until)
     values ($1, $2, 'xero', $3, $4, $5::jsonb, $5::jsonb, now() + interval '30 minutes', array['offline_access'],
             case when $3::uuid is null then '[]'::jsonb end, case when $3::uuid is null then now() + interval '10 minutes' end)`,
    [id, orgId, connectionId, person, ENVELOPE]
  );
  return id;
}

async function bill(orgId: string, connectionId: string, externalId = "bill-1"): Promise<string> {
  return (
    await db.query<{ id: string }>(
      `insert into public.accounting_bills (org_id, connection_id, external_id, contact_external_id, contact_name, number, currency, total, amount_due, due_on, source_status, external_version)
       values ($1, $2, $3, 'contact-1', 'Acme Supplies', 'INV-0042', 'USD', 1250, 1250, '2026-10-30', 'open', '2026-10-12T08:00:00.000Z') returning id`,
      [orgId, connectionId, externalId]
    )
  ).rows[0].id;
}

describe("accounting_connections", () => {
  it("keeps one connection per workspace, provider and organisation, and one not revoked per workspace and provider", async () => {
    const orgId = await createOrg(db, "xero-one-active");
    const first = await connection(orgId, "tenant-a");
    await expect(connection(orgId, "tenant-b")).rejects.toThrow(/accounting_connections_one_active/);
    await expect(connection(orgId, "tenant-a", "revoked")).rejects.toThrow(/accounting_connections_external_key/);
    await db.query("update public.accounting_connections set status = 'revoked', revoked_at = now() where id = $1", [first]);
    expect(await connection(orgId, "tenant-b")).toBeTruthy();
  });

  it("refuses a provider it does not know, a status it does not know, and revoked without a time", async () => {
    const orgId = await createOrg(db, "xero-checks");
    await expect(
      db.query(
        `insert into public.accounting_connections (org_id, provider, external_org_id, consent_version, consented_at, window_from) values ($1, 'sage', 't', 'v', now(), '2026-07-14')`,
        [orgId]
      )
    ).rejects.toThrow(/accounting_connections_provider_check/);
    const id = await connection(orgId, "tenant-c");
    await expect(db.query("update public.accounting_connections set status = 'paused' where id = $1", [id])).rejects.toThrow(/status_check/);
    await expect(db.query("update public.accounting_connections set status = 'revoked' where id = $1", [id])).rejects.toThrow(/accounting_connections_revoked_check/);
  });

  it("is read and written by its own workspace only, and never deleted by the tenant role", async () => {
    const a = await createOrg(db, "xero-tenant-a");
    const b = await createOrg(db, "xero-tenant-b");
    await connection(a);
    const theirs = await connection(b);
    const seen = await asTenant(db, a, async (tx) => (await tx.query<{ org_id: string }>("select org_id from public.accounting_connections")).rows);
    expect(seen.map((row) => row.org_id)).toEqual([a]);
    const updated = await asTenant(db, a, (tx) => tx.query("update public.accounting_connections set last_error = 'x' where id = $1", [theirs]));
    expect(updated.affectedRows ?? 0).toBe(0);
    await expect(asTenant(db, a, (tx) => tx.query("delete from public.accounting_connections"))).rejects.toThrow(/permission denied/);
    await expect(asRole(db, "authenticated", (tx) => tx.query("select 1 from public.accounting_connections"))).rejects.toThrow(/permission denied/);
  });
});

describe("accounting_tokens", () => {
  it("is closed to the tenant role and the browser roles, and open to the service role", async () => {
    const orgId = await createOrg(db, "xero-tokens-closed");
    await tokens(orgId, await connection(orgId));
    await expect(asTenant(db, orgId, (tx) => tx.query("select 1 from public.accounting_tokens"))).rejects.toThrow(/permission denied/);
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select 1 from public.accounting_tokens"))).rejects.toThrow(/permission denied/);
    }
    const rows = await asServiceRole(db, async (tx) => (await tx.query("select 1 from public.accounting_tokens where org_id = $1", [orgId])).rows);
    expect(rows).toHaveLength(1);
  });

  it("holds a pending choice only without a connection, and one token row per connection", async () => {
    const orgId = await createOrg(db, "xero-tokens-pending");
    expect(await tokens(orgId, null)).toBeTruthy();
    const connectionId = await connection(orgId);
    await tokens(orgId, connectionId);
    await expect(tokens(orgId, connectionId)).rejects.toThrow(/accounting_tokens_connection_key/);
    await expect(
      db.query("update public.accounting_tokens set choose_until = now() where connection_id = $1", [connectionId])
    ).rejects.toThrow(/accounting_tokens_pending_check/);
  });

  it("refuses a connection of another workspace", async () => {
    const a = await createOrg(db, "xero-tokens-a");
    const b = await createOrg(db, "xero-tokens-b");
    await expect(tokens(a, await connection(b))).rejects.toThrow(/accounting_tokens_connection_fkey/);
  });
});

describe("the refresh lease and the compare-and-set", () => {
  const lease = (orgId: string, tokenId: string, holder: string, seconds = 60) =>
    asServiceRole(db, async (tx) =>
      (await tx.query<{ id: string; version: string }>("select id, version::text from public.accounting_token_lease($1, $2, $3, $4)", [orgId, tokenId, holder, seconds])).rows
    );
  const store = (orgId: string, tokenId: string, holder: string, version: number) =>
    asServiceRole(db, async (tx) =>
      (
        await tx.query<{ v: string | null }>(
          "select public.accounting_token_store($1, $2, $3, $4, $5::jsonb, $5::jsonb, now() + interval '30 minutes', array['offline_access']) as v",
          [orgId, tokenId, holder, version, ENVELOPE]
        )
      ).rows[0].v
    );

  it("gives the lease to one holder at a time, and to the next once it expires or is released", async () => {
    const orgId = await createOrg(db, "xero-lease");
    const tokenId = await tokens(orgId, await connection(orgId));
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    expect(await lease(orgId, tokenId, first)).toHaveLength(1);
    expect(await lease(orgId, tokenId, second)).toHaveLength(0);
    await asServiceRole(db, (tx) => tx.query("select public.accounting_token_release($1, $2, $3)", [orgId, tokenId, first]));
    expect(await lease(orgId, tokenId, second, 0)).toHaveLength(1);
    // A lease of no seconds is already over: the next holder takes it.
    expect(await lease(orgId, tokenId, first)).toHaveLength(1);
  });

  it("stores only for the holder of the lease at the version it read, bumps the version and frees the lease", async () => {
    const orgId = await createOrg(db, "xero-store");
    const tokenId = await tokens(orgId, await connection(orgId));
    const holder = crypto.randomUUID();
    const [leased] = await lease(orgId, tokenId, holder);
    const version = Number(leased.version);
    expect(await store(orgId, tokenId, crypto.randomUUID(), version)).toBeNull();
    expect(await store(orgId, tokenId, holder, version + 1)).toBeNull();
    expect(Number(await store(orgId, tokenId, holder, version))).toBe(version + 1);
    // Stored once: the same holder and version cannot store again.
    expect(await store(orgId, tokenId, holder, version)).toBeNull();
    const row = (await db.query<{ lease_holder: string | null }>("select lease_holder from public.accounting_tokens where id = $1", [tokenId])).rows[0];
    expect(row.lease_holder).toBeNull();
  });

  it("never leases a pending row, nor another workspace's", async () => {
    const orgId = await createOrg(db, "xero-lease-pending");
    const pending = await tokens(orgId, null);
    expect(await lease(orgId, pending, crypto.randomUUID())).toHaveLength(0);
    const other = await createOrg(db, "xero-lease-other");
    const tokenId = await tokens(orgId, await connection(orgId));
    expect(await lease(other, tokenId, crypto.randomUUID())).toHaveLength(0);
  });

  it("is the service role's alone", async () => {
    const orgId = await createOrg(db, "xero-lease-roles");
    const tokenId = await tokens(orgId, await connection(orgId));
    await expect(
      asTenant(db, orgId, (tx) => tx.query("select * from public.accounting_token_lease($1, $2, $3, 60)", [orgId, tokenId, crypto.randomUUID()]))
    ).rejects.toThrow(/permission denied/);
  });
});

describe("accounting_connections_due", () => {
  it("lists connected connections past their next sync and not leased, oldest synced first", async () => {
    const due = (await createOrg(db, "xero-due"));
    const later = await createOrg(db, "xero-due-later");
    const leased = await createOrg(db, "xero-due-leased");
    const gone = await createOrg(db, "xero-due-revoked");
    const dueId = await connection(due);
    const laterId = await connection(later);
    const leasedId = await connection(leased);
    await connection(gone, "tenant-1", "revoked");
    await db.query("update public.accounting_connections set next_sync_after = now() + interval '1 hour' where id = $1", [laterId]);
    await db.query("update public.accounting_connections set sync_lease_until = now() + interval '5 minutes' where id = $1", [leasedId]);
    const rows = await asServiceRole(db, async (tx) =>
      (await tx.query<{ org_id: string; connection_id: string; provider: string }>("select * from public.accounting_connections_due(500)")).rows
    );
    const ids = rows.map((row) => row.connection_id);
    expect(ids).toContain(dueId);
    expect(ids).not.toContain(laterId);
    expect(ids).not.toContain(leasedId);
    expect(rows.find((row) => row.connection_id === dueId)).toMatchObject({ org_id: due, provider: "xero" });
    await expect(asTenant(db, due, (tx) => tx.query("select * from public.accounting_connections_due(5)"))).rejects.toThrow(/permission denied/);
  });
});

describe("external_links", () => {
  it("links an external object once, and a local row once per organisation and type", async () => {
    const orgId = await createOrg(db, "xero-links");
    const connectionId = await connection(orgId);
    const counterparty = (await db.query<{ id: string }>("insert into public.counterparties (org_id, name, role) values ($1, 'Acme', 'vendor') returning id", [orgId])).rows[0].id;
    const link = (externalId: string, localId: string | null) =>
      db.query(
        `insert into public.external_links (org_id, connection_id, provider, external_org_id, object_type, external_id, local_id, linked_at, label)
         values ($1, $2, 'xero', 'tenant-1', 'contact', $3, $4, case when $4::uuid is null then null else now() end, 'Acme')`,
        [orgId, connectionId, externalId, localId]
      );
    await link("contact-1", counterparty);
    await expect(link("contact-1", null)).rejects.toThrow(/external_links_external_key/);
    await expect(link("contact-2", counterparty)).rejects.toThrow(/external_links_local_key/);
    await link("contact-3", null);
    await expect(
      db.query("update public.external_links set linked_at = null where external_id = 'contact-1' and org_id = $1", [orgId])
    ).rejects.toThrow(/external_links_linked_check/);
  });

  it("refuses a connection of another workspace", async () => {
    const a = await createOrg(db, "xero-links-a");
    const b = await createOrg(db, "xero-links-b");
    const theirs = await connection(b);
    await expect(
      db.query(
        "insert into public.external_links (org_id, connection_id, provider, external_org_id, object_type, external_id) values ($1, $2, 'xero', 'tenant-1', 'bill', 'b')",
        [a, theirs]
      )
    ).rejects.toThrow(/external_links_connection_fkey/);
  });
});

describe("accounting_bills and accounting_sync_cursors", () => {
  it("keeps a bill once per connection, with a review state and what the provider says of it", async () => {
    const orgId = await createOrg(db, "xero-bills");
    const connectionId = await connection(orgId);
    await bill(orgId, connectionId);
    await expect(bill(orgId, connectionId)).rejects.toThrow(/accounting_bills_external_key/);
    await expect(db.query("update public.accounting_bills set review_state = 'paid' where org_id = $1", [orgId])).rejects.toThrow(/review_state_check/);
    await expect(db.query("update public.accounting_bills set source_status = 'AUTHORISED' where org_id = $1", [orgId])).rejects.toThrow(/source_status_check/);
    await expect(db.query("update public.accounting_bills set currency = 'usd' where org_id = $1", [orgId])).rejects.toThrow(/currency_check/);
  });

  it("keeps one cursor per connection and object type", async () => {
    const orgId = await createOrg(db, "xero-cursors");
    const connectionId = await connection(orgId);
    const cursor = () =>
      db.query("insert into public.accounting_sync_cursors (org_id, connection_id, object_type) values ($1, $2, 'bill')", [orgId, connectionId]);
    await cursor();
    await expect(cursor()).rejects.toThrow(/accounting_sync_cursors_key/);
    await expect(db.query("update public.accounting_sync_cursors set page = 0 where org_id = $1", [orgId])).rejects.toThrow(/page_check/);
  });

  it("goes with its workspace: connection, tokens, links, bills and cursors", async () => {
    const orgId = await createOrg(db, "xero-cascade");
    const connectionId = await connection(orgId);
    await tokens(orgId, connectionId);
    await tokens(orgId, null);
    await bill(orgId, connectionId);
    await db.query("insert into public.accounting_sync_cursors (org_id, connection_id, object_type) values ($1, $2, 'contact')", [orgId, connectionId]);
    await db.query(
      "insert into public.external_links (org_id, connection_id, provider, external_org_id, object_type, external_id) values ($1, $2, 'xero', 'tenant-1', 'bill', 'bill-1')",
      [orgId, connectionId]
    );
    await db.query("delete from public.orgs where id = $1", [orgId]);
    for (const table of ["accounting_connections", "accounting_tokens", "external_links", "accounting_bills", "accounting_sync_cursors"]) {
      expect((await db.query(`select 1 from public.${table} where org_id = $1`, [orgId])).rows, table).toHaveLength(0);
    }
  });
});
