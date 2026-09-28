import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg, seedOrgRows, TENANT_TABLES,
} from "./support/pglite";

/**
 * Migration 0022 (spec §6 "Abandoned sandboxes", §10 step 5b): activity is
 * refreshed at most hourly, an abandoned sandbox is deleted whole, a live
 * organization never is, and the sandbox cycle cap is checked and the run
 * opened in one transaction.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
}, 60_000);

afterAll(async () => {
  await db.close();
});

const lastActive = async (orgId: string) =>
  (await db.query<{ t: Date }>("select last_active_at as t from public.orgs where id = $1", [orgId])).rows[0].t;

describe("touch_org_activity", () => {
  it("refreshes last_active_at only when it is more than an hour old", async () => {
    const orgId = await createOrg(db, "touch-co");
    await db.query("update public.orgs set last_active_at = now() - interval '30 minutes' where id = $1", [orgId]);
    const before = await lastActive(orgId);
    await asServiceRole(db, (tx) => tx.query("select public.touch_org_activity($1)", [orgId]));
    expect(await lastActive(orgId)).toEqual(before);

    await db.query("update public.orgs set last_active_at = now() - interval '2 hours' where id = $1", [orgId]);
    await asServiceRole(db, (tx) => tx.query("select public.touch_org_activity($1)", [orgId]));
    expect(Date.now() - (await lastActive(orgId)).getTime()).toBeLessThan(60_000);
  });
});

describe("delete_sandbox_org", () => {
  const purge = (orgId: string, cutoff: string) =>
    asServiceRole(db, async (tx) =>
      (await tx.query<{ deleted: boolean }>("select public.delete_sandbox_org($1, $2::timestamptz) as deleted", [orgId, cutoff])).rows[0].deleted);

  it("deletes an inactive sandbox and every row it owns, ledger included, and nothing of anyone else's", async () => {
    const doomed = await createOrg(db, "doomed-co");
    const kept = await createOrg(db, "kept-co");
    await seedOrgRows(db, doomed, "doomed");
    await seedOrgRows(db, kept, "kept");
    await db.query("update public.orgs set last_active_at = now() - interval '61 days' where id = $1", [doomed]);

    expect(await purge(doomed, new Date(Date.now() - 60 * 86_400_000).toISOString())).toBe(true);

    expect((await db.query("select 1 from public.orgs where id = $1", [doomed])).rows).toHaveLength(0);
    for (const table of TENANT_TABLES) {
      const doomedRows = await db.query(`select 1 from public.${table} where org_id = $1`, [doomed]);
      const keptRows = await db.query(`select 1 from public.${table} where org_id = $1`, [kept]);
      expect(doomedRows.rows, table).toHaveLength(0);
      expect(keptRows.rows.length, table).toBeGreaterThan(0);
    }
  });

  it("leaves a sandbox that was active after the cutoff", async () => {
    const recent = await createOrg(db, "recent-co");
    expect(await purge(recent, new Date(Date.now() - 60 * 86_400_000).toISOString())).toBe(false);
    expect((await db.query("select 1 from public.orgs where id = $1", [recent])).rows).toHaveLength(1);
  });

  it("refuses a live organization, however old", async () => {
    const live = await createOrg(db, "live-co");
    await db.query("update public.orgs set mode = 'live', last_active_at = now() - interval '400 days' where id = $1", [live]);
    await expect(purge(live, new Date().toISOString())).rejects.toThrow(/not_a_sandbox/);
  });

  it("keeps cycle_snapshots append-only everywhere else", async () => {
    const other = await createOrg(db, "snap-co");
    await seedOrgRows(db, other, "snap");
    await expect(db.query("delete from public.cycle_snapshots where org_id = $1", [other])).rejects.toThrow(/append-only/);
  });

  it("is not executable by the tenant or browser roles", async () => {
    const orgId = await createOrg(db, "guarded-co");
    await expect(asTenant(db, orgId, (tx) => tx.query("select public.delete_sandbox_org($1, now())", [orgId]))).rejects.toThrow(/permission denied/);
    await expect(asRole(db, "authenticated", (tx) => tx.query("select public.touch_org_activity($1)", [orgId]))).rejects.toThrow(/permission denied/);
  });
});

describe("begin_cycle_run", () => {
  const begin = (orgId: string, cap: number | null) =>
    asTenant(db, orgId, async (tx) =>
      (await tx.query<{ id: string }>(
        "select public.begin_cycle_run($1, $2, now(), 'real', 'simulate', 'simulate') as id", [orgId, cap])).rows[0].id);

  it("opens a running run and returns its id", async () => {
    const orgId = await createOrg(db, "runs-co");
    const id = await begin(orgId, 20);
    const row = await db.query<{ status: string; org_id: string; sim_day: number | null }>(
      "select status, org_id, sim_day from public.cycle_runs where id = $1", [id]);
    expect(row.rows[0]).toEqual({ status: "running", org_id: orgId, sim_day: null });
  });

  it("refuses once today's runs reach the cap, and counts only today's", async () => {
    const orgId = await createOrg(db, "capped-co");
    await db.query(
      "insert into public.cycle_runs (org_id, started_at, clock_mode, chain_mode, screening_mode) values ($1, now() - interval '2 days', 'real', 'simulate', 'simulate')",
      [orgId]);
    await begin(orgId, 2);
    await begin(orgId, 2);
    await expect(begin(orgId, 2)).rejects.toThrow(/sandbox_cap_reached/);
  });

  it("has no cap when p_daily_cap is null", async () => {
    const orgId = await createOrg(db, "uncapped-co");
    for (let i = 0; i < 3; i++) await begin(orgId, null);
    await expect(begin(orgId, null)).resolves.toBeTruthy();
  });

  it("cannot open a run in another organization", async () => {
    const mine = await createOrg(db, "mine-co");
    const theirs = await createOrg(db, "theirs-co");
    await expect(asTenant(db, mine, (tx) =>
      tx.query("select public.begin_cycle_run($1, null, now(), 'real', 'simulate', 'simulate')", [theirs]))).rejects.toThrow();
  });
});
