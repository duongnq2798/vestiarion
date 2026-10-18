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
        { tbl: "accounting_bills", col: "decided_by", action: "n" },
        { tbl: "accounting_connections", col: "connected_by", action: "n" },
        { tbl: "accounting_connections", col: "payment_account_by", action: "n" },
        { tbl: "accounting_connections", col: "revoked_by", action: "n" },
        { tbl: "accounting_connections", col: "writes_by", action: "n" },
        { tbl: "accounting_postings", col: "approved_by", action: "n" },
        { tbl: "accounting_tokens", col: "authorized_by", action: "n" },
        { tbl: "agent_budgets", col: "updated_by", action: "n" },
        { tbl: "api_keys", col: "created_by", action: "n" },
        { tbl: "approval_policies", col: "updated_by", action: "n" },
        // Who linked, unlinked and accepted an Asana task (0115): the record stays, without the person.
        { tbl: "asana_task_links", col: "accepted_by", action: "n" },
        { tbl: "asana_task_links", col: "linked_by", action: "n" },
        { tbl: "asana_task_links", col: "unlinked_by", action: "n" },
        { tbl: "bank_statement_lines", col: "imported_by", action: "n" },
        { tbl: "cash_scenario_versions", col: "created_by", action: "n" },
        { tbl: "collection_policies", col: "account_owner", action: "n" },
        { tbl: "collection_policies", col: "created_by", action: "n" },
        { tbl: "collection_tasks", col: "assignee", action: "n" },
        { tbl: "collection_tasks", col: "resolved_by", action: "n" },
        // Commissions (0118): who made a payout, set or ended a plan, and the member a plan names as its partner.
        { tbl: "commission_payouts", col: "created_by", action: "n" },
        { tbl: "commission_plans", col: "beneficiary_member", action: "n" },
        { tbl: "commission_plans", col: "created_by", action: "n" },
        { tbl: "commission_plans", col: "ended_by", action: "n" },
        // Who added a vendor's bank account, and who set the workspace up with BlindPay (0124).
        { tbl: "counterparty_bank_accounts", col: "added_by", action: "n" },
        { tbl: "crm_deals", col: "reviewed_by", action: "n" },
        { tbl: "crm_receipt_writes", col: "overwrite_by", action: "n" },
        { tbl: "customer_portal_links", col: "created_by", action: "n" },
        { tbl: "customer_portal_links", col: "revoked_by", action: "n" },
        { tbl: "customer_request_messages", col: "by", action: "n" },
        { tbl: "customer_requests", col: "closed_by", action: "n" },
        { tbl: "deal_costs", col: "created_by", action: "n" },
        { tbl: "deal_costs", col: "linked_by", action: "n" },
        { tbl: "deal_costs", col: "removed_by", action: "n" },
        { tbl: "deal_lines", col: "released_by", action: "n" },
        { tbl: "deal_versions", col: "created_by", action: "n" },
        { tbl: "deals", col: "auto_release_by", action: "n" },
        { tbl: "deals", col: "created_by", action: "n" },
        { tbl: "decision_reasons", col: "given_by", action: "n" },
        { tbl: "decision_verdicts", col: "decided_by", action: "n" },
        // Who made an early-payment offer (0125).
        { tbl: "early_payment_offers", col: "created_by", action: "n" },
        { tbl: "escrow_contracts", col: "created_by", action: "n" },
        // Who disconnected a Chrome extension (0121).
        { tbl: "extension_grants", col: "revoked_by", action: "n" },
        { tbl: "fx_rates", col: "recorded_by", action: "n" },
        { tbl: "gateway_signers", col: "created_by", action: "n" },
        { tbl: "github_installations", col: "connected_by", action: "n" },
        { tbl: "inbox_emails", col: "decided_by", action: "n" },
        { tbl: "invitations", col: "invited_by", action: "c" },
        // Who captured a draft with the Chrome extension and who decided it (0121).
        { tbl: "invoice_drafts", col: "captured_by", action: "n" },
        { tbl: "invoice_drafts", col: "decided_by", action: "n" },
        { tbl: "invoice_inboxes", col: "created_by", action: "n" },
        { tbl: "invoices", col: "created_by", action: "n" },
        { tbl: "invoices", col: "reviewed_by", action: "n" },
        { tbl: "memberships", col: "invited_by", action: "n" },
        { tbl: "memberships", col: "user_id", action: "c" },
        { tbl: "milestones", col: "acceptance_criteria_by", action: "n" },
        { tbl: "milestones", col: "closed_by", action: "n" },
        { tbl: "milestones", col: "created_by", action: "n" },
        { tbl: "milestones", col: "decision_claimed_by", action: "n" },
        // A member's checklist marks (0114) are theirs alone: they go with the account.
        { tbl: "onboarding_marks", col: "user_id", action: "c" },
        { tbl: "orgs", col: "agent_paused_by", action: "n" },
        { tbl: "orgs", col: "created_by", action: "n" },
        // Who let the agent offer customers discounts for paying early (0129).
        { tbl: "orgs", col: "customer_offers_on_by", action: "n" },
        // Who let the agent make early-payment offers (0126).
        { tbl: "orgs", col: "early_offers_on_by", action: "n" },
        // Who let the agent ask suppliers for more time (0128).
        { tbl: "orgs", col: "term_requests_on_by", action: "n" },
        { tbl: "orgs", col: "usyc_live_by", action: "n" },
        { tbl: "payee_links", col: "created_by", action: "n" },
        { tbl: "payment_actuals", col: "recorded_by", action: "n" },
        { tbl: "payment_approvals", col: "approved_by", action: "c" },
        { tbl: "payment_receipts", col: "created_by", action: "n" },
        { tbl: "platform_team", col: "user_id", action: "c" },
        { tbl: "policy_proposals", col: "decided_by", action: "n" },
        { tbl: "project_reservations", col: "reserved_by", action: "n" },
        { tbl: "projects", col: "created_by", action: "n" },
        { tbl: "projects", col: "updated_by", action: "n" },
        { tbl: "receivable_allocations", col: "created_by", action: "n" },
        { tbl: "receivable_links", col: "created_by", action: "n" },
        { tbl: "receivable_links", col: "reminders_on_by", action: "n" },
        { tbl: "recurring_payables", col: "created_by", action: "n" },
        { tbl: "recurring_payables", col: "stopped_by", action: "n" },
        { tbl: "report_baselines", col: "answered_by", action: "n" },
        { tbl: "report_shares", col: "created_by", action: "n" },
        { tbl: "report_shares", col: "revoked_by", action: "n" },
        { tbl: "reporting_currencies", col: "set_by", action: "n" },
        { tbl: "screening_dismissals", col: "dismissed_by", action: "n" },
        { tbl: "shadow_modes", col: "started_by", action: "n" },
        { tbl: "slack_installs", col: "installed_by", action: "n" },
        { tbl: "spending_limit_contracts", col: "created_by", action: "n" },
        // Who made and who stopped a supplier's payment status link (0131).
        { tbl: "supplier_status_links", col: "created_by", action: "n" },
        { tbl: "supplier_status_links", col: "revoked_by", action: "n" },
        { tbl: "webhook_endpoints", col: "created_by", action: "n" },
        { tbl: "workspace_payout_partners", col: "set_up_by", action: "n" },
      ]);
    } finally {
      await fresh.close();
    }
  }, 60_000);
});
