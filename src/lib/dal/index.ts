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
 * path already crossed a tenant boundary. An upsert that could still *update*
 * a row — anything but `ignoreDuplicates` — must also name `org_id` in
 * `onConflict`, or the conflict key it does name could resolve onto another
 * organization's row. And the organization is bound once, when `db()` is
 * called: a handle kept past a nested scope for another organization refuses
 * to act rather than keep serving the one it was created in.
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
  const client = currentContext().db;
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
  };
}

/** Throws with the Postgres error message attached, rather than a bare `null`. */
export function unwrap<T>(result: { data: T | null; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  if (result.data === null) throw new Error("Supabase returned no data");
  return result.data;
}
