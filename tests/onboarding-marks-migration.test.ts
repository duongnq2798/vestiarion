import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asTenant, createDatabase, createOrg, createUser } from "./support/pglite";

/**
 * Migration 0114 (docs/superpowers/specs/2026-10-13-role-onboarding-evidence-access-design.md R4): what a member did in a
 * workspace that no other row records, and the role checklists they dismissed. One row per member, workspace and mark;
 * only the marks the app knows; seen and written only by its own workspace, and never changed or deleted by it, so a
 * dismissed checklist stays dismissed.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  // Re-runnable, as scripts/migrate.ts re-runs every file.
  await applyMigrations(db, (file) => file.startsWith("0114_"));
}, 60_000);

afterAll(async () => {
  await db.close();
});

const mark = (orgId: string, userId: string, value: string) =>
  db.query("insert into public.onboarding_marks (org_id, user_id, mark) values ($1, $2, $3)", [orgId, userId, value]);

describe("onboarding_marks (0114)", () => {
  it("keeps one row per member, workspace and mark, stamped when it was made", async () => {
    const orgId = await createOrg(db, "marks-one");
    const userId = await createUser(db, "marks-one@example.com");
    await mark(orgId, userId, "dismissed_approver");
    await expect(mark(orgId, userId, "dismissed_approver")).rejects.toThrow(/duplicate key|onboarding_marks_pkey/);
    await db.query("insert into public.onboarding_marks (org_id, user_id, mark) values ($1, $2, 'dismissed_approver') on conflict do nothing", [orgId, userId]);
    const rows = (await db.query<{ mark: string; marked_at: Date }>("select mark, marked_at from public.onboarding_marks where org_id = $1", [orgId])).rows;
    expect(rows.map((row) => row.mark)).toEqual(["dismissed_approver"]);
    expect(rows[0].marked_at).toBeInstanceOf(Date);
  });

  it("takes only the marks the app knows", async () => {
    const orgId = await createOrg(db, "marks-known");
    const userId = await createUser(db, "marks-known@example.com");
    for (const known of [
      "dismissed_owner",
      "dismissed_approver",
      "dismissed_accountant",
      "approvals_opened",
      "held_reason_seen",
      "accountant_console_opened",
      "accountant_queue_opened",
      "limits_confirmed",
    ]) {
      await mark(orgId, userId, known);
    }
    await expect(mark(orgId, userId, "dismissed_viewer")).rejects.toThrow(/onboarding_marks_mark_check/);
    await expect(mark(orgId, userId, "")).rejects.toThrow(/onboarding_marks_mark_check/);
  });

  it("goes with its workspace and with the person's account", async () => {
    const orgId = await createOrg(db, "marks-cascade");
    const kept = await createOrg(db, "marks-cascade-kept");
    const userId = await createUser(db, "marks-cascade@example.com");
    const other = await createUser(db, "marks-cascade-other@example.com");
    await mark(orgId, userId, "approvals_opened");
    await mark(kept, userId, "approvals_opened");
    await mark(kept, other, "approvals_opened");
    await db.query("delete from public.orgs where id = $1", [orgId]);
    expect((await db.query("select 1 from public.onboarding_marks where org_id = $1", [orgId])).rows).toHaveLength(0);
    await db.query("delete from auth.users where id = $1", [userId]);
    const left = (await db.query<{ user_id: string }>("select user_id from public.onboarding_marks where org_id = $1", [kept])).rows;
    expect(left).toEqual([{ user_id: other }]);
  });

  it("is seen and written only by its own workspace, and never changed or deleted there", async () => {
    const mine = await createOrg(db, "marks-tenant-a");
    const theirs = await createOrg(db, "marks-tenant-b");
    const userId = await createUser(db, "marks-tenant@example.com");
    await mark(mine, userId, "limits_confirmed");
    await mark(theirs, userId, "dismissed_owner");

    const seen = await asTenant(db, mine, async (tx) => (await tx.query<{ mark: string }>("select mark from public.onboarding_marks")).rows);
    expect(seen).toEqual([{ mark: "limits_confirmed" }]);

    const inserted = await asTenant(db, mine, async (tx) =>
      (await tx.query<{ mark: string }>("insert into public.onboarding_marks (org_id, user_id, mark) values ($1, $2, 'dismissed_owner') returning mark", [mine, userId])).rows
    );
    expect(inserted).toEqual([{ mark: "dismissed_owner" }]);
    // Marking it again is a no-op, as the app writes it: on conflict, nothing.
    await asTenant(db, mine, (tx) =>
      tx.query("insert into public.onboarding_marks (org_id, user_id, mark) values ($1, $2, 'dismissed_owner') on conflict (org_id, user_id, mark) do nothing", [mine, userId])
    );

    await expect(
      asTenant(db, mine, (tx) => tx.query("insert into public.onboarding_marks (org_id, user_id, mark) values ($1, $2, 'approvals_opened')", [theirs, userId]))
    ).rejects.toThrow();
    await expect(asTenant(db, mine, (tx) => tx.query("update public.onboarding_marks set mark = 'approvals_opened'"))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, mine, (tx) => tx.query("delete from public.onboarding_marks"))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, null, async (tx) => (await tx.query("select 1 from public.onboarding_marks")).rows)).resolves.toEqual([]);
  });
});
