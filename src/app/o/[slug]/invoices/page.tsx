import { randomUUID } from "node:crypto";
import { FileSpreadsheet, FileText, Handshake, ListFilter, PenLine, Repeat, Search } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { AutoRefresh } from "@/components/AutoRefresh";
import InboxEmails from "@/components/InboxEmails";
import { AccountingBillsReview } from "@/components/AccountingBillsReview";
import { AccountingBookings } from "@/components/AccountingBookings";
import AgentControls from "@/components/AgentControls";
import { AllocationLines } from "@/components/AllocationLines";
import { ApplyPayments } from "@/components/ApplyPayments";
import BillImport from "@/components/intake/BillImport";
import InvoiceDocumentIntake from "@/components/intake/InvoiceDocumentIntake";
import InvoiceIntake from "@/components/intake/InvoiceIntake";
import RecurringPayableIntake from "@/components/intake/RecurringPayableIntake";
import { PayLinkControl } from "@/components/PayLinkControl";
import { ReceiptControl } from "@/components/ReceiptControl";
import VerdictControl from "@/components/VerdictControl";
import { WaitingPayableAction } from "@/components/WaitingPayableAction";
import { Callout } from "@/components/ui/Callout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { DecisionRows, RowGroupHeading, type DecisionRowItem } from "@/components/vx/DecisionRows";
import { IntakeFold } from "@/components/vx/IntakeFold";
import { Money } from "@/components/vx/Primitives";
import { StatTile } from "@/components/vx/StatTile";
import { invoiceDecision } from "@/components/vx/map";
import { payableSignals, stoppedWhy } from "@/components/vx/decision-signals";
import { RecurringSummary } from "@/components/vx/RecurringSummary";
import { PaymentPlanSection } from "@/components/vx/PaymentPlan";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { sectionTitle } from "@/components/vx/nav";
import { addedSince, latestDecision, recordedFacts, waitingHint } from "@/lib/added-details";
import { readAllocationBook, stillOwed, toReceivableIn } from "@/lib/allocations/book";
import { toMicros, type PaymentIn } from "@/lib/allocations/model";
import { receivableLabel } from "@/lib/allocations/suggest";
import { applyPaymentsView, paymentsByReceivable, receivableViews, type ReceivableView } from "@/lib/allocations/view";
import { invoiceMatch, parseSearch } from "@/lib/invoice-search";
import { CASH_SHORTFALL, SHADOW_VERDICT } from "@/lib/next-step";
import { hasRunningCycle } from "@/lib/agent/cycle-running";
import { isSoleApprover } from "@/lib/agent/sole-approver";
import { viewerCan } from "@/lib/auth/authorize";
import { requireMembership } from "@/lib/auth/membership";
import { orgHref } from "@/lib/auth/org-paths";
import { shellModes } from "@/lib/circle";
import { db } from "@/lib/dal";
import { inOrg } from "@/lib/dal/scope";
import { inboxEmailsToDecide } from "@/lib/email-inbox/list";
import { inboxSettingsFromEnv } from "@/lib/email-inbox/settings";
import { connectionFor, NotSetUpError } from "@/lib/connectors/connections";
import { PROVIDER_LABELS, PROVIDERS, type ProviderId } from "@/lib/connectors/provider";
import { accountingReview, type ReviewView } from "@/lib/connectors/review";
import { accountingProvider, accountingProviderOn } from "@/lib/accounting-providers";
import { accountingBookings, type BookingsView } from "@/lib/connectors/bookings-view";
import { ledgerReadMayBeCut, listLedgerEntries, listLedgerEntriesForTargets } from "@/lib/ledger";
import { listCounterparties, listInvoices, stats, type InvoiceRow } from "@/lib/queries";
import { plural, utcDay } from "@/lib/copy";
import { payLinkStates, type PayLinkState } from "@/lib/platform/pay-links";
import { listRecurringPayables } from "@/lib/recurring-payables";
import { readPaymentPlan } from "@/lib/payment-plan-read";
import { planOutcomes } from "@/lib/payment-plan-outcomes";
import { billCurrencyOf } from "@/lib/shadow-currency";
import { verdictFacts } from "@/lib/verdicts";
import { receiptShareable } from "@/lib/receipts/facts";
import { sharedReceipts } from "@/lib/receipts/share";
import { settlementsByBill } from "@/lib/settlement-facts";
import { readInvoicePayments, type PaymentRecord } from "@/lib/settlement-read";
import { workspaceNetwork } from "@/lib/workspace-network";
import { shellStatus } from "@/lib/shell-status";
import { DealForm } from "@/components/deals/DealForm";
import { DealsSection } from "@/components/deals/DealsSection";
import { HubSpotDeals } from "@/components/HubSpotDeals";
import { crmPrefillFor, crmReady, crmReview, type CrmPrefillRead, type CrmReviewView } from "@/lib/connectors/crm-review";
import { dealLinksOf, plannedLinesOf, readDeals, type DealLink } from "@/lib/deals/read";
import { hubspotSettingsFromEnv } from "@/lib/hubspot/settings";

export const dynamic = "force-dynamic";

/** An imported list of up to 200 bills is added one bill at a time, each with its signed entry (import design B12). */
export const maxDuration = 300;

export const metadata: Metadata = { title: sectionTitle("invoices") };

type InvoiceSearchParams = Promise<{
  status?: string | string[];
  /** `all` shows every settled invoice; otherwise the latest ten. */
  history?: string | string[];
  /** Present: the new invoice form opens, as the command palette's "Add a bill" asks (workspace shell design S9). */
  add?: string | string[];
  /** A search: an id, an invoice number, a purchase order, a counterparty, an amount, or a payment's reference (I09). */
  q?: string | string[];
  /** A HubSpot deal of the list: the New deal form opens filled in from it (HubSpot connector H11). */
  hubspot?: string | string[];
}>;

/** Payables still to be paid: decided or not, held or scheduled. */
const OPEN = new Set(["pending", "matched", "scheduled", "held", "flagged", "awaiting_info"]);
/** Payables waiting for a person (Approvals). */
const WAITING = new Set(["held", "flagged", "awaiting_info"]);
/** Settled rows shown before "Show all": history, kept short so the work leads. */
const HISTORY_SHOWN = 5;

type InvoicePageProps = {
  params: Promise<{ slug: string }>;
  searchParams: InvoiceSearchParams;
};

/**
 * The bills an accounting tool brought in, waiting for a person (Xero connector X11, X19; QuickBooks connector Q19), on
 * a deployment where the tool is set up: hidden before migration 0101, without a connection, and when it cannot be read.
 */
function broughtIn(provider: ProviderId): Promise<ReviewView> {
  if (!accountingProviderOn(provider)) return Promise.resolve({ state: "hidden" });
  return connectionFor(provider)
    .then(accountingReview)
    .catch((error: unknown): ReviewView => {
      if (!(error instanceof NotSetUpError)) console.error(`invoices: bills from ${PROVIDER_LABELS[provider]} not loaded`, error instanceof Error ? error.message : error);
      return { state: "hidden" };
    });
}

/**
 * The payments made on Arc to book in an accounting tool, each for a person to review (accounting write-back W6, W10),
 * for a tool that books: hidden before migration 0106, without a connection, and when it cannot be read.
 */
function toBookIn(provider: ProviderId): Promise<BookingsView> {
  if (!accountingProviderOn(provider)) return Promise.resolve({ state: "hidden" });
  return connectionFor(provider)
    .then((connection) => accountingBookings(connection, accountingProvider(provider)))
    .catch((error: unknown): BookingsView => {
      if (!(error instanceof NotSetUpError)) console.error(`invoices: bookings in ${PROVIDER_LABELS[provider]} not loaded`, error instanceof Error ? error.message : error);
      return { state: "hidden" };
    });
}

export default async function InvoicesPage({ params, searchParams }: InvoicePageProps) {
  const { slug } = await params;
  const access = await requireMembership(slug);
  return inOrg(access, async () => {
    const network = workspaceNetwork().id;
    const query = await searchParams;
    const [invoices, counterparties, headEntries, dashboardStats, canWrite, canDecide, schedules, deciding, emailed, fromXero, fromQuickBooks, dealsRead, fromHubSpot] = await Promise.all([
      listInvoices(),
      listCounterparties(),
      listLedgerEntries(1),
      stats(),
      viewerCan(slug, "records.write"),
      viewerCan(slug, "approval.decide"),
      // Best effort: a list that cannot be read hides its section, nothing else.
      listRecurringPayables().catch((error: unknown) => {
        console.error("invoices: recurring payments not loaded", error instanceof Error ? error.message : error);
        return [];
      }),
      // A cycle running now is deciding the payables not yet decided: they say so (decision trail R1). Best effort.
      hasRunningCycle().catch(() => false),
      // The invoices that arrived by email and wait for a person, on a deployment that receives them (email invoices E7).
      inboxSettingsFromEnv()
        ? inboxEmailsToDecide().catch((error: unknown) => {
            console.error("invoices: emailed invoices not loaded", error instanceof Error ? error.message : error);
            return [];
          })
        : [],
      // The bills Xero and QuickBooks brought in, waiting for a person (Xero connector X11, X19; QuickBooks connector
      // Q19), each on a deployment where it is set up; hidden before migration 0101, without a connection, and when it
      // cannot be read.
      broughtIn("xero"),
      broughtIn("quickbooks"),
      // The workspace's deals and their schedules (deal schedule). Best effort: before migration 0104 runs the section
      // says deals are not set up, and a read that fails hides only the section.
      readDeals().catch((error: unknown) => {
        console.error("invoices: deals not loaded", error instanceof Error ? error.message : error);
        return "unread" as const;
      }),
      // HubSpot's won deals, to plan collections from (HubSpot connector H20), on a deployment where HubSpot is set up;
      // hidden before migration 0105, without a connection, and when they cannot be read.
      hubspotSettingsFromEnv()
        ? connectionFor("hubspot")
            .then(async (connection) => {
              await crmReady();
              return crmReview(connection);
            })
            .catch((error: unknown): CrmReviewView => {
              if (!(error instanceof NotSetUpError)) console.error("invoices: deals from HubSpot not loaded", error instanceof Error ? error.message : error);
              return { state: "hidden" };
            })
        : ({ state: "hidden" } as CrmReviewView),
    ]);
    const deals = dealsRead === "unread" ? "unread" : dealsRead.available ? dealsRead.deals : "not_ready";
    // The payments made on Arc to book in each accounting tool, for a person to review (accounting write-back W6, W10).
    const [toBook, canBook] = await Promise.all([Promise.all(PROVIDERS.map(toBookIn)), viewerCan(slug, "accounting.book")]);
    // Each receivable a deal line became names its deal (deal schedule).
    const dealLinks = Array.isArray(deals) ? dealLinksOf(deals) : new Map<string, DealLink>();
    const filter = typeof query.status === "string" ? query.status : undefined;
    const search = parseSearch(typeof query.q === "string" ? query.q : undefined);
    // The payments applied to receivables (allocations L11). Best effort: a read that fails shows receivables as before.
    const book = await readAllocationBook(db()).catch((error: unknown) => {
      console.error("invoices: payments applied not read", error instanceof Error ? error.message : error);
      return null;
    });
    const receivablesIn = invoices.filter((invoice) => invoice.direction === "receivable").map(toReceivableIn);
    const allocations = book ? receivableViews(book, receivablesIn) : new Map<string, ReceivableView>();
    const appliedPayments = book ? paymentsByReceivable(book) : new Map<string, PaymentIn[]>();
    const [entries, paymentPlan] = await Promise.all([
      listLedgerEntriesForTargets({ invoiceIds: invoices.map((invoice) => invoice.id) }),
      // The next 14 days of payments, in the order the cash allows (payment plan design P1), from the invoices and
      // counterparties read above, shown over the whole list only. Best effort: a plan that cannot be read says so in
      // its section, and nothing else changes.
      filter
        ? null
        : readPaymentPlan({
            invoices,
            counterparties,
            // Deal lines not invoiced yet, listed apart from the plan's balances (deal schedule D14).
            planned: Array.isArray(deals) ? plannedLinesOf(deals) : deals === "not_ready" ? [] : null,
            // A part-paid receivable, a released deal line among them, is expected for what is still owed (allocations L11).
            owed: new Map(
              invoices.filter((invoice) => invoice.direction === "receivable").map((invoice) => [invoice.id, stillOwed(invoice, book?.rows ?? [])] as const)
            ),
          }).catch((error: unknown) => {
            console.error("invoices: payment plan not read", error instanceof Error ? error.message : error);
            return null;
          }),
    ]);
    const paymentOutcomes = planOutcomes({ now: Date.now(), invoices, entries });
    // Whoever entered a bill approves its day only as the workspace's only approver (payment plan P10); asked only then.
    const soleApprover =
      canDecide && paymentPlan?.lines.some((line) => line.move !== null && line.createdBy === access.user.id) ? await isSoleApprover(access.user.id) : false;
    // In shadow mode, each card carries a person's verdict on the agent's decision, given or to give (shadow mode S3).
    const verdicts = await verdictFacts(db(), entries, canDecide);
    // The workspace's customers, as the New deal form offers them.
    const customers = counterparties
      .filter((counterparty) => counterparty.role === "client")
      .map(({ id, name }) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const dealCurrencies = ["USDC", "EURC", ...(billCurrencyOf(verdicts.shadow) ? [billCurrencyOf(verdicts.shadow) as string] : [])];
    // A HubSpot deal picked to plan: the New deal form filled in from it (HubSpot connector H11). Read again on confirm.
    const planFromHubSpot: CrmPrefillRead | null =
      typeof query.hubspot === "string" && canWrite && fromHubSpot.state === "list" && Array.isArray(deals)
        ? await crmPrefillFor({ rowId: query.hubspot, customers, workspace: { shadowOn: verdicts.shadow !== null }, today: new Date().toISOString().slice(0, 10) }).catch(
            (error: unknown): CrmPrefillRead => {
              console.error("invoices: a HubSpot deal was not read to plan", error instanceof Error ? error.message : error);
              return { ok: false, message: "That deal could not be read. Reload the page in a moment." };
            }
          )
        : null;
    const byStatus = filter ? invoices.filter((invoice) => invoice.status === filter) : invoices;
    // A search keeps what it finds (I09): by id, invoice number, purchase order, counterparty, amount or a payment applied.
    const shown = search
      ? byStatus.filter((invoice) => {
          const owed = allocations.get(invoice.id);
          return invoiceMatch(search, invoice, { outstanding: owed ? toMicros(owed.outstanding) : undefined, payments: appliedPayments.get(invoice.id) }) !== null;
        })
      : byStatus;
    // Money received on Arc not applied in full, with suggestions; a search keeps the payments it finds.
    const toApply = book?.available ? applyPaymentsView(book, receivablesIn, counterparties.map(({ id, name, address }) => ({ id, name, address })), { query: search }) : [];
    const counterpartiesById = new Map(counterparties.map((counterparty) => [counterparty.id, counterparty]));
    // Where each payable's payment is, from its payment intent, the entries about it and the bill (settlement lifecycle
    // L7, L8). Best effort: a read that fails is logged and the cards show no track.
    const asOf = Date.now();
    const payments = await readInvoicePayments(db()).catch((error: unknown) => {
      console.error("invoices: payment intents not read", error instanceof Error ? error.message : error);
      return new Map<string, PaymentRecord>();
    });
    // The entries answer in one request, newest first: one cut at its limit may hold no entry for an older payable.
    const settlements = settlementsByBill({ payments: payments.values(), invoices: shown.filter((invoice) => invoice.direction === "payable"), entries, entriesComplete: !ledgerReadMayBeCut(entries), now: asOf });
    const decisions = shown.map((invoice) => invoiceDecision(invoice, counterpartiesById.get(invoice.counterparty_id), entries, { network, deciding, verdicts, settlements, asOf, allocations }));
    const payables = decisions.filter((decision) => decision.domain === "ap");
    const receivables = decisions.filter((decision) => decision.domain === "ar");
    const ordinaryPayables = payables.filter((decision) => decision.outcome !== "refused");
    // A paid payable with a transaction on chain offers its receipt to an owner or admin (payment receipts P6).
    const invoicesById = new Map(shown.map((invoice) => [invoice.id, invoice]));
    const shareable = canWrite
      ? new Set(ordinaryPayables.filter((decision) => {
          const invoice = invoicesById.get(decision.id);
          return invoice !== undefined && receiptShareable(invoice, decision);
        }).map((decision) => decision.id))
      : new Set<string>();
    const shared = await sharedReceipts([...shareable]);
    const receiptFor = (decision: ReturnType<typeof invoiceDecision>) =>
      shareable.has(decision.id) ? <ReceiptControl orgSlug={slug} invoiceId={decision.id} shared={shared.has(decision.id)} /> : undefined;
    // An open receivable in a live workspace offers a pay link for its client (receivables on Arc §2);
    // a sandbox has no real wallet to be paid into (R4).
    const payLinkable = new Set(
      canWrite && access.membership.mode === "live"
        ? shown.filter((invoice) => invoice.direction === "receivable" && (invoice.status === "pending" || invoice.status === "matched")).map((invoice) => invoice.id)
        : []
    );
    // Its link, kept so it can be copied again, and the agent's reminders to the client (collections R1, R2). Best effort.
    const linkStates = await payLinkStates([...payLinkable]).catch((error: unknown) => {
      console.error("invoices: pay links not read", error instanceof Error ? error.message : error);
      return new Map<string, PayLinkState>();
    });
    const dealContext = (decision: ReturnType<typeof invoiceDecision>) => {
      const link = dealLinks.get(decision.id);
      return link ? `Deal · ${link.title} · ${link.line}` : undefined;
    };
    const payLinkFor = (decision: ReturnType<typeof invoiceDecision>) => {
      const invoice = invoicesById.get(decision.id);
      if (!payLinkable.has(decision.id) || !invoice) return undefined;
      const client = counterpartiesById.get(invoice.counterparty_id);
      return (
        <PayLinkControl
          network={network}
          orgSlug={slug}
          invoiceId={decision.id}
          view={linkStates.get(decision.id) ?? null}
          dueDate={invoice.due_date}
          client={{ id: invoice.counterparty_id, name: invoice.counterparty_name, hasEmail: Boolean(client?.notice_email) }}
        />
      );
    };

    // A receivable's payments applied, above its pay link (allocations L11): what was received, what is owed, and Reverse.
    const appliedAndPayLink = (decision: ReturnType<typeof invoiceDecision>) => {
      const view = allocations.get(decision.id);
      const invoice = invoicesById.get(decision.id);
      const link = payLinkFor(decision);
      if (!view || view.lines.length === 0 || !invoice) return link;
      const lines = (
        <AllocationLines orgSlug={slug} network={network} view={view} label={receivableLabel({ memo: invoice.memo, dueDate: invoice.due_date })} canWrite={canWrite} />
      );
      return link ? (
        <div className="space-y-4">
          {lines}
          <div className="border-t border-line pt-4">{link}</div>
        </div>
      ) : (
        lines
      );
    };
    // A receivable made from a deal line opens its deal, above its payments applied and its pay link.
    const receivableFooter = (decision: ReturnType<typeof invoiceDecision>) => {
      const link = dealLinks.get(decision.id);
      const below = appliedAndPayLink(decision);
      if (!link) return below;
      return (
        <div className="space-y-3">
          <p className="flex flex-wrap items-center gap-x-2 text-[0.8125rem] text-ink-2">
            <Handshake aria-hidden className="size-4 text-agent" />
            <span>
              {link.line} of the deal {link.title}
              {link.index > 0 ? `, line ${link.index} of ${link.count}` : ""}.
            </span>
            <Button asChild variant="link" className="text-[0.8125rem]">
              <Link href={orgHref(slug, `/invoices/deals/${link.dealId}`)}>Open the deal</Link>
            </Button>
          </p>
          {below}
        </div>
      );
    };
    const owedNote = (decision: ReturnType<typeof invoiceDecision>): Pick<DecisionRowItem, "note"> => {
      const view = allocations.get(decision.id);
      if (!view || view.state !== "part_paid") return {};
      const money = (value: number) => `${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })} ${view.currency}`;
      return { note: `Part paid · ${money(view.outstanding)} still owed` };
    };

    // A payable waiting for a person: the purchase order and goods receipt on file, and what a person added since
    // the agent's decision. Its row says what it needs; its card lets an owner or admin add it, and opens it in
    // Approvals (complete held invoice).
    const waiting = new Map(
      shown
        .filter((invoice) => invoice.direction === "payable" && WAITING.has(invoice.status))
        .map((invoice) => {
          const onFile = {
            poReference: invoice.po_reference ?? null,
            goodsReceived: invoice.goods_received === true,
            // A counterparty paid without purchase orders is never asked for one (three-way match design M2).
            purchaseOrderRequired: counterpartiesById.get(invoice.counterparty_id)?.purchase_order_required !== false,
          };
          return [invoice.id, { onFile, added: addedSince(recordedFacts(latestDecision(entries, invoice.id)), onFile) }] as const;
        })
    );
    const needsYouFor = (decision: ReturnType<typeof invoiceDecision>) => {
      const invoice = invoicesById.get(decision.id);
      const facts = waiting.get(decision.id);
      if (!invoice || !facts) return receiptFor(decision);
      return (
        <WaitingPayableAction
          orgSlug={slug}
          invoice={{ id: invoice.id, counterpartyName: invoice.counterparty_name, counterpartyId: invoice.counterparty_id, ...facts.onFile }}
          added={facts.added}
          // A transfer recorded against it is approved in Approvals, never completed here (R3).
          canAddDetails={canWrite && invoice.tx_ref === null}
          canDecide={canDecide}
          rule={decision.guardrail?.rule ?? (decision.heldForCash ? CASH_SHORTFALL : decision.heldForVerdict ? SHADOW_VERDICT : null)}
          canFix={canWrite}
        />
      );
    };

    // The work, not the documents (Bills & receivables layout): what waits for a person, what is coming, what is settled.
    const today = new Date().toISOString().slice(0, 10);
    const inAWeek = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    // The verdict first: a payment held for it asks for nothing else; any other card keeps its own footer below it.
    const withVerdict =
      (footerFor?: (decision: ReturnType<typeof invoiceDecision>) => React.ReactNode) =>
      function verdictFirst(decision: ReturnType<typeof invoiceDecision>): React.ReactNode {
        const footer = footerFor?.(decision);
        if (!decision.verdict) return footer;
        const verdict = <VerdictControl orgSlug={slug} view={decision.verdict} />;
        if (decision.verdict.heldForVerdict && decision.verdict.open) return verdict;
        return footer ? (
          <div className="space-y-3">
            {verdict}
            {footer}
          </div>
        ) : (
          verdict
        );
      };
    const row = (
      decision: ReturnType<typeof invoiceDecision>,
      footerFor?: (decision: ReturnType<typeof invoiceDecision>) => React.ReactNode,
      extra: Pick<DecisionRowItem, "signals" | "why" | "note"> = {}
    ): DecisionRowItem => {
      const invoice = invoicesById.get(decision.id) as InvoiceRow;
      const facts = waiting.get(decision.id);
      const hint = facts ? waitingHint(facts.onFile, facts.added) : undefined;
      // A row that says what it needs says why already: the why line is for the rest.
      return { decision, date: rowDate(invoice, today), footerAction: footerFor?.(decision), hint, ...extra, why: hint ? undefined : extra.why };
    };
    const statusOf = (decision: ReturnType<typeof invoiceDecision>) => invoicesById.get(decision.id)?.status ?? "";
    const byDue = (a: ReturnType<typeof invoiceDecision>, b: ReturnType<typeof invoiceDecision>) => dueOf(invoicesById.get(a.id)).localeCompare(dueOf(invoicesById.get(b.id)));
    const latestFirst = (a: ReturnType<typeof invoiceDecision>, b: ReturnType<typeof invoiceDecision>) => b.at.localeCompare(a.at);
    const needsYou = payables.filter((decision) => decision.outcome === "refused" || WAITING.has(statusOf(decision))).sort(byDue);
    const upcoming = payables.filter((decision) => decision.outcome !== "refused" && OPEN.has(statusOf(decision)) && !WAITING.has(statusOf(decision))).sort(byDue);
    const settled = payables.filter((decision) => decision.outcome !== "refused" && !OPEN.has(statusOf(decision))).sort(latestFirst);
    const openReceivables = receivables.filter((decision) => ["pending", "matched"].includes(statusOf(decision))).sort(byDue);
    const settledReceivables = receivables.filter((decision) => !["pending", "matched"].includes(statusOf(decision))).sort(latestFirst);
    const showAllHistory = query.history === "all";

    // The tiles count every open payable, whatever the status filter shows.
    const openPayables = invoices.filter((invoice) => invoice.direction === "payable" && OPEN.has(invoice.status));
    const dueSoon = openPayables.filter((invoice) => invoice.due_date.slice(0, 10) >= today && invoice.due_date.slice(0, 10) <= inAWeek);
    const overdue = openPayables.filter((invoice) => invoice.due_date.slice(0, 10) < today);
    const waitingCount = openPayables.filter((invoice) => WAITING.has(invoice.status)).length;

    return (
      <ProductShell network={access.membership.network} day={dashboardStats.day} clockMode={dashboardStats.clockMode} lastCycleAt={dashboardStats.lastCycleAt} chainModes={shellModes()} status={await shellStatus()}>
        <PageHead
          title={sectionTitle("invoices")}
          sub="Your bills, what the agent decided on each, and why."
          right={<AgentControls orgSlug={slug} nextDay={dashboardStats.day + 1} headSeq={headEntries[0]?.seq ?? 0} clockMode={dashboardStats.clockMode} />}
        />
        {/* The agent decides within a minute of an event (an invoice added, a payable returned): the page
            re-reads its data every 20 s, and at once on return to the tab, so the decision appears without a reload. */}
        <AutoRefresh intervalMs={20_000} />

        {/* Search Bills & receivables by more than a name (I09): an address, so a search can be linked. */}
        <form method="get" role="search" aria-label="Search bills and receivables" className="mb-4 flex flex-wrap items-center gap-2">
          {filter && <input type="hidden" name="status" value={filter} />}
          <Input
            name="q"
            type="search"
            defaultValue={search?.text ?? ""}
            maxLength={100}
            aria-label="Search by invoice number, id, purchase order, counterparty, amount or transaction"
            placeholder="Invoice number, id, PO, counterparty, amount or transaction"
            className="min-w-0 flex-1 sm:max-w-md"
          />
          <Button type="submit" variant="secondary" icon={<Search />}>
            Search
          </Button>
        </form>
        {search && (
          <Callout icon={<Search />} className="mb-6">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>
                Showing what matches <span className="font-mono">{search.text}</span>: {shown.length} {plural(shown.length, "invoice", "invoices")}
                {toApply.length > 0 ? `, ${toApply.length} ${plural(toApply.length, "payment", "payments")} to apply` : ""}
              </span>
              <Button asChild variant="link" className="ml-auto">
                <Link href={orgHref(slug, filter ? `/invoices?status=${encodeURIComponent(filter)}` : "/invoices")}>Clear search</Link>
              </Button>
            </div>
          </Callout>
        )}

        {filter && (
          <Callout tone="held" icon={<ListFilter />} className="mb-6">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>
                Showing status: <span className="font-mono">{filter}</span>
              </span>
              <Button asChild variant="link" className="ml-auto">
                <Link href={orgHref(slug, "/invoices")}>Clear filter</Link>
              </Button>
            </div>
          </Callout>
        )}

        <div className="mb-6 grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 xl:grid-cols-4">
          <StatTile label="Needs you" tone={waitingCount > 0 ? "held" : "default"} href={orgHref(slug, "/approvals")} sub={waitingCount > 0 ? "Payables waiting for a person" : "Nothing waiting"}>
            <span className="tabular-nums">{waitingCount}</span>
          </StatTile>
          <StatTile label="Due within 7 days" sub={<Totals invoices={dueSoon} />}>
            <span className="tabular-nums">{dueSoon.length}</span>
          </StatTile>
          <StatTile label="Overdue" tone={overdue.length > 0 ? "held" : "default"} sub={overdue.length > 0 ? <Totals invoices={overdue} /> : "Nothing past its due date"}>
            <span className="tabular-nums">{overdue.length}</span>
          </StatTile>
          <StatTile label="Open payables" sub={`${openPayables.length} ${openPayables.length === 1 ? "invoice" : "invoices"} not yet paid`}>
            <Totals invoices={openPayables} />
          </StatTile>
        </div>

        <InboxEmails orgSlug={slug} emails={emailed} canAdd={canWrite} counterparties={counterparties.map(({ id, name, role }) => ({ id, name, role }))} />

        {fromXero.state === "list" && (
          <AccountingBillsReview
            provider="xero"
            orgSlug={slug}
            connectionId={fromXero.connectionId}
            organisation={fromXero.organisation}
            items={fromXero.items}
            closed={fromXero.closed}
            partlyPaidSince={fromXero.partlyPaid}
            canAdd={canWrite}
          />
        )}

        {fromQuickBooks.state === "list" && (
          <AccountingBillsReview
            provider="quickbooks"
            orgSlug={slug}
            connectionId={fromQuickBooks.connectionId}
            organisation={fromQuickBooks.organisation}
            items={fromQuickBooks.items}
            closed={fromQuickBooks.closed}
            partlyPaidSince={fromQuickBooks.partlyPaid}
            canAdd={canWrite}
          />
        )}

        {toBook.map((view) =>
          view.state === "list" ? (
            <AccountingBookings
              key={view.provider}
              provider={view.provider}
              orgSlug={slug}
              connectionId={view.connectionId}
              organisation={view.organisation}
              scopeMissing={view.scopeMissing}
              accountChosen={view.accountChosen}
              toReview={view.toReview}
              done={view.done}
              canBook={canBook}
            />
          ) : null
        )}

        {canWrite ? (
          // Folded until it is needed; open on a workspace with no invoice yet, where adding one is the next step.
          <IntakeFold label="New invoice" meta="typed in, read from a document, imported from a list, or recurring" defaultOpen={invoices.length === 0 || query.add !== undefined}>
            <Tabs defaultValue="manual">
              <TabsList aria-label="New invoice">
                <TabsTrigger value="manual">
                  <PenLine aria-hidden />
                  Enter one invoice
                </TabsTrigger>
                <TabsTrigger value="document">
                  <FileText aria-hidden />
                  From a document
                </TabsTrigger>
                <TabsTrigger value="list">
                  <FileSpreadsheet aria-hidden />
                  Import a list
                </TabsTrigger>
                <TabsTrigger value="recurring">
                  <Repeat aria-hidden />
                  Recurring
                </TabsTrigger>
              </TabsList>
              {/* Both stay mounted, so switching tabs never loses what was typed. */}
              <TabsContent value="manual" forceMount className="data-[state=inactive]:hidden">
                <InvoiceIntake orgSlug={slug} counterparties={counterparties.map(({ id, name, role }) => ({ id, name, role }))} billCurrency={billCurrencyOf(verdicts.shadow)} />
              </TabsContent>
              <TabsContent value="document" forceMount className="data-[state=inactive]:hidden">
                <InvoiceDocumentIntake orgSlug={slug} counterparties={counterparties.map(({ id, name, role }) => ({ id, name, role }))} />
              </TabsContent>
              <TabsContent value="list" forceMount className="data-[state=inactive]:hidden">
                <BillImport
                  orgSlug={slug}
                  workspace={{ shadowOn: verdicts.shadow !== null, shadowCurrency: billCurrencyOf(verdicts.shadow) ?? null, network }}
                />
              </TabsContent>
              <TabsContent value="recurring" forceMount className="data-[state=inactive]:hidden">
                <RecurringPayableIntake orgSlug={slug} counterparties={counterparties.map(({ id, name, role }) => ({ id, name, role }))} />
              </TabsContent>
            </Tabs>
          </IntakeFold>
        ) : (
          <Callout className="mb-8">Only an owner or admin of this workspace can add or import invoices.</Callout>
        )}

        <div className="space-y-10">
          {/* The plan covers every open bill, so it is shown over the whole list, not over a status filter. */}
          {!filter && (
            <PaymentPlanSection plan={paymentPlan} outcomes={paymentOutcomes} orgSlug={slug} canDecide={canDecide} viewerId={access.user.id} soleApprover={soleApprover} />
          )}

          <section>
            <SectionHeader title="Payables" meta={`${payables.length} ${plural(payables.length, "invoice", "invoices")} · open any to see why the agent decided as it did`} />
            {payables.length === 0 ? (
              <EmptyState compact title="No payables here" body="There are no records in this view." />
            ) : (
              <>
                {needsYou.length > 0 && (
                  <>
                    <RowGroupHeading
                      title="Needs you"
                      count={needsYou.length}
                      action={
                        <Button asChild variant="link" className="text-[0.8125rem]">
                          <Link href={orgHref(slug, "/approvals")}>Decide in Approvals</Link>
                        </Button>
                      }
                    />
                    {/* Closed, so many fit: each says what the agent checked and why it waits; opening it shows the card and its actions. */}
                    <DecisionRows
                      orgSlug={slug}
                      items={needsYou.map((decision) => row(decision, withVerdict(needsYouFor), { signals: payableSignals(decision), why: stoppedWhy(decision) }))}
                    />
                  </>
                )}
                {upcoming.length > 0 && (
                  <>
                    <RowGroupHeading title="Upcoming" count={upcoming.length} />
                    <DecisionRows orgSlug={slug} items={upcoming.map((decision) => row(decision, withVerdict(receiptFor), { signals: payableSignals(decision) }))} />
                  </>
                )}
                {settled.length > 0 && (
                  <>
                    <RowGroupHeading
                      title="Paid and closed"
                      count={settled.length}
                      action={
                        settled.length > HISTORY_SHOWN ? (
                          <Button asChild variant="link" className="text-[0.8125rem]">
                            <Link href={orgHref(slug, showAllHistory ? "/invoices" : "/invoices?history=all")} scroll={false}>
                              {showAllHistory ? `Show the latest ${HISTORY_SHOWN}` : `Show all ${settled.length}`}
                            </Link>
                          </Button>
                        ) : undefined
                      }
                    />
                    <DecisionRows orgSlug={slug} items={(showAllHistory ? settled : settled.slice(0, HISTORY_SHOWN)).map((decision) => row(decision, withVerdict(receiptFor)))} />
                  </>
                )}
              </>
            )}
          </section>

          {schedules.length > 0 && <RecurringSummary schedules={schedules} orgSlug={slug} canWrite={canWrite} />}

          <section>
            <SectionHeader title="Receivables" meta={`${receivables.length} ${plural(receivables.length, "invoice", "invoices")}`} />
            {/* Before migration 0103 runs, receivables show as before, and say applying payments waits for it (allocations L11). */}
            {book && !book.available && receivables.length > 0 && <p className="mb-3 text-xs text-ink-3">Applying payments is not set up on this deployment yet.</p>}
            {toApply.length > 0 && receivables.length > 0 && <ApplyPayments orgSlug={slug} network={network} payments={toApply} canWrite={canWrite} />}
            {receivables.length === 0 ? (
              <EmptyState compact title="No receivables here" body="There are no records in this view." />
            ) : (
              <>
                {openReceivables.length > 0 && (
                  <>
                    <RowGroupHeading title="Open" count={openReceivables.length} />
                    <DecisionRows orgSlug={slug} items={openReceivables.map((decision) => ({ ...row(decision, receivableFooter, owedNote(decision)), context: dealContext(decision) }))} />
                  </>
                )}
                {settledReceivables.length > 0 && (
                  <>
                    <RowGroupHeading title="Received and closed" count={settledReceivables.length} />
                    <DecisionRows
                      orgSlug={slug}
                      items={settledReceivables.slice(0, showAllHistory ? undefined : HISTORY_SHOWN).map((decision) => ({ ...row(decision, receivableFooter), context: dealContext(decision) }))}
                    />
                  </>
                )}
              </>
            )}
          </section>

          <DealsSection
            deals={deals}
            orgSlug={slug}
            today={today}
            fromCrm={
              fromHubSpot.state === "list" ? (
                <>
                  {planFromHubSpot && (
                    <div id="plan-from-hubspot" className="scroll-mt-6">
                      {planFromHubSpot.ok ? (
                        <IntakeFold label={`Plan collections: ${planFromHubSpot.name}`} meta={`from ${planFromHubSpot.label}: pick how it is billed, check the rest, and confirm`} defaultOpen>
                          <DealForm
                            orgSlug={slug}
                            customers={customers}
                            currencies={dealCurrencies.includes(planFromHubSpot.prefill.currency) ? dealCurrencies : [...dealCurrencies, planFromHubSpot.prefill.currency]}
                            idempotencyKey={randomUUID()}
                            today={today}
                            prefill={{ crmRowId: planFromHubSpot.rowId, label: planFromHubSpot.label, ...planFromHubSpot.prefill }}
                          />
                        </IntakeFold>
                      ) : (
                        <Callout tone="held" className="mb-6">
                          {planFromHubSpot.message}
                        </Callout>
                      )}
                    </div>
                  )}
                  <HubSpotDeals orgSlug={slug} organisation={fromHubSpot.organisation} won={fromHubSpot.won} open={fromHubSpot.open} emails={fromHubSpot.emails} canWrite={canWrite} />
                </>
              ) : undefined
            }
            newDeal={
              canWrite && Array.isArray(deals) ? (
                <IntakeFold label="New deal" meta="a signed deal and its collection schedule: a deposit, milestones, a retainer or your own lines" defaultOpen={deals.length === 0 && query.add === "deal"}>
                  <DealForm
                    orgSlug={slug}
                    customers={customers}
                    currencies={dealCurrencies}
                    idempotencyKey={randomUUID()}
                    today={today}
                  />
                </IntakeFold>
              ) : undefined
            }
          />
        </div>
      </ProductShell>
    );
  });
}

/** The date a row leads with: the day it is scheduled for, its due date (marked once past), or when it was paid. */
function rowDate(invoice: InvoiceRow | undefined, today: string): DecisionRowItem["date"] {
  if (!invoice) return null;
  if (invoice.status === "scheduled" && invoice.scheduled_for) return { label: `Pays ${utcDay(`${invoice.scheduled_for.slice(0, 10)}T00:00:00Z`)}` };
  if (!OPEN.has(invoice.status)) return { label: `Due ${utcDay(`${invoice.due_date.slice(0, 10)}T00:00:00Z`)}` };
  const due = invoice.due_date.slice(0, 10);
  return due < today ? { label: `Overdue ${utcDay(`${due}T00:00:00Z`)}`, tone: "held" } : { label: `Due ${utcDay(`${due}T00:00:00Z`)}` };
}

/** Sorts by the day that matters: the scheduled day, else the due date. */
function dueOf(invoice: InvoiceRow | undefined): string {
  if (!invoice) return "";
  return (invoice.status === "scheduled" && invoice.scheduled_for ? invoice.scheduled_for : invoice.due_date).slice(0, 10);
}

/** The total of some invoices, in USDC, with any EURC beside it: the two are never added together. */
function Totals({ invoices }: { invoices: InvoiceRow[] }) {
  const usdc = invoices.filter((invoice) => (invoice.currency ?? "USDC") === "USDC").reduce((sum, invoice) => sum + Number(invoice.amount), 0);
  const eurc = invoices.filter((invoice) => invoice.currency === "EURC").reduce((sum, invoice) => sum + Number(invoice.amount), 0);
  return (
    <>
      <Money value={usdc} />
      {eurc > 0 && (
        <>
          {" "}
          + <Money value={eurc} token="EURC" />
        </>
      )}
    </>
  );
}
