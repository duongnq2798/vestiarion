import type { PostgrestError } from "@supabase/supabase-js";
import type { ReminderTone } from "../collections";
import type { OrgDb } from "../dal";
import {
  defaultPolicy,
  type Approval,
  type CollectionPolicy,
  type CollectionTask,
  type CrmContext,
  type CustomerSaid,
  type TaskKind,
  type TaskOutcome,
  type TaskProposal,
  type TaskReason,
} from "./model";

/**
 * Reading a receivable's context in the workspace in scope (docs/superpowers/specs/2026-10-13-collections-context-design.md
 * C7): its customer's rules (the latest version), its collection tasks, the HubSpot deal it was planned from with that
 * deal's owner, and what its customer said on its statement. Each read answers what it can: before migration 0110 runs
 * there are no rules and no tasks (every customer has the workspace's own), and before 0109 nothing said.
 */

/** A table or a column this deployment does not have yet. */
export function notThereYet(error: PostgrestError | null): boolean {
  if (!error) return false;
  return error.code === "PGRST205" || error.code === "42P01" || error.code === "42703" || error.code === "PGRST204";
}

const POLICY_COLUMNS = "id, counterparty_id, version, approval, max_tone, min_days_between, channel, account_owner, created_by, created_at";

type PolicyRow = {
  id: string;
  counterparty_id: string;
  version: number;
  approval: Approval;
  max_tone: ReminderTone;
  min_days_between: number;
  channel: "email";
  account_owner: string | null;
  created_by: string | null;
  created_at: string;
};

export function toPolicy(row: PolicyRow): CollectionPolicy {
  return {
    id: row.id,
    counterpartyId: row.counterparty_id,
    version: Number(row.version),
    approval: row.approval,
    maxTone: row.max_tone,
    minDaysBetween: Number(row.min_days_between),
    channel: row.channel,
    accountOwner: row.account_owner,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export type PoliciesRead = { available: false } | { available: true; latest: Map<string, CollectionPolicy> };

/** Each customer's latest rules (of these customers, or all). */
export async function readPolicies(orgDb: OrgDb, counterpartyIds?: readonly string[]): Promise<PoliciesRead> {
  if (counterpartyIds && counterpartyIds.length === 0) return { available: true, latest: new Map() };
  let query = orgDb.from("collection_policies").select(POLICY_COLUMNS).order("version", { ascending: false }).limit(2000);
  if (counterpartyIds) query = query.in("counterparty_id", [...counterpartyIds]);
  const read = await query;
  if (read.error) {
    if (notThereYet(read.error)) return { available: false };
    throw new Error(read.error.message);
  }
  const latest = new Map<string, CollectionPolicy>();
  for (const row of (read.data ?? []) as PolicyRow[]) if (!latest.has(row.counterparty_id)) latest.set(row.counterparty_id, toPolicy(row));
  return { available: true, latest };
}

/** A customer's rules: its latest version, or the workspace's own. */
export const policyOf = (read: PoliciesRead, counterpartyId: string): CollectionPolicy =>
  (read.available ? read.latest.get(counterpartyId) : undefined) ?? defaultPolicy(counterpartyId);

export const TASK_COLUMNS =
  "id, invoice_id, counterparty_id, kind, reason, subject_key, assignee, policy_version, proposal, status, outcome, hold_until, approved_number, approved_tone, resolved_at, resolved_by, notified_at, created_at";

export type TaskRow = {
  id: string;
  invoice_id: string;
  counterparty_id: string;
  kind: TaskKind;
  reason: TaskReason;
  subject_key: string;
  assignee: string | null;
  policy_version: number;
  proposal: unknown;
  status: "open" | "done";
  outcome: TaskOutcome | null;
  hold_until: string | null;
  approved_number: number | null;
  approved_tone: ReminderTone | null;
  resolved_at: string | null;
  resolved_by: string | null;
  notified_at: string | null;
  created_at: string;
};

function proposalOf(value: unknown): TaskProposal {
  const json = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    headline: typeof json.headline === "string" ? json.headline : "",
    reasons: Array.isArray(json.reasons)
      ? json.reasons.filter((reason): reason is TaskProposal["reasons"][number] => !!reason && typeof reason === "object" && typeof (reason as { text?: unknown }).text === "string")
      : [],
    reminder: json.reminder && typeof json.reminder === "object" ? (json.reminder as TaskProposal["reminder"]) : null,
  };
}

export function toTask(row: TaskRow): CollectionTask {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    counterpartyId: row.counterparty_id,
    kind: row.kind,
    reason: row.reason,
    subjectKey: row.subject_key,
    assignee: row.assignee,
    policyVersion: Number(row.policy_version),
    proposal: proposalOf(row.proposal),
    status: row.status,
    outcome: row.outcome,
    holdUntil: row.hold_until ? String(row.hold_until).slice(0, 10) : null,
    approvedNumber: row.approved_number === null ? null : Number(row.approved_number),
    approvedTone: row.approved_tone,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    notifiedAt: row.notified_at,
    createdAt: row.created_at,
  };
}

export type TasksRead = { available: false } | { available: true; tasks: CollectionTask[] };

/** The tasks about these receivables (or every open one), newest first. */
export async function readTasks(orgDb: OrgDb, filter: { invoiceIds?: readonly string[]; openOnly?: boolean } = {}): Promise<TasksRead> {
  if (filter.invoiceIds && filter.invoiceIds.length === 0) return { available: true, tasks: [] };
  let query = orgDb.from("collection_tasks").select(TASK_COLUMNS).order("created_at", { ascending: false }).limit(1000);
  if (filter.invoiceIds) query = query.in("invoice_id", [...filter.invoiceIds]);
  if (filter.openOnly) query = query.eq("status", "open");
  const read = await query;
  if (read.error) {
    if (notThereYet(read.error)) return { available: false };
    throw new Error(read.error.message);
  }
  return { available: true, tasks: ((read.data ?? []) as TaskRow[]).map(toTask) };
}

/** HubSpot's own address for a deal, in the account it lives in. */
export const hubspotDealUrl = (portalId: string, dealId: string) =>
  /^\d{1,20}$/.test(portalId) && /^\d{1,30}$/.test(dealId) ? `https://app.hubspot.com/contacts/${portalId}/record/0-3/${dealId}` : null;

type CrmRow = { deal_id: string; connection_id: string; external_id: string; name: string; owner_external_id?: string | null };

/**
 * The HubSpot deal each receivable's deal was planned from, with its owner: by the receivable's deal. The owner is read
 * where migration 0110 added it; before, a deal reads with no owner.
 */
export async function readCrmContexts(orgDb: OrgDb, invoices: ReadonlyArray<{ id: string; deal_id?: string | null }>): Promise<Map<string, CrmContext>> {
  const contexts = new Map<string, CrmContext>();
  const dealIds = [...new Set(invoices.map((invoice) => invoice.deal_id).filter((id): id is string => typeof id === "string"))];
  if (dealIds.length === 0) return contexts;
  const withOwner = "deal_id, connection_id, external_id, name, owner_external_id";
  let read: { data: unknown; error: PostgrestError | null } = await orgDb.from("crm_deals").select(withOwner).in("deal_id", dealIds);
  if (read.error && (read.error.code === "42703" || read.error.code === "PGRST204")) {
    read = await orgDb.from("crm_deals").select("deal_id, connection_id, external_id, name").in("deal_id", dealIds);
  }
  if (read.error) {
    if (notThereYet(read.error)) return contexts;
    throw new Error(read.error.message);
  }
  const rows = (read.data ?? []) as CrmRow[];
  if (rows.length === 0) return contexts;
  const connections = await orgDb.from("accounting_connections").select("id, provider, external_org_id").in("id", [...new Set(rows.map((row) => row.connection_id))]);
  const accountOf = new Map(
    connections.error ? [] : ((connections.data ?? []) as Array<{ id: string; provider: string; external_org_id: string }>).filter((row) => row.provider === "hubspot").map((row) => [row.id, row.external_org_id] as const)
  );
  const byDeal = new Map(rows.filter((row) => accountOf.has(row.connection_id)).map((row) => [row.deal_id, row]));
  for (const invoice of invoices) {
    const row = invoice.deal_id ? byDeal.get(invoice.deal_id) : undefined;
    if (!row) continue;
    contexts.set(invoice.id, {
      provider: "hubspot",
      dealExternalId: row.external_id,
      dealName: row.name,
      ownerId: row.owner_external_id ?? null,
      url: hubspotDealUrl(accountOf.get(row.connection_id) as string, row.external_id),
    });
  }
  return contexts;
}

type SaidRow = {
  id: string;
  invoice_id: string;
  kind: CustomerSaid["kind"];
  status: "open" | "closed";
  outcome: CustomerSaid["outcome"];
  promised_on: string | null;
  paid_on: string | null;
  created_at: string;
  closed_at: string | null;
};

/** What each receivable's customer said on its statement: its open requests, and those closed since `closedSince`. */
export async function readSaid(orgDb: OrgDb, invoiceIds: readonly string[], closedSince: string): Promise<Map<string, CustomerSaid[]>> {
  const byInvoice = new Map<string, CustomerSaid[]>();
  if (invoiceIds.length === 0) return byInvoice;
  const read = await orgDb
    .from("customer_requests")
    .select("id, invoice_id, kind, status, outcome, promised_on, paid_on, created_at, closed_at")
    .in("invoice_id", [...invoiceIds])
    .or(`status.eq.open,closed_at.gte.${closedSince}`)
    .order("created_at", { ascending: false })
    .limit(2000);
  if (read.error) {
    if (notThereYet(read.error)) return byInvoice;
    throw new Error(read.error.message);
  }
  for (const row of (read.data ?? []) as SaidRow[]) {
    const said: CustomerSaid = {
      id: row.id,
      kind: row.kind,
      status: row.status,
      outcome: row.outcome,
      promisedOn: row.promised_on ? String(row.promised_on).slice(0, 10) : null,
      paidOn: row.paid_on ? String(row.paid_on).slice(0, 10) : null,
      createdAt: row.created_at,
      closedAt: row.closed_at,
    };
    byInvoice.set(row.invoice_id, [...(byInvoice.get(row.invoice_id) ?? []), said]);
  }
  return byInvoice;
}

/** Groups tasks by their receivable. */
export function tasksByInvoice(tasks: readonly CollectionTask[]): Map<string, CollectionTask[]> {
  const by = new Map<string, CollectionTask[]>();
  for (const task of tasks) by.set(task.invoiceId, [...(by.get(task.invoiceId) ?? []), task]);
  return by;
}
