import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asTenant, createDatabase, createOrg } from "./support/pglite";

/**
 * Migration 0043: begin_cycle_run refuses to open a second run while one is in
 * progress, under the per-organization lock it already takes. Checking first
 * and inserting after, from the app, left a window in which two instances
 * could both find nothing running and both open a run; the AP stage does not
 * claim the payables it decides, so the later cycle's write could move a paid
 * invoice's status back. "In progress" is the window delete_org (0031) and
 * hasRunningCycle use: a row still `running` that started within 15 minutes.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
}, 60_000);

afterAll(async () => {
  await db.close();
});

const begin = (orgId: string) =>
  asTenant(db, orgId, async (tx) =>
    (await tx.query<{ id: string }>("select public.begin_cycle_run($1, null, now(), 'real', 'simulate', 'simulate') as id", [orgId])).rows[0].id);

const runs = async (orgId: string) =>
  Number((await db.query<{ n: number }>("select count(*)::int as n from public.cycle_runs where org_id = $1", [orgId])).rows[0].n);

describe("begin_cycle_run, one run at a time (0043)", () => {
  it("refuses a second run while the first is still running, and opens nothing", async () => {
    const orgId = await createOrg(db, "busy-co");
    await begin(orgId);
    await expect(begin(orgId)).rejects.toThrow(/^cycle_running/);
    expect(await runs(orgId)).toBe(1);
  });

  it("opens a run once the one before it has finished", async () => {
    const orgId = await createOrg(db, "done-co");
    const first = await begin(orgId);
    await db.query("update public.cycle_runs set status = 'completed', finished_at = now() where id = $1", [first]);
    await expect(begin(orgId)).resolves.toBeTruthy();
  });

  it("does not wait on a run left running for more than 15 minutes", async () => {
    const orgId = await createOrg(db, "stale-co");
    await db.query(
      "insert into public.cycle_runs (org_id, started_at, status, clock_mode, chain_mode, screening_mode) values ($1, now() - interval '16 minutes', 'running', 'real', 'simulate', 'simulate')",
      [orgId]
    );
    await expect(begin(orgId)).resolves.toBeTruthy();
  });

  it("is not held up by another organization's running cycle", async () => {
    const busy = await createOrg(db, "one-co");
    const other = await createOrg(db, "two-co");
    await begin(busy);
    await expect(begin(other)).resolves.toBeTruthy();
  });

  it("still refuses a paused agent first", async () => {
    const orgId = await createOrg(db, "paused-co");
    await begin(orgId);
    await db.query("update public.orgs set agent_paused_at = now() where id = $1", [orgId]);
    await expect(begin(orgId)).rejects.toThrow(/^agent_paused/);
  });
});
