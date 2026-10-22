import { can, type OrgRole } from "../auth/roles";
import type { SentReminder } from "../collections";
import { todayOf, type Coin } from "../customer-portal/model";
import { db } from "../dal";
import type { Network } from "../network";
import type { PayLinkState } from "../platform/pay-links";
import { proposeNextAction, type CollectionPolicy, type CollectionTask, type CrmContext, type CustomerSaid } from "./model";
import { policyOf, readCrmContexts, readPolicies, readSaid, readTasks, readTaskStart, tasksByInvoice, type PoliciesRead } from "./read";
import { collectionsPanel, promiseRecord, proposalView, reminderPreview, type CollectionsPanelView, type PromiseOutcome, type ProposalView } from "./view";

/**
 * Collections on the Receivables tab (docs/superpowers/specs/2026-10-13-collections-context-design.md C8): each
 * receivable due in the next week, overdue, opened in a panel or with a task, proposed with the same `proposeNextAction`
 * the collections stage acts on, so the page shows what the agent will do. `buildCollections` is pure, for the page and
 * the pictures; `readCollections` reads what it needs in the workspace in scope.
 */

/** Receivables due within this many days are in the panel, with every overdue one. */
export const PANEL_DAYS = 7;

export interface CollectionInvoice {
  id: string;
  counterparty_id: string;
  counterparty_name: string;
  direction: string;
  amount: number;
  currency?: string | null;
  due_date: string;
  status: string;
  memo: string | null;
  po_reference: string | null;
  settled_at?: string | null;
  deal_id?: string | null;
}

export interface CollectionMember {
  userId: string;
  email: string;
  role: OrgRole;
}

export interface CollectionsInput {
  orgName: string;
  network: Network;
  origin: string;
  now: number;
  invoices: readonly CollectionInvoice[];
  /** The customers' billing emails, by counterparty id. */
  billingEmails: ReadonlyMap<string, string | null>;
  /** What is still owed and what arrived on each receivable, from the payments applied. */
  owed: (invoice: CollectionInvoice) => { owed: number; received: number };
  links: ReadonlyMap<string, PayLinkState>;
  said: ReadonlyMap<string, CustomerSaid[]>;
  policies: PoliciesRead;
  tasks: readonly CollectionTask[];
  crm: ReadonlyMap<string, CrmContext>;
  members: readonly CollectionMember[] | null;
  /** The receivables always proposed, whatever their due day: the ones opened on the page. */
  focus: readonly string[];
  sentThisWeek: number;
  promises: readonly PromiseOutcome[];
  href: (invoiceId: string) => string;
  /** The day tasks began in the workspace, as the stage reads it: what was already so then opens none. */
  tasksFrom?: string | null;
}

export interface CollectionsView {
  /** Whether rules and tasks are set up here (migration 0110). */
  available: boolean;
  views: Map<string, ProposalView>;
  panel: CollectionsPanelView;
}

const OPEN = new Set(["pending", "matched"]);

/** The receivables the tab proposes: open ones due within a week or overdue, the ones in focus, and those with an open task. */
export function inCollections(invoices: readonly CollectionInvoice[], today: string, focus: readonly string[], withTasks: ReadonlySet<string>): CollectionInvoice[] {
  const until = new Date(Date.parse(`${today}T00:00:00Z`) + PANEL_DAYS * 86_400_000).toISOString().slice(0, 10);
  const focused = new Set(focus);
  return invoices.filter(
    (invoice) => invoice.direction === "receivable" && OPEN.has(invoice.status) && (invoice.due_date.slice(0, 10) <= until || focused.has(invoice.id) || withTasks.has(invoice.id))
  );
}

export function buildCollections(input: CollectionsInput): CollectionsView {
  const today = todayOf(input.now);
  const tasksBy = tasksByInvoice(input.tasks);
  const openTasks = new Set(input.tasks.filter((task) => task.status === "open").map((task) => task.invoiceId));
  const members = new Map((input.members ?? []).map((member) => [member.userId, member.email]));
  const owners = (input.members ?? []).filter((member) => can(member.role, "records.write")).map((member) => ({ id: member.userId, email: member.email }));
  const views = new Map<string, ProposalView>();
  for (const invoice of inCollections(input.invoices, today, input.focus, openTasks)) {
    const currency: Coin = invoice.currency === "EURC" ? "EURC" : "USDC";
    const link = input.links.get(invoice.id);
    const billingEmail = input.billingEmails.get(invoice.counterparty_id) ?? null;
    const policy: CollectionPolicy = policyOf(input.policies, invoice.counterparty_id);
    const balance = input.owed(invoice);
    const tasks = tasksBy.get(invoice.id) ?? [];
    const crm = input.crm.get(invoice.id) ?? null;
    const sent: SentReminder[] = link?.sent ?? [];
    const proposal = proposeNextAction(
      {
        invoiceId: invoice.id,
        customerId: invoice.counterparty_id,
        customerName: invoice.counterparty_name,
        billingEmail: Boolean(billingEmail),
        amount: Number(invoice.amount),
        currency,
        dueDate: invoice.due_date,
        status: invoice.status,
        owed: balance.owed,
        received: balance.received,
        remindersOn: Boolean(link?.remindersOnAt),
        payLink: Boolean(link?.url),
        deferredUntil: link?.deferredUntil ?? null,
        sent,
        said: input.said.get(invoice.id) ?? [],
        policy,
        crm,
        tasks,
        tasksFrom: input.tasksFrom ?? null,
      },
      input.now
    );
    const preview =
      proposal.reminder && billingEmail && (proposal.action === "remind" || proposal.action === "ask_owner")
        ? reminderPreview({
            orgName: input.orgName,
            customerName: invoice.counterparty_name,
            billingEmail,
            currency,
            amount: Number(invoice.amount),
            memo: invoice.memo,
            poReference: invoice.po_reference,
            dueDate: invoice.due_date,
            reminder: proposal.reminder,
            payUrl: link?.url ?? null,
            origin: input.origin,
            network: input.network,
          })
        : null;
    views.set(
      invoice.id,
      proposalView({
        proposal,
        invoice: { id: invoice.id, memo: invoice.memo, dueDate: invoice.due_date, amount: Number(invoice.amount), currency, owed: balance.owed },
        customerName: invoice.counterparty_name,
        policy,
        tasks,
        members,
        owners,
        preview,
        crm: crm ? { name: crm.dealName, url: crm.url, hasOwner: crm.ownerId !== null } : null,
        today,
        href: input.href(invoice.id),
      })
    );
  }
  return {
    available: input.policies.available,
    views,
    panel: collectionsPanel({ views: [...views.values()], sentThisWeek: input.sentThisWeek, promises: promiseRecord(input.promises, today) }),
  };
}

/**
 * Reads what the tab's collections need and builds them. Best effort for the caller: it throws on a database error, and
 * the page shows the tab without the panel.
 */
export async function readCollections(
  input: Omit<CollectionsInput, "links" | "said" | "policies" | "tasks" | "crm" | "sentThisWeek" | "promises" | "tasksFrom" | "members"> & {
    linkStates: (invoiceIds: string[]) => Promise<Map<string, PayLinkState>>;
    /** The members, or their read under way: the reads here start without waiting for it (bills page parallel reads R4). */
    members: CollectionsInput["members"] | Promise<CollectionsInput["members"]>;
  }
): Promise<CollectionsView> {
  const orgDb = db();
  const today = todayOf(input.now);
  // Awaited with the last reads below, so a read of the members that fails is thrown there, as any other read's is.
  const membersRead = Promise.resolve(input.members);
  membersRead.catch(() => undefined);
  const open = await readTasks(orgDb, { openOnly: true });
  const withTasks = new Set(open.available ? open.tasks.map((task) => task.invoiceId) : []);
  const chosen = inCollections(input.invoices, today, input.focus, withTasks);
  const ids = chosen.map((invoice) => invoice.id);
  const weekAgo = new Date(input.now - 7 * 86_400_000).toISOString();
  const promisedFrom = new Date(input.now - 90 * 86_400_000).toISOString().slice(0, 10);
  const [links, said, policies, tasks, crm, sentThisWeek, promised, start, members] = await Promise.all([
    input.linkStates(ids),
    readSaid(orgDb, ids, new Date(input.now - 90 * 86_400_000).toISOString()),
    readPolicies(orgDb, [...new Set(chosen.map((invoice) => invoice.counterparty_id))]),
    readTasks(orgDb, { invoiceIds: ids }),
    readCrmContexts(orgDb, chosen),
    orgDb.from("ar_reminders").select("id", { count: "exact", head: true }).gte("sent_at", weekAgo),
    orgDb.from("customer_requests").select("invoice_id, promised_on, outcome").eq("kind", "promise").gte("promised_on", promisedFrom).limit(1000),
    // Read, never set: before the stage's first run, tasks begin today at the earliest.
    readTaskStart(orgDb),
    membersRead,
  ]);
  const settled = new Map(input.invoices.map((invoice) => [invoice.id, invoice.settled_at ?? null]));
  const promises: PromiseOutcome[] = promised.error
    ? []
    : ((promised.data ?? []) as Array<{ invoice_id: string; promised_on: string; outcome: string | null }>).map((row) => ({
        promisedOn: String(row.promised_on).slice(0, 10),
        outcome: row.outcome,
        settledAt: settled.get(row.invoice_id) ?? null,
      }));
  return buildCollections({
    ...input,
    members,
    links,
    said,
    policies,
    tasks: tasks.available ? tasks.tasks : [],
    crm,
    sentThisWeek: sentThisWeek.error ? 0 : (sentThisWeek.count ?? 0),
    promises,
    tasksFrom: start === "" ? today : start,
  });
}
