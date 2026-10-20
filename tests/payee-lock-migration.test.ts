import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asTenant, createDatabase, createOrg, createUser } from "./support/pglite";

/**
 * Migration 0135 (docs/superpowers/specs/2026-10-20-payee-lock-design.md PL1): a workspace's payee lock on its
 * approval_policies row, off with no cooling-off by default, the cooling-off between 0 and 168 hours, and re-runnable.
 */

let db: PGlite;
let owner: string;
let org: string, other: string;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  owner = await createUser(db, "lock-owner@example.com");
  org = await createOrg(db, "payee-lock-co");
  other = await createOrg(db, "payee-lock-other");
  await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'owner')", [org, owner]);
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("approval_policies' payee lock", () => {
  it("is off with no cooling-off for a workspace that never set it", async () => {
    await db.query("insert into public.approval_policies (org_id) values ($1) on conflict (org_id) do nothing", [org]);
    const rows = await db.query<{ payee_lock: boolean; payee_lock_cooling_hours: number }>(
      "select payee_lock, payee_lock_cooling_hours from public.approval_policies where org_id = $1",
      [org]
    );
    expect(rows.rows[0]).toEqual({ payee_lock: false, payee_lock_cooling_hours: 0 });
  });

  it("takes a cooling-off from 0 to 168 hours and refuses any other", async () => {
    await db.query("update public.approval_policies set payee_lock = true, payee_lock_cooling_hours = 168 where org_id = $1", [org]);
    await expect(db.query("update public.approval_policies set payee_lock_cooling_hours = 169 where org_id = $1", [org])).rejects.toThrow(
      /approval_policies_payee_lock_cooling_hours_check/
    );
    await expect(db.query("update public.approval_policies set payee_lock_cooling_hours = -1 where org_id = $1", [org])).rejects.toThrow(
      /approval_policies_payee_lock_cooling_hours_check/
    );
  });

  it("is the workspace's own: the tenant role sees and changes only its own row", async () => {
    await db.query("insert into public.approval_policies (org_id, payee_lock) values ($1, true) on conflict (org_id) do update set payee_lock = true", [other]);
    const seen = await asTenant(db, org, (tx) => tx.query<{ org_id: string }>("select org_id from public.approval_policies"));
    expect(seen.rows.map((row) => row.org_id)).toEqual([org]);
    await asTenant(db, org, (tx) => tx.query("update public.approval_policies set payee_lock_cooling_hours = 24"));
    const theirs = await db.query<{ payee_lock_cooling_hours: number }>("select payee_lock_cooling_hours from public.approval_policies where org_id = $1", [other]);
    expect(theirs.rows[0].payee_lock_cooling_hours).toBe(0);
  });

  it("runs again without error or change", async () => {
    const sql = readFileSync(path.join(process.cwd(), "supabase/migrations/0135_payee_lock.sql"), "utf8");
    await db.exec(sql);
    await db.exec(sql);
    const rows = await db.query<{ payee_lock: boolean; payee_lock_cooling_hours: number }>(
      "select payee_lock, payee_lock_cooling_hours from public.approval_policies where org_id = $1",
      [org]
    );
    expect(rows.rows[0].payee_lock).toBe(true);
  });
});
