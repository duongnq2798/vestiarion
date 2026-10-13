import { invoiceDiscount } from "../agent/payment-timing";
import { membershipsOf, type OrgMembership } from "../auth/membership";
import { approvalAnchor, orgHref } from "../auth/org-paths";
import { billsHref } from "../bills-view";
import { ACCOUNTANT_BOOKING_CONSENTS } from "../connectors/consent";
import { PROVIDER_LABELS } from "../connectors/provider";
import { readCustomerRequests } from "../customer-portal/requests";
import { db, type OrgDb } from "../dal";
import { withOrg } from "../dal/scope";
import { decideByOf } from "../exceptions";
import { readConnectorProblems, readUsageLimits } from "../usage/read";
import { routeTo, sortTriage, type TriageItem } from "./triage";

/**
 * The accountant console's read model (docs/superpowers/specs/2026-10-13-accountant-console-design.md A2, A3): the
 * workspaces a person is a member of, each read in its own scope, through its own tenant client, as that person.
 *
 * Never a service-role read across tenants. The list of workspaces is the person's own memberships, read afresh on
 * every request from the session's user id (`membershipsOf`, the same read every workspace page's gate makes); each
 * workspace's items are read inside `withOrg(orgId, ..., { userId })`, whose requests carry a token naming that one
 * workspace, so row-level security confines them even if a filter here were wrong. Removing a member removes the
 * membership row, and the next request lists the workspace no more.
 */

/** At most this many workspaces are read at once. */
const CONCURRENCY = 4;
/** The most rows one part reads in one workspace: the console is a queue, not a ledger. */
const ROWS = 200;

export interface WorkspaceTriage {
  slug: string;
  name: string;
  role: OrgMembership["role"];
  mode: OrgMembership["mode"];
  network: OrgMembership["network"];
  items: TriageItem[];
  /** The parts that could not be read in this workspace, in words; the rest still show. */
  unread: string[];
}

export interface Portfolio {
  workspaces: WorkspaceTriage[];
  /** Every workspace's items in one queue, in triage order. */
  items: TriageItem[];
}

const day = (now: Date) => now.toISOString().slice(0, 10);
const num = (value: unknown) => (typeof value === "number" ? value : Number(value ?? 0));

async function part<T>(label: string, unread: string[], read: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await read();
  } catch (error) {
    console.error(`accountant: ${label} not read`, error instanceof Error ? error.message : "unknown error");
    unread.push(label);
    return empty;
  }
}

function notSetUp(error: { code?: string } | null): boolean {
  return error?.code === "42P01" || error?.code === "PGRST205";
}

type PayableRow = {
  id: string;
  amount: string | number;
  currency: string | null;
  due_date: string;
  status: "held" | "flagged" | "awaiting_info";
  decided_at: string | null;
  created_at: string;
  early_pay_discount_pct: string | number | null;
  discount_due_date: string | null;
  counterparties: { name: string } | null;
};

const HELD_WORDS: Record<PayableRow["status"], string> = {
  held: "Held for a person",
  flagged: "Flagged for review",
  awaiting_info: "Waiting for details",
};

const dayWords = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${iso.slice(0, 10)}T00:00:00.000Z`));

async function decisionItems(orgDb: OrgDb, ws: { slug: string; name: string; role: OrgMembership["role"] }, now: Date): Promise<TriageItem[]> {
  const today = day(now);
  const [payables, milestones] = await Promise.all([
    orgDb
      .from("invoices")
      .select("id, amount, currency, due_date, status, decided_at, created_at, early_pay_discount_pct, discount_due_date, counterparties(name)")
      .eq("direction", "payable")
      .in("status", ["held", "flagged", "awaiting_info"])
      .order("due_date", { ascending: true })
      .limit(ROWS),
    orgDb.from("milestones").select("id, title, amount, decided_at, created_at, counterparties(name)").eq("status", "held").order("created_at", { ascending: true }).limit(ROWS),
  ]);
  if (payables.error) throw new Error(payables.error.message);
  if (milestones.error) throw new Error(milestones.error.message);
  const items: TriageItem[] = [];
  for (const row of (payables.data ?? []) as unknown as PayableRow[]) {
    const decideBy = decideByOf({ dueDate: row.due_date, discount: invoiceDiscount(row) }, today);
    const past = decideBy.day < today;
    const kind = past ? "past_decide_by" : "decision";
    items.push({
      key: `${ws.slug}:${kind}:${row.id}`,
      kind,
      workspace: { slug: ws.slug, name: ws.name },
      title: row.counterparties?.name ?? "A supplier",
      detail: past
        ? `${HELD_WORDS[row.status]}. Its decide-by day was ${dayWords(decideBy.day)}${decideBy.reason === "discount" ? ", to keep the early-payment discount" : ""}.`
        : `${HELD_WORDS[row.status]}. Decide by ${dayWords(decideBy.day)}.`,
      amount: { value: num(row.amount), currency: row.currency ?? "USDC" },
      since: past ? decideBy.day : (row.decided_at ?? row.created_at),
      href: `${orgHref(ws.slug, "/approvals")}#${approvalAnchor(row.id)}`,
      ...routeTo(ws.role, kind),
    });
  }
  for (const row of (milestones.data ?? []) as unknown as Array<{ id: string; title: string; amount: string | number; decided_at: string | null; created_at: string; counterparties: { name: string } | null }>) {
    items.push({
      key: `${ws.slug}:decision:${row.id}`,
      kind: "decision",
      workspace: { slug: ws.slug, name: ws.name },
      title: row.counterparties?.name ?? "A contractor",
      detail: `Milestone held for a person: ${row.title}.`,
      amount: { value: num(row.amount), currency: "USDC" },
      since: row.decided_at ?? row.created_at,
      href: orgHref(ws.slug, "/contractors"),
      ...routeTo(ws.role, "decision"),
    });
  }
  return items;
}

async function bookingItems(orgDb: OrgDb, ws: { slug: string; name: string; role: OrgMembership["role"] }): Promise<TriageItem[]> {
  const result = await orgDb
    .from("accounting_postings")
    .select("id, connection_id, provider, amount, currency, state, paid_on, message, created_at")
    .in("state", ["draft", "failed"])
    .order("created_at", { ascending: true })
    .limit(ROWS);
  // Before migration 0106 nothing is booked, so there is nothing to book.
  if (result.error && notSetUp(result.error)) return [];
  if (result.error) throw new Error(result.error.message);
  const rows = (result.data ?? []) as Array<{ id: string; connection_id: string; provider: "xero" | "quickbooks"; amount: string | number; currency: string; state: "draft" | "failed"; paid_on: string; message: string | null; created_at: string }>;
  // An accountant books only where the connection agreed to words that name the accountant, as `bookAccountingPayments`
  // checks (accountant console A1): elsewhere the item waits on an owner or admin, and says why.
  let agreed: Map<string, string> | null = null;
  if (ws.role === "accountant" && rows.length > 0) {
    const connections = await orgDb.from("accounting_connections").select("id, consent_version").in("id", [...new Set(rows.map((row) => row.connection_id))]);
    if (connections.error) throw new Error(connections.error.message);
    agreed = new Map(((connections.data ?? []) as Array<{ id: string; consent_version: string }>).map((row) => [row.id, row.consent_version]));
  }
  return rows.map((row) => {
    const label = PROVIDER_LABELS[row.provider] ?? row.provider;
    const consent = agreed?.get(row.connection_id);
    const route =
      agreed && !(consent && ACCOUNTANT_BOOKING_CONSENTS.has(consent))
        ? { canAct: false, who: `Waiting on an owner or admin of this workspace: ${label} was connected before an accountant could book` }
        : routeTo(ws.role, "to_book");
    return {
      key: `${ws.slug}:to_book:${row.id}`,
      kind: "to_book" as const,
      workspace: { slug: ws.slug, name: ws.name },
      title: `A payment of ${dayWords(row.paid_on)}`,
      detail: row.state === "failed" ? `Booking in ${label} failed${row.message ? `: ${row.message}` : "."}` : `Waiting for review before it is booked in ${label}.`,
      amount: { value: num(row.amount), currency: row.currency },
      since: row.created_at,
      href: orgHref(ws.slug, billsHref({ tab: "bills", review: row.provider === "quickbooks" ? "book-quickbooks" : "book-xero" })),
      ...route,
    };
  });
}

async function receivableItems(orgDb: OrgDb, ws: { slug: string; name: string; role: OrgMembership["role"] }, now: Date): Promise<TriageItem[]> {
  const today = day(now);
  const [overdue, requests] = await Promise.all([
    orgDb
      .from("invoices")
      .select("id, amount, currency, due_date, counterparties(name)")
      .eq("direction", "receivable")
      .in("status", ["pending", "matched"])
      .lt("due_date", today)
      .order("due_date", { ascending: true })
      .limit(ROWS),
    readCustomerRequests(orgDb, { openOnly: true }),
  ]);
  if (overdue.error) throw new Error(overdue.error.message);
  const items: TriageItem[] = ((overdue.data ?? []) as unknown as Array<{ id: string; amount: string | number; currency: string | null; due_date: string; counterparties: { name: string } | null }>).map((row) => ({
    key: `${ws.slug}:receivable_overdue:${row.id}`,
    kind: "receivable_overdue" as const,
    workspace: { slug: ws.slug, name: ws.name },
    title: row.counterparties?.name ?? "A customer",
    detail: `Was due ${dayWords(row.due_date)}.`,
    amount: { value: num(row.amount), currency: row.currency ?? "USDC" },
    since: row.due_date.slice(0, 10),
    href: orgHref(ws.slug, billsHref({ tab: "receivables", open: row.id })),
    ...routeTo(ws.role, "receivable_overdue"),
  }));
  if (!requests.available) return items;
  const open = requests.requests.filter((request) => request.kind === "paid" || request.kind === "dispute");
  if (open.length === 0) return items;
  const names = await orgDb.from("counterparties").select("id, name").in("id", [...new Set(open.map((request) => request.counterpartyId))]);
  if (names.error) throw new Error(names.error.message);
  const nameOf = new Map(((names.data ?? []) as Array<{ id: string; name: string }>).map((row) => [row.id, row.name]));
  for (const request of open) {
    const kind = request.kind === "paid" ? ("customer_says_paid" as const) : ("disputed" as const);
    items.push({
      key: `${ws.slug}:${kind}:${request.id}`,
      kind,
      workspace: { slug: ws.slug, name: ws.name },
      title: nameOf.get(request.counterpartyId) ?? "A customer",
      detail:
        kind === "customer_says_paid"
          ? `Says it paid${request.paidOn ? ` on ${dayWords(request.paidOn)}` : ""}${request.reference ? `, reference ${request.reference}` : ""}. Nothing is marked paid until the money is found.`
          : "Disputes an invoice on its statement link. Its reminders wait while the dispute is open.",
      amount: request.amount !== null ? { value: request.amount, currency: "USDC" } : null,
      since: request.createdAt,
      href: `${orgHref(ws.slug, billsHref({ tab: "receivables" }))}#from-customers`,
      ...routeTo(ws.role, kind),
    });
  }
  return items;
}

async function connectorItems(ws: { slug: string; name: string; role: OrgMembership["role"] }, now: Date): Promise<TriageItem[]> {
  return (await readConnectorProblems(db(), now)).map((problem) => ({
    key: `${ws.slug}:connector:${problem.provider}`,
    kind: "connector" as const,
    workspace: { slug: ws.slug, name: ws.name },
    title: PROVIDER_LABELS[problem.provider],
    detail: `${problem.title}. ${problem.detail}`.trim(),
    amount: null,
    since: problem.since ?? now.toISOString(),
    href: orgHref(ws.slug, `/settings#${problem.provider}`),
    ...routeTo(ws.role, "connector"),
  }));
}

async function limitItems(ws: { orgId: string; slug: string; name: string; role: OrgMembership["role"]; mode: OrgMembership["mode"] }, now: Date): Promise<TriageItem[]> {
  // Gateway's balance is a network call per workspace: the console leaves it to Settings.
  const limits = await readUsageLimits({ orgId: ws.orgId, mode: ws.mode }, { now, withGateway: false });
  return limits
    .filter((limit) => limit.state === "reached" && limit.key !== "connector")
    .map((limit) => ({
      key: `${ws.slug}:limit:${limit.key}`,
      kind: "limit" as const,
      workspace: { slug: ws.slug, name: ws.name },
      title: limit.title,
      detail: `${limit.used}. ${limit.stops}`,
      amount: null,
      since: limit.key === "sandbox_cycles" || limit.key === "agent_budget" || limit.key === "service_budget" ? `${day(now)}T00:00:00.000Z` : now.toISOString(),
      href: orgHref(ws.slug, "/settings#usage"),
      ...routeTo(ws.role, "limit", limit.key),
    }));
}

/**
 * One workspace's open items, read in the scope already entered: each part on its own, so one that cannot be read is
 * named and the rest still show.
 */
export async function readWorkspaceTriage(membership: OrgMembership, now: Date = new Date()): Promise<WorkspaceTriage> {
  const unread: string[] = [];
  const ws = { orgId: membership.orgId, slug: membership.slug, name: membership.name, role: membership.role, mode: membership.mode };
  const orgDb = db();
  const parts = await Promise.all([
    part("payments waiting for a decision", unread, () => decisionItems(orgDb, ws, now), []),
    part("payments to book", unread, () => bookingItems(orgDb, ws), []),
    part("receivables", unread, () => receivableItems(orgDb, ws, now), []),
    part("connectors", unread, () => connectorItems(ws, now), []),
    part("limits", unread, () => limitItems(ws, now), []),
  ]);
  return {
    slug: membership.slug,
    name: membership.name,
    role: membership.role,
    mode: membership.mode,
    network: membership.network,
    items: sortTriage(parts.flat()),
    unread,
  };
}

/** Runs `fn` over `values`, at most `limit` at a time, keeping their order. */
async function inBatches<T, R>(values: readonly T[], limit: number, fn: (value: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let start = 0; start < values.length; start += limit) {
    out.push(...(await Promise.all(values.slice(start, start + limit).map(fn))));
  }
  return out;
}

/**
 * Every workspace the person is a member of, each read in its own scope as them. A workspace that cannot be entered
 * at all is listed with nothing read, and says so.
 */
export async function readPortfolio(userId: string, now: Date = new Date()): Promise<Portfolio> {
  const memberships = await membershipsOf(userId);
  const workspaces = await inBatches(memberships, CONCURRENCY, async (membership) => {
    try {
      return await withOrg(membership.orgId, () => readWorkspaceTriage(membership, now), { userId });
    } catch (error) {
      console.error("accountant: a workspace was not read", error instanceof Error ? error.message : "unknown error");
      return { slug: membership.slug, name: membership.name, role: membership.role, mode: membership.mode, network: membership.network, items: [], unread: ["this workspace"] };
    }
  });
  return { workspaces, items: sortTriage(workspaces.flatMap((workspace) => workspace.items)) };
}
