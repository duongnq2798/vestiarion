import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asTenant, createDatabase, createOrg } from "./support/pglite";

/**
 * Migration 0052 (docs/superpowers/specs/2026-10-02-outflow-budget-design.md R7): the agent's
 * spending limit, one row per workspace, each figure positive or absent, the 7-day one no lower than
 * the daily one, seen and written only by its own workspace.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
}, 60_000);

afterAll(async () => {
  await db.close();
});

const setBudget = (orgId: string, daily: number | null, weekly: number | null) =>
  db.query(
    `insert into public.agent_budgets (org_id, daily_usdc, weekly_usdc) values ($1, $2, $3)
     on conflict (org_id) do update set daily_usdc = excluded.daily_usdc, weekly_usdc = excluded.weekly_usdc`,
    [orgId, daily, weekly]
  );

describe("agent_budgets (0052)", () => {
  it("holds one row per workspace, either figure optional", async () => {
    const orgId = await createOrg(db, "budget-one");
    await setBudget(orgId, 100, null);
    await setBudget(orgId, null, 500);
    await setBudget(orgId, 100, 500);
    const rows = (await db.query<{ daily_usdc: string; weekly_usdc: string }>("select daily_usdc, weekly_usdc from public.agent_budgets where org_id = $1", [orgId])).rows;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].daily_usdc)).toBe(100);
    expect(Number(rows[0].weekly_usdc)).toBe(500);
  });

  it("refuses a figure of zero or less, and a 7-day figure below the daily one", async () => {
    const orgId = await createOrg(db, "budget-checks");
    await expect(setBudget(orgId, 0, null)).rejects.toThrow(/agent_budgets_daily_usdc_check/);
    await expect(setBudget(orgId, null, -1)).rejects.toThrow(/agent_budgets_weekly_usdc_check/);
    await expect(setBudget(orgId, 100, 50)).rejects.toThrow(/agent_budgets_weekly_covers_daily/);
  });

  it("goes with its workspace", async () => {
    const orgId = await createOrg(db, "budget-gone");
    await setBudget(orgId, 10, 20);
    await db.query("delete from public.orgs where id = $1", [orgId]);
    expect((await db.query("select 1 from public.agent_budgets where org_id = $1", [orgId])).rows).toHaveLength(0);
  });

  it("is seen and written only by its own workspace's tenant requests", async () => {
    const mine = await createOrg(db, "budget-tenant-a");
    const theirs = await createOrg(db, "budget-tenant-b");
    await setBudget(mine, 10, null);
    await setBudget(theirs, 20, null);
    const seen = await asTenant(db, mine, async (tx) => (await tx.query<{ daily_usdc: string }>("select daily_usdc from public.agent_budgets")).rows);
    expect(seen.map((row) => Number(row.daily_usdc))).toEqual([10]);
    const changed = await asTenant(db, mine, async (tx) => (await tx.query("update public.agent_budgets set daily_usdc = 1 where org_id = $1 returning org_id", [theirs])).rows);
    expect(changed).toHaveLength(0);
    const unset = await createOrg(db, "budget-tenant-c");
    await expect(
      asTenant(db, mine, (tx) => tx.query("insert into public.agent_budgets (org_id, daily_usdc) values ($1, 5)", [unset]))
    ).rejects.toThrow(/row-level security/);
    await expect(asRole(db, "anon", (tx) => tx.query("select 1 from public.agent_budgets"))).rejects.toThrow(/permission denied/);
  });
});
