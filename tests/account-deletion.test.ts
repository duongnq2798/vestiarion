import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, createDatabase, createUser, seedOrgRows } from "./support/pglite";

/**
 * Migration 0023: deleting an account (an `auth.users` row, from the Supabase
 * dashboard or a future account-deletion feature) keeps the workspaces it
 * created and the members it invited. Its open invitations go with it, and the
 * 0020 trigger still refuses to delete the last owner of a workspace.
 */

let db: PGlite;
let founder: string, partner: string, invitee: string, solo: string;
let orgId: string, soloOrgId: string;

const hash = () => crypto.randomBytes(32).toString("hex");

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  founder = await createUser(db, "founder@example.com");
  partner = await createUser(db, "partner@example.com");
  invitee = await createUser(db, "invitee@example.com");
  solo = await createUser(db, "solo@example.com");

  orgId = (await db.query<{ id: string }>(
    "insert into public.orgs (slug, name, mode, created_by) values ('kept-co', 'Kept', 'sandbox', $1) returning id", [founder])).rows[0].id;
  await db.query(
    `insert into public.memberships (org_id, user_id, role, invited_by)
     values ($1, $2, 'owner', null), ($1, $3, 'owner', $2), ($1, $4, 'viewer', $2)`,
    [orgId, founder, partner, invitee]);
  await db.query(
    `insert into public.invitations (org_id, email, role, token_hash, invited_by, expires_at)
     values ($1, 'pending@example.com', 'viewer', $2, $3, now() + interval '7 days')`,
    [orgId, hash(), founder]);
  await seedOrgRows(db, orgId, "kept");
  await db.query("update public.invoices set created_by = $2 where org_id = $1", [orgId, founder]);
  await db.query("update public.milestones set created_by = $2 where org_id = $1", [orgId, founder]);

  soloOrgId = (await db.query<{ id: string }>(
    "insert into public.orgs (slug, name, mode, created_by) values ('solo-co', 'Solo', 'sandbox', $1) returning id", [solo])).rows[0].id;
  await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'owner')", [soloOrgId, solo]);
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("deleting an account", () => {
  it("succeeds for someone who invited a member and created a workspace, while another owner remains", async () => {
    await expect(db.query("delete from auth.users where id = $1", [founder])).resolves.toBeDefined();
  });

  it("keeps the workspace it created, with created_by cleared", async () => {
    const org = await db.query<{ created_by: string | null }>("select created_by from public.orgs where id = $1", [orgId]);
    expect(org.rows).toEqual([{ created_by: null }]);
  });

  it("keeps the members it invited, with invited_by cleared, and removes its own membership", async () => {
    const members = await db.query<{ user_id: string; invited_by: string | null }>(
      "select user_id, invited_by from public.memberships where org_id = $1 order by role", [orgId]);
    expect(members.rows).toHaveLength(2);
    expect(members.rows).toContainEqual({ user_id: partner, invited_by: null });
    expect(members.rows).toContainEqual({ user_id: invitee, invited_by: null });
  });

  it("removes the invitations it sent", async () => {
    const invitations = await db.query("select 1 from public.invitations where org_id = $1", [orgId]);
    expect(invitations.rows).toHaveLength(0);
  });

  it("keeps the invoices and milestones it created, with created_by cleared", async () => {
    for (const table of ["invoices", "milestones"]) {
      const rows = await db.query<{ created_by: string | null }>(`select created_by from public.${table} where org_id = $1`, [orgId]);
      expect(rows.rows.length).toBeGreaterThan(0);
      expect(rows.rows.every((row) => row.created_by === null)).toBe(true);
    }
  });

  it("is still refused for the last owner of a workspace, with the 0020 trigger's message", async () => {
    await expect(db.query("delete from auth.users where id = $1", [solo]))
      .rejects.toThrow("the last owner of an organization cannot be removed or demoted");
    const still = await db.query("select 1 from auth.users where id = $1", [solo]);
    expect(still.rows).toHaveLength(1);
  });
});

describe("0023 is idempotent", () => {
  it("replays every migration twice, leaving exactly one foreign key per column with its delete action", async () => {
    const fresh = await createDatabase();
    try {
      await applyMigrations(fresh);
      await applyMigrations(fresh);

      const keys = await fresh.query<{ tbl: string; col: string; action: string }>(`
        select c.conrelid::regclass::text as tbl, a.attname as col, c.confdeltype as action
          from pg_constraint c
          join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
         where c.contype = 'f' and c.confrelid = 'auth.users'::regclass
         order by 1, 2`);
      expect(keys.rows).toEqual([
        { tbl: "agent_budgets", col: "updated_by", action: "n" },
        { tbl: "api_keys", col: "created_by", action: "n" },
        { tbl: "escrow_contracts", col: "created_by", action: "n" },
        { tbl: "gateway_signers", col: "created_by", action: "n" },
        { tbl: "invitations", col: "invited_by", action: "c" },
        { tbl: "invoices", col: "created_by", action: "n" },
        { tbl: "invoices", col: "reviewed_by", action: "n" },
        { tbl: "memberships", col: "invited_by", action: "n" },
        { tbl: "memberships", col: "user_id", action: "c" },
        { tbl: "milestones", col: "created_by", action: "n" },
        { tbl: "orgs", col: "agent_paused_by", action: "n" },
        { tbl: "orgs", col: "created_by", action: "n" },
        { tbl: "orgs", col: "usyc_live_by", action: "n" },
        { tbl: "payee_links", col: "created_by", action: "n" },
        { tbl: "payment_receipts", col: "created_by", action: "n" },
        { tbl: "platform_team", col: "user_id", action: "c" },
        { tbl: "receivable_links", col: "created_by", action: "n" },
        { tbl: "screening_dismissals", col: "dismissed_by", action: "n" },
        { tbl: "webhook_endpoints", col: "created_by", action: "n" },
      ]);
    } finally {
      await fresh.close();
    }
  }, 60_000);
});
