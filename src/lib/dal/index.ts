import type { SupabaseClient } from "@supabase/supabase-js";
import { currentContext, currentOrgId } from "../context";

/**
 * The Data Access Layer: the only way the application reaches tenant data.
 *
 * `db()` is the organization's tenant client, narrowed to it twice over: each
 * request runs as `vestiarion_tenant` with a token naming the organization, so
 * row-level security confines it in the database; and every read, update and
 * delete it builds carries `org_id = <the organization in scope>`, every
 * insert and upsert stamps it, and every tenant RPC receives it as `p_org_id`.
 * A caller cannot widen that: a row or an argument naming another
 * organization is refused, not re-stamped, because it means some other code
 * path already crossed a tenant boundary. An upsert that could still *update*
 * a row — anything but `ignoreDuplicates` — must also name `org_id` in
 * `onConflict`, or the conflict key it does name could resolve onto another
 * organization's row. And the organization is bound once, when `db()` is
 * called: a handle kept past a nested scope for another organization refuses
 * to act rather than keep serving the one it was created in.
 *
 * `platformDb()` reaches the tables that exist before any organization is
 * known — organizations, memberships, invitations — plus the workspace API
 * keys, which must be read before any organization is known (a request names
 * its organization only through its key), the webhook endpoints and delivery
 * queue, which the dispatcher works through across every organization at once,
 * and the functions that write them, and nothing else. It keeps the service
 * role, because none of those rows belong to one tenant.
 *
 * The team's growth records (migration 0099) are platform tables too: leads, campaigns, spend and revenue belong to
 * no workspace, and only the founder dashboard (src/lib/growth), behind its own team gate, reads or writes them.
 *
 * An accounting connection's tokens (migration 0101) are a platform table as Slack's bot token is: only
 * `src/lib/connectors/token-store.ts` reads or writes them, always naming the workspace in scope, and the service-role
 * functions that serialize a refresh and list the connections due a sync go with them. So does the one that finds a
 * connection by the provider's own organisation id across workspaces (migration 0102, again in 0105), for QuickBooks'
 * webhook, which names a company and no workspace, and the connect flow's check that a QuickBooks company or a HubSpot
 * account is no other workspace's; it answers ids and a status, nothing else.
 *
 * An Asana webhook's secret (migration 0115) is one too: only `src/lib/asana/webhook-store.ts` reads or writes
 * `asana_webhooks`, naming the workspace in scope, except the webhook route's lookup of one row by the id in Asana's
 * target address.
 *
 * So are the Chrome extension's connections and one-time codes (migration 0121): a request names its workspace only
 * through its token, as with an API key, so only `src/lib/extension/tokens.ts` reads or writes them, by a token's hash
 * or naming the workspace.
 *
 * One read reaches past those tables: the dispatcher embeds a delivery's own
 * ledger entry (`webhook_deliveries` → `ledger_entries` by foreign key), so it
 * can only ever see the entry that delivery was queued for.
 *
 * ESLint forbids the raw client outside this directory. See eslint.config.mjs.
 */

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
  // Why a person went against the agent, asked in the moment (migration 0120).
  "decision_reasons",
  // What the Chrome extension captured, until a person adds it as a bill or discards it (migration 0121).
  "invoice_drafts",
  // Bank payouts through BlindPay: the workspace's customer and each vendor's bank account (migration 0124).
  "workspace_payout_partners", "counterparty_bank_accounts",
  "early_payment_offers",
  // The agent's one review of each bill it may offer early payment on (migration 0126).
  "early_payment_offer_reviews",
  // Discounts the agent offers customers for paying early, and its one review of each receivable (migration 0129).
  "customer_discount_offers", "customer_discount_reviews",
  // Requests for more time on bills held for cash, and the agent's one review of each bill (migration 0128).
  "payment_term_requests", "payment_term_request_reviews",
  // Suppliers' payment status links (migration 0131, supplier status V1).
  "supplier_status_links",
  // Asking a payee's contact whether they changed its address (migration 0137, address change check AC1).
  "address_change_checks",
] as const;
export type TenantTable = (typeof TENANT_TABLES)[number];

export const TENANT_RPCS = [
  "append_ledger_entry", "advance_sim_day", "claim_payment_intent", "ledger_entries_for_targets",
  "begin_cycle_run", "agent_paused", "claim_invoice_decision", "begin_payment_retry", "claim_milestone_decision",
  "sole_approver", "approvers_besides", "approvers_among",
  // How many accountants co-sign besides those named (migration 0138, accountant co-sign CS5).
  "cosigners_besides",
  "create_deal", "revise_deal",
  "reserve_project_budget", "project_figures",
  "accept_asana_task", "hold_asana_acceptance",
  // Whether migration 0116 has run (Pipedrive connector P2): it reads nothing.
  "pipedrive_connector_ready",
  // Whether migration 0122 has run (Zoho Books connector Z12): it reads nothing.
  "zohobooks_connector_ready",
  // Whether migration 0123 has run (Zoho CRM connector C17): it reads nothing.
  "zohocrm_connector_ready",
  // Whether migration 0124 has run (bank payouts B11): it reads nothing.
  "bank_payouts_ready",
  // Whether migration 0125 has run (early-payment offers E7): it reads nothing.
  "early_payment_offers_ready",
  // Whether migration 0126 has run (agent early-payment offers AO4): it reads nothing.
  "early_payment_offer_reviews_ready",
  // Whether migration 0129 has run (customer discounts C1): it reads nothing.
  "customer_discounts_ready",
  // Whether migration 0128 has run (term requests X6): it reads nothing.
  "term_requests_ready",
  // Commissions on money received (commissions C2, C5, C10, C11).
  "set_commission_plan", "end_commission_plan", "record_commissions", "create_commission_payout", "commission_partner_members",
] as const;
export type TenantRpc = (typeof TENANT_RPCS)[number];

export const PLATFORM_TABLES = [
  "orgs", "memberships", "invitations", "api_keys", "webhook_endpoints", "webhook_deliveries", "payee_links", "x402_sales",
  "telegram_link_codes", "telegram_links", "telegram_drafts", "api_idempotency",
  "slack_installs", "slack_links", "slack_link_requests", "slack_drafts", "invoice_inboxes", "github_installations", "github_bounties",
  "platform_controls",
  "growth_campaigns", "growth_leads", "growth_lead_events", "growth_spend", "growth_revenue",
  "accounting_tokens",
  "asana_webhooks",
  // The Chrome extension's connections and one-time codes (migration 0121): read by token before any workspace is known.
  "extension_grants", "extension_auth_codes",
] as const;
export type PlatformTable = (typeof PLATFORM_TABLES)[number];

export const PLATFORM_RPCS = [
  "create_org", "invite_member", "accept_invitation", "change_member_role", "remove_member_revoking_keys",
  "revoke_invitation", "org_members", "touch_org_activity", "delete_sandbox_org",
  "pending_invitations_for", "accept_invitation_by_id", "pause_agent", "resume_agent", "create_api_key",
  "claim_webhook_deliveries", "record_webhook_failure", "create_webhook_endpoint", "choose_hosted_wallet", "delete_org",
  "open_numbers", "open_first_payments", "open_outcomes", "open_verdicts", "open_funnel", "set_platform_team_member", "platform_team_members",
  "latest_team_decision", "recent_team_decisions", "landing_team_journeys",
  "create_payee_link", "payee_link_preview", "payee_link_chain", "claim_payee_link", "release_payee_link", "revoke_payee_link", "payee_link_status",
  // A payee link made with its options, closing an earlier link's invoice, and the invoice a payee sends (0133, payee invoice link P1, P4-P6).
  "create_payee_link_with_options", "close_payee_invoice_intake", "submit_payee_invoice",
  "payment_receipt_by_token", "report_share_by_token", "pay_link_preview", "enable_usyc_reserve", "payee_history",
  "telegram_claim_code", "telegram_activate", "slack_link_member",
  "growth_team_member", "growth_workspaces", "growth_update_lead", "growth_import_leads", "record_org_attribution",
  "growth_decision_reasons",
  "accounting_token_lease", "accounting_token_store", "accounting_token_release", "accounting_connections_due",
  "accounting_connections_by_external",
  "customer_portal_by_token", "customer_portal_submit", "customer_portal_reply",
  // The daily cleanup's retention for invoice capture (migration 0121).
  "invoice_capture_sweep",
  // Early-payment offers (0125, early-payment offers E3-E6): made and withdrawn by a workspace, previewed and decided by token.
  "create_early_payment_offer", "withdraw_early_payment_offer", "early_payment_offer_preview", "decide_early_payment_offer", "set_agent_early_offers",
  // Suppliers' counters to the agent's offers (0127, offer counters N1, N2, N5).
  "early_payment_offer_by_agent", "counter_early_payment_offer", "answer_early_payment_counter",
  // Discounts offered to customers for paying early (0129, customer discounts C1, C4-C6): set, made, withdrawn and settled
  // for a workspace, previewed and decided by token.
  "set_customer_offers", "create_customer_discount_offer", "withdraw_customer_discount_offer", "customer_discount_preview",
  "decide_customer_discount", "settle_customer_discount",
  // Requests for more time (0128, term requests X1, X4-X6): made and withdrawn by the agent, previewed and decided by token.
  "create_term_request", "term_request_preview", "decide_term_request", "withdraw_term_request", "set_term_requests",
  // Suppliers' counters to the agent's requests for more time (0130, term counters F5, F6).
  "counter_term_request", "answer_term_counter",
  // A supplier's payment status page, looked up by its link (0131, supplier status V4).
  "supplier_status_by_token",
  // "Was this you?" (0137, address change check AC1-AC4): made and marked sent for a workspace, previewed and answered by
  // token, and a frozen payee unfrozen.
  "create_address_change_check", "mark_address_change_check_sent", "address_change_check_preview", "answer_address_change_check",
  "unfreeze_counterparty", "restore_counterparty_freeze",
] as const;
export type PlatformRpc = (typeof PLATFORM_RPCS)[number];

type Row = Record<string, unknown>;
type Count = "exact" | "planned" | "estimated";

const CROSSED = "names a different organization than the one in scope";

function refuseOtherOrg(value: unknown, orgId: string, key: "org_id" | "p_org_id"): void {
  if (value && typeof value === "object" && key in value && (value as Row)[key] !== orgId) {
    throw new Error(`A ${key === "org_id" ? "row" : "call"} ${CROSSED}`);
  }
}

function stamp<T extends Row | Row[]>(values: T, orgId: string): T {
  const one = (row: Row): Row => {
    refuseOtherOrg(row, orgId, "org_id");
    return { ...row, org_id: orgId };
  };
  return (Array.isArray(values) ? values.map(one) : one(values)) as T;
}

/**
 * Merge-mode upsert — `ignoreDuplicates` unset or `false`, postgrest-js's own
 * default — resolves the conflict on whatever `onConflict` names, and on the
 * global `id` primary key when it names nothing. Naming `org_id` is what
 * confines that resolution to rows already inside the organization; without
 * it, an upsert stamped with the right `org_id` on *insert* would still
 * *update* — and relabel into this organization — whatever row elsewhere
 * happens to share the key it does name (R9). `ignoreDuplicates` upserts
 * never update an existing row, so they carry no such risk.
 */
function refuseUnsafeUpsert(options?: { onConflict?: string; ignoreDuplicates?: boolean }): void {
  if (options?.ignoreDuplicates === true) return;
  const columns = (options?.onConflict ?? "").split(",").map((column) => column.trim());
  if (!columns.includes("org_id")) {
    throw new Error("An upsert that can update rows must name org_id in onConflict");
  }
}

/**
 * `db()` binds its organization once, when it is called. A handle kept
 * across an `await` and then used inside a nested `runWith` for another
 * organization must not go on acting for the first one, so `from()` and
 * `rpc()` re-check the scope on every call rather than trusting the closure
 * (R10) — and so does every method of the table handle `from()` returns,
 * which can be kept across a nested scope just the same.
 */
function refuseScopeMismatch(boundOrgId: string): void {
  if (currentOrgId() !== boundOrgId) {
    throw new Error("This database handle belongs to a different organization than the one in scope");
  }
}

function tenantTable(client: SupabaseClient, table: TenantTable, orgId: string) {
  const from = () => {
    refuseScopeMismatch(orgId);
    return client.from(table);
  };
  return {
    select: <Q extends string = "*">(columns?: Q, options?: { head?: boolean; count?: Count }) =>
      from().select(columns, options).eq("org_id", orgId),
    insert: (values: Row | Row[], options?: { count?: Count; defaultToNull?: boolean }) =>
      from().insert(stamp(values, orgId), options),
    upsert: (
      values: Row | Row[],
      options?: { onConflict?: string; ignoreDuplicates?: boolean; count?: Count; defaultToNull?: boolean }
    ) => {
      refuseUnsafeUpsert(options);
      return from().upsert(stamp(values, orgId), options);
    },
    update: (values: Row, options?: { count?: Count }) => {
      refuseOtherOrg(values, orgId, "org_id");
      return from().update(values, options).eq("org_id", orgId);
    },
    delete: (options?: { count?: Count }) => from().delete(options).eq("org_id", orgId),
  };
}

export function db() {
  const orgId = currentOrgId();
  const client = currentContext().tenantDb;
  // No fallback to the service role: a scope the DAL did not build has no
  // tenant client, and reaching tenant data without one is the failure this
  // whole layer exists to prevent.
  if (!client) throw new Error("This organization's scope has no tenant client; enter it through withOrg or inOrg");
  return {
    orgId,
    from(table: TenantTable) {
      refuseScopeMismatch(orgId);
      if (!(TENANT_TABLES as readonly string[]).includes(table)) throw new Error(`${table} is not a tenant table`);
      return tenantTable(client, table, orgId);
    },
    rpc(name: TenantRpc, args: Row = {}, options?: { head?: boolean; get?: boolean; count?: Count }) {
      refuseScopeMismatch(orgId);
      if (!(TENANT_RPCS as readonly string[]).includes(name)) throw new Error(`${name} is not a tenant function`);
      refuseOtherOrg(args, orgId, "p_org_id");
      return client.rpc(name, { ...args, p_org_id: orgId }, options);
    },
  };
}

export type OrgDb = ReturnType<typeof db>;

export function platformDb() {
  const client = currentContext().db;
  return {
    from(table: PlatformTable) {
      if (!(PLATFORM_TABLES as readonly string[]).includes(table)) throw new Error(`${table} is not a platform table`);
      return client.from(table);
    },
    rpc(name: PlatformRpc, args: Row = {}) {
      if (!(PLATFORM_RPCS as readonly string[]).includes(name)) throw new Error(`${name} is not a platform function`);
      return client.rpc(name, args);
    },
  };
}

/**
 * The service role's auth admin API, narrowed to the one call the platform
 * makes: deleting the signed-in person's own account (account deletion,
 * spec §6 A3). Nothing else of the admin API is reachable from here.
 */
export function platformAuth() {
  const client = currentContext().db;
  return {
    deleteUser: (userId: string) => client.auth.admin.deleteUser(userId, false),
  };
}

/** Throws with the Postgres error message attached, rather than a bare `null`. */
export function unwrap<T>(result: { data: T | null; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  if (result.data === null) throw new Error("Supabase returned no data");
  return result.data;
}
