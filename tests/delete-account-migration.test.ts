import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asServiceRole, createDatabase, createOrg, createUser, seedOrgRows } from "./support/pglite";

/**
 * Account deletion's database half (spec §6, A2, A3), as `deleteAccount`
 * runs it: `delete_org` (0031) for each workspace the person is the only
 * member of, then the `auth.users` row is deleted the way Supabase's
 * `auth.admin.deleteUser` deletes it — a plain row delete, which 0023's
 * foreign keys and 0020's last-owner trigger then act on.
 */

let db: PGlite;
let me: string, partner: string, teammate: string;
let solo: string, coOwned: string, member: string, lastOwned: string;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  me = await createUser(db, "me@example.com");
  partner = await createUser(db, "partner@example.com");
  teammate = await createUser(db, "teammate@example.com");

  const own = async (slug: string, rows: Array<[string, string]>) => {
    const orgId = await createOrg(db, slug);
    await db.query("update public.orgs set created_by = $2 where id = $1", [orgId, me]);
    for (const [user, role] of rows) {
      await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, $3)", [orgId, user, role]);
    }
    return orgId;
  };
  // The only member: deleted with the account.
  solo = await own("my-solo-co", [[me, "owner"]]);
  await seedOrgRows(db, solo, "my-solo-co");
  await db.query("update public.cycle_runs set status = 'completed', finished_at = now(), duration_ms = 0 where org_id = $1", [solo]);
  // Another owner remains: only my membership goes.
  coOwned = await own("co-owned-co", [[me, "owner"], [partner, "owner"], [teammate, "viewer"]]);
  await seedOrgRows(db, coOwned, "co-owned-co");
  await db.query("update public.invoices set created_by = $2, reviewed_by = $2 where org_id = $1", [coOwned, me]);
  await db.query("update public.milestones set created_by = $2 where org_id = $1", [coOwned, me]);
  await db.query(
    `insert into public.invitations (org_id, email, role, token_hash, invited_by, expires_at)
     values ($1, 'someone@example.com', 'viewer', 'my-invitation-token-hash', $2, now() + interval '7 days')`,
    [coOwned, me]
  );
  await db.query("insert into public.api_keys (org_id, name, prefix, secret_hash, created_by) values ($1, 'mine', 'abcdefgh', $2, $3)", [coOwned, "a".repeat(64), me]);
  // I am only a member.
  member = await own("member-co", [[partner, "owner"], [me, "approver"]]);
  // I am the last owner, with a teammate: blocked, so never reached by a real deletion.
  lastOwned = await own("last-owned-co", [[me, "owner"], [teammate, "viewer"]]);
}, 60_000);

afterAll(async () => {
  await db.close();
});

const deleteAuthUser = (userId: string) => db.query("delete from auth.users where id = $1", [userId]);

describe("deleting an account (A3)", () => {
  it("is refused by the last-owner trigger while I am the last owner of a workspace with other members", async () => {
    await expect(deleteAuthUser(me)).rejects.toThrow(/the last owner of an organization cannot be removed or demoted/);
    expect((await db.query("select 1 from auth.users where id = $1", [me])).rows).toHaveLength(1);
  });

  it("goes through once my sole workspaces are deleted and nothing blocks, leaving co-owned workspaces whole", async () => {
    // The blocked case is resolved the way the dialog asks: the teammate is made an owner.
    await db.query("update public.memberships set role = 'owner' where org_id = $1 and user_id = $2", [lastOwned, teammate]);

    await asServiceRole(db, (tx) => tx.query("select public.delete_org($1, $2)", [solo, me]));
    await deleteAuthUser(me);

    expect((await db.query("select 1 from auth.users where id = $1", [me])).rows).toHaveLength(0);
  });

  it("deleted the sole workspace through delete_org, leaving its tombstone", async () => {
    expect((await db.query("select 1 from public.orgs where id = $1", [solo])).rows).toHaveLength(0);
    const tombstone = await db.query<{ deleted_by: string | null; ledger_entries: number }>(
      "select deleted_by, ledger_entries from public.deleted_orgs where org_id = $1", [solo]);
    // deleted_by has no foreign key, so it still names the deleted account.
    expect(tombstone.rows).toEqual([{ deleted_by: me, ledger_entries: 1 }]);
  });

  it("removed my memberships and kept every other workspace and member", async () => {
    expect((await db.query("select 1 from public.memberships where user_id = $1", [me])).rows).toHaveLength(0);
    for (const orgId of [coOwned, member, lastOwned]) {
      expect((await db.query("select 1 from public.orgs where id = $1", [orgId])).rows).toHaveLength(1);
    }
    const coOwners = await db.query<{ user_id: string; role: string }>(
      "select user_id, role from public.memberships where org_id = $1 order by role", [coOwned]);
    expect(coOwners.rows).toEqual([{ user_id: partner, role: "owner" }, { user_id: teammate, role: "viewer" }]);
  });

  it("removed the invitations I sent", async () => {
    expect((await db.query("select 1 from public.invitations where token_hash = 'my-invitation-token-hash'")).rows).toHaveLength(0);
  });

  it("kept my records in the workspaces that survive, without my name on them", async () => {
    const checks: Array<[string, string]> = [
      ["orgs", "created_by"],
      ["invoices", "created_by"],
      ["invoices", "reviewed_by"],
      ["milestones", "created_by"],
      ["api_keys", "created_by"],
    ];
    for (const [table, column] of checks) {
      const where = table === "orgs" ? "id = $1" : "org_id = $1";
      const rows = await db.query<{ value: string | null }>(`select ${column} as value from public.${table} where ${where}`, [coOwned]);
      expect(rows.rows.length, `${table}.${column}`).toBeGreaterThan(0);
      expect(rows.rows.every((row) => row.value === null), `${table}.${column}`).toBe(true);
    }
  });
});
