import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg, createUser } from "./support/pglite";

/**
 * Migration 0131 (docs/superpowers/specs/2026-10-18-supplier-status-design.md V1, V4): a supplier's payment status link,
 * kept only as the SHA-256 of its secret, for a vendor or contractor only, one live per supplier, expiring and stopped
 * once; and the lookup, which names nothing of an expired link and answers null for a stopped one. The page takes no
 * write from the link, so there is nothing else.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  // Re-runnable, as scripts/migrate.ts re-runs every file.
  await applyMigrations(db, (file) => file.startsWith("0131_"));
}, 60_000);

afterAll(async () => {
  await db.close();
});

let counter = 0;
const nextHash = () => (++counter).toString(16).padStart(64, "0");

async function counterparty(orgId: string, name = "Cobalt Cloud", role = "vendor"): Promise<string> {
  return (await db.query<{ id: string }>("insert into public.counterparties (org_id, name, role) values ($1, $2, $3) returning id", [orgId, name, role])).rows[0].id;
}

async function link(orgId: string, counterpartyId: string, hash = nextHash(), expiresIn = "30 days"): Promise<{ id: string; hash: string }> {
  const id = (
    await db.query<{ id: string }>(
      "insert into public.supplier_status_links (org_id, counterparty_id, token_hash, expires_at) values ($1, $2, $3, now() + $4::interval) returning id",
      [orgId, counterpartyId, hash, expiresIn]
    )
  ).rows[0].id;
  return { id, hash };
}

const lookUp = (hash: string) =>
  asServiceRole(db, async (tx) => (await tx.query<{ found: Record<string, unknown> | null }>("select public.supplier_status_by_token($1) as found", [hash])).rows[0].found);

describe("supplier_status_links (0131)", () => {
  it("keeps a link's hash and expiry, for a vendor only, one live per vendor", async () => {
    const orgId = await createOrg(db, "supplier-links");
    const vendor = await counterparty(orgId);
    const contractor = await counterparty(orgId, "Alder Copywriting", "contractor");
    const client = await counterparty(orgId, "Harbor Design", "client");
    const first = await link(orgId, vendor);
    await expect(link(orgId, contractor)).rejects.toThrow(/supplier_status_not_supplier/);
    await expect(link(orgId, client)).rejects.toThrow(/supplier_status_not_supplier/);
    await expect(link(orgId, vendor)).rejects.toThrow(/supplier_status_links_one_live/);
    await db.query("update public.supplier_status_links set revoked_at = now() where id = $1", [first.id]);
    await link(orgId, vendor);
  });

  it("takes only a 64-character hex hash, once, and an expiry within about 90 days", async () => {
    const orgId = await createOrg(db, "supplier-hash");
    const a = await counterparty(orgId, "A");
    const b = await counterparty(orgId, "B");
    const c = await counterparty(orgId, "C");
    const taken = await link(orgId, a);
    await expect(link(orgId, b, taken.hash)).rejects.toThrow(/supplier_status_links_token_hash_key/);
    await expect(link(orgId, b, "vxv_not-a-hash")).rejects.toThrow(/supplier_status_links_token_hash_check/);
    await expect(link(orgId, b, "AB".repeat(32))).rejects.toThrow(/supplier_status_links_token_hash_check/);
    await expect(link(orgId, b, nextHash(), "92 days")).rejects.toThrow(/supplier_status_links_expiry_check/);
    await expect(link(orgId, b, nextHash(), "-1 hour")).rejects.toThrow(/supplier_status_links_expiry_check/);
    await link(orgId, c, nextHash(), "90 days");
  });

  it("lets the tenant stop its own link once, and change nothing else of it", async () => {
    const orgId = await createOrg(db, "supplier-revoke");
    const person = await createUser(db, "owner-supplier@example.com");
    const { id } = await link(orgId, await counterparty(orgId));
    await asTenant(db, orgId, (tx) => tx.query("update public.supplier_status_links set revoked_at = now(), revoked_by = $2 where id = $1", [id, person]));
    const revoked = (await db.query<{ revoked_by: string }>("select revoked_by from public.supplier_status_links where id = $1", [id])).rows[0];
    expect(revoked.revoked_by).toBe(person);
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.supplier_status_links set revoked_at = null where id = $1", [id]))).rejects.toThrow(/supplier_status_link_revoked/);
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.supplier_status_links set expires_at = now() + interval '80 days' where id = $1", [id]))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.supplier_status_links set token_hash = $2 where id = $1", [id, nextHash()]))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, orgId, (tx) => tx.query("delete from public.supplier_status_links where id = $1", [id]))).rejects.toThrow(/permission denied/);
  });

  it("is seen, made and stopped only by its own workspace", async () => {
    const mine = await createOrg(db, "supplier-tenant-a");
    const theirs = await createOrg(db, "supplier-tenant-b");
    const myVendor = await counterparty(mine);
    const theirVendor = await counterparty(theirs);
    const theirLink = await link(theirs, theirVendor);
    const made = await asTenant(db, mine, async (tx) =>
      (
        await tx.query<{ id: string }>(
          "insert into public.supplier_status_links (org_id, counterparty_id, token_hash, expires_at) values ($1, $2, $3, now() + interval '7 days') returning id",
          [mine, myVendor, nextHash()]
        )
      ).rows
    );
    expect(made).toHaveLength(1);
    const seen = await asTenant(db, mine, async (tx) => (await tx.query<{ org_id: string }>("select org_id from public.supplier_status_links")).rows);
    expect(seen.every((row) => row.org_id === mine)).toBe(true);
    // Another workspace's supplier cannot be linked, whatever the row says.
    await expect(
      asTenant(db, mine, (tx) =>
        tx.query("insert into public.supplier_status_links (org_id, counterparty_id, token_hash, expires_at) values ($1, $2, $3, now() + interval '7 days')", [mine, theirVendor, nextHash()])
      )
    ).rejects.toThrow(/supplier_status_not_supplier|supplier_status_links_counterparty_fkey/);
    const stopped = await asTenant(db, mine, (tx) => tx.query("update public.supplier_status_links set revoked_at = now() where id = $1", [theirLink.id]));
    expect(stopped.affectedRows ?? 0).toBe(0);
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select 1 from public.supplier_status_links"))).rejects.toThrow(/permission denied/);
    }
  });

  it("takes from the tenant only what a new link needs: never the day it was made", async () => {
    // The expiry is bounded by created_at: a tenant that could write created_at could make a link that works for years.
    const orgId = await createOrg(db, "supplier-created-at");
    const vendor = await counterparty(orgId);
    await expect(
      asTenant(db, orgId, (tx) =>
        tx.query(
          "insert into public.supplier_status_links (org_id, counterparty_id, token_hash, created_at, expires_at) values ($1, $2, $3, now() + interval '5 years', now() + interval '5 years 30 days')",
          [orgId, vendor, nextHash()]
        )
      )
    ).rejects.toThrow(/permission denied/);
  });

  it("gives the browser roles and the tenant no use of its functions", async () => {
    for (const fn of ["supplier_status_links_supplier()", "supplier_status_links_revoke_once()"]) {
      for (const role of ["anon", "authenticated"]) {
        const granted = (await db.query<{ ok: boolean }>("select has_function_privilege($1, $2, 'execute') as ok", [role, `public.${fn}`])).rows[0].ok;
        expect(granted, `${role} on ${fn}`).toBe(false);
      }
    }
    for (const role of ["anon", "authenticated", "vestiarion_tenant"]) {
      const granted = (await db.query<{ ok: boolean }>("select has_function_privilege($1, 'public.supplier_status_by_token(text)', 'execute') as ok", [role])).rows[0].ok;
      expect(granted, `${role} on supplier_status_by_token`).toBe(false);
    }
  });

  it("goes with its supplier and its workspace", async () => {
    const orgId = await createOrg(db, "supplier-cascade");
    const vendor = await counterparty(orgId);
    const { hash } = await link(orgId, vendor);
    await db.query("delete from public.counterparties where id = $1", [vendor]);
    expect((await db.query("select 1 from public.supplier_status_links where token_hash = $1", [hash])).rows).toHaveLength(0);
  });
});

describe("supplier_status_by_token (0131)", () => {
  it("returns a live link's supplier, workspace and expiry", async () => {
    const orgId = await createOrg(db, "supplier-lookup");
    await db.query("update public.orgs set name = 'Pinecrest Studio' where id = $1", [orgId]);
    const vendor = await counterparty(orgId, "Cobalt Cloud");
    const { id, hash } = await link(orgId, vendor);
    expect(await lookUp(hash)).toMatchObject({
      expired: false,
      linkId: id,
      orgId,
      counterpartyId: vendor,
      orgName: "Pinecrest Studio",
      supplierName: "Cobalt Cloud",
      mode: "sandbox",
      network: "arc-testnet",
    });
  });

  it("names nothing of an expired link, and answers null for a stopped or unknown one", async () => {
    const orgId = await createOrg(db, "supplier-dead");
    const a = await counterparty(orgId, "Expired Ltd");
    const expired = await link(orgId, a);
    await db.query("update public.supplier_status_links set created_at = now() - interval '40 days', expires_at = now() - interval '10 days' where id = $1", [expired.id]);
    const found = await lookUp(expired.hash);
    expect(found).toMatchObject({ expired: true });
    expect(Object.keys(found ?? {}).sort()).toEqual(["expired", "expiresAt"]);

    const b = await counterparty(orgId, "Stopped Ltd");
    const stopped = await link(orgId, b);
    await db.query("update public.supplier_status_links set revoked_at = now() where id = $1", [stopped.id]);
    expect(await lookUp(stopped.hash)).toBeNull();
    expect(await lookUp(nextHash())).toBeNull();
  });
});
