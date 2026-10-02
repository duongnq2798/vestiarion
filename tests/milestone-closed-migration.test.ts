import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asTenant, createDatabase, createOrg, createUser, seedOrgRows } from "./support/pglite";

/**
 * Migration 0059 (held milestone actions R2, R3): a milestone may be `closed`, with when, by whom and why, and
 * `claim_milestone_decision` gives one person a held milestone to decide. The milestone stays `held` while it is
 * claimed; a second claim is refused until the first is 10 minutes old, and only a held milestone is claimed.
 */

let db: PGlite;
let approver: string, admin: string;
let orgId: string, otherOrgId: string, contractorId: string;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  approver = await createUser(db, "approver@example.com");
  admin = await createUser(db, "admin@example.com");
  orgId = await createOrg(db, "held-co");
  contractorId = (await seedOrgRows(db, orgId, "held")).counterpartyId;
  otherOrgId = await createOrg(db, "other-held-co");
  await seedOrgRows(db, otherOrgId, "other-held");
}, 60_000);

afterAll(async () => {
  await db.close();
});

async function milestone(status: string, org = orgId): Promise<string> {
  const contractor = org === orgId ? contractorId : (await db.query<{ id: string }>("select id from public.counterparties where org_id = $1 limit 1", [org])).rows[0].id;
  return (
    await db.query<{ id: string }>("insert into public.milestones (org_id, contractor_id, title, amount, status) values ($1, $2, 'Work', 0.3, $3) returning id", [org, contractor, status])
  ).rows[0].id;
}

const claim = (org: string, actor: string, milestoneId: string) =>
  asTenant(db, org, async (tx) => (await tx.query<Record<string, unknown>>("select * from public.claim_milestone_decision($1, $2, $3)", [org, milestoneId, actor])).rows[0]);

describe("claim_milestone_decision", () => {
  it("claims a held milestone for one person, leaving it held", async () => {
    const id = await milestone("held");
    const row = await claim(orgId, approver, id);
    expect(row).toMatchObject({ id, status: "held", decision_claimed_by: approver });
    expect(row.decision_claimed_at).toBeTruthy();
  });

  it("refuses a second claim while the first is fresh, and lets it be retaken once stale", async () => {
    const id = await milestone("held");
    await claim(orgId, approver, id);
    await expect(claim(orgId, admin, id)).rejects.toThrow(/already_claimed/);
    await db.query("update public.milestones set decision_claimed_at = now() - interval '11 minutes' where id = $1", [id]);
    expect(await claim(orgId, admin, id)).toMatchObject({ id, decision_claimed_by: admin });
  });

  it("claims only a held milestone, and only in the caller's organization", async () => {
    for (const status of ["pending", "verified", "paid", "closed"]) {
      await expect(claim(orgId, approver, await milestone(status)), status).rejects.toThrow(new RegExp(`not_held: the milestone is ${status} now`));
    }
    const elsewhere = await milestone("held", otherOrgId);
    await expect(claim(orgId, approver, elsewhere)).rejects.toThrow(/milestone_not_found/);
  });
});

describe("a closed milestone", () => {
  it("keeps when, by whom and why", async () => {
    const id = await milestone("held");
    await db.query("update public.milestones set status = 'closed', closed_at = now(), closed_by = $2, close_reason = 'Paid in cash' where id = $1", [id, approver]);
    const row = (await db.query<{ status: string; close_reason: string }>("select status, close_reason from public.milestones where id = $1", [id])).rows[0];
    expect(row).toEqual({ status: "closed", close_reason: "Paid in cash" });
  });

  it("refuses a blank reason, and a status the app does not know", async () => {
    const id = await milestone("held");
    await expect(db.query("update public.milestones set close_reason = '   ' where id = $1", [id])).rejects.toThrow(/milestones_close_reason_check/);
    await expect(db.query("update public.milestones set status = 'cancelled' where id = $1", [id])).rejects.toThrow(/milestones_status_check/);
  });
});
