import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg, createUser } from "./support/pglite";

/**
 * Migration 0112 (docs/superpowers/specs/2026-10-13-accountant-console-design.md): the accountant role (A1) and what a
 * workspace used (U1). Every membership from before keeps its role; an owner or an admin may grant the accountant and
 * nobody else; an accountant decides no payment in the database either. Usage rows are append-only, and each workspace
 * sees only its own.
 */

let db: PGlite;
let orgA: string, orgB: string;
let owner: string, admin: string, approver: string, viewer: string;

const hash = () => crypto.randomBytes(32).toString("hex");
const call = <T = Record<string, unknown>>(sql: string, params: unknown[]) => asServiceRole(db, async (tx) => (await tx.query<T>(sql, params)).rows);

beforeAll(async () => {
  db = await createDatabase();
  // Everything before 0112, with a membership of every earlier role, as a database already in use has.
  await applyMigrations(db, (file) => file < "0112_");
  owner = await createUser(db, "owner@example.com");
  admin = await createUser(db, "admin@example.com");
  approver = await createUser(db, "approver@example.com");
  viewer = await createUser(db, "viewer@example.com");
  orgA = await createOrg(db, "acct-a");
  orgB = await createOrg(db, "acct-b");
  for (const [user, role] of [[owner, "owner"], [admin, "admin"], [approver, "approver"], [viewer, "viewer"]] as const) {
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, $3)", [orgA, user, role]);
  }
  await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'owner')", [orgB, owner]);
  await expect(db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'accountant')", [orgB, viewer])).rejects.toThrow(/memberships_role_check/);
  await applyMigrations(db, (file) => file >= "0112_");
  // Re-runnable, as scripts/migrate.ts re-runs every file.
  await applyMigrations(db, (file) => file.startsWith("0112_"));
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("the accountant role (A1)", () => {
  it("keeps every membership from before with its role", async () => {
    const rows = (await db.query<{ role: string }>("select role from public.memberships where org_id = $1 order by role", [orgA])).rows;
    expect(rows.map((row) => row.role)).toEqual(["admin", "approver", "owner", "viewer"]);
  });

  it("lets a membership and an invitation hold the accountant, and still nothing else", async () => {
    const someone = await createUser(db, "someone@example.com");
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'accountant')", [orgB, someone]);
    await expect(db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'bookkeeper')", [orgB, viewer])).rejects.toThrow(/memberships_role_check/);
    await expect(
      db.query("insert into public.invitations (org_id, email, role, token_hash, invited_by, expires_at) values ($1, 'x@example.com', 'superuser', $2, $3, now())", [orgB, hash(), owner])
    ).rejects.toThrow(/invitations_role_check/);
  });

  it("ranks the accountant with the approver, below an admin", async () => {
    const rank = async (role: string) => (await db.query<{ r: number | null }>("select public.role_rank($1) as r", [role])).rows[0].r;
    expect(await rank("accountant")).toBe(await rank("approver"));
    expect(await rank("owner")).toBe(4);
    expect(await rank("admin")).toBe(3);
    expect(await rank("viewer")).toBe(1);
  });

  it("lets an owner or an admin invite an accountant, and nobody else", async () => {
    const invite = (actor: string, email: string) =>
      call("select * from public.invite_member($1, $2, $3, 'accountant', $4)", [orgA, actor, email, hash()]);
    await expect(invite(owner, "books1@example.com")).resolves.toHaveLength(1);
    await expect(invite(admin, "books2@example.com")).resolves.toHaveLength(1);
    await expect(invite(approver, "books3@example.com")).rejects.toThrow(/role_not_assignable/);
    await expect(invite(viewer, "books4@example.com")).rejects.toThrow(/role_not_assignable/);
  });

  it("refuses a role it does not know rather than letting it through", async () => {
    const assignable = async (actor: string, target: string) => (await db.query<{ ok: boolean | null }>("select public.can_assign_role($1, $2) as ok", [actor, target])).rows[0].ok;
    expect(await assignable("admin", "bookkeeper")).toBe(false);
    expect(await assignable("owner", "bookkeeper")).toBe(false);
    expect(await assignable("admin", "accountant")).toBe(true);
    expect(await assignable("accountant", "viewer")).toBe(false);
    expect(await assignable("admin", "admin")).toBe(false);
  });

  it("lets the person who accepts become an accountant, and an admin change an accountant to a viewer", async () => {
    const books = await createUser(db, "books5@example.com");
    const token = hash();
    await call("select * from public.invite_member($1, $2, 'books5@example.com', 'accountant', $3)", [orgA, admin, token]);
    const [accepted] = await call<{ role: string }>("select * from public.accept_invitation($1, $2)", [token, books]);
    expect(accepted.role).toBe("accountant");
    await call("select public.change_member_role($1, $2, $3, 'viewer')", [orgA, admin, books]);
    expect((await db.query<{ role: string }>("select role from public.memberships where org_id = $1 and user_id = $2", [orgA, books])).rows[0].role).toBe("viewer");
    await call("select public.change_member_role($1, $2, $3, 'accountant')", [orgA, admin, books]);
    // An accountant grants nothing.
    await expect(call("select public.change_member_role($1, $2, $3, 'viewer')", [orgA, books, viewer])).rejects.toThrow(/role_not_assignable/);
  });

  it("does not count an accountant as someone who decides payments", async () => {
    const books = await createUser(db, "books6@example.com");
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'accountant')", [orgA, books]);
    // 0025: pausing the agent takes a deciding role.
    await expect(call("select public.pause_agent($1, $2, 'checking')", [orgA, books])).rejects.toThrow(/pause_not_permitted/);
    // 0025, 0054, 0031: resuming it, turning on the USYC reserve and deleting the workspace take an owner or an admin.
    await expect(call("select public.resume_agent($1, $2)", [orgA, books])).rejects.toThrow(/resume_not_permitted/);
    await expect(call("select public.enable_usyc_reserve($1, $2)", [orgA, books])).rejects.toThrow(/usyc_not_permitted/);
    await expect(call("select public.delete_org($1, $2)", [orgA, books])).rejects.toThrow(/not_owner/);
    // 0061, 0077: an accountant is never the sole approver, never counted toward two approvals, and its approval counts for nothing.
    const [sole] = await call<{ sole: boolean }>("select public.sole_approver($1, $2) as sole", [orgA, books]);
    expect(sole.sole).toBe(false);
    const [among] = await call<{ ids: string[] }>("select public.approvers_among($1, $2::uuid[]) as ids", [orgA, [books, approver]]);
    expect(among.ids).toEqual([approver]);
    const deciders = (await db.query<{ id: string }>("select user_id as id from public.memberships where org_id = $1 and role in ('owner', 'admin', 'approver')", [orgA])).rows;
    const [besides] = await call<{ n: number }>("select public.approvers_besides($1, '{}'::uuid[]) as n", [orgA]);
    expect(besides.n).toBe(deciders.length);
  });

  it("lets nobody reach admin or owner through the accountant role", async () => {
    const books = await createUser(db, "books7@example.com");
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'accountant')", [orgA, books]);
    // An admin may not raise an accountant to admin or owner; an accountant may raise nobody, itself included.
    for (const target of ["admin", "owner"]) {
      await expect(call("select public.change_member_role($1, $2, $3, $4)", [orgA, admin, books, target])).rejects.toThrow(/role_not_assignable/);
      await expect(call("select public.change_member_role($1, $2, $3, $4)", [orgA, books, books, target])).rejects.toThrow(/role_not_assignable/);
      await expect(call("select * from public.invite_member($1, $2, $3, $4, $5)", [orgA, books, `up-${target}@example.com`, target, hash()])).rejects.toThrow(/role_not_assignable/);
    }
    // An accountant removes nobody else.
    await expect(call("select public.remove_member($1, $2, $3)", [orgA, books, viewer])).rejects.toThrow(/role_not_assignable/);
    // An invitation an admin sent stops working once that admin is moved to accountant.
    const helper = await createUser(db, "helper@example.com");
    const invited = await createUser(db, "invited@example.com");
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'admin')", [orgA, helper]);
    const token = hash();
    await call("select * from public.invite_member($1, $2, 'invited@example.com', 'approver', $3)", [orgA, helper, token]);
    await call("select public.change_member_role($1, $2, $3, 'accountant')", [orgA, owner, helper]);
    await expect(call("select * from public.accept_invitation($1, $2)", [token, invited])).rejects.toThrow(/invitation_no_longer_valid/);
    // An owner still may make an accountant an admin.
    await call("select public.change_member_role($1, $2, $3, 'admin')", [orgA, owner, books]);
    expect((await db.query<{ role: string }>("select role from public.memberships where org_id = $1 and user_id = $2", [orgA, books])).rows[0].role).toBe("admin");
  });
});

describe("usage_events (U1)", () => {
  const insert = (orgId: string, row: Record<string, unknown>) =>
    asTenant(db, orgId, async (tx) => {
      const full = { org_id: orgId, kind: "model_call", action: "decision", ...row };
      const columns = Object.keys(full);
      return (await tx.query<{ id: string }>(
        `insert into public.usage_events (${columns.join(", ")}) values (${columns.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
        Object.values(full)
      )).rows[0].id;
    });

  it("records a model call with its tokens and its cost in USD, and an x402 purchase in USDC", async () => {
    await insert(orgA, { provider: "anthropic", model: "claude-sonnet-4-5", input_tokens: 1200, output_tokens: 300, cost: "0.0081", cost_currency: "USD" });
    await insert(orgA, { kind: "x402_purchase", action: "screening", cost: "0.01", cost_currency: "USDC" });
    const rows = await asTenant(db, orgA, async (tx) => (await tx.query<{ kind: string; cost: string; cost_currency: string }>("select kind, cost, cost_currency from public.usage_events order by kind")).rows);
    expect(rows).toEqual([
      { kind: "model_call", cost: "0.008100", cost_currency: "USD" },
      { kind: "x402_purchase", cost: "0.010000", cost_currency: "USDC" },
    ]);
  });

  it("refuses a kind it does not know, an action in free words, and a cost without its currency", async () => {
    await expect(insert(orgA, { kind: "bank_wire" })).rejects.toThrow(/usage_events_kind_check/);
    await expect(insert(orgA, { action: "Paid Acme's bill" })).rejects.toThrow(/usage_events_action_check/);
    await expect(insert(orgA, { cost: "1" })).rejects.toThrow(/usage_events_cost_pair/);
    await expect(insert(orgA, { cost_currency: "USD" })).rejects.toThrow(/usage_events_cost_pair/);
    await expect(insert(orgA, { cost: "1", cost_currency: "VND" })).rejects.toThrow(/usage_events_cost_currency_check/);
  });

  it("is append-only for the tenant role", async () => {
    const id = await insert(orgA, { kind: "email", action: "invitation" });
    await expect(asTenant(db, orgA, (tx) => tx.query("update public.usage_events set quantity = 5 where id = $1", [id]))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, orgA, (tx) => tx.query("delete from public.usage_events where id = $1", [id]))).rejects.toThrow(/permission denied/);
  });

  it("shows each workspace only its own, and refuses a row for another", async () => {
    await insert(orgB, { kind: "connector_sync", action: "xero" });
    const seenByB = await asTenant(db, orgB, async (tx) => (await tx.query<{ org_id: string }>("select org_id from public.usage_events")).rows);
    expect(seenByB.length).toBe(1);
    expect(seenByB.every((row) => row.org_id === orgB)).toBe(true);
    await expect(
      asTenant(db, orgB, (tx) => tx.query("insert into public.usage_events (org_id, kind, action) values ($1, 'email', 'invitation')", [orgA]))
    ).rejects.toThrow(/row-level security/);
    const none = await asTenant(db, null, async (tx) => (await tx.query("select 1 from public.usage_events")).rows);
    expect(none).toHaveLength(0);
  });

  it("gives the browser roles nothing", async () => {
    await expect(asRole(db, "anon", (tx) => tx.query("select 1 from public.usage_events"))).rejects.toThrow(/permission denied/);
    await expect(asRole(db, "authenticated", (tx) => tx.query("select 1 from public.usage_events"))).rejects.toThrow(/permission denied/);
  });

  it("goes with its workspace", async () => {
    const gone = await createOrg(db, "acct-gone");
    await insert(gone, { kind: "email", action: "invitation" });
    await db.query("delete from public.orgs where id = $1", [gone]);
    expect((await db.query("select 1 from public.usage_events where org_id = $1", [gone])).rows).toHaveLength(0);
  });
});
