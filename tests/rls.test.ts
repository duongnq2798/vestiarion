import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bodyHashOf } from "@/lib/ledger";
import { ledgerKeyId } from "@/lib/ledger-keys";
import {
  FOUNDING_ORG_ID as A, TENANT_TABLES, applyMigrations, asRole, asTenant, createDatabase, createOrg, seedOrgRows,
  type SeededRows,
} from "./support/pglite";

/**
 * Row-level security as PostgREST applies it: the role `vestiarion_tenant`,
 * with the request's claims in `request.jwt.claims`. Organization A is the
 * founding organization; B is a second one. Every table holds one row of each.
 */

let db: PGlite;
let B: string;
let rowsB: SeededRows;

const count = async (tx: { query: PGlite["query"] }, table: string) =>
  (await tx.query<{ n: number }>(`select count(*)::int as n from public.${table}`)).rows[0].n;

/**
 * For each of the ten CRUD tenant tables (everything but the two append-only
 * ones), a real, non-trivial column update to try against another
 * organization's rows — `org_id = org_id` is a no-op RLS cannot meaningfully
 * block, so this picks a column that would visibly change.
 */
const CRUD_UPDATE: Record<string, { column: string; expr: string }> = {
  accounts: { column: "name", expr: "name || '-changed'" },
  counterparties: { column: "name", expr: "name || '-changed'" },
  invoices: { column: "memo", expr: "coalesce(memo, '') || '-changed'" },
  milestones: { column: "title", expr: "title || '-changed'" },
  treasury_actions: { column: "reasoning", expr: "coalesce(reasoning, '') || '-changed'" },
  compliance_checks: { column: "notes", expr: "coalesce(notes, '') || '-changed'" },
  forecasts: { column: "recommendation", expr: "coalesce(recommendation, '') || '-changed'" },
  payment_intents: { column: "last_error", expr: "coalesce(last_error, '') || '-changed'" },
  cycle_runs: { column: "sim_day", expr: "coalesce(sim_day, 0) + 1" },
  sim_clock: { column: "current_day", expr: "current_day + 1" },
  gateway_signers: { column: "delegate_tx_id", expr: "coalesce(delegate_tx_id, '') || '-changed'" },
  payment_receipts: { column: "revoked_at", expr: "now()" },
  escrow_contracts: { column: "circle_contract_id", expr: "coalesce(circle_contract_id, '') || '-changed'" },
  fx_swaps: { column: "failure", expr: "coalesce(failure, '') || '-changed'" },
  screening_dismissals: { column: "reason", expr: "'changed'" },
  receivable_links: { column: "revoked_at", expr: "now()" },
  incoming_transfers: { column: "matched_by", expr: "'person'" },
  agent_budgets: { column: "daily_usdc", expr: "coalesce(daily_usdc, 1) + 1" },
  recurring_payables: { column: "memo", expr: "'changed'" },
  policy_proposals: { column: "reasoning", expr: "'changed'" },
  spending_limit_contracts: { column: "circle_contract_id", expr: "coalesce(circle_contract_id, '') || '-changed'" },
  ar_reminders: { column: "tone", expr: "'firm'" },
  inbox_emails: { column: "status", expr: "'dismissed'" },
  approval_policies: { column: "two_approvals_above", expr: "coalesce(two_approvals_above, 1) + 1" },
  payment_approvals: { column: "used_at", expr: "now()" },
  shadow_modes: { column: "currency", expr: "'USD'" },
  // Claimed, marked sent, or released by deleting the claim (0108).
  approval_escalations: { column: "recipients", expr: "coalesce(recipients, 0) + 1" },
  // An email claimed, marked sent, or released by deleting an unsent claim (0110).
  notification_deliveries: { column: "provider_id", expr: "'changed'" },
};

/** The connector tables (0101): updated by their own workspace, never deleted by the tenant role. */
const KEEP_UPDATE: Record<string, { column: string; expr: string }> = {
  accounting_connections: { column: "last_error", expr: "'changed'" },
  external_links: { column: "label", expr: "'changed'" },
  accounting_bills: { column: "review_state", expr: "'dismissed'" },
  accounting_sync_cursors: { column: "page", expr: "coalesce(page, 0) + 1" },
  // The deals a CRM brought in (0105).
  crm_deals: { column: "name", expr: "'changed'" },
  accounting_postings: { column: "message", expr: "'changed'" },
  // The receipts written back to HubSpot (0107).
  crm_receipt_writes: { column: "message", expr: "'changed'" },
  // An Asana task linked to a milestone is unlinked, never deleted (0115).
  asana_task_links: { column: "read_error", expr: "'changed'" },
  // A customer's statement link is stopped, and what the customer said is closed, never deleted (0109).
  customer_portal_links: { column: "revoked_at", expr: "now()" },
  customer_requests: { column: "outcome", expr: "'resolved'" },
  // A collection task is resolved, never deleted (0110).
  collection_tasks: { column: "notified_at", expr: "now()" },
  // A captured draft is confirmed or discarded, never deleted by a tenant (0121).
  invoice_drafts: { column: "memo", expr: "'changed'" },
  // Projects are changed and archived, never deleted; a reservation is only released (0111).
  projects: { column: "name", expr: "name || '-changed'" },
  project_reservations: { column: "release_reason", expr: "'changed'" },
  // A workspace's reporting currency is changed, never deleted (0113).
  reporting_currencies: { column: "currency", expr: "'MYR'" },
  // The workspace's BlindPay customer, and a vendor's bank account, which is removed, never deleted (0124).
  workspace_payout_partners: { column: "kyb_status", expr: "'approved'" },
  counterparty_bank_accounts: { column: "status", expr: "'approved'" },
};

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  B = await createOrg(db, "northstar");
  await seedOrgRows(db, A, "a");
  rowsB = await seedOrgRows(db, B, "b");
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("request_org_id()", () => {
  it("is the claim's org_id, and null without one", async () => {
    expect(await asTenant(db, A, async (tx) => (await tx.query<{ v: string }>("select public.request_org_id() as v")).rows[0].v)).toBe(A);
    expect(await asTenant(db, null, async (tx) => (await tx.query<{ v: string | null }>("select public.request_org_id() as v")).rows[0].v)).toBeNull();
  });

  it("fails rather than silently matching when the claim's org_id is malformed", async () => {
    await expect(asTenant(db, "nope", (tx) => tx.query("select public.request_org_id()"))).rejects.toThrow(/invalid input syntax for type uuid/);
  });

  it("is not executable by the browser roles", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select public.request_org_id()"))).rejects.toThrow(/permission denied/);
    }
  });
});

describe("extensions schema", () => {
  it("grants the tenant role USAGE, so digest() (used by append_ledger_entry) resolves in production", async () => {
    const result = await db.query<{ ok: boolean }>(
      "select has_schema_privilege('vestiarion_tenant', 'extensions', 'USAGE') as ok"
    );
    expect(result.rows[0].ok).toBe(true);
  });
});

describe("0018's self-checks", () => {
  // A GRANT run by a role without the grant option only raises a WARNING,
  // not an error, when it doesn't take — PGlite always applies migrations as
  // a superuser, so the GRANT itself can never actually fail to take here,
  // and there's no clean way on PGlite to reproduce the privilege-less role
  // that would make it warn instead of grant in production. What can be
  // proven on PGlite is that the guard clauses 0018 adds — copied verbatim
  // below — correctly raise when the privilege they check for is absent,
  // which is the only thing standing between a silent WARNING and a failed
  // migration.
  // Each builds a fresh database and replays every migration, which can take longer than the default timeout when the whole suite runs in parallel.
  it("the extensions-USAGE guard raises when the grant did not take", async () => {
    const fresh = await createDatabase();
    await applyMigrations(fresh);
    await fresh.exec("revoke usage on schema extensions from vestiarion_tenant");
    await expect(fresh.exec(`
      do $$
      begin
        if not has_schema_privilege('vestiarion_tenant', 'extensions', 'USAGE') then
          raise exception 'vestiarion_tenant has no USAGE on schema extensions, so digest() would not resolve for tenant requests';
        end if;
      end $$;
    `)).rejects.toThrow(/vestiarion_tenant has no USAGE on schema extensions/);
    await fresh.close();
  }, 60_000);

  it("the authenticator-membership guard raises when the grant did not take", async () => {
    const fresh = await createDatabase();
    await applyMigrations(fresh);
    await fresh.exec("revoke vestiarion_tenant from authenticator");
    await expect(fresh.exec(`
      do $$
      begin
        if not pg_has_role('authenticator', 'vestiarion_tenant', 'MEMBER') then
          raise exception 'authenticator could not be granted vestiarion_tenant membership, so PostgREST could not switch to the role';
        end if;
      end $$;
    `)).rejects.toThrow(/authenticator could not be granted vestiarion_tenant membership/);
    await fresh.close();
  }, 60_000);
});

describe.each(TENANT_TABLES)("%s", (table) => {
  it("shows a tenant its own rows and none of another organization's", async () => {
    expect(await asTenant(db, A, (tx) => count(tx, table))).toBeGreaterThan(0);
    const seen = await asTenant(db, A, async (tx) =>
      (await tx.query<{ org_id: string }>(`select distinct org_id from public.${table}`)).rows.map((row) => row.org_id));
    expect(seen).toEqual([A]);
  });

  it("shows a request whose token names no organization nothing", async () => {
    expect(await asTenant(db, null, (tx) => count(tx, table))).toBe(0);
  });

  it("gives the browser roles no access at all", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => count(tx, table))).rejects.toThrow(/permission denied/);
    }
  });

  it("cannot change or remove another organization's rows", async () => {
    if (table === "ledger_entries" || table === "cycle_snapshots" || table === "service_purchases" || table === "decision_verdicts" || table === "payment_actuals" || table === "report_baselines" || table === "bank_statement_lines" || table === "receivable_allocations" || table === "deal_versions" || table === "customer_request_messages" || table === "approval_escalation_starts" || table === "collection_policies" || table === "collection_task_starts" || table === "usage_events" || table === "cash_scenario_versions" || table === "fx_rates" || table === "fx_variances" || table === "onboarding_marks" || table === "decision_reasons" || table === "commission_plans" || table === "commission_plan_deals" || table === "commission_payouts" || table === "commission_lines") {
      // Append-only tables, and a workspace's escalation start (0108): the tenant role holds no UPDATE/DELETE privilege
      // at all, cross-org or not, so each statement is refused on its own —
      // the first failure would abort the transaction before the second ran.
      await expect(asTenant(db, A, (tx) => tx.query(`update public.${table} set org_id = org_id where org_id = $1`, [B]))).rejects.toThrow(/permission denied/);
      await expect(asTenant(db, A, (tx) => tx.query(`delete from public.${table} where org_id = $1`, [B]))).rejects.toThrow(/permission denied/);
      return;
    }
    if (table === "deals" || table === "deal_lines" || table === "deal_costs") {
      // Status-only updates (column grants) and no delete: another organization's row is hidden from the update, and
      // the delete is refused outright. A cost's link and removal are the only columns the tenant updates (0108).
      const column = table === "deals" ? "auto_release = not auto_release" : table === "deal_costs" ? "removed_at = now()" : "status = status";
      const updated = await asTenant(db, A, (tx) => tx.query(`update public.${table} set ${column} where org_id = $1`, [B]));
      expect(updated.affectedRows ?? 0).toBe(0);
      await expect(asTenant(db, A, (tx) => tx.query(`delete from public.${table} where org_id = $1`, [B]))).rejects.toThrow(/permission denied/);
      return;
    }
    if (table === "report_shares") {
      // Revoke-only: the tenant role may set revoked_at on its own links and delete none, so another
      // organization's link is hidden from the update and the delete is refused outright.
      const revoked = await asTenant(db, A, (tx) => tx.query(`update public.${table} set revoked_at = now() where org_id = $1`, [B]));
      expect(revoked.affectedRows ?? 0).toBe(0);
      await expect(asTenant(db, A, (tx) => tx.query(`delete from public.${table} where org_id = $1`, [B]))).rejects.toThrow(/permission denied/);
      return;
    }
    if (table in KEEP_UPDATE) {
      // Kept, never deleted (0101): the tenant role updates its own connector rows and deletes none, so another
      // organization's rows are hidden from the update and the delete is refused outright.
      const { column, expr } = KEEP_UPDATE[table];
      const updated = await asTenant(db, A, (tx) => tx.query(`update public.${table} set ${column} = ${expr} where org_id = $1`, [B]));
      expect(updated.affectedRows ?? 0).toBe(0);
      await expect(asTenant(db, A, (tx) => tx.query(`delete from public.${table} where org_id = $1`, [B]))).rejects.toThrow(/permission denied/);
      return;
    }
    const { column, expr } = CRUD_UPDATE[table];
    const updated = await asTenant(db, A, (tx) => tx.query(`update public.${table} set ${column} = ${expr} where org_id = $1`, [B]));
    expect(updated.affectedRows ?? 0).toBe(0);
    const deleted = await asTenant(db, A, (tx) => tx.query(`delete from public.${table} where org_id = $1`, [B]));
    expect(deleted.affectedRows ?? 0).toBe(0);
  });
});

describe("history is append-only for the tenant role", () => {
  it.each(["ledger_entries", "cycle_snapshots", "service_purchases", "decision_verdicts", "payment_actuals", "report_baselines", "bank_statement_lines", "receivable_allocations", "deal_versions", "customer_request_messages", "usage_events", "cash_scenario_versions", "fx_rates", "fx_variances", "onboarding_marks", "decision_reasons", "commission_plans", "commission_plan_deals", "commission_payouts", "commission_lines"])("%s refuses UPDATE and DELETE even on the tenant's own rows", async (table) => {
    await expect(asTenant(db, A, (tx) => tx.query(`update public.${table} set org_id = org_id`))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, A, (tx) => tx.query(`delete from public.${table}`))).rejects.toThrow(/permission denied/);
  });
});

describe("writes name the tenant's own organization", () => {
  it("refuses a row for another organization", async () => {
    await expect(asTenant(db, A, (tx) =>
      tx.query("insert into counterparties (org_id, name, role) values ($1, 'x', 'vendor')", [B]))).rejects.toThrow(/row-level security/);
  });

  it("refuses moving a row to another organization", async () => {
    await expect(asTenant(db, A, (tx) =>
      tx.query("update counterparties set org_id = $1 where org_id = $2", [B, A]))).rejects.toThrow(/row-level security/);
  });

  it("accepts a row for its own organization, for every CRUD table plus a cycle_snapshots insert", async () => {
    // A dedicated organization, so this test's own inserts can't collide with
    // what beforeAll already seeded for A (sim_clock in particular holds one
    // row per organization).
    const C = await createOrg(db, "acceptco");

    // Column shapes copied from seedOrgRows: each insert both proves RLS
    // accepts an own-organization row for that table, and — for the tables
    // whose FK another entry below needs — supplies a same-organization row
    // for the composite foreign key to hold.
    const ids: Record<string, string> = {};
    const insertReturningId = async (table: string, sql: string, params: unknown[]) => {
      const row = (await asTenant(db, C, (tx) => tx.query<{ id: string }>(sql, params))).rows[0];
      expect(row?.id).toBeTruthy();
      ids[table] = row.id;
    };
    const insertRow = async (table: string, sql: string, params: unknown[]) => {
      await asTenant(db, C, (tx) => tx.query(sql, params));
    };

    await insertReturningId("counterparties",
      "insert into counterparties (org_id, name, role) values ($1, 'own-cp', 'vendor') returning id", [C]);
    await insertReturningId("accounts",
      "insert into accounts (org_id, name, kind, chain) values ($1, 'own-acct', 'operating', 'ARC-TESTNET') returning id", [C]);
    await insertReturningId("invoices",
      "insert into invoices (org_id, direction, counterparty_id, amount, due_date) values ($1, 'payable', $2, 1, now()) returning id",
      [C, ids.counterparties]);
    await insertRow("milestones",
      "insert into milestones (org_id, contractor_id, title, amount) values ($1, $2, 'own-ms', 1)", [C, ids.counterparties]);
    await insertRow("treasury_actions",
      "insert into treasury_actions (org_id, action, amount, from_account) values ($1, 'rebalance', 1, $2)", [C, ids.accounts]);
    await insertRow("compliance_checks",
      "insert into compliance_checks (org_id, counterparty_id, risk_level, source) values ($1, $2, 'clear', 'test')", [C, ids.counterparties]);
    await insertRow("forecasts",
      "insert into forecasts (org_id, as_of, horizon_days, projected_inflow, projected_outflow, liquid_balance) values ($1, now(), 7, 0, 0, 0)", [C]);
    await insertRow("payment_intents",
      `insert into payment_intents (org_id, source_type, source_id, idempotency_key, provider, amount, destination)
       values ($1, 'invoice', $2, 'k-own-insert', 'simulate', 1, 'sim:x')`, [C, ids.invoices]);
    await insertReturningId("cycle_runs",
      "insert into cycle_runs (org_id, started_at, clock_mode, chain_mode, screening_mode) values ($1, now(), 'real', 'simulate', 'simulate') returning id",
      [C]);
    await insertRow("sim_clock", "insert into sim_clock (org_id, current_day) values ($1, 0)", [C]);
    await insertReturningId("cycle_snapshots",
      `insert into cycle_snapshots (org_id, cycle_run_id, captured_at, account_balances, total_liquid, open_payables,
         open_receivables, obligations_due_7d, obligations_due_14d, reserve_position, chain_mode)
       values ($1, $2, now(), '{}'::jsonb, 0, 0, 0, 0, 0, 0, 'simulate') returning id`,
      [C, ids.cycle_runs]);
  });
});

describe("the tenant RPCs under the tenant role", () => {
  function signed(summary: string) {
    const key = crypto.generateKeyPairSync("ed25519");
    const input = { actor: "system" as const, domain: "system" as const, action: "note", summary, detail: { summary } };
    const bodyHash = bodyHashOf(input);
    const signature = crypto.sign(null, Buffer.from(bodyHash, "hex"), key.privateKey).toString("hex");
    return [input.actor, input.domain, input.action, input.summary, JSON.stringify(input.detail), bodyHash, signature, ledgerKeyId(key.privateKey)];
  }
  const append = "select * from append_ledger_entry($1::uuid, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)";

  it("appends to the tenant's own chain", async () => {
    const row = await asTenant(db, A, async (tx) => (await tx.query<{ org_id: string }>(append, [A, ...signed("own")])).rows[0]);
    expect(row.org_id).toBe(A);
  });

  it("refuses appending to another organization's chain", async () => {
    await expect(asTenant(db, A, (tx) => tx.query(append, [B, ...signed("theirs")]))).rejects.toThrow(/row-level security/);
  });

  it("refuses advancing another organization's clock", async () => {
    await expect(asTenant(db, A, (tx) => tx.query("select advance_sim_day($1::uuid)", [B]))).rejects.toThrow(/row-level security/);
  });

  it("cannot claim another organization's payment", async () => {
    const claimed = await asTenant(db, A, async (tx) =>
      (await tx.query<{ id: string | null }>("select * from claim_payment_intent($1::uuid, $2)", [B, rowsB.idempotencyKey])).rows[0]);
    expect(claimed?.id ?? null).toBeNull();
  });

  it("reads no ledger entry of another organization by target", async () => {
    const rows = await asTenant(db, A, async (tx) =>
      (await tx.query("select * from ledger_entries_for_targets($1::uuid, array[$2::text])", [B, rowsB.invoiceId])).rows);
    expect(rows).toEqual([]);
  });

  it("stays closed to the browser roles", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select advance_sim_day($1::uuid)", [A]))).rejects.toThrow(/permission denied/);
    }
  });
});

describe("platform tables", () => {
  it.each(["orgs", "memberships", "invitations", "api_keys", "webhook_endpoints", "webhook_deliveries"])("%s is closed to the tenant role", async (table) => {
    await expect(asTenant(db, A, (tx) => count(tx, table))).rejects.toThrow(/permission denied/);
  });
});

describe("0018 is idempotent", () => {
  it("replays twice without error", async () => {
    await applyMigrations(db);
    await applyMigrations(db);
  });
});

describe("0001's replay never reopens public reads", () => {
  // scripts/migrate.ts replays 0001 on every run, including a run that stops
  // early or a `--through` run that never reaches 0003. 0001's policy loop
  // must therefore only ever drop `<table>_public_read`, never recreate it.
  it("leaves no _public_read policy behind, and tenant visibility unchanged", async () => {
    await applyMigrations(db, (file) => file === "0001_init.sql");

    const stray = await db.query<{ policyname: string }>(
      "select policyname from pg_policies where schemaname = 'public' and policyname like '%_public_read'"
    );
    expect(stray.rows).toEqual([]);

    for (const table of TENANT_TABLES) {
      const seen = await asTenant(db, A, async (tx) =>
        (await tx.query<{ org_id: string }>(`select distinct org_id from public.${table}`)).rows.map((row) => row.org_id));
      expect(seen).toEqual([A]);
    }
  });

  // Even if some future migration adds a stray permissive policy for the
  // tenant role (by mistake, or by forgetting `to vestiarion_tenant`), the
  // restrictive tenant_isolation_guard from 0018 must still hold the line:
  // a restrictive policy is AND-combined with every permissive one.
  it("a stray permissive policy cannot widen what a tenant sees", async () => {
    await db.query("create policy stray_open on public.forecasts for select using (true)");
    try {
      const seen = await asTenant(db, A, async (tx) =>
        (await tx.query<{ org_id: string }>("select distinct org_id from public.forecasts")).rows.map((row) => row.org_id));
      expect(seen).toEqual([A]);
    } finally {
      await db.query("drop policy if exists stray_open on public.forecasts");
    }
  });
});

describe("invoice_drafts' guard (0121)", () => {
  // A captured draft moves draft → sent → confirmed or discarded, back from confirmed only while no bill is linked; a
  // bill is linked once, and only to a confirmed draft; what was captured never changes once the draft is sent, and
  // the captured text is only ever removed. Under the tenant role, as the app writes it.
  async function draft(state = "draft"): Promise<string> {
    return (
      await db.query<{ id: string }>(
        `insert into public.invoice_drafts (org_id, state, source, supplier_name, amount, raw_text, connection_id, idempotency_key, request_sha256)
         values ($1, $2, 'selection', 'Northwind Hosting', '200.00', 'Invoice INV-2207', gen_random_uuid(), gen_random_uuid()::text, repeat('a', 64)) returning id`,
        [A, state]
      )
    ).rows[0].id;
  }
  async function bill(): Promise<string> {
    const counterparty = (await db.query<{ id: string }>("insert into public.counterparties (org_id, name, role) values ($1, $2, 'vendor') returning id", [A, `guard-${crypto.randomUUID()}`])).rows[0].id;
    return (
      await db.query<{ id: string }>("insert into public.invoices (org_id, direction, counterparty_id, amount, due_date) values ($1, 'payable', $2, 1, now()) returning id", [A, counterparty])
    ).rows[0].id;
  }
  const update = (id: string, set: string, params: unknown[] = []) =>
    asTenant(db, A, (tx) => tx.query(`update public.invoice_drafts set ${set} where id = $1`, [id, ...params]));

  it("allows draft → sent → confirmed, a bill linked once, and the text removed", async () => {
    const id = await draft();
    await update(id, "supplier_name = 'Northwind Hosting Ltd', counterparty_id = null");
    await update(id, "state = 'sent', sent_at = now()");
    await update(id, "state = 'confirmed', decided_at = now()");
    await update(id, "invoice_id = $2, raw_text = null", [await bill()]);
    const row = (await db.query<{ state: string; raw_text: string | null }>("select state, raw_text from public.invoice_drafts where id = $1", [id])).rows[0];
    expect(row).toEqual({ state: "confirmed", raw_text: null });
  });

  it("allows a confirmed draft back to sent only while no bill is linked, and discarding a draft not yet decided", async () => {
    const back = await draft("sent");
    await update(back, "state = 'confirmed'");
    await update(back, "state = 'sent', decided_at = null");
    await update(back, "state = 'discarded'");
    await update(await draft(), "state = 'discarded'");

    const linked = await draft("sent");
    await update(linked, "state = 'confirmed'");
    await update(linked, "invoice_id = $2", [await bill()]);
    await expect(update(linked, "state = 'sent', invoice_id = null")).rejects.toThrow(/invoice_draft_state/);
    await expect(update(linked, "state = 'sent'")).rejects.toThrow(/invoice_draft_state/);
  });

  it("refuses every other move", async () => {
    for (const [from, to] of [["sent", "draft"], ["discarded", "sent"], ["discarded", "draft"], ["confirmed", "discarded"], ["draft", "confirmed"]]) {
      const id = await draft(from);
      await expect(update(id, `state = '${to}'`), `${from} → ${to}`).rejects.toThrow(/invoice_draft_state/);
    }
  });

  it("links a bill once, and only to a confirmed draft", async () => {
    const id = await draft("sent");
    await expect(update(id, "invoice_id = $2", [await bill()])).rejects.toThrow(/invoice_drafts_invoice_state_check/);
    await update(id, "state = 'confirmed'");
    const first = await bill();
    await update(id, "invoice_id = $2", [first]);
    await expect(update(id, "invoice_id = $2", [await bill()])).rejects.toThrow(/invoice_draft_linked/);
    const other = await draft("sent");
    await update(other, "state = 'confirmed'");
    await expect(update(other, "invoice_id = $2", [first])).rejects.toThrow(/invoice_drafts_invoice_key/);
  });

  it("keeps what was captured once it is sent, and where it came from always", async () => {
    const id = await draft("sent");
    await expect(update(id, "amount = '1.00'")).rejects.toThrow(/invoice_draft_sent/);
    await expect(update(id, "supplier_name = 'Someone else'")).rejects.toThrow(/invoice_draft_sent/);
    await expect(update(id, "counterparty_id = $2", [rowsB.counterpartyId])).rejects.toThrow();
    const editing = await draft();
    await expect(update(editing, "source = 'file'")).rejects.toThrow(/invoice_draft_fixed/);
    await expect(update(editing, "read = '{}'::jsonb")).rejects.toThrow(/invoice_draft_fixed/);
    await expect(update(editing, "connection_id = gen_random_uuid()")).rejects.toThrow(/invoice_draft_fixed/);
    await expect(update(editing, "raw_text = 'Something else'")).rejects.toThrow(/invoice_draft_text/);
  });
});
