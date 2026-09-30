import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg, createUser } from "./support/pglite";

/**
 * Migration 0039 (docs/superpowers/specs/2026-09-30-payee-links-design.md):
 * one-time links a payee uses to enter their own Arc address. Only a hash of
 * each token is stored; a link works once, expires, and a new one revokes the
 * payee's unused one; nothing but the service role reaches the table.
 */

let db: PGlite;
let user: string;
let orgA: string;
let orgB: string;
let payeeA: string;
let payeeB: string;

const hash = (n: number) => n.toString(16).padStart(64, "0");
const inAWeek = "2099-01-01T00:00:00Z";

async function counterparty(orgId: string, name: string): Promise<string> {
  return (await db.query<{ id: string }>("insert into public.counterparties (org_id, name, role) values ($1, $2, 'vendor') returning id", [orgId, name]))
    .rows[0].id;
}

async function create(orgId: string, counterpartyId: string, n: number, expiresAt = inAWeek): Promise<{ id: string }> {
  return (
    await db.query<{ id: string }>("select id from public.create_payee_link($1, $2, $3, $4, $5::timestamptz)", [orgId, counterpartyId, hash(n), user, expiresAt])
  ).rows[0];
}

const claim = async (n: number) =>
  (await db.query<{ link_id: string; org_id: string; counterparty_id: string }>("select * from public.claim_payee_link($1)", [hash(n)])).rows;

const preview = async (n: number) =>
  (await db.query<{ org_name: string; counterparty_name: string; expires_at: string }>("select * from public.payee_link_preview($1)", [hash(n)])).rows;

const row = async (id: string) =>
  (await db.query<{ used_at: string | null; revoked_at: string | null }>("select used_at, revoked_at from public.payee_links where id = $1", [id])).rows[0];

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  user = await createUser(db, "owner@acme.test");
  orgA = await createOrg(db, "acme");
  orgB = await createOrg(db, "other");
  payeeA = await counterparty(orgA, "Northwind");
  payeeB = await counterparty(orgB, "Elsewhere");
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("payee_links (0039)", () => {
  it("previews a usable link with the workspace's and the payee's names", async () => {
    await create(orgA, payeeA, 1);
    expect(await preview(1)).toEqual([{ org_name: "acme", counterparty_name: "Northwind", expires_at: expect.anything() }]);
  });

  it("works once: the first claim gets the link, the second nothing", async () => {
    await create(orgA, payeeA, 2);
    expect(await claim(2)).toEqual([{ link_id: expect.any(String), org_id: orgA, counterparty_id: payeeA }]);
    expect(await claim(2)).toEqual([]);
    expect(await preview(2)).toEqual([]);
  });

  it("can be released after a failed submission, and claimed again", async () => {
    const link = await create(orgA, payeeA, 3);
    await claim(3);
    await db.query("select public.release_payee_link($1)", [link.id]);
    expect(await claim(3)).toHaveLength(1);
  });

  it("refuses an expired link", async () => {
    await create(orgA, payeeA, 4, "2020-01-01T00:00:00Z");
    expect(await preview(4)).toEqual([]);
    expect(await claim(4)).toEqual([]);
  });

  it("revokes the payee's unused link when a new one is created, and leaves a used one alone", async () => {
    const used = await create(orgA, payeeA, 5);
    await claim(5);
    const old = await create(orgA, payeeA, 6);
    const fresh = await create(orgA, payeeA, 7);
    expect((await row(old.id)).revoked_at).not.toBeNull();
    expect((await row(used.id)).revoked_at).toBeNull();
    expect((await row(fresh.id)).revoked_at).toBeNull();
    expect(await claim(6)).toEqual([]);
    expect(await claim(7)).toHaveLength(1);
  });

  it("refuses a counterparty from another workspace", async () => {
    await expect(create(orgA, payeeB, 8)).rejects.toThrow(/counterparty_not_found/);
  });

  it("revokes an unused link of its own workspace only, and never a used one", async () => {
    const link = await create(orgA, payeeA, 9);
    const revokedElsewhere = await db.query<{ revoked: boolean }>("select public.revoke_payee_link($1, $2, $3) as revoked", [orgB, link.id, user]);
    expect(revokedElsewhere.rows[0].revoked).toBe(false);
    const revoked = await db.query<{ revoked: boolean }>("select public.revoke_payee_link($1, $2, $3) as revoked", [orgA, link.id, user]);
    expect(revoked.rows[0].revoked).toBe(true);
    expect(await claim(9)).toEqual([]);

    const used = await create(orgA, payeeA, 10);
    await claim(10);
    const again = await db.query<{ revoked: boolean }>("select public.revoke_payee_link($1, $2, $3) as revoked", [orgA, used.id, user]);
    expect(again.rows[0].revoked).toBe(false);
  });

  it("stores only a 64-hex hash", async () => {
    await expect(
      db.query("select public.create_payee_link($1, $2, $3, $4, $5::timestamptz)", [orgA, payeeA, "vxp_plaintext", user, inAWeek])
    ).rejects.toThrow(/payee_links_token_hash_check/);
  });

  it("goes with its payee", async () => {
    const payee = await counterparty(orgA, "Short-lived");
    const link = await create(orgA, payee, 11);
    await db.query("delete from public.counterparties where id = $1", [payee]);
    expect(await row(link.id)).toBeUndefined();
  });

  it("runs for the service role", async () => {
    await asServiceRole(db, (tx) => tx.query("select * from public.payee_link_preview($1)", [hash(1)]));
  });

  it("is closed to the browser roles and the tenant role", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select * from public.payee_links"))).rejects.toThrow(/permission denied/);
      await expect(asRole(db, role, (tx) => tx.query("select * from public.claim_payee_link($1)", [hash(1)]))).rejects.toThrow(/permission denied/);
      await expect(asRole(db, role, (tx) => tx.query("select * from public.payee_link_preview($1)", [hash(1)]))).rejects.toThrow(/permission denied/);
    }
    await expect(asTenant(db, orgA, (tx) => tx.query("select * from public.payee_links"))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, orgA, (tx) => tx.query("select * from public.claim_payee_link($1)", [hash(1)]))).rejects.toThrow(/permission denied/);
  });
});
