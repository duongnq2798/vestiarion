import { readFrozenPayees } from "../address-change-check";
import { invoiceLateFee, readWithLateFee } from "../agent/late-fee";
import { invoiceDiscount } from "../agent/payment-timing";
import { billApproversBesides, readAccountantCosign } from "../approval-policy";
import { stateWords as asanaStateWords, type HeldReason as AsanaHeldReason } from "../asana/acceptance";
import { isAsanaNotSetUp } from "../asana/links";
import { asanaSettingsFromEnv } from "../asana/settings";
import { membershipsOf, type OrgMembership } from "../auth/membership";
import { approvalAnchor, orgHref } from "../auth/org-paths";
import { can } from "../auth/roles";
import { billsHref } from "../bills-view";
import { closePackMonth, type ClosePackMonth } from "../close-pack/month";
import { CLOSE_PACK_EXPORTED } from "../close-pack/record";
import { ACCOUNTANT_BOOKING_CONSENTS } from "../connectors/consent";
import { PROVIDER_LABELS } from "../connectors/provider";
import { currentUserId } from "../context";
import { readCosignStates, type CosignState } from "../cosign-state";
import { addressUnconfirmed } from "../counterparty-address";
import { counterpartyPath, milestoneRowPath } from "../counterparty-paths";
import { readCustomerRequests } from "../customer-portal/requests";
import { db, type OrgDb } from "../dal";
import { withOrg } from "../dal/scope";
import { before0148, STILL_TO_DECIDE, TO_DECIDE_LIMIT, type InboxSource, type InboxStatus } from "../email-inbox/list";
import { inboxSettingsFromEnv } from "../email-inbox/settings";
import { decideByOf, lateFeeDayWords, type DecideBy } from "../exceptions";
import { googleDriveSettingsFromEnv } from "../googledrive/settings";
import { missingFields, REVIEW_LIMIT, type DraftSource } from "../invoice-drafts/model";
import { stateWords as jiraStateWords, type HeldReason as JiraHeldReason } from "../jira/acceptance";
import { isJiraNotSetUp } from "../jira/links";
import { jiraSettingsFromEnv } from "../jira/settings";
import { stateWords as linearStateWords, type HeldReason as LinearHeldReason } from "../linear/acceptance";
import { isLinearNotSetUp } from "../linear/links";
import { linearSettingsFromEnv } from "../linear/settings";
import { addressGiver } from "../new-payee";
import { ID_CHUNK, loadNewPayeeFacts, newPayeeCheckFor } from "../new-payee-facts";
import { readPayeeLock } from "../payee-lock";
import { maskEmail } from "../payment-notices";
import { twoApprovalsSentence } from "../two-approvals";
import { readConnectorProblems, readUsageLimits } from "../usage/read";
import { verdictHolds } from "../verdicts";
import { routeTo, sortTriage, type TriageItem } from "./triage";

/**
 * The accountant console's read model (docs/superpowers/specs/2026-10-13-accountant-console-design.md A2, A3; bills to
 * co-sign and addresses to confirm, 2026-10-22-accountant-queue-design.md AQ3, AQ4; verdicts, invoices to review, work
 * to accept and last month's close, 2026-11-01-accountant-all-waiting-design.md AW1 to AW5): the workspaces a person is
 * a member of, each read in its own scope, through its own tenant client, as that person. Those four kinds read only
 * Vestiarion's own tables and ledger: no model, Google, Asana, Linear, Jira, accounting tool or Circle is called (AW1).
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
  /** Its late fee (0141); absent before it. */
  late_fee_kind?: string | null;
  late_fee_value?: string | number | null;
  late_fee_starts_on?: string | null;
  counterparty_id: string;
  /** The payee's screening and address, read for whether a co-sign could be given, and never shown on an item. */
  counterparties: { name: string; risk_level?: string | null; address?: string | null } | null;
};

const HELD_WORDS: Record<PayableRow["status"], string> = {
  held: "Held for a person",
  flagged: "Flagged for review",
  awaiting_info: "Waiting for details",
};

/**
 * What a bill's item says of a shadow-mode verdict (docs/superpowers/specs/2026-11-01-accountant-all-waiting-design.md
 * AW2). Every bill `verdictHolds` answers `waiting` is one the agent decided to pay (`awaitsVerdict`), so a verdict item
 * says that, and that agreeing pays it, as the next step for a shadow-mode hold does: never the held words, which name a
 * hold the agent chose.
 */
const VERDICT_WORDS = {
  give: "The agent decided to pay it, and shadow mode pays nothing until a person agrees. Agree and pay it, or disagree.",
  alsoWaits: "It also waits for a verdict in shadow mode.",
  disagreed: "Someone disagreed with the agent in shadow mode: return or reject it.",
} as const;

const dayWords = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${iso.slice(0, 10)}T00:00:00.000Z`));

/** What a decide-by day that passed says besides the day: the discount's last day, or the bill's late fee (LF5). */
function pastWhy(decideBy: DecideBy): string {
  if (decideBy.reason === "discount") return ", to keep the early-payment discount";
  return decideBy.reason === "late_fee" && decideBy.lateFee ? `; ${lateFeeDayWords(decideBy.lateFee)}` : "";
}

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
  cosign: { on: boolean; viewerId: string | undefined },
  unread: string[]
): Promise<TriageItem[]> {
  const today = day(now);
  const [payables, milestones] = await Promise.all([
    // With each bill's late fee, where migration 0141 has run (late fees LF5).
    readWithLateFee((lateFee) =>
      orgDb
        .from("invoices")
        .select(`id, amount, currency, due_date, status, decided_at, created_at, early_pay_discount_pct, discount_due_date, counterparty_id, counterparties(name, risk_level, address)${lateFee}`)
        .eq("direction", "payable")
        .in("status", ["held", "flagged", "awaiting_info"])
        .order("due_date", { ascending: true })
        .limit(ROWS)
    ),
    orgDb.from("milestones").select("id, title, amount, decided_at, created_at, counterparties(name)").eq("status", "held").order("created_at", { ascending: true }).limit(ROWS),
  ]);
  if (payables.error) throw new Error(payables.error.message);
  if (milestones.error) throw new Error(milestones.error.message);
  const rows = (payables.data ?? []) as unknown as PayableRow[];
  // A verdict holds a bill only while it is held, as `verdictGate` refuses an approval of it and Approvals offers the
  // verdict on it: so only held bills are asked about, once for them all (all waiting AW2).
  const held = rows.filter((row) => row.status === "held").map((row) => row.id);
  const [states, verdicts] = await Promise.all([
    // A bill an accountant can co-sign becomes theirs to act on, in place of its decision item: one item per bill, so
    // nothing is counted twice (AQ3). Milestones are never co-signed.
    ws.role === "accountant" && cosign.on && cosign.viewerId && rows.length > 0 ? cosignStatesOf(cosign.viewerId, rows, unread) : null,
    // Its own part: unread, the bills stay decision items, and the card names it (AW1).
    held.length > 0 ? part("decisions waiting for a verdict", unread, () => verdictHolds(held), null) : null,
  ]);
  const items: TriageItem[] = [];
  for (const row of rows) {
    const decideBy = decideByOf({ dueDate: row.due_date, discount: invoiceDiscount(row), lateFee: invoiceLateFee(row), currency: row.currency }, today);
    const past = decideBy.day < today;
    const state = states?.get(row.id);
    const verdict = verdicts?.waiting.has(row.id) ? "waiting" : verdicts?.disagreed.has(row.id) ? "disagreed" : null;
    // A bill waiting for a verdict is a verdict item in place of its decision item, never both; past its decide-by day
    // it stays there, and says it also waits for one (AW2).
    const kind = state?.state === "can_cosign" ? "cosign" : past ? "past_decide_by" : verdict === "waiting" ? "verdict" : "decision";
    const by = past
      ? `Its decide-by day was ${dayWords(decideBy.day)}${pastWhy(decideBy)}.`
      : `Decide by ${dayWords(decideBy.day)}.`;
    // A co-sign a verdict blocks says so once, in the verdict's own words.
    const words = verdict && state?.state === "blocked" ? null : cosignWords(state);
    const standing = words ? `${words} ${HELD_WORDS[row.status]}.` : `${HELD_WORDS[row.status]}.`;
    // A verdict item says the agent's decision in place of the held words (AW2).
    const decided = words ? `${words} ${VERDICT_WORDS.give}` : VERDICT_WORDS.give;
    items.push({
      key: `${ws.slug}:${kind}:${row.id}`,
      kind,
      workspace: { slug: ws.slug, name: ws.name },
      title: row.counterparties?.name ?? "A supplier",
      detail:
        kind === "cosign"
          ? `${words} ${by}`
          : kind === "verdict"
            ? `${decided} ${by}`
            : verdict === "disagreed"
              ? `${standing} ${VERDICT_WORDS.disagreed} ${by}`
              : verdict === "waiting"
                ? `${standing} ${by} ${VERDICT_WORDS.alsoWaits}`
                : `${standing} ${by}`,
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
      // CL15: its row on Contractors, which opens at it; a held milestone is not paid yet.
      href: orgHref(ws.slug, milestoneRowPath(row.id, { paid: false })),
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
      href: orgHref(ws.slug, counterpartyPath(row.id, "address")),
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

/**
 * An email address anywhere in words a document, a file or a person wrote, masked as a sender's is ("li***@example.com"):
 * the console shows no email address (all waiting AW3).
 */
const EMAIL_ADDRESS = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const withoutAddresses = (text: string) => text.replace(EMAIL_ADDRESS, (address) => maskEmail(address.toLowerCase()));

/** An amount as a read gave it, in its own currency; none unless the read named both. */
function readAmount(amount: string | null, currency: string | null): TriageItem["amount"] {
  const value = Number(amount);
  return amount && currency && Number.isFinite(value) ? { value, currency } : null;
}

/** Where a review list's document waits, in its state's words (AW3). */
function reviewState(status: "ready" | "needs_details" | "unreadable", reason: string | null): string {
  if (status === "ready") return "Ready to add.";
  if (status === "unreadable") return "Could not be read.";
  const why = reason ? withoutAddresses(reason.trim()) : "a detail is missing";
  return `Needs details: ${/[.!?]$/.test(why) ? why : `${why}.`}`;
}

type InboxRow = {
  id: string;
  /** Absent before migration 0148, when every row is an email. */
  source?: InboxSource | null;
  file_name?: string | null;
  received_at: string;
  status: InboxStatus;
  reasons: string[] | null;
  counterparty_name: string | null;
  vendor_name: string | null;
  amount: string | null;
  currency: string | null;
};

/** The workspace's Google Drive folder's name, for its files' words; null when none is chosen, or it cannot be read. */
async function driveFolderName(orgDb: OrgDb): Promise<string | null> {
  const result = await orgDb.from("google_drive_folders").select("folder_name").limit(1);
  if (result.error) {
    if (!notSetUp(result.error)) console.error("accountant: the Google Drive folder's name not read", result.error.message);
    return null;
  }
  return ((result.data ?? []) as Array<{ folder_name: string }>)[0]?.folder_name ?? null;
}

/**
 * Invoices emailed to the workspace's address and files found in its Google Drive folder, waiting on Bills & receivables
 * (AW3), read as `inboxEmailsToDecide` reads them and only where the Bills page lists them: on a deployment that receives
 * invoices by email or reads a Google Drive folder. The same window as that list, its newest `TO_DECIDE_LIMIT` documents
 * still to decide, so an item never opens a list that leaves it out; of them, those waiting for a person. Never the
 * sender, the subject or the email's words: only what the read named, the file's name, the state and the first reason.
 */
async function inboxItems(orgDb: OrgDb, ws: { slug: string; name: string; role: OrgMembership["role"] }): Promise<TriageItem[]> {
  if (!inboxSettingsFromEnv() && !googleDriveSettingsFromEnv()) return [];
  const read = (columns: string) =>
    orgDb
      .from("inbox_emails")
      .select(`id, ${columns}received_at, status, reasons, counterparty_name:read->>counterpartyName, vendor_name:read->>vendorName, amount:read->>amount, currency:read->>currency`)
      .in("status", STILL_TO_DECIDE)
      .order("received_at", { ascending: false })
      .limit(TO_DECIDE_LIMIT);
  const first = await read("source, file_name, ");
  // Before migration 0148 every row is an email, read without the columns it adds (Google Drive intake GD3).
  const result = before0148(first.error) ? await read("") : first;
  if (result.error && notSetUp(result.error)) return [];
  if (result.error) throw new Error(result.error.message);
  // Of the documents the review list holds, those waiting for a person: never one still being read.
  const rows = ((result.data ?? []) as unknown as InboxRow[]).filter(
    (row): row is InboxRow & { status: Exclude<InboxStatus, "received"> } => row.status !== "received"
  );
  const folder = rows.some((row) => row.source === "google_drive") ? await driveFolderName(orgDb) : null;
  const route = routeTo(ws.role, "to_review");
  return rows.map((row) => {
    const drive = row.source === "google_drive";
    const named = row.counterparty_name || row.vendor_name || (drive ? row.file_name : null);
    const how = drive ? (folder ? `Added to the Google Drive folder ${withoutAddresses(folder)}` : "Added to the workspace's Google Drive folder") : "Emailed to the workspace's address";
    return {
      key: `${ws.slug}:to_review:${row.id}`,
      kind: "to_review" as const,
      workspace: { slug: ws.slug, name: ws.name },
      title: named ? withoutAddresses(named) : drive ? "A file from Google Drive" : "An emailed invoice",
      detail: `${how}. ${reviewState(row.status, row.reasons?.[0] ?? null)}`,
      amount: row.status === "unreadable" ? null : readAmount(row.amount, row.currency),
      since: row.received_at,
      href: orgHref(ws.slug, billsHref({ tab: "bills", review: "email" })),
      ...route,
    };
  });
}

type DraftRow = {
  id: string;
  source: DraftSource;
  supplier_name: string | null;
  invoice_number: string | null;
  amount: string | null;
  currency: string | null;
  due_date: string | null;
  captured_at: string;
  sent_at: string | null;
  counterparty_name: string | null;
};

/**
 * Invoices captured in Chrome and sent for review, and those a payee sent through its invoice link (AW3): the drafts
 * still open, as the Bills page reads them (`state` sent: not added, not dismissed, and never swept, which only takes
 * drafts never sent), in the same window, its newest `REVIEW_LIMIT`, so an item never opens a list that leaves it out.
 * Ready to add once nothing a bill needs is missing, as the extension words it.
 */
async function capturedItems(orgDb: OrgDb, ws: { slug: string; name: string; role: OrgMembership["role"] }): Promise<TriageItem[]> {
  const result = await orgDb
    .from("invoice_drafts")
    .select("id, source, supplier_name, invoice_number, amount, currency, due_date, captured_at, sent_at, counterparty_name:read->>counterpartyName")
    .eq("state", "sent")
    .order("sent_at", { ascending: false })
    .limit(REVIEW_LIMIT);
  // Before migration 0121 nothing is captured.
  if (result.error && notSetUp(result.error)) return [];
  if (result.error) throw new Error(result.error.message);
  const route = routeTo(ws.role, "to_review");
  return ((result.data ?? []) as unknown as DraftRow[]).map((row) => {
    const payee = row.source === "payee_link";
    const named = row.counterparty_name || row.supplier_name;
    const missing = missingFields({
      supplierName: row.supplier_name,
      invoiceNumber: row.invoice_number,
      amount: row.amount,
      currency: row.currency,
      invoiceDate: null,
      dueDate: row.due_date,
      poReference: null,
      memo: null,
    });
    return {
      key: `${ws.slug}:to_review:${row.id}`,
      kind: "to_review" as const,
      workspace: { slug: ws.slug, name: ws.name },
      title: named ? withoutAddresses(named) : payee ? "An invoice from a payee" : "A captured invoice",
      detail: `${payee ? "Sent through the payee's invoice link" : "Captured in Chrome"}. ${missing.length === 0 ? reviewState("ready", null) : reviewState("needs_details", missing[0].message)}`,
      amount: readAmount(row.amount, row.currency),
      since: row.sent_at ?? row.captured_at,
      href: orgHref(ws.slug, billsHref({ tab: "bills", review: "captured" })),
      ...route,
    };
  });
}

/**
 * One item per document waiting to be added, whichever way it came (AW3). Bills brought in from Xero, QuickBooks or Zoho
 * Books are not listed yet: they wait in the workspace's own review list (`accounting_bills`, from the tool's last sync),
 * which this does not read.
 */
async function reviewItems(orgDb: OrgDb, ws: { slug: string; name: string; role: OrgMembership["role"] }): Promise<TriageItem[]> {
  return (await Promise.all([inboxItems(orgDb, ws), capturedItems(orgDb, ws)])).flat();
}

type WorkLinkRow = {
  id: string;
  milestone_id: string;
  /** A Linear or Jira issue's identifier ("ENG-12"); absent on an Asana task. */
  identifier?: string;
  /** Jira's resolution, as last read ("Won't Do"); absent on an Asana task and a Linear issue. */
  resolution_name?: string | null;
  state: "ready" | "held";
  held_reason: string | null;
  held_at: string | null;
  completed_at: string | null;
  linked_at: string;
};

/**
 * One tool's live links waiting on a person (AW4): ready for acceptance, or held for review. A link held after its payment
 * was sent is left out: there is no work to accept on a paid milestone. Before the tool's migration (0115 for Asana,
 * 0147 for Linear, 0149 for Jira) its table is missing: the tool adds nothing, and nothing is named unread.
 */
async function waitingLinks(
  orgDb: OrgDb,
  table: "asana_task_links" | "linear_issue_links" | "jira_issue_links",
  columns: string,
  notReady: (error: { code?: string | null; message?: string }) => boolean
): Promise<WorkLinkRow[]> {
  const result = await orgDb
    .from(table)
    .select(columns)
    .is("unlinked_at", null)
    .in("state", ["ready", "held"])
    .eq("after_payment", false)
    .order("linked_at", { ascending: true })
    .limit(ROWS);
  if (result.error && notReady(result.error)) return [];
  if (result.error) throw new Error(result.error.message);
  return (result.data ?? []) as unknown as WorkLinkRow[];
}

/**
 * What a held link's item says to whoever may accept work: a held link may not be accepted as it stands (`acceptable`
 * refuses an unreachable task or issue, one not completed, archived, or without criteria), so they review it on its card
 * first, as its detail says, never a promise to accept it (AW4).
 */
const HELD_WORK = { canAct: true, who: "You can review it" } as const;

/**
 * Contractor work to accept (AW4): milestones still waiting for verification whose Asana task, Linear issue or Jira issue
 * is ready for acceptance, or held for review, in the words of the Contractors card. A milestone held for a person is a
 * decision item already, and is not waiting for verification, so it is never listed twice. Each tool only on a deployment
 * where it is set up, as Contractors shows its card (`asanaOnContractors`, `linearOnContractors`, `jiraOnContractors`):
 * elsewhere no card offers the acceptance an item would send someone to. Jira is set up only with both JIRA_CLIENT_ID and
 * JIRA_CLIENT_SECRET (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR1).
 */
async function workItems(orgDb: OrgDb, ws: { slug: string; name: string; role: OrgMembership["role"] }): Promise<TriageItem[]> {
  const [asana, linear, jira] = await Promise.all([
    asanaSettingsFromEnv()
      ? waitingLinks(orgDb, "asana_task_links", "id, milestone_id, state, held_reason, held_at, completed_at, linked_at", isAsanaNotSetUp)
      : [],
    linearSettingsFromEnv()
      ? waitingLinks(orgDb, "linear_issue_links", "id, milestone_id, identifier, state, held_reason, held_at, completed_at, linked_at", isLinearNotSetUp)
      : [],
    jiraSettingsFromEnv()
      ? waitingLinks(orgDb, "jira_issue_links", "id, milestone_id, identifier, state, held_reason, held_at, completed_at, linked_at, resolution_name", isJiraNotSetUp)
      : [],
  ]);
  const ids = [...new Set([...asana, ...linear, ...jira].map((link) => link.milestone_id))];
  if (ids.length === 0) return [];
  const reads = await Promise.all(
    Array.from({ length: Math.ceil(ids.length / ID_CHUNK) }, (_, index) =>
      orgDb
        .from("milestones")
        .select("id, title, amount, counterparties(name)")
        .in("id", ids.slice(index * ID_CHUNK, (index + 1) * ID_CHUNK))
        .eq("status", "pending")
    )
  );
  const milestones = new Map<string, { title: string; amount: string | number; counterparties: { name: string } | null }>();
  for (const result of reads) {
    if (result.error) throw new Error(result.error.message);
    for (const row of (result.data ?? []) as unknown as Array<{ id: string; title: string; amount: string | number; counterparties: { name: string } | null }>) milestones.set(row.id, row);
  }
  const route = routeTo(ws.role, "accept_work");
  const item = (link: WorkLinkRow, ready: string, held: string): TriageItem[] => {
    const milestone = milestones.get(link.milestone_id);
    if (!milestone) return [];
    return [
      {
        key: `${ws.slug}:accept_work:${link.id}`,
        kind: "accept_work",
        workspace: { slug: ws.slug, name: ws.name },
        title: `${milestone.counterparties?.name ?? "A contractor"}: ${milestone.title}`,
        detail: link.state === "ready" ? `${ready} Accept it against its criteria.` : `Held: ${held}`,
        amount: { value: num(milestone.amount), currency: "USDC" },
        since: link.state === "ready" ? (link.completed_at ?? link.linked_at) : (link.held_at ?? link.linked_at),
        // CL15: the milestone waits for verification, so it is open on Contractors.
        href: orgHref(ws.slug, milestoneRowPath(link.milestone_id, { paid: false })),
        ...(link.state === "held" && route.canAct ? HELD_WORK : route),
      },
    ];
  };
  return [
    ...asana.flatMap((link) => item(link, "Completed in Asana.", asanaStateWords("held", link.held_reason as AsanaHeldReason | null, false).line)),
    ...linear.flatMap((link) =>
      item(link, `Completed in Linear${link.identifier ? ` (${link.identifier})` : ""}.`, linearStateWords("held", link.held_reason as LinearHeldReason | null, false).line)
    ),
    // Jira says Done, its status category (JR9); a canceled issue's line names Jira's resolution, as the card does.
    ...jira.flatMap((link) =>
      item(
        link,
        `Done in Jira${link.identifier ? ` (${link.identifier})` : ""}.`,
        jiraStateWords("held", link.held_reason as JiraHeldReason | null, false, link.resolution_name ?? null).line
      )
    ),
  ];
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Last month's close (AW5): the last full UTC month, while it holds a payment the close pack lists and no one has
 * downloaded or exported its pack. The payments are counted as the pack reads them, confirmed, created or sent in the
 * month, with a count and no rows. An export is a `close_pack_exported` entry naming the month (its `detail.month`,
 * YYYY-MM) as ended: a pack taken while the month was still running, "so far", does not close it.
 */
async function monthCloseItems(orgDb: OrgDb, ws: { slug: string; name: string; role: OrgMembership["role"] }, now: Date): Promise<TriageItem[]> {
  const month = closePackMonth(null, now) as ClosePackMonth;
  const from = `${month.from}T00:00:00.000Z`;
  const to = `${month.to}T00:00:00.000Z`;
  const inMonth = (column: string) => `and(${column}.gte.${from},${column}.lt.${to})`;
  const [payments, exported] = await Promise.all([
    orgDb.from("payment_intents").select("id", { count: "exact", head: true }).or(`${inMonth("confirmed_at")},${inMonth("created_at")},${inMonth("submitted_at")}`),
    orgDb.from("ledger_entries").select("seq").eq("action", CLOSE_PACK_EXPORTED).eq("detail->>month", month.key).eq("detail->>ended", "true").limit(1),
  ]);
  if (payments.error) throw new Error(payments.error.message);
  if (exported.error) throw new Error(exported.error.message);
  const paid = payments.count ?? 0;
  if (paid === 0 || ((exported.data ?? []) as unknown[]).length > 0) return [];
  return [
    {
      key: `${ws.slug}:month_close:${month.key}`,
      kind: "month_close",
      workspace: { slug: ws.slug, name: ws.name },
      title: month.label,
      detail: `${count(paid, "payment", "payments")}. The close pack has not been downloaded or exported yet.`,
      amount: null,
      // From the first day of the month after it, when it could first be closed.
      since: month.to,
      href: orgHref(ws.slug, `/evidence/close-pack?month=${month.key}`),
      ...routeTo(ws.role, "month_close"),
    },
  ];
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
    part("payments waiting for a decision", unread, async () => decisionItems(orgDb, ws, now, { on: await cosignOn, viewerId }, unread), []),
    // Whoever may confirm a changed address: whoever decides payments, and an accountant while co-signing is on (CS6).
    part("addresses to confirm", unread, async () => (can(ws.role, "approval.decide") || (await cosignOn) ? addressItems(orgDb, ws, viewerId) : []), []),
    part("payments to book", unread, () => bookingItems(orgDb, ws), []),
    part("receivables", unread, () => receivableItems(orgDb, ws, now), []),
    part("connectors", unread, () => connectorItems(ws, now), []),
    part("limits", unread, () => limitItems(ws, now), []),
    // What else waits on a person, each its own part (all waiting AW1, AW3 to AW5); verdicts are read with the bills.
    part("invoices to review", unread, () => reviewItems(orgDb, ws), []),
    part("work to accept", unread, () => workItems(orgDb, ws), []),
    part("last month's close", unread, () => monthCloseItems(orgDb, ws, now), []),
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
