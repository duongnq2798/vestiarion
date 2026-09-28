import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createUser } from "./support/pglite";

/**
 * Migration 0024: pending invitations reachable from /onboarding, for anyone
 * who returns to accept an invitation on another device, another browser, or
 * simply later — the second layer of the fix, alongside the vx_after_sign_in
 * cookie for the same-browser case. `accept_invitation_by_id` looks up the
 * invitation's token hash and defers every check to `accept_invitation`
 * (0021), so the two acceptance paths cannot drift.
 */

let db: PGlite;
let owner: string, invitee: string, outsider: string;
let orgId: string;

const hash = () => crypto.randomBytes(32).toString("hex");

async function call<T = Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> {
  return asServiceRole(db, async (tx) => (await tx.query<T>(sql, params)).rows);
}
const invite = (email: string, role: string, tokenHash = hash()) =>
  call<{ id: string; email: string; expires_at: Date }>(
    "select * from public.invite_member($1, $2, $3, $4, $5)", [orgId, owner, email, role, tokenHash]);
const pending = (userId: string) =>
  call<{ invitation_id: string; org_name: string; role: string; expires_at: Date }>(
    "select * from public.pending_invitations_for($1)", [userId]);
const acceptById = (invitationId: string, userId: string) =>
  call<{ org_id: string; slug: string; role: string; invitation_id: string }>(
    "select * from public.accept_invitation_by_id($1, $2)", [invitationId, userId]);

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  owner = await createUser(db, "owner@example.com");
  invitee = await createUser(db, "Invitee@Example.com");
  outsider = await createUser(db, "outsider@example.com");
  orgId = (await db.query<{ id: string }>(
    "insert into public.orgs (slug, name, mode) values ('pending-co', 'Pending Co', 'sandbox') returning id")).rows[0].id;
  await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'owner')", [orgId, owner]);
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("pending_invitations_for", () => {
  it("lists an open invitation for the user's address, case-insensitively", async () => {
    await invite("invitee@example.com", "viewer");

    const rows = await pending(invitee);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ org_name: "Pending Co", role: "viewer" });
  });

  it("excludes a revoked invitation", async () => {
    const other = (await db.query<{ id: string }>(
      "insert into public.orgs (slug, name, mode) values ('revoked-co', 'Revoked Co', 'sandbox') returning id")).rows[0].id;
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'owner')", [other, owner]);
    const [row] = await call<{ id: string }>(
      "select * from public.invite_member($1, $2, 'invitee@example.com', 'viewer', $3)", [other, owner, hash()]);
    await call("select public.revoke_invitation($1, $2, $3)", [other, owner, row.id]);

    const rows = await pending(invitee);
    expect(rows.map((r) => r.org_name)).not.toContain("Revoked Co");
  });

  it("excludes an accepted invitation", async () => {
    const other = (await db.query<{ id: string }>(
      "insert into public.orgs (slug, name, mode) values ('accepted-co', 'Accepted Co', 'sandbox') returning id")).rows[0].id;
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'owner')", [other, owner]);
    const token = hash();
    await call("select * from public.invite_member($1, $2, 'invitee@example.com', 'viewer', $3)", [other, owner, token]);
    await call("select * from public.accept_invitation($1, $2)", [token, invitee]);

    const rows = await pending(invitee);
    expect(rows.map((r) => r.org_name)).not.toContain("Accepted Co");
  });

  it("excludes an expired invitation", async () => {
    const other = (await db.query<{ id: string }>(
      "insert into public.orgs (slug, name, mode) values ('expired-co', 'Expired Co', 'sandbox') returning id")).rows[0].id;
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'owner')", [other, owner]);
    const token = hash();
    await call("select * from public.invite_member($1, $2, 'invitee@example.com', 'viewer', $3)", [other, owner, token]);
    await db.query("update public.invitations set expires_at = now() - interval '1 minute' where token_hash = $1", [token]);

    const rows = await pending(invitee);
    expect(rows.map((r) => r.org_name)).not.toContain("Expired Co");
  });

  it("excludes an invitation for a different address", async () => {
    const rows = await pending(outsider);
    expect(rows).toEqual([]);
  });

  it("excludes an organization the user already belongs to", async () => {
    // invite_member itself refuses inviting an existing member, so the open
    // invitation row here is written directly — modelling one created before
    // the person joined some other way (e.g. an owner added them by hand).
    const already = (await db.query<{ id: string }>(
      "insert into public.orgs (slug, name, mode) values ('already-co', 'Already Co', 'sandbox') returning id")).rows[0].id;
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'owner')", [already, owner]);
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'viewer')", [already, invitee]);
    await db.query(
      `insert into public.invitations (org_id, email, role, token_hash, invited_by, expires_at)
       values ($1, 'invitee@example.com', 'admin', $2, $3, now() + interval '7 days')`,
      [already, hash(), owner]
    );

    const rows = await pending(invitee);
    expect(rows.map((r) => r.org_name)).not.toContain("Already Co");
  });
});

describe("accept_invitation_by_id", () => {
  it("joins the invited user to the organization", async () => {
    const newcomer = await createUser(db, "newcomer@example.com");
    const [row] = await invite("newcomer@example.com", "approver");

    const [joined] = await acceptById(row.id, newcomer);

    expect(joined).toMatchObject({ org_id: orgId, slug: "pending-co", role: "approver" });
    const member = await db.query("select role from public.memberships where org_id = $1 and user_id = $2", [orgId, newcomer]);
    expect(member.rows).toEqual([{ role: "approver" }]);
  });

  it("refuses a different address, leaving the invitation open", async () => {
    const [row] = await invite("someone.else@example.com", "viewer");

    await expect(acceptById(row.id, outsider)).rejects.toThrow(/invitation_email_mismatch/);

    const open = await db.query<{ accepted_at: Date | null }>(
      "select accepted_at from public.invitations where id = $1", [row.id]);
    expect(open.rows[0].accepted_at).toBeNull();
  });

  it("refuses an unknown id", async () => {
    await expect(acceptById(crypto.randomUUID(), outsider)).rejects.toThrow(/invitation_not_found/);
  });

  it("refuses a revoked invitation", async () => {
    const [row] = await invite("towithdraw@example.com", "viewer");
    await call("select public.revoke_invitation($1, $2, $3)", [orgId, owner, row.id]);
    const withdrawn = await createUser(db, "towithdraw@example.com");

    await expect(acceptById(row.id, withdrawn)).rejects.toThrow(/invitation_not_found/);
  });
});

describe("who may call these functions", () => {
  it.each(["anon", "authenticated"] as const)("%s cannot execute them", async (role) => {
    await expect(asRole(db, role, (tx) => tx.query("select * from public.pending_invitations_for($1)", [invitee])))
      .rejects.toThrow(/permission denied/);
    await expect(asRole(db, role, (tx) => tx.query("select * from public.accept_invitation_by_id($1, $2)", [crypto.randomUUID(), invitee])))
      .rejects.toThrow(/permission denied/);
  });

  it("the tenant role cannot execute them", async () => {
    await expect(asTenant(db, orgId, (tx) => tx.query("select * from public.pending_invitations_for($1)", [invitee])))
      .rejects.toThrow(/permission denied/);
    await expect(asTenant(db, orgId, (tx) => tx.query("select * from public.accept_invitation_by_id($1, $2)", [crypto.randomUUID(), invitee])))
      .rejects.toThrow(/permission denied/);
  });
});
