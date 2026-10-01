import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asTenant, createDatabase, createOrg } from "./support/pglite";

/**
 * Migration 0051 (docs/superpowers/specs/2026-10-01-dismiss-screening-match-design.md §4): the matched
 * entity of a counterparty's current verdict, and the matches people dismissed as not the same person,
 * one per counterparty and entity, seen and written only by its own workspace.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
}, 60_000);

afterAll(async () => {
  await db.close();
});

async function counterparty(slug: string): Promise<{ orgId: string; counterpartyId: string }> {
  const orgId = await createOrg(db, slug);
  const result = await db.query<{ id: string }>(
    "insert into public.counterparties (org_id, name, role, risk_entity_id) values ($1, 'Quoc Duong', 'contractor', 'Q12345') returning id",
    [orgId]
  );
  return { orgId, counterpartyId: result.rows[0].id };
}

const dismiss = (orgId: string, counterpartyId: string, entity = "Q12345", reason = "Our freelancer, not the politician") =>
  db.query(
    `insert into public.screening_dismissals (org_id, counterparty_id, matched_entity_id, matched_caption, matched_score, screened_name, reason)
     values ($1, $2, $3, 'Dương Trung Quốc', 0.909, 'Quoc Duong', $4)`,
    [orgId, counterpartyId, entity, reason]
  );

describe("screening_dismissals (0051)", () => {
  it("keeps the matched entity on the counterparty", async () => {
    const { counterpartyId } = await counterparty("dismiss-entity");
    const row = (await db.query<{ risk_entity_id: string }>("select risk_entity_id from public.counterparties where id = $1", [counterpartyId])).rows[0];
    expect(row.risk_entity_id).toBe("Q12345");
  });

  it("holds one dismissal per counterparty and matched entity, with a reason", async () => {
    const { orgId, counterpartyId } = await counterparty("dismiss-one");
    await dismiss(orgId, counterpartyId);
    await expect(dismiss(orgId, counterpartyId)).rejects.toThrow(/screening_dismissals_entity_key/);
    await dismiss(orgId, counterpartyId, "Q99999");
    await expect(dismiss(orgId, counterpartyId, "Q77777", "no")).rejects.toThrow(/screening_dismissals_reason_check/);
  });

  it("refers only to a counterparty of its own workspace, and goes with it", async () => {
    const mine = await counterparty("dismiss-mine");
    const theirs = await counterparty("dismiss-theirs");
    await expect(dismiss(mine.orgId, theirs.counterpartyId)).rejects.toThrow(/screening_dismissals_counterparty_fkey/);
    await dismiss(mine.orgId, mine.counterpartyId);
    await db.query("delete from public.counterparties where id = $1", [mine.counterpartyId]);
    expect((await db.query("select 1 from public.screening_dismissals where counterparty_id = $1", [mine.counterpartyId])).rows).toHaveLength(0);
  });

  it("is seen and written only by its own workspace's tenant requests", async () => {
    const mine = await counterparty("dismiss-tenant-a");
    const theirs = await counterparty("dismiss-tenant-b");
    await dismiss(mine.orgId, mine.counterpartyId, "QA");
    await dismiss(theirs.orgId, theirs.counterpartyId, "QB");
    const seen = await asTenant(db, mine.orgId, async (tx) => (await tx.query<{ matched_entity_id: string }>("select matched_entity_id from public.screening_dismissals")).rows);
    expect(seen.map((row) => row.matched_entity_id)).toEqual(["QA"]);
    await expect(
      asTenant(db, mine.orgId, (tx) =>
        tx.query(
          `insert into public.screening_dismissals (org_id, counterparty_id, matched_entity_id, screened_name, reason) values ($1, $2, 'QX', 'x', 'reason')`,
          [theirs.orgId, theirs.counterpartyId]
        )
      )
    ).rejects.toThrow(/row-level security/);
    await expect(asRole(db, "anon", (tx) => tx.query("select 1 from public.screening_dismissals"))).rejects.toThrow(/permission denied/);
  });
});
