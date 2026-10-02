import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asTenant, createDatabase, createOrg } from "./support/pglite";

/**
 * Migration 0056 (docs/superpowers/specs/2026-10-02-limit-proposals-design.md §4): the agent's
 * proposals, one open per counterparty, for a counterparty of its own workspace, seen and written
 * only by that workspace.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
}, 60_000);

afterAll(async () => {
  await db.close();
});

async function vendor(slug: string): Promise<{ orgId: string; counterpartyId: string }> {
  const orgId = await createOrg(db, slug);
  const result = await db.query<{ id: string }>("insert into public.counterparties (org_id, name, role, baseline_payment_limit) values ($1, 'Centronex', 'vendor', 2) returning id", [orgId]);
  return { orgId, counterpartyId: result.rows[0].id };
}

const propose = (orgId: string, counterpartyId: string, status = "open", to = 6) =>
  db.query(
    `insert into public.policy_proposals (org_id, counterparty_id, from_limit, to_limit, evidence, reasoning, status)
     values ($1, $2, 2, $3, '[{"amount": 5}]', 'People approved three payments above the limit.', $4)`,
    [orgId, counterpartyId, to, status]
  );

describe("policy_proposals (0056)", () => {
  it("keeps one open proposal per counterparty, any number decided", async () => {
    const { orgId, counterpartyId } = await vendor("prop-one");
    await propose(orgId, counterpartyId);
    await expect(propose(orgId, counterpartyId)).rejects.toThrow(/policy_proposals_one_open/);
    await propose(orgId, counterpartyId, "dismissed");
    await propose(orgId, counterpartyId, "accepted");
  });

  it("refuses an unknown status, a limit of zero and an empty reasoning", async () => {
    const { orgId, counterpartyId } = await vendor("prop-checks");
    await expect(propose(orgId, counterpartyId, "maybe")).rejects.toThrow(/policy_proposals_status_check/);
    await expect(propose(orgId, counterpartyId, "open", 0)).rejects.toThrow(/policy_proposals_to_limit_check/);
    await expect(
      db.query("insert into public.policy_proposals (org_id, counterparty_id, to_limit, reasoning) values ($1, $2, 3, ' ')", [orgId, counterpartyId])
    ).rejects.toThrow(/policy_proposals_reasoning_check/);
  });

  it("is for a counterparty of its own workspace, and goes with it", async () => {
    const mine = await vendor("prop-mine");
    const theirs = await vendor("prop-theirs");
    await expect(propose(mine.orgId, theirs.counterpartyId)).rejects.toThrow(/policy_proposals_counterparty_fkey/);
    await propose(mine.orgId, mine.counterpartyId);
    await db.query("delete from public.counterparties where id = $1", [mine.counterpartyId]);
    expect((await db.query("select 1 from public.policy_proposals where org_id = $1", [mine.orgId])).rows).toHaveLength(0);
  });

  it("is seen and written only by its own workspace's tenant requests", async () => {
    const mine = await vendor("prop-tenant-a");
    const theirs = await vendor("prop-tenant-b");
    await propose(mine.orgId, mine.counterpartyId);
    await propose(theirs.orgId, theirs.counterpartyId);
    const seen = await asTenant(db, mine.orgId, async (tx) => (await tx.query<{ org_id: string }>("select org_id from public.policy_proposals")).rows);
    expect(seen.map((row) => row.org_id)).toEqual([mine.orgId]);
    await expect(asRole(db, "anon", (tx) => tx.query("select 1 from public.policy_proposals"))).rejects.toThrow(/permission denied/);
  });
});
