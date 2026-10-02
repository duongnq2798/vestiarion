import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, createDatabase, createOrg, createUser } from "./support/pglite";

/**
 * Migration 0054 (docs/superpowers/specs/2026-10-02-usyc-live-design.md R1): when a live workspace's
 * USYC reserve was turned on, and by whom, through a function that checks the person's role itself,
 * turns it on once, and is the service role's alone.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
}, 60_000);

afterAll(async () => {
  await db.close();
});

async function workspace(slug: string, mode: "live" | "sandbox" = "live"): Promise<string> {
  const orgId = await createOrg(db, slug);
  await db.query("update public.orgs set mode = $2 where id = $1", [orgId, mode]);
  return orgId;
}

async function member(orgId: string, role: string): Promise<string> {
  const user = await createUser(db, `${role}-${orgId.slice(0, 8)}@acme.test`);
  await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, $3)", [orgId, user, role]);
  return user;
}

const enable = (orgId: string, actor: string) => db.query<{ enable_usyc_reserve: string }>("select public.enable_usyc_reserve($1, $2)", [orgId, actor]);

describe("enable_usyc_reserve (0054)", () => {
  it("lets an owner or admin turn a live workspace's reserve on, once, and records who", async () => {
    const orgId = await workspace("usyc-owner");
    const admin = await member(orgId, "admin");
    const at = (await enable(orgId, admin)).rows[0].enable_usyc_reserve;
    expect(at).toBeTruthy();
    const row = (await db.query<{ usyc_live_at: string; usyc_live_by: string }>("select usyc_live_at, usyc_live_by from public.orgs where id = $1", [orgId])).rows[0];
    expect(row.usyc_live_by).toBe(admin);
    await expect(enable(orgId, await member(orgId, "owner"))).rejects.toThrow(/already_live/);
  });

  it("refuses an approver, a viewer and a stranger", async () => {
    const orgId = await workspace("usyc-roles");
    await expect(enable(orgId, await member(orgId, "approver"))).rejects.toThrow(/usyc_not_permitted/);
    await expect(enable(orgId, await member(orgId, "viewer"))).rejects.toThrow(/usyc_not_permitted/);
    await expect(enable(orgId, await createUser(db, "stranger@acme.test"))).rejects.toThrow(/not_a_member/);
  });

  it("refuses a sandbox, which has no wallets to hold USYC", async () => {
    const orgId = await workspace("usyc-sandbox", "sandbox");
    await expect(enable(orgId, await member(orgId, "owner"))).rejects.toThrow(/not_live/);
  });

  it("is the service role's alone", async () => {
    const orgId = await workspace("usyc-grants");
    const owner = await member(orgId, "owner");
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select public.enable_usyc_reserve($1, $2)", [orgId, owner]))).rejects.toThrow(/permission denied/);
    }
  });
});
