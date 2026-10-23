import { readFrozenPayees } from "../address-change-check";
import { invoiceDiscount } from "../agent/payment-timing";
import { billApproversBesides, readAccountantCosign } from "../approval-policy";
import { membershipsOf, type OrgMembership } from "../auth/membership";
import { approvalAnchor, orgHref } from "../auth/org-paths";
import { can } from "../auth/roles";
import { billsHref } from "../bills-view";
import { ACCOUNTANT_BOOKING_CONSENTS } from "../connectors/consent";
import { PROVIDER_LABELS } from "../connectors/provider";
import { currentUserId } from "../context";
import { readCosignStates, type CosignState } from "../cosign-state";
import { addressUnconfirmed } from "../counterparty-address";
import { readCustomerRequests } from "../customer-portal/requests";
import { db, type OrgDb } from "../dal";
import { withOrg } from "../dal/scope";
import { decideByOf } from "../exceptions";
import { addressGiver } from "../new-payee";
import { ID_CHUNK, loadNewPayeeFacts, newPayeeCheckFor } from "../new-payee-facts";
import { counterpartyPath } from "../next-step";
import { readPayeeLock } from "../payee-lock";
import { twoApprovalsSentence } from "../two-approvals";
import { readConnectorProblems, readUsageLimits } from "../usage/read";
import { routeTo, sortTriage, type TriageItem } from "./triage";

/**
 * The accountant console's read model (docs/superpowers/specs/2026-10-13-accountant-console-design.md A2, A3; bills to
 * co-sign and addresses to confirm, 2026-10-22-accountant-queue-design.md AQ3, AQ4): the workspaces a person is a member
 * of, each read in its own scope, through its own tenant client, as that person.
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
  counterparty_id: string;
  /** The payee's screening and address, read for whether a co-sign could be given, and never shown on an item. */
  counterparties: { name: string; risk_level?: string | null; address?: string | null } | null;
};

const HELD_WORDS: Record<PayableRow["status"], string> = {
  held: "Held for a person",
  flagged: "Flagged for review",
  awaiting_info: "Waiting for details",
};

const dayWords = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${iso.slice(0, 10)}T00:00:00.000Z`));

/** What a bill's item says of its co-sign (docs/superpowers/specs/2026-10-22-accountant-queue-design.md AQ3), ahead of its decide-by day. */
function cosignWords(state: CosignState | undefined): string | null {
  switch (state?.state) {
    case "can_cosign":
      return `${twoApprovalsSentence(state.above)} ${state.approvals > 0 ? "One approval is given." : "No one has approved it yet."}`;
    case "cosigned":
      return "You co-signed it. An owner, admin or approver pays it.";
    case "blocked":
      return `${state.reason}.`;
    default:
      return null;
  }
}

/**
 * For an accountant while the workspace's accountants co-sign: each bill's co-sign state (AQ3). Read on its own, so a
 * failure leaves the bills as decision items, and names "bills to co-sign" on the card.
 */
async function cosignStatesOf(viewerId: string, rows: PayableRow[], unread: string[]): Promise<Map<string, CosignState> | null> {
  try {
    return await readCosignStates(
      viewerId,
      rows.map((row) => ({
        id: row.id,
        amount: num(row.amount),
        currency: row.currency === "EURC" ? "EURC" : "USDC",
        status: row.status,
        reviewedAt: null,
        counterpartyId: row.counterparty_id,
        riskLevel: row.counterparties?.risk_level ?? null,
        address: row.counterparties?.address ?? null,
      }))
    );
  } catch (error) {
    console.error("accountant: bills to co-sign not read", error instanceof Error ? error.message : "unknown error");
    unread.push("bills to co-sign");
    return null;
  }
}

async function decisionItems(
  orgDb: OrgDb,
  ws: { slug: string; name: string; role: OrgMembership["role"] },
  now: Date,
  cosign: { on: boolean; viewerId: string | undefined; unread: string[] }
): Promise<TriageItem[]> {
  const today = day(now);
  const [payables, milestones] = await Promise.all([
    orgDb
      .from("invoices")
      .select("id, amount, currency, due_date, status, decided_at, created_at, early_pay_discount_pct, discount_due_date, counterparty_id, counterparties(name, risk_level, address)")
      .eq("direction", "payable")
      .in("status", ["held", "flagged", "awaiting_info"])
      .order("due_date", { ascending: true })
      .limit(ROWS),
    orgDb.from("milestones").select("id, title, amount, decided_at, created_at, counterparties(name)").eq("status", "held").order("created_at", { ascending: true }).limit(ROWS),
  ]);
  if (payables.error) throw new Error(payables.error.message);
  if (milestones.error) throw new Error(milestones.error.message);
  const rows = (payables.data ?? []) as unknown as PayableRow[];
  // A bill an accountant can co-sign becomes theirs to act on, in place of its decision item: one item per bill, so
  // nothing is counted twice (AQ3). Milestones are never co-signed.
  const states = ws.role === "accountant" && cosign.on && cosign.viewerId && rows.length > 0 ? await cosignStatesOf(cosign.viewerId, rows, cosign.unread) : null;
  const items: TriageItem[] = [];
  for (const row of rows) {
    const decideBy = decideByOf({ dueDate: row.due_date, discount: invoiceDiscount(row) }, today);
    const past = decideBy.day < today;
    const state = states?.get(row.id);
    const kind = state?.state === "can_cosign" ? "cosign" : past ? "past_decide_by" : "decision";
    const by = past
      ? `Its decide-by day was ${dayWords(decideBy.day)}${decideBy.reason === "discount" ? ", to keep the early-payment discount" : ""}.`
      : `Decide by ${dayWords(decideBy.day)}.`;
    const words = cosignWords(state);
    items.push({
      key: `${ws.slug}:${kind}:${row.id}`,
      kind,
      workspace: { slug: ws.slug, name: ws.name },
      title: row.counterparties?.name ?? "A supplier",
      detail: kind === "cosign" ? `${words} ${by}` : words ? `${words} ${HELD_WORDS[row.status]}. ${by}` : `${HELD_WORDS[row.status]}. ${by}`,
      amount: { value: num(row.amount), currency: row.currency ?? "USDC" },
      // A bill past its decide-by day ages from that day, whichever kind it is.
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

/** What a changed address's item says to whoever entered or asked for it, under the payee lock, while another may confirm it. */
const GIVER_WAITS = { canAct: false, who: "Waiting on another member to confirm it: you entered or asked for this address" } as const;

/**
 * Of these payees' changed addresses, those the viewer may not confirm (AQ4): with the payee lock on, whoever entered or
 * asked for an address does not confirm it while another member may (payee lock PL3), as `confirmCounterpartyAddress`
 * refuses with `giver_confirms`. None with the lock off, and none where no one else may confirm, since the viewer's
 * confirmation is then recorded as a solo one. The addresses are read here only to know who gave each, and never put on
 * an item. Best effort: a part that cannot be read leaves the items as the viewer's role routes them, and the server
 * still refuses what it must.
 */
async function givenByViewer(orgDb: OrgDb, viewerId: string, counterpartyIds: string[]): Promise<Set<string>> {
  const none = new Set<string>();
  if (counterpartyIds.length === 0) return none;
  try {
    if (!(await readPayeeLock(orgDb)).on) return none;
    const addressReads = Array.from({ length: Math.ceil(counterpartyIds.length / ID_CHUNK) }, (_, index) =>
      orgDb.from("counterparties").select("id, address").in("id", counterpartyIds.slice(index * ID_CHUNK, (index + 1) * ID_CHUNK))
    );
    // Who gave each address, from its signed entries, in one read for them all, as the confirmation reads it.
    const [facts, ...addresses] = await Promise.all([loadNewPayeeFacts(orgDb, counterpartyIds), ...addressReads]);
    const given = new Set<string>();
    for (const result of addresses) {
      if (result.error) throw new Error(result.error.message);
      for (const row of (result.data ?? []) as Array<{ id: string; address: string | null }>) {
        if (addressGiver(newPayeeCheckFor(facts, row)) === viewerId) given.add(row.id);
      }
    }
    if (given.size === 0) return none;
    // A co-signing accountant confirms addresses too, so counts as someone else (accountant co-sign CS6).
    return (await billApproversBesides([viewerId])) > 0 ? given : none;
  } catch (error) {
    console.error("accountant: who gave an address not read", error instanceof Error ? error.message : "unknown error");
    return none;
  }
}

/**
 * Changed payout addresses no one has confirmed yet (AQ4), for whoever may confirm one: the newest changes first, up to
 * the console's most, never the address itself. A frozen payee is unfrozen first, by an owner or admin; under the payee
 * lock, an address the viewer entered or asked for waits on another member, where one may confirm it.
 */
async function addressItems(orgDb: OrgDb, ws: { slug: string; name: string; role: OrgMembership["role"] }, viewerId: string | undefined): Promise<TriageItem[]> {
  const result = await orgDb
    .from("counterparties")
    .select("id, name, address_changed_at, address_confirmed_at")
    .not("address_changed_at", "is", null)
    .order("address_changed_at", { ascending: false })
    .limit(ROWS);
  if (result.error) throw new Error(result.error.message);
  // Changed, and no confirmation since: two columns compared, so here rather than in the request.
  const rows = ((result.data ?? []) as Array<{ id: string; name: string; address_changed_at: string; address_confirmed_at: string | null }>).filter((row) =>
    addressUnconfirmed(row.address_changed_at, row.address_confirmed_at)
  );
  if (rows.length === 0) return [];
  // None before migration 0137.
  const frozen = await readFrozenPayees(rows.map((row) => row.id), orgDb);
  const roleRoute = routeTo(ws.role, "confirm_address");
  const unfrozen = rows.filter((row) => !frozen.has(row.id)).map((row) => row.id);
  const viewerGave = roleRoute.canAct && viewerId ? await givenByViewer(orgDb, viewerId, unfrozen) : new Set<string>();
  return rows.map((row) => {
    const isFrozen = frozen.has(row.id);
    const route = !isFrozen
      ? (viewerGave.has(row.id) ? GIVER_WAITS : roleRoute)
      : can(ws.role, "records.write")
        ? { canAct: true, who: "You can unfreeze it once you have checked with them, then confirm it" }
        : { canAct: false, who: "Waiting on an owner or admin of this workspace" };
    return {
      key: `${ws.slug}:confirm_address:${row.id}`,
      kind: "confirm_address" as const,
      workspace: { slug: ws.slug, name: ws.name },
      title: row.name,
      detail: isFrozen
        ? `Its address changed on ${dayWords(row.address_changed_at)}, and its contact said they did not make the change. It is unfrozen before it is confirmed.`
        : `Its address changed on ${dayWords(row.address_changed_at)}. The agent pays nothing to it until someone confirms it.`,
      amount: null,
      since: row.address_changed_at,
      href: orgHref(ws.slug, counterpartyPath(row.id)),
      ...route,
    };
  });
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
 * One workspace's open items, read in the scope already entered, as the person it names (`viewerId`, the scope's user by
 * default): each part on its own, so one that cannot be read is named and the rest still show.
 */
export async function readWorkspaceTriage(membership: OrgMembership, now: Date = new Date(), viewerId: string | undefined = currentUserId()): Promise<WorkspaceTriage> {
  const unread: string[] = [];
  const ws = { orgId: membership.orgId, slug: membership.slug, name: membership.name, role: membership.role, mode: membership.mode };
  const orgDb = db();
  // Whether the workspace's accountants co-sign (AQ4): read once, for an accountant only, and shared by the two parts it
  // shapes. Read afresh on every request; unread, it counts as off, as `cosignsNow` reads it, and the card names it.
  const cosignOn: Promise<boolean> = can(ws.role, "approval.cosign")
    ? part("the co-sign setting", unread, async () => (await readAccountantCosign(orgDb)).on, false)
    : Promise.resolve(false);
  const parts = await Promise.all([
    part("payments waiting for a decision", unread, async () => decisionItems(orgDb, ws, now, { on: await cosignOn, viewerId, unread }), []),
    // Whoever may confirm a changed address: whoever decides payments, and an accountant while co-signing is on (CS6).
    part("addresses to confirm", unread, async () => (can(ws.role, "approval.decide") || (await cosignOn) ? addressItems(orgDb, ws, viewerId) : []), []),
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
