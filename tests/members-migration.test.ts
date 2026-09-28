import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createUser } from "./support/pglite";

/**
 * Migration 0021: every membership change goes through a service-role
 * function that is told who is acting and checks that person's role itself
 * (spec §7, §10 step 5b). No one grants a role above their own.
 */

let db: PGlite;
let owner: string, admin: string, approver: string, viewer: string, outsider: string;
let orgId: string;

const hash = () => crypto.randomBytes(32).toString("hex");

async function call<T = Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> {
  return asServiceRole(db, async (tx) => (await tx.query<T>(sql, params)).rows);
}
const invite = (actor: string, email: string, role: string, tokenHash = hash()) =>
  call<{ id: string; email: string; expires_at: Date }>(
    "select * from public.invite_member($1, $2, $3, $4, $5)", [orgId, actor, email, role, tokenHash]);
const accept = (tokenHash: string, userId: string) =>
  call<{ org_id: string; slug: string; role: string; invitation_id: string }>(
    "select * from public.accept_invitation($1, $2)", [tokenHash, userId]);
const changeRole = (actor: string, userId: string, role: string) =>
  call<{ previous: string }>("select public.change_member_role($1, $2, $3, $4) as previous", [orgId, actor, userId, role]);
const remove = (actor: string, userId: string) =>
  call<{ removed: string }>("select public.remove_member($1, $2, $3) as removed", [orgId, actor, userId]);
const roleOf = async (userId: string) =>
  (await db.query<{ role: string }>("select role from public.memberships where org_id = $1 and user_id = $2", [orgId, userId])).rows[0]?.role ?? null;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  owner = await createUser(db, "owner@example.com");
  admin = await createUser(db, "admin@example.com");
  approver = await createUser(db, "approver@example.com");
  viewer = await createUser(db, "viewer@example.com");
  outsider = await createUser(db, "Outsider@Example.com");
  orgId = (await db.query<{ id: string }>(
    "insert into public.orgs (slug, name, mode) values ('members-co', 'Members Co', 'sandbox') returning id")).rows[0].id;
  for (const [user, role] of [[owner, "owner"], [admin, "admin"], [approver, "approver"], [viewer, "viewer"]] as const) {
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, $3)", [orgId, user, role]);
  }
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("invite_member", () => {
  it("stores a lowercased address, the hash and a 7-day expiry", async () => {
    const [row] = await invite(owner, "  New.Person@Example.COM ", "admin");
    expect(row.email).toBe("new.person@example.com");
    const days = (new Date(row.expires_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThan(7.01);
  });

  it("lets an admin invite an approver or a viewer, but not an admin or an owner", async () => {
    await expect(invite(admin, "a1@example.com", "viewer")).resolves.toHaveLength(1);
    await expect(invite(admin, "a2@example.com", "approver")).resolves.toHaveLength(1);
    await expect(invite(admin, "a3@example.com", "admin")).rejects.toThrow(/role_not_assignable/);
    await expect(invite(admin, "a4@example.com", "owner")).rejects.toThrow(/role_not_assignable/);
  });

  it("refuses approvers, viewers and non-members", async () => {
    await expect(invite(approver, "b1@example.com", "viewer")).rejects.toThrow(/role_not_assignable/);
    await expect(invite(viewer, "b2@example.com", "viewer")).rejects.toThrow(/role_not_assignable/);
    await expect(invite(outsider, "b3@example.com", "viewer")).rejects.toThrow(/not_a_member/);
  });

  it("refuses something that is not an email address", async () => {
    await expect(invite(owner, "<script>@x", "viewer")).rejects.toThrow(/invalid_email/);
    await expect(invite(owner, "no-at-sign", "viewer")).rejects.toThrow(/invalid_email/);
  });

  it("refuses an address that already belongs to a member", async () => {
    await expect(invite(owner, "VIEWER@example.com", "admin")).rejects.toThrow(/already_a_member/);
  });

  it("replaces the open invitation for the same address", async () => {
    await invite(owner, "again@example.com", "viewer");
    await invite(owner, "again@example.com", "approver");
    const open = await db.query<{ role: string }>(
      "select role from public.invitations where org_id = $1 and email = 'again@example.com' and accepted_at is null", [orgId]);
    expect(open.rows.map((r) => r.role)).toEqual(["approver"]);
  });

  it("refuses a 21st open invitation", async () => {
    const other = (await db.query<{ id: string }>(
      "insert into public.orgs (slug, name) values ('busy-co', 'Busy') returning id")).rows[0].id;
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'owner')", [other, owner]);
    for (let i = 0; i < 20; i++) {
      await call("select public.invite_member($1, $2, $3, 'viewer', $4)", [other, owner, `p${i}@example.com`, hash()]);
    }
    await expect(call("select public.invite_member($1, $2, 'p20@example.com', 'viewer', $3)", [other, owner, hash()]))
      .rejects.toThrow(/invitation_limit_reached/);
  });
});

describe("accept_invitation", () => {
  it("makes the invited person a member with the invited role, once", async () => {
    const token = hash();
    await invite(owner, "outsider@example.com", "approver", token);
    const [joined] = await accept(token, outsider);
    expect(joined).toMatchObject({ org_id: orgId, slug: "members-co", role: "approver" });
    expect(await roleOf(outsider)).toBe("approver");
    await expect(accept(token, outsider)).rejects.toThrow(/invitation_used/);
    await remove(owner, outsider);
  });

  it("refuses someone signed in with a different address and leaves the invitation open", async () => {
    const token = hash();
    await invite(owner, "someone.else@example.com", "viewer", token);
    await expect(accept(token, outsider)).rejects.toThrow(/invitation_email_mismatch/);
    const open = await db.query("select 1 from public.invitations where token_hash = $1 and accepted_at is null", [token]);
    expect(open.rows).toHaveLength(1);
  });

  it("refuses an unknown or expired token", async () => {
    await expect(accept(hash(), outsider)).rejects.toThrow(/invitation_not_found/);
    const token = hash();
    await invite(owner, "outsider@example.com", "viewer", token);
    await db.query("update public.invitations set expires_at = now() - interval '1 minute' where token_hash = $1", [token]);
    await expect(accept(token, outsider)).rejects.toThrow(/invitation_expired/);
  });

  it("refuses when the inviter can no longer grant the role", async () => {
    const token = hash();
    const newcomer = await createUser(db, "newcomer@example.com");
    await invite(admin, "newcomer@example.com", "approver", token);
    await changeRole(owner, admin, "viewer");
    await expect(accept(token, newcomer)).rejects.toThrow(/invitation_no_longer_valid/);
    await changeRole(owner, admin, "admin");
  });
});

describe("change_member_role and remove_member", () => {
  it("lets an owner change any role and returns the previous one", async () => {
    const [{ previous }] = await changeRole(owner, viewer, "admin");
    expect(previous).toBe("viewer");
    await changeRole(owner, viewer, "viewer");
  });

  it("lets an admin move people between approver and viewer only", async () => {
    await expect(changeRole(admin, viewer, "approver")).resolves.toHaveLength(1);
    await expect(changeRole(admin, viewer, "admin")).rejects.toThrow(/role_not_assignable/);
    await expect(changeRole(admin, owner, "viewer")).rejects.toThrow(/role_not_assignable/);
    await changeRole(owner, viewer, "viewer");
  });

  it("refuses approvers and viewers, and names a target that is not a member", async () => {
    await expect(changeRole(approver, viewer, "approver")).rejects.toThrow(/role_not_assignable/);
    await expect(changeRole(owner, outsider, "viewer")).rejects.toThrow(/member_not_found/);
  });

  it("keeps the last owner", async () => {
    await expect(changeRole(owner, owner, "admin")).rejects.toThrow(/last owner/);
    await expect(remove(owner, owner)).rejects.toThrow(/last owner/);
  });

  it("lets anyone leave, and an admin remove only approvers and viewers", async () => {
    const leaver = await createUser(db, "leaver@example.com");
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'viewer')", [orgId, leaver]);
    const [{ removed }] = await remove(leaver, leaver);
    expect(removed).toBe("viewer");
    await expect(remove(admin, owner)).rejects.toThrow(/role_not_assignable/);
  });
});

describe("revoke_invitation and org_members", () => {
  it("revokes only an invitation the actor could have sent", async () => {
    const [ownerInvite] = await invite(owner, "boss@example.com", "admin");
    await expect(call("select public.revoke_invitation($1, $2, $3)", [orgId, admin, ownerInvite.id])).rejects.toThrow(/role_not_assignable/);
    await call("select public.revoke_invitation($1, $2, $3)", [orgId, owner, ownerInvite.id]);
    const left = await db.query("select 1 from public.invitations where id = $1", [ownerInvite.id]);
    expect(left.rows).toHaveLength(0);
  });

  it("lists members with their address and role", async () => {
    const rows = await call<{ email: string; role: string }>("select email, role from public.org_members($1) order by email", [orgId]);
    expect(rows).toContainEqual({ email: "owner@example.com", role: "owner" });
    expect(rows).toContainEqual({ email: "viewer@example.com", role: "viewer" });
  });
});

describe("who may call these functions", () => {
  it.each(["anon", "authenticated"] as const)("%s cannot execute them", async (role) => {
    await expect(asRole(db, role, (tx) => tx.query("select * from public.org_members($1)", [orgId]))).rejects.toThrow(/permission denied/);
  });

  it("the tenant role cannot execute them", async () => {
    await expect(asTenant(db, orgId, (tx) => tx.query("select * from public.org_members($1)", [orgId]))).rejects.toThrow(/permission denied/);
  });
});
