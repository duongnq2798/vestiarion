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
  "service_purchases", "spending_limit_contracts", "ar_reminders",
] as const;
export type TenantTable = (typeof TENANT_TABLES)[number];

export const TENANT_RPCS = [
  "append_ledger_entry", "advance_sim_day", "claim_payment_intent", "ledger_entries_for_targets",
  "begin_cycle_run", "agent_paused", "claim_invoice_decision", "begin_payment_retry", "claim_milestone_decision",
  "sole_approver",
] as const;
export type TenantRpc = (typeof TENANT_RPCS)[number];

export const PLATFORM_TABLES = [
  "orgs", "memberships", "invitations", "api_keys", "webhook_endpoints", "webhook_deliveries", "payee_links", "x402_sales",
  "telegram_link_codes", "telegram_links", "telegram_drafts", "api_idempotency",
  "slack_installs", "slack_links", "slack_link_requests", "slack_drafts",
] as const;
export type PlatformTable = (typeof PLATFORM_TABLES)[number];

export const PLATFORM_RPCS = [
  "create_org", "invite_member", "accept_invitation", "change_member_role", "remove_member_revoking_keys",
  "revoke_invitation", "org_members", "touch_org_activity", "delete_sandbox_org",
  "pending_invitations_for", "accept_invitation_by_id", "pause_agent", "resume_agent", "create_api_key",
  "claim_webhook_deliveries", "record_webhook_failure", "create_webhook_endpoint", "choose_hosted_wallet", "delete_org",
  "open_numbers", "open_first_payments", "open_outcomes", "set_platform_team_member", "platform_team_members",
  "create_payee_link", "payee_link_preview", "payee_link_chain", "claim_payee_link", "release_payee_link", "revoke_payee_link", "payee_link_status",
  "payment_receipt_by_token", "pay_link_preview", "enable_usyc_reserve", "payee_history",
  "telegram_claim_code", "telegram_activate", "slack_link_member",
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
