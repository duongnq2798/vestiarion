import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg } from "./support/pglite";

/**
 * Migration 0029 (go-live design L2, review focus "A sandbox that went quiet
 * after connecting"): `delete_sandbox_org` (0022, redefined here) gains one
 * refusal — a sandbox holding Circle credentials is never deleted
 * automatically, connected or not yet live. Everything else about it,
 * including the grants, is unchanged.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
}, 60_000);

afterAll(async () => {
  await db.close();
});

const ENVELOPE = { v: 1, iv: "x", tag: "y", data: "z" };

const purge = (orgId: string, cutoff: string) =>
  asServiceRole(db, async (tx) =>
    (await tx.query<{ deleted: boolean }>(
      "select public.delete_sandbox_org($1, $2::timestamptz) as deleted", [orgId, cutoff]
    )).rows[0].deleted);

describe("delete_sandbox_org (0029)", () => {
  it("refuses an inactive sandbox that holds Circle credentials", async () => {
    const orgId = await createOrg(db, "connected-co");
    await db.query(
      "update public.orgs set last_active_at = now() - interval '400 days', circle_api_key_enc = $2::jsonb where id = $1",
      [orgId, JSON.stringify(ENVELOPE)]
    );

    await expect(purge(orgId, new Date().toISOString())).rejects.toThrow(/has_circle_credentials/);

    expect((await db.query("select 1 from public.orgs where id = $1", [orgId])).rows).toHaveLength(1);
  });

  it("still deletes an inactive sandbox that never connected Circle", async () => {
    const orgId = await createOrg(db, "unconnected-co");
    await db.query("update public.orgs set last_active_at = now() - interval '400 days' where id = $1", [orgId]);

    expect(await purge(orgId, new Date().toISOString())).toBe(true);

    expect((await db.query("select 1 from public.orgs where id = $1", [orgId])).rows).toHaveLength(0);
  });

  it("is idempotent across a replay of every migration", async () => {
    await applyMigrations(db);

    const orgId = await createOrg(db, "replay-co");
    await db.query(
      "update public.orgs set last_active_at = now() - interval '400 days', circle_api_key_enc = $2::jsonb where id = $1",
      [orgId, JSON.stringify(ENVELOPE)]
    );
    await expect(purge(orgId, new Date().toISOString())).rejects.toThrow(/has_circle_credentials/);
  });

  it("keeps the grants unchanged: only the service role can execute it", async () => {
    const orgId = await createOrg(db, "guarded-co");
    await expect(
      asTenant(db, orgId, (tx) => tx.query("select public.delete_sandbox_org($1, now())", [orgId]))
    ).rejects.toThrow(/permission denied/);
    await expect(
      asRole(db, "authenticated", (tx) => tx.query("select public.delete_sandbox_org($1, now())", [orgId]))
    ).rejects.toThrow(/permission denied/);
    await expect(
      asRole(db, "anon", (tx) => tx.query("select public.delete_sandbox_org($1, now())", [orgId]))
    ).rejects.toThrow(/permission denied/);
  });
});
