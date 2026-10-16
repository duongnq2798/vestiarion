import crypto from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { bodyHashOf, type LedgerEntryInput, type LedgerRow } from "@/lib/ledger";
import { ledgerKeyId } from "@/lib/ledger-keys";

export const FOUNDING_ORG_ID = "00000000-0000-4000-8000-000000000001";
export const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");

/**
 * What Supabase provides that a vanilla Postgres does not, and nothing more:
 * the three API roles the migrations grant and revoke against, the
 * `auth.users` table that the tenancy tables reference, and the `extensions`
 * schema so 0018's conditional grant on it is exercised. pgcrypto itself
 * stays wherever PGlite loads it (below) — this schema is otherwise empty.
 */
const SUPABASE_BASELINE = `
  create role anon;
  create role authenticated;
  create role service_role bypassrls;
  create role authenticator;
  create schema auth;
  create schema extensions;
  create table auth.users (id uuid primary key, email text);
`;

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith(".sql")).sort();
}

/**
 * A fresh database with Supabase's baseline, on UTC as Supabase's own databases are. PGlite otherwise takes the
 * machine's time zone, so ahead of UTC, early in the local day, its `current_date` was a day past the UTC dates the
 * tests write, and a check such as "a promise within 90 days" let a date it refuses in production through.
 */
export async function createDatabase(): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec("set timezone = 'UTC'");
  await db.exec(SUPABASE_BASELINE);
  return db;
}

export async function applyMigrations(db: PGlite, include: (file: string) => boolean = () => true): Promise<void> {
  for (const file of migrationFiles().filter(include)) {
    await db.exec(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
  }
}

/**
 * Signs the way `appendLedgerEntry` does and hands the body to the real Postgres function to link.
 * Calls the pre-0017 signature (no `p_org_id`): for tests of migrations before 0017 only.
 */
export async function appendSigned(
  db: PGlite,
  input: LedgerEntryInput,
  privateKey: crypto.KeyObject,
  signingKeyId: string | null = ledgerKeyId(privateKey)
): Promise<LedgerRow> {
  const bodyHash = bodyHashOf(input);
  const signature = crypto.sign(null, Buffer.from(bodyHash, "hex"), privateKey).toString("hex");
  const result = await db.query<LedgerRow>(
    "select * from append_ledger_entry($1, $2, $3, $4, $5::jsonb, $6, $7, $8)",
    [input.actor, input.domain, input.action, input.summary, JSON.stringify(input.detail), bodyHash, signature, signingKeyId]
  );
  return result.rows[0];
}

/** As `appendSigned`, through the per-organization append that 0016 adds. */
export async function appendSignedForOrg(
  db: PGlite,
  orgId: string,
  input: LedgerEntryInput,
  privateKey: crypto.KeyObject,
  signingKeyId: string | null = ledgerKeyId(privateKey)
): Promise<LedgerRow> {
  const bodyHash = bodyHashOf(input);
  const signature = crypto.sign(null, Buffer.from(bodyHash, "hex"), privateKey).toString("hex");
  const result = await db.query<LedgerRow>(
    "select * from append_ledger_entry($1::uuid, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)",
    [orgId, input.actor, input.domain, input.action, input.summary, JSON.stringify(input.detail), bodyHash, signature, signingKeyId]
  );
  return result.rows[0];
}

/** A second organization, for isolation tests. */
export async function createOrg(db: PGlite, slug: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    "insert into orgs (slug, name, mode) values ($1, $1, 'sandbox') returning id",
    [slug]
  );
  return result.rows[0].id;
}

/** A person, for tests that need someone to be `created_by` or a member. */
export async function createUser(db: PGlite, email: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    "insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id",
    [email]
  );
  return result.rows[0].id;
}

export const TENANT_TABLES = [
  "accounts", "counterparties", "invoices", "milestones", "treasury_actions", "compliance_checks",
  "forecasts", "ledger_entries", "payment_intents", "cycle_runs", "cycle_snapshots", "sim_clock", "gateway_signers", "payment_receipts", "escrow_contracts",
  "fx_swaps", "screening_dismissals", "receivable_links", "incoming_transfers", "agent_budgets", "recurring_payables", "policy_proposals",
  "service_purchases", "spending_limit_contracts", "ar_reminders", "inbox_emails", "approval_policies", "payment_approvals",
  "shadow_modes", "decision_verdicts", "payment_actuals", "bank_statement_lines", "report_shares", "report_baselines", "receivable_allocations",
  "accounting_connections", "external_links", "accounting_bills", "accounting_sync_cursors", "accounting_postings",
  "deals", "deal_versions", "deal_lines", "deal_costs", "approval_escalations", "approval_escalation_starts",
  "crm_deals", "crm_receipt_writes",
  "customer_portal_links", "customer_requests", "customer_request_messages",
  "projects", "project_reservations",
  "usage_events",
  "collection_policies", "collection_tasks", "notification_deliveries", "collection_task_starts",
  "reporting_currencies", "cash_scenario_versions", "fx_rates", "fx_variances",
  "onboarding_marks",
  "asana_task_links",
  "commission_plans", "commission_plan_deals", "commission_payouts", "commission_lines",
  "decision_reasons",
  "invoice_drafts",
  "workspace_payout_partners", "counterparty_bank_accounts",
  "early_payment_offers", "early_payment_offer_reviews",
] as const;

export interface SeededRows {
  counterpartyId: string;
  accountId: string;
  invoiceId: string;
  cycleRunId: string;
  idempotencyKey: string;
}

type Queryable = Pick<PGlite, "query">;

/** One row in every tenant table for `orgId`, written as the superuser (the service role's stand-in). */
export async function seedOrgRows(db: PGlite, orgId: string, tag: string): Promise<SeededRows> {
  const one = async (sql: string, params: unknown[]) => (await db.query<{ id: string }>(sql, params)).rows[0]?.id;
  const counterpartyId = await one(
    "insert into counterparties (org_id, name, role) values ($1, $2, 'vendor') returning id", [orgId, `cp-${tag}`]);
  const accountId = await one(
    "insert into accounts (org_id, name, kind, chain) values ($1, $2, 'operating', 'ARC-TESTNET') returning id", [orgId, `acct-${tag}`]);
  const invoiceId = await one(
    "insert into invoices (org_id, direction, counterparty_id, amount, due_date) values ($1, 'payable', $2, 1, now()) returning id",
    [orgId, counterpartyId]);
  await db.query("insert into milestones (org_id, contractor_id, title, amount) values ($1, $2, $3, 1)", [orgId, counterpartyId, `m-${tag}`]);
  await db.query("insert into treasury_actions (org_id, action, amount, from_account) values ($1, 'rebalance', 1, $2)", [orgId, accountId]);
  await db.query("insert into compliance_checks (org_id, counterparty_id, risk_level, source) values ($1, $2, 'clear', 'test')", [orgId, counterpartyId]);
  await db.query(
    "insert into forecasts (org_id, as_of, horizon_days, projected_inflow, projected_outflow, liquid_balance) values ($1, now(), 7, 0, 0, 0)", [orgId]);
  const idempotencyKey = `k-${tag}`;
  await db.query(
    `insert into payment_intents (org_id, source_type, source_id, idempotency_key, provider, amount, destination)
     values ($1, 'invoice', $2, $3, 'simulate', 1, 'sim:x')`, [orgId, invoiceId, idempotencyKey]);
  const cycleRunId = await one(
    "insert into cycle_runs (org_id, started_at, clock_mode, chain_mode, screening_mode) values ($1, now(), 'real', 'simulate', 'simulate') returning id",
    [orgId]);
  await db.query(
    `insert into cycle_snapshots (org_id, cycle_run_id, captured_at, account_balances, total_liquid, open_payables,
       open_receivables, obligations_due_7d, obligations_due_14d, reserve_position, chain_mode)
     values ($1, $2, now(), '{}'::jsonb, 0, 0, 0, 0, 0, 0, 'simulate')`, [orgId, cycleRunId]);
  await db.query("select advance_sim_day($1::uuid)", [orgId]);
  await db.query("insert into gateway_signers (org_id, circle_wallet_id, address) values ($1, $2, '0x' || repeat('ab', 20))", [orgId, `signer-${tag}`]);
  await db.query(
    "insert into payment_receipts (org_id, invoice_id, entry_seq, token_hash) values ($1, $2, 1, encode(sha256(convert_to($3, 'utf8')), 'hex'))",
    [orgId, invoiceId, `receipt-${tag}`]
  );
  await db.query("insert into escrow_contracts (org_id) values ($1)", [orgId]);
  await db.query("insert into spending_limit_contracts (org_id) values ($1)", [orgId]);
  await db.query(
    `insert into fx_swaps (org_id, invoice_id, state, usdc_in, eurc_minimum, eurc_estimated, usdc_per_eurc, cost_percent, adapter, call_data, deadline)
     values ($1, $2, 'confirmed', 1, 0.8, 0.82, 1.2, 0, '0x' || repeat('bb', 20), '0x', now())`,
    [orgId, invoiceId]
  );
  await db.query(
    "insert into screening_dismissals (org_id, counterparty_id, matched_entity_id, screened_name, reason) values ($1, $2, $3, $4, 'seeded dismissal')",
    [orgId, counterpartyId, `Q-${tag}`, `cp-${tag}`]
  );
  await db.query(
    "insert into receivable_links (org_id, invoice_id, token_hash) values ($1, $2, encode(sha256(convert_to($3, 'utf8')), 'hex'))",
    [orgId, invoiceId, `pay-${tag}`]
  );
  await db.query(
    "insert into incoming_transfers (org_id, circle_tx_id, amount, token, chain, received_at) values ($1, $2, 1, 'USDC', 'ARC-TESTNET', now())",
    [orgId, `circle-${tag}`]
  );
  await db.query("insert into ar_reminders (org_id, invoice_id, number, tone) values ($1, $2, 1, 'friendly')", [orgId, invoiceId]);
  await db.query("insert into inbox_emails (org_id, resend_email_id, status, invoice_id) values ($1, $2, 'added', $3)", [orgId, `re-${tag}`, invoiceId]);
  await db.query("insert into agent_budgets (org_id, daily_usdc, weekly_usdc) values ($1, 100, 500)", [orgId]);
  await db.query("insert into approval_policies (org_id, two_approvals_above) values ($1, 100)", [orgId]);
  await db.query("insert into shadow_modes (org_id, currency) values ($1, 'VND')", [orgId]);
  await db.query(
    "insert into decision_verdicts (org_id, entry_seq, subject, subject_id, agent_action, verdict) values ($1, 1, 'invoice', $2, 'ap_pay', 'agree')",
    [orgId, invoiceId]
  );
  const actualId = await one(
    "insert into payment_actuals (org_id, invoice_id, outcome, paid_on, amount, currency, method) values ($1, $2, 'paid', '2026-10-09', 1, 'USDC', 'bank_transfer') returning id",
    [orgId, invoiceId]
  );
  // A statement line, and the correction it recorded (0094).
  const statementLineId = await one(
    "insert into bank_statement_lines (org_id, account, booked_on, amount, currency, description, file_line, line_hash) values ($1, 'Main account', '2026-10-09', -1, 'USDC', $2, 2, encode(sha256(convert_to($2, 'utf8')), 'hex')) returning id",
    [orgId, `line-${tag}`]
  );
  await db.query(
    "insert into payment_actuals (org_id, invoice_id, outcome, paid_on, amount, currency, method, replaces, source, statement_line_id) values ($1, $2, 'paid', '2026-10-09', 1, 'USDC', 'bank_transfer', $3, 'statement', $4)",
    [orgId, invoiceId, actualId, statementLineId]
  );
  await db.query(
    "insert into report_shares (org_id, token_hash) values ($1, encode(sha256(convert_to($2, 'utf8')), 'hex'))",
    [orgId, `report-${tag}`]
  );
  await db.query("insert into report_baselines (org_id, minutes_per_bill, people_per_bill) values ($1, 20, 2)", [orgId]);
  // A deal, its signed version and its one line (0104), written whole as create_deal writes it.
  await db.query(
    `select public.create_deal($1, jsonb_build_object('counterpartyId', $2::text, 'title', $3::text, 'currency', 'USDC', 'minorDigits', 2, 'totalMinor', 100,
       'startsOn', '2026-10-12', 'termsDays', 14, 'template', 'custom', 'idempotencyKey', $4::text),
       '[{"position": 1, "label": "All", "invoiceOn": "2026-10-12", "dueOn": "2026-10-26", "amountMinor": 100}]'::jsonb)`,
    [orgId, counterpartyId, `deal-${tag}`, `deal-key-${tag}`]
  );
  // A planned cost of that deal, linked to the payable it became, and an escalation of that payable (0108).
  await db.query(
    `insert into deal_costs (org_id, deal_id, label, amount_minor, expected_on, invoice_id, linked_at, idempotency_key)
     select $1, d.id, 'Contractor', 50, '2026-10-20', $2, now(), $3 from deals d where d.org_id = $1 and d.idempotency_key = $4`,
    [orgId, invoiceId, `cost-key-${tag}`, `deal-key-${tag}`]
  );
  await db.query("insert into approval_escalations (org_id, invoice_id, decide_by) values ($1, $2, '2026-10-20')", [orgId, invoiceId]);
  await db.query("insert into approval_escalation_starts (org_id, starts_on) values ($1, '2026-10-13')", [orgId]);
  // An accounting connection, a link, a bill to review and a cursor (0101).
  const connectionId = await one(
    `insert into accounting_connections (org_id, provider, external_org_id, consent_version, consented_at, window_from)
     values ($1, 'xero', $2, 'xero-2026-10-12', now(), '2026-07-14') returning id`,
    [orgId, `tenant-${tag}`]
  );
  await db.query(
    "insert into external_links (org_id, connection_id, provider, external_org_id, object_type, external_id, local_id, linked_at) values ($1, $2, 'xero', $3, 'contact', $4, $5, now())",
    [orgId, connectionId, `tenant-${tag}`, `contact-${tag}`, counterpartyId]
  );
  await db.query(
    "insert into accounting_bills (org_id, connection_id, external_id, contact_name, currency, total, amount_due, source_status) values ($1, $2, $3, $4, 'USD', 1, 1, 'open')",
    [orgId, connectionId, `bill-${tag}`, `cp-${tag}`]
  );
  await db.query("insert into accounting_sync_cursors (org_id, connection_id, object_type) values ($1, $2, 'bill')", [orgId, connectionId]);
  // A HubSpot connection and a won deal read from it (0105).
  const crmConnectionId = await one(
    `insert into accounting_connections (org_id, provider, external_org_id, consent_version, consented_at, window_from)
     values ($1, 'hubspot', $2, 'hubspot-2026-10-12', now(), '2026-07-14') returning id`,
    [orgId, `hub-${tag}`]
  );
  const dealId = (await db.query<{ id: string }>("select id from deals where org_id = $1 and idempotency_key = $2", [orgId, `deal-key-${tag}`])).rows[0].id;
  const crmDealId = await one(
    "insert into crm_deals (org_id, connection_id, external_id, name, amount, currency, stage_state, deal_id) values ($1, $2, $3, 'Website rebuild', 1, 'USD', 'won', $4) returning id",
    [orgId, crmConnectionId, `deal-${tag}`, dealId]
  );
  // A receipt queued to be written back to that deal in HubSpot (0107).
  await db.query(
    `insert into crm_receipt_writes (org_id, connection_id, crm_deal_id, deal_id, provider, external_org_id, external_deal_id, fields, network, shadow)
     values ($1, $2, $3, $4, 'hubspot', $5, $6, '{"vestiarion_collected": "0.00"}'::jsonb, 'arc-testnet', false)`,
    [orgId, crmConnectionId, crmDealId, dealId, `hub-${tag}`, `deal-${tag}`]
  );
  // A payment made on Arc, drafted to be booked against its bill (0106).
  await db.query(
    `insert into accounting_postings (org_id, connection_id, provider, external_org_id, invoice_id, bill_external_id, amount, currency, paid_on, reference, network, shadow, paid_amount, paid_token)
     values ($1, $2, 'xero', $3, $4, $5, 1, 'USD', '2026-10-12', $6, 'arc-testnet', true, 1, 'USDC')`,
    [orgId, connectionId, `tenant-${tag}`, invoiceId, `bill-${tag}`, `0x${"ab".repeat(32)}`]
  );
  // A receivable part paid from a payment received on Arc (0103).
  const receivableId = await one(
    "insert into invoices (org_id, direction, counterparty_id, amount, due_date) values ($1, 'receivable', $2, 2, now()) returning id",
    [orgId, counterpartyId]
  );
  const paymentId = await one(
    "insert into incoming_transfers (org_id, circle_tx_id, amount, token, chain, received_at) values ($1, $2, 1, 'USDC', 'ARC-TESTNET', now()) returning id",
    [orgId, `circle-applied-${tag}`]
  );
  await db.query(
    "insert into receivable_allocations (org_id, kind, invoice_id, transfer_id, amount, currency, basis) values ($1, 'payment', $2, $3, 1, 'USDC', 'person')",
    [orgId, receivableId, paymentId]
  );
  // A partner's commission plan on the deal, an accrual on that payment, in a payout of the payable (0118).
  const commissionPlanId = await one(
    "insert into commission_plans (org_id, beneficiary_id, rate_bps, basis, scope, hold_days) values ($1, $2, 1000, 'net', 'chosen_deals', 0) returning id",
    [orgId, counterpartyId]
  );
  await db.query("insert into commission_plan_deals (org_id, plan_id, deal_id) values ($1, $2, $3)", [orgId, commissionPlanId, dealId]);
  const commissionPayoutId = await one(
    "insert into commission_payouts (org_id, beneficiary_id, invoice_id, statement, currency, amount, line_count) values ($1, $2, $3, 'CS-0000AB12', 'USDC', 0.1, 1) returning id",
    [orgId, counterpartyId, invoiceId]
  );
  await db.query(
    `insert into commission_lines (org_id, kind, plan_id, beneficiary_id, invoice_id, deal_id, source, allocation_id, transfer_id, basis, base_amount, rate_bps, amount, currency, applied_at, due_at, payout_id)
     select $1, 'accrual', $2, $3, a.invoice_id, $4, 'payment', a.id, a.transfer_id, 'net', a.amount, 1000, 0.1, 'USDC', a.created_at, a.created_at, $5
       from receivable_allocations a where a.org_id = $1 and a.invoice_id = $6`,
    [orgId, commissionPlanId, counterpartyId, dealId, commissionPayoutId, receivableId]
  );
  const approver = await one("insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id", [`approver-${tag}-${crypto.randomUUID()}@example.com`]);
  await db.query(
    "insert into payment_approvals (org_id, source_type, source_id, approved_by, amount, currency) values ($1, 'invoice', $2, $3, 1, 'USDC')",
    [orgId, invoiceId, approver]
  );
  await db.query(
    "insert into recurring_payables (org_id, counterparty_id, amount, memo, every_count, every_unit, starts_on) values ($1, $2, 5, $3, 1, 'month', '2026-10-31')",
    [orgId, counterpartyId, `recurring-${tag}`]
  );
  await db.query(
    "insert into policy_proposals (org_id, counterparty_id, from_limit, to_limit, reasoning) values ($1, $2, 2, 6, $3)",
    [orgId, counterpartyId, `proposal-${tag}`]
  );
  await db.query(
    "insert into service_purchases (org_id, counterparty_id, address, seller_url, status, reason) values ($1, $2, '0x' || repeat('cd', 20), $3, 'refused', 'seeded')",
    [orgId, counterpartyId, `https://seller.invalid/${tag}`]
  );
  // A customer's statement link, a claim of payment through it, and a reply under it (0109).
  const customerId = await one("insert into counterparties (org_id, name, role) values ($1, $2, 'client') returning id", [orgId, `customer-${tag}`]);
  const customerInvoiceId = await one(
    "insert into invoices (org_id, direction, counterparty_id, amount, due_date) values ($1, 'receivable', $2, 3, now()) returning id",
    [orgId, customerId]
  );
  const portalLinkId = await one(
    "insert into customer_portal_links (org_id, counterparty_id, token_hash, expires_at) values ($1, $2, encode(sha256(convert_to($3, 'utf8')), 'hex'), now() + interval '30 days') returning id",
    [orgId, customerId, `portal-${tag}`]
  );
  const customerRequestId = await one(
    "insert into customer_requests (org_id, link_id, counterparty_id, invoice_id, kind, paid_on) values ($1, $2, $3, $4, 'paid', current_date) returning id",
    [orgId, portalLinkId, customerId, customerInvoiceId]
  );
  await db.query("insert into customer_request_messages (org_id, request_id, body) values ($1, $2, 'We are checking.')", [orgId, customerRequestId]);
  // That customer's collection rules, a task about its invoice, and a reminder email recorded as sent (0110).
  await db.query(
    "insert into collection_policies (org_id, counterparty_id, version, approval, max_tone, min_days_between) values ($1, $2, 1, 'ask_first', 'firm', 7)",
    [orgId, customerId]
  );
  await db.query(
    `insert into collection_tasks (org_id, invoice_id, counterparty_id, kind, reason, subject_key, policy_version, proposal)
     values ($1, $2, $3, 'ask_owner', 'policy_ask_first', 'policy:1:reminder:1', 1, '{"headline": "Ask first"}'::jsonb)`,
    [orgId, customerInvoiceId, customerId]
  );
  await db.query(
    `insert into notification_deliveries (org_id, idempotency_key, kind, subject_id, recipient_hash, policy_version, sent_at)
     values ($1, encode(sha256(convert_to($2, 'utf8')), 'hex'), 'collection_reminder', $3, encode(sha256(convert_to($4, 'utf8')), 'hex'), 1, now())`,
    [orgId, `delivery-${tag}`, customerInvoiceId, `billing-${tag}@example.com`]
  );
  await db.query("insert into collection_task_starts (org_id, starts_on) values ($1, '2026-10-13')", [orgId]);
  // A project, a payable put in it, and the money set aside for that payable (0111).
  const projectId = await one(
    "insert into projects (org_id, name, budget_minor, idempotency_key) values ($1, $2, 100000, $3) returning id",
    [orgId, `project-${tag}`, `project-key-${tag}`]
  );
  const projectVendorId = await one("insert into counterparties (org_id, name, role) values ($1, $2, 'vendor') returning id", [orgId, `project-vendor-${tag}`]);
  const projectBillId = await one(
    "insert into invoices (org_id, direction, counterparty_id, amount, due_date, project_id) values ($1, 'payable', $2, 5, now(), $3) returning id",
    [orgId, projectVendorId, projectId]
  );
  await db.query("select public.reserve_project_budget($1, $2, null, 'entry', null)", [orgId, projectBillId]);
  // What the workspace used: a model call for a decision, with its tokens and cost (0112).
  await db.query(
    "insert into usage_events (org_id, kind, action, provider, model, input_tokens, output_tokens, cost, cost_currency) values ($1, 'model_call', 'decision', 'anthropic', 'claude-test', 100, 20, 0.0006, 'USD')",
    [orgId]
  );
  // The reporting currency, a saved cash scenario with a rate typed into it, the day's reference rate, and the FX
  // variance on a paid bill at it (0113).
  await db.query("insert into reporting_currencies (org_id, currency) values ($1, 'SGD')", [orgId]);
  const scenarioVersionId = await one(
    "insert into cash_scenario_versions (org_id, scenario_id, version, name, levers) values ($1, gen_random_uuid(), 1, $2, '{}'::jsonb) returning id",
    [orgId, `scenario-${tag}`]
  );
  await db.query(
    "insert into fx_rates (org_id, base, quote, rate, kind, source, published_at, scenario_version_id) values ($1, 'USD', 'SGD', 1.4, 'manual', 'Cash scenario', now(), $2)",
    [orgId, scenarioVersionId]
  );
  const rateId = await one(
    "insert into fx_rates (org_id, base, quote, rate, kind, source, published_at) values ($1, 'USD', 'SGD', 1.36, 'reference', 'ExchangeRate-API', '2026-10-12T00:02:00Z') returning id",
    [orgId]
  );
  await db.query(
    `insert into fx_variances (org_id, invoice_id, currency, paid_currency, paid_amount, paid_at, covered_amount, decision_rate, decision_source,
       decision_at, payment_rate_id, payment_rate, payment_source, payment_rate_at, value_at_payment, variance)
     values ($1, $2, 'SGD', 'USDC', 1000, '2026-10-12T15:00:00Z', 1350, 1.35, 'ExchangeRate-API', '2026-10-10T00:02:00Z', $3, 1.36,
       'ExchangeRate-API', '2026-10-12T00:02:00Z', 992.65, 7.35)`,
    [orgId, invoiceId, rateId]
  );
  // An Asana connection, and a task linked to the workspace's milestone (0115).
  const asanaConnectionId = await one(
    `insert into accounting_connections (org_id, provider, external_org_id, consent_version, consented_at, window_from)
     values ($1, 'asana', $2, 'asana-2026-10-14', now(), '2026-07-14') returning id`,
    [orgId, String(crypto.randomInt(1, 2 ** 40))]
  );
  await db.query(
    `insert into asana_task_links (org_id, milestone_id, connection_id, workspace_gid, task_gid, task_name)
     select $1, m.id, $2, '1204081671801519', $3, 'Logo animation' from milestones m where m.org_id = $1 and m.title = $4`,
    [orgId, asanaConnectionId, String(crypto.randomInt(1, 2 ** 40)), `m-${tag}`]
  );
  // A member's checklist mark: Approvals opened while a bill waited there (0114).
  await db.query("insert into onboarding_marks (org_id, user_id, mark) values ($1, $2, 'approvals_opened')", [orgId, approver]);
  // A reason a member gave for rejecting a bill (0120).
  await db.query(
    `insert into decision_reasons (org_id, feature, decision, surface, subject, subject_id, reason, app_version, given_by)
     values ($1, 'approvals', 'reject', 'console', 'invoice', $2, $3, 'v0.1.0', $4)`,
    [orgId, invoiceId, `reason-${tag}`, approver]
  );
  // A draft the Chrome extension captured, added as that payable (0121).
  await db.query(
    `insert into invoice_drafts (org_id, state, source, supplier_name, amount, connection_id, idempotency_key, request_sha256, invoice_id)
     values ($1, 'confirmed', 'selection', $2, '1', gen_random_uuid(), $3, encode(sha256(convert_to($3, 'utf8')), 'hex'), $4)`,
    [orgId, `cp-${tag}`, `capture-${tag}`, invoiceId]
  );
  // The workspace's BlindPay customer, and a vendor's bank account at BlindPay (0124).
  await db.query("insert into workspace_payout_partners (org_id, tos_id, customer_id) values ($1, 'to_test1234', 're_test1234')", [orgId]);
  await db.query(
    `insert into counterparty_bank_accounts (org_id, counterparty_id, external_id, bank_code, last4, beneficiary_name)
     values ($1, $2, 'ba_test1234', '012', '9716', 'Ana López')`,
    [orgId, counterpartyId]
  );
  // An early-payment offer for the bill (0125).
  await db.query(
    `insert into early_payment_offers (org_id, invoice_id, counterparty_id, discount_pct, amount, offered_amount, token_hash, expires_at)
     values ($1, $2, $3, 1, 1, 0.99, encode(sha256(convert_to($4, 'utf8')), 'hex'), now() + interval '7 days')`,
    [orgId, invoiceId, counterpartyId, `offer-${tag}`]
  );
  // The agent's review of the bill (0126).
  await db.query("insert into early_payment_offer_reviews (org_id, invoice_id, action) values ($1, $2, 'skip')", [orgId, invoiceId]);
  const key = crypto.generateKeyPairSync("ed25519");
  await appendSignedForOrg(db, orgId, { actor: "system", domain: "system", action: "note", summary: tag, detail: { tag } }, key.privateKey);
  return { counterpartyId, accountId, invoiceId, cycleRunId, idempotencyKey };
}

/**
 * Runs `fn` the way PostgREST runs a request made with a tenant token: as the
 * role `vestiarion_tenant`, with `request.jwt.claims` holding the token's
 * claims. `null` means a request whose token names no organization.
 */
export async function asTenant<T>(db: PGlite, orgId: string | null, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    const claims = orgId ? { role: "vestiarion_tenant", org_id: orgId } : { role: "vestiarion_tenant" };
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    // PostgREST connects as authenticator and switches to vestiarion_tenant
    // from there, through the membership 0018 grants — not straight to the
    // target role — so this does the same, rather than jumping straight to
    // `set local role vestiarion_tenant`.
    await tx.query("set local role authenticator");
    await tx.query("set local role vestiarion_tenant");
    return fn(tx);
  });
}

/** Runs `fn` as one of the browser roles, which must have no access at all. */
export async function asRole<T>(db: PGlite, role: "anon" | "authenticated", fn: (tx: Queryable) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query(`set local role ${role}`);
    return fn(tx);
  });
}

/**
 * Runs `fn` as `service_role`, the way the server's own RPC calls run: RLS
 * applies to the connection but is bypassed through the role's BYPASSRLS
 * attribute (as on Supabase), rather than sidestepped by staying on PGlite's
 * superuser connection.
 */
export async function asServiceRole<T>(db: PGlite, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query("set local role service_role");
    return fn(tx);
  });
}
