import { can, type OrgRole, type Permission } from "../auth/roles";
import type { UsageLimit } from "../usage/model";

/**
 * The accountant console's triage queue (docs/superpowers/specs/2026-10-13-accountant-console-design.md A3 to A6, and
 * 2026-10-22-accountant-queue-design.md AQ2 for bills to co-sign and addresses to confirm), as pure functions: what each
 * item is, who can act on it, how old it is, and the order the queue shows. The reading is in `read.ts`; nothing here
 * touches a database.
 *
 * Amounts stay with their own item and currency. Nothing here adds money across items, currencies or workspaces: the
 * console counts items, never a balance.
 */

export const TRIAGE_KINDS = [
  "past_decide_by",
  "decision",
  "cosign",
  "confirm_address",
  "customer_says_paid",
  "disputed",
  "to_book",
  "receivable_overdue",
  "connector",
  "limit",
] as const;
export type TriageKind = (typeof TRIAGE_KINDS)[number];

export const KIND_TITLES: Record<TriageKind, { one: string; many: string }> = {
  past_decide_by: { one: "Past its decide-by day", many: "Past their decide-by day" },
  decision: { one: "Payment waiting for a decision", many: "Payments waiting for a decision" },
  cosign: { one: "Waiting for your co-sign", many: "Bills waiting for your co-sign" },
  confirm_address: { one: "Address to confirm", many: "Addresses to confirm" },
  customer_says_paid: { one: "Customer says paid", many: "Customers say paid" },
  disputed: { one: "Disputed by the customer", many: "Disputed by customers" },
  to_book: { one: "Payment to book", many: "Payments to book" },
  receivable_overdue: { one: "Receivable overdue", many: "Receivables overdue" },
  connector: { one: "Connector problem", many: "Connector problems" },
  limit: { one: "Limit reached", many: "Limits reached" },
};

/**
 * Which permission acts on each kind; a limit's depends on the limit. A co-sign is an accountant's, and so is confirming
 * an address when the viewer is one: the console lists either only while the workspace's accountants co-sign
 * (docs/superpowers/specs/2026-10-22-accountant-queue-design.md AQ2, AQ4), which these pure functions cannot see.
 */
const ACTS: Record<Exclude<TriageKind, "limit">, Permission> = {
  past_decide_by: "approval.decide",
  decision: "approval.decide",
  cosign: "approval.cosign",
  confirm_address: "approval.decide",
  customer_says_paid: "receivables.reconcile",
  disputed: "receivables.reconcile",
  to_book: "accounting.book",
  receivable_overdue: "receivables.reconcile",
  connector: "integrations.manage",
};

const LIMIT_ACTS: Record<UsageLimit["key"], Permission> = {
  sandbox_cycles: "org.administer",
  agent_budget: "agent.budget",
  service_budget: "treasury.manage",
  invitations: "members.manage",
  connector: "integrations.manage",
};

/** Who holds each permission, in words, for an item the viewer cannot act on. */
const HOLDERS: Partial<Record<Permission, string>> = {
  "approval.decide": "an owner, admin or approver",
  "approval.cosign": "a co-signing accountant",
  "receivables.reconcile": "an owner, admin or accountant",
  "accounting.book": "an owner, admin or accountant",
  "integrations.manage": "an owner or admin",
  "agent.budget": "an owner or admin",
  "treasury.manage": "an owner or admin",
  "members.manage": "an owner or admin",
  "org.administer": "an owner",
};

const DOING: Record<Exclude<TriageKind, "limit">, string> = {
  past_decide_by: "decide it",
  decision: "decide it",
  cosign: "co-sign it",
  confirm_address: "confirm it",
  customer_says_paid: "check it and apply the payment or answer",
  disputed: "answer the customer",
  to_book: "review and book it",
  receivable_overdue: "follow it up",
  connector: "reconnect it",
};

export interface TriageItem {
  /** Unique across the queue: the workspace, the kind and the row. */
  key: string;
  kind: TriageKind;
  workspace: { slug: string; name: string };
  /** Who or what it is about: a supplier, a customer, a connector. */
  title: string;
  /** One line on why it is here. */
  detail: string;
  /** The item's own amount, in its own currency, never added to another's. */
  amount: { value: number; currency: string } | null;
  /** When it became open, for its age: the agent's decision, the decide-by day, the due date, the customer's message. */
  since: string;
  /** The workspace page where it is acted on. */
  href: string;
  /** Whether the viewer's role in that workspace may act on it there. */
  canAct: boolean;
  /** Who acts, in words. */
  who: string;
}

export function permissionFor(kind: TriageKind, limit?: UsageLimit["key"], role?: OrgRole): Permission {
  if (kind === "limit") return LIMIT_ACTS[limit ?? "connector"];
  // An accountant confirms a changed address as a co-signer (accountant co-sign CS6); the others as deciders.
  if (kind === "confirm_address" && role === "accountant") return "approval.cosign";
  return ACTS[kind];
}

/** Whether the viewer acts, and the words: "You can decide it", or "An owner, admin or approver decides it here". */
export function routeTo(role: OrgRole, kind: TriageKind, limit?: UsageLimit["key"]): { canAct: boolean; who: string } {
  const permission = permissionFor(kind, limit, role);
  if (can(role, permission)) {
    return { canAct: true, who: kind === "limit" ? "You can act on it" : `You can ${DOING[kind as Exclude<TriageKind, "limit">]}` };
  }
  const holders = HOLDERS[permission] ?? "someone else in the workspace";
  return { canAct: false, who: `Waiting on ${holders} of this workspace` };
}

export const AGE_BUCKETS = [
  { key: "day", label: "Under a day", below: 1 },
  { key: "days", label: "1 to 3 days", below: 4 },
  { key: "week", label: "4 to 7 days", below: 8 },
  { key: "month", label: "8 to 30 days", below: 31 },
  { key: "older", label: "Over 30 days", below: Number.POSITIVE_INFINITY },
] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number]["key"];

/** Whole days open, never below zero (a decide-by day still to come reads as today). */
export function daysOpen(since: string, now: Date): number {
  const at = Date.parse(since.length === 10 ? `${since}T00:00:00.000Z` : since);
  if (Number.isNaN(at)) return 0;
  return Math.max(0, Math.floor((now.getTime() - at) / 86_400_000));
}

export function ageBucketOf(since: string, now: Date): AgeBucket {
  const days = daysOpen(since, now);
  return (AGE_BUCKETS.find((bucket) => days < bucket.below) ?? AGE_BUCKETS[AGE_BUCKETS.length - 1]).key;
}

/** The KPI: how many items are open in each age bucket, every bucket listed, the oldest last. */
export function countByAge(items: readonly TriageItem[], now: Date): Array<{ key: AgeBucket; label: string; count: number }> {
  const counts = new Map<AgeBucket, number>();
  for (const item of items) {
    const bucket = ageBucketOf(item.since, now);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  return AGE_BUCKETS.map((bucket) => ({ key: bucket.key, label: bucket.label, count: counts.get(bucket.key) ?? 0 }));
}

/** "Under a day", "3 days", "45 days". */
export function ageWords(since: string, now: Date): string {
  const days = daysOpen(since, now);
  if (days < 1) return "Under a day";
  return `${days} ${days === 1 ? "day" : "days"}`;
}

/**
 * The queue's order: what the viewer can act on first, then by kind (past its day, waiting decisions, bills to co-sign,
 * addresses to confirm, what customers said, bookings, overdue receivables, connectors, limits), then the oldest first,
 * then by workspace and title so the order never depends on the order the workspaces answered in.
 */
export function sortTriage(items: readonly TriageItem[]): TriageItem[] {
  const rank = (kind: TriageKind) => TRIAGE_KINDS.indexOf(kind);
  return [...items].sort(
    (a, b) =>
      Number(b.canAct) - Number(a.canAct) ||
      rank(a.kind) - rank(b.kind) ||
      a.since.localeCompare(b.since) ||
      a.workspace.name.localeCompare(b.workspace.name) ||
      a.title.localeCompare(b.title) ||
      a.key.localeCompare(b.key)
  );
}

export function countByKind(items: readonly TriageItem[]): Array<{ kind: TriageKind; count: number }> {
  return TRIAGE_KINDS.map((kind) => ({ kind, count: items.filter((item) => item.kind === kind).length })).filter((row) => row.count > 0);
}

export function kindWords(kind: TriageKind, count: number): string {
  return `${count} ${count === 1 ? KIND_TITLES[kind].one.toLowerCase() : KIND_TITLES[kind].many.toLowerCase()}`;
}

/** What the queue can be narrowed to, read from the page's address; anything else is no filter. */
export function triageFilter(raw: { kind?: string | string[]; workspace?: string | string[]; mine?: string | string[] }): {
  kind: TriageKind | null;
  workspace: string | null;
  mine: boolean;
} {
  const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? null;
  const kind = one(raw.kind);
  const workspace = one(raw.workspace);
  return {
    kind: kind && (TRIAGE_KINDS as readonly string[]).includes(kind) ? (kind as TriageKind) : null,
    workspace: workspace && /^[a-z0-9-]{1,64}$/.test(workspace) ? workspace : null,
    mine: one(raw.mine) === "1",
  };
}

export function applyFilter(items: readonly TriageItem[], filter: ReturnType<typeof triageFilter>): TriageItem[] {
  return items.filter(
    (item) => (!filter.kind || item.kind === filter.kind) && (!filter.workspace || item.workspace.slug === filter.workspace) && (!filter.mine || item.canAct)
  );
}
