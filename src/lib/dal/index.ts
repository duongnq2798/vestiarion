import type { SupabaseClient } from "@supabase/supabase-js";
import { currentContext, currentOrgId } from "../context";

/**
 * The Data Access Layer: the only way the application reaches tenant data.
 *
 * `db()` is a service-role client narrowed to one organization. Every read,
 * update and delete it builds carries `org_id = <the organization in scope>`,
 * every insert and upsert stamps it, and every tenant RPC receives it as
 * `p_org_id`. A caller cannot widen that: a row or an argument naming another
 * organization is refused, not re-stamped, because it means some other code
 * path already crossed a tenant boundary.
 *
 * `platformDb()` reaches the three tables that exist before any organization
 * is known — organizations, memberships, invitations — and nothing else.
 *
 * ESLint forbids the raw client outside this directory. See eslint.config.mjs.
 */

export const TENANT_TABLES = [
  "accounts", "counterparties", "invoices", "milestones", "treasury_actions", "compliance_checks",
  "forecasts", "ledger_entries", "payment_intents", "cycle_runs", "cycle_snapshots", "sim_clock",
] as const;
export type TenantTable = (typeof TENANT_TABLES)[number];

export const TENANT_RPCS = [
  "append_ledger_entry", "advance_sim_day", "claim_payment_intent", "ledger_entries_for_targets",
] as const;
export type TenantRpc = (typeof TENANT_RPCS)[number];

export const PLATFORM_TABLES = ["orgs", "memberships", "invitations"] as const;
export type PlatformTable = (typeof PLATFORM_TABLES)[number];

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

function tenantTable(client: SupabaseClient, table: TenantTable, orgId: string) {
  const from = () => client.from(table);
  return {
    select: <Q extends string = "*">(columns?: Q, options?: { head?: boolean; count?: Count }) =>
      from().select(columns, options).eq("org_id", orgId),
    insert: (values: Row | Row[], options?: { count?: Count; defaultToNull?: boolean }) =>
      from().insert(stamp(values, orgId), options),
    upsert: (
      values: Row | Row[],
      options?: { onConflict?: string; ignoreDuplicates?: boolean; count?: Count; defaultToNull?: boolean }
    ) => from().upsert(stamp(values, orgId), options),
    update: (values: Row, options?: { count?: Count }) => {
      refuseOtherOrg(values, orgId, "org_id");
      return from().update(values, options).eq("org_id", orgId);
    },
    delete: (options?: { count?: Count }) => from().delete(options).eq("org_id", orgId),
  };
}

export function db() {
  const orgId = currentOrgId();
  const client = currentContext().db;
  return {
    orgId,
    from(table: TenantTable) {
      if (!(TENANT_TABLES as readonly string[]).includes(table)) throw new Error(`${table} is not a tenant table`);
      return tenantTable(client, table, orgId);
    },
    rpc(name: TenantRpc, args: Row = {}, options?: { head?: boolean; get?: boolean; count?: Count }) {
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
  };
}

/** Throws with the Postgres error message attached, rather than a bare `null`. */
export function unwrap<T>(result: { data: T | null; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  if (result.data === null) throw new Error("Supabase returned no data");
  return result.data;
}
