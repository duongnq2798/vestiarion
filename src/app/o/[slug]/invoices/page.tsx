import { randomUUID } from "node:crypto";
import { Handshake } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { AutoRefresh } from "@/components/AutoRefresh";
import InboxEmails from "@/components/InboxEmails";
import { AccountingBillsReview } from "@/components/AccountingBillsReview";
import { AccountingBookings } from "@/components/AccountingBookings";
import AgentControls from "@/components/AgentControls";
import { AllocationLines } from "@/components/AllocationLines";
import { ApplyPayments } from "@/components/ApplyPayments";
import { BillsScreen } from "@/components/bills/BillsScreen";
import type { PanelContent } from "@/components/bills/BillsPanels";
import type { WaitingItem } from "@/components/bills/BillsSummary";
import { billRowItem, countBills, countReceivables, homeOf, JUST_ADDED_MS, listData, listRowOf as rowOf, summaryData, viewHref } from "@/components/bills/build";
import { NewMenu } from "@/components/bills/NewMenu";
import type { BillRowItem, ListData } from "@/components/bills/types";
import { PayLinkControl } from "@/components/PayLinkControl";
import { ReceiptControl } from "@/components/ReceiptControl";
import VerdictControl from "@/components/VerdictControl";
import { WaitingPayableAction } from "@/components/WaitingPayableAction";
import { Callout } from "@/components/ui/Callout";
import { DecisionCard } from "@/components/vx/DecisionCard";
import { IntakeFold } from "@/components/vx/IntakeFold";
import { invoiceDecision } from "@/components/vx/map";
import { RecurringSummary } from "@/components/vx/RecurringSummary";
import { PaymentPlanSection } from "@/components/vx/PaymentPlan";
import { Button } from "@/components/ui/Button";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { sectionTitle } from "@/components/vx/nav";
import type { Decision } from "@/components/vx/types";
import { addedSince, latestDecision, recordedFacts } from "@/lib/added-details";
import { readAllocationBook, stillOwed, toReceivableIn } from "@/lib/allocations/book";
import { toMicros, type PaymentIn } from "@/lib/allocations/model";
import { receivableLabel } from "@/lib/allocations/suggest";
import { applyPaymentsView, paymentsByReceivable, receivableViews, type ReceivableView } from "@/lib/allocations/view";
import {
  billFilterMatches,
  billsHref,
  PAGE_SIZE,
  pageOf,
  readBillsQuery,
  receivableFilterMatches,
  resolveBillsView,
  sortRows,
  WAITING_STATUSES,
  type BillFilter,
  type BillsView,
  type ListRow,
  type Page,
  type ReceivableFilter,
  type ReviewPanel,
} from "@/lib/bills-view";
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
import { plural } from "@/lib/copy";
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
import { crmPlanState } from "@/components/deals/crm-plan";
import { PlanFromCrmForm, PlannedFromCrm } from "@/components/deals/PlannedFromCrm";
import { HubSpotDeals } from "@/components/HubSpotDeals";
import { crmPrefillFor, crmReady, crmReview, type CrmPrefillRead, type CrmReviewView } from "@/lib/connectors/crm-review";
import { dealLinksOf, plannedLinesOf, readDeals, type DealLink } from "@/lib/deals/read";
import { hubspotSettingsFromEnv } from "@/lib/hubspot/settings";

export const dynamic = "force-dynamic";

/** An imported list of up to 200 bills is added one bill at a time, each with its signed entry (import design B12). */
export const maxDuration = 300;

export const metadata: Metadata = { title: sectionTitle("invoices") };

type InvoicePageProps = {
  params: Promise<{ slug: string }>;
  /**
   * The view (docs/superpowers/specs/2026-10-12-bills-tabs-design.md B3, B4): `tab`, `filter`, `q` (a search by id, invoice
   * number, purchase order, counterparty, amount or a payment's reference, I09), `sort`, `page`, `open` (a bill's
   * detail), `review` (a review list over the page), `new` and the palette's `add` (a New form), `hubspot` (a HubSpot
   * deal to plan, H11); and, from before the tabs, `history=all` and `status`, read by `readBillsQuery`.
   */
  searchParams: Promise<Record<string, string | string[] | undefined>>;
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
    const raw = await searchParams;
    const query = readBillsQuery(raw);
    // Every tab: what the figures, the strip and the New forms need (B5).
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
    const search = parseSearch(query.q ?? undefined);
    // The payments applied to receivables (allocations L11). Best effort: a read that fails shows receivables as before.
    const book = await readAllocationBook(db()).catch((error: unknown) => {
      console.error("invoices: payments applied not read", error instanceof Error ? error.message : error);
      return null;
    });
    const receivablesIn = invoices.filter((invoice) => invoice.direction === "receivable").map(toReceivableIn);
    const allocations = book ? receivableViews(book, receivablesIn) : new Map<string, ReceivableView>();
    const appliedPayments = book ? paymentsByReceivable(book) : new Map<string, PaymentIn[]>();
    // One read of the entries about every invoice, as before: Needs you counts the bills code refused, which only the
    // entries say, and the cards' verdicts come from them.
    const entries = await listLedgerEntriesForTargets({ invoiceIds: invoices.map((invoice) => invoice.id) });
    // In shadow mode, each card carries a person's verdict on the agent's decision, given or to give (shadow mode S3).
    const verdicts = await verdictFacts(db(), entries, canDecide);
    const counterpartiesById = new Map(counterparties.map((counterparty) => [counterparty.id, counterparty]));
    const invoicesById = new Map(invoices.map((invoice) => [invoice.id, invoice]));
    const asOf = Date.now();
    const today = new Date(asOf).toISOString().slice(0, 10);
    const inAWeek = new Date(asOf + 7 * 86_400_000).toISOString().slice(0, 10);

    // Every invoice's decision, without its payment's track: what the filters, counts and rows read. The rows shown get
    // their track below, from the payments read for them alone.
    const decided = new Map(invoices.map((invoice) => [invoice.id, invoiceDecision(invoice, counterpartiesById.get(invoice.counterparty_id), entries, { network, deciding, verdicts, asOf, allocations })]));
    const listRowOf = (invoice: InvoiceRow): ListRow => rowOf(invoice, decided.get(invoice.id) as Decision);
    // A search keeps what it finds (I09): by id, invoice number, purchase order, counterparty, amount or a payment applied.
    const matches = (invoice: InvoiceRow) => {
      if (!search) return true;
      const owed = allocations.get(invoice.id);
      return invoiceMatch(search, invoice, { outstanding: owed ? toMicros(owed.outstanding) : undefined, payments: appliedPayments.get(invoice.id) }) !== null;
    };
    const payableRows = invoices.filter((invoice) => invoice.direction === "payable").map(listRowOf);
    const receivableRows = invoices.filter((invoice) => invoice.direction === "receivable").map(listRowOf);
    const foundPayables = search ? payableRows.filter((row) => matches(invoicesById.get(row.id) as InvoiceRow)) : payableRows;
    const foundReceivables = search ? receivableRows.filter((row) => matches(invoicesById.get(row.id) as InvoiceRow)) : receivableRows;
    // Money received on Arc not applied in full, with suggestions; a search keeps the payments it finds.
    const toApply = book?.available ? applyPaymentsView(book, receivablesIn, counterparties.map(({ id, name, address }) => ({ id, name, address })), { query: search }) : [];

    const billCounts = countBills(foundPayables, today, inAWeek);
    const receivableCounts = countReceivables(foundReceivables, today);
    const view: BillsView = resolveBillsView(query, {
      directionOf: (id) => {
        const direction = invoicesById.get(id)?.direction;
        return direction === "payable" || direction === "receivable" ? direction : null;
      },
      homeOf: (id) => {
        const invoice = invoicesById.get(id);
        return invoice ? homeOf(invoice, listRowOf(invoice), today, inAWeek) : null;
      },
      billCounts,
      receivableCounts,
      searchHits: { payables: foundPayables.length, receivables: foundReceivables.length + toApply.length },
    });

    // The list the tab shows: its filter, its order, and the page holding an open bill when no page was asked.
    const listed: ListRow[] =
      view.tab === "bills"
        ? sortRows(foundPayables.filter((row) => billFilterMatches(view.filter as BillFilter, row, today, inAWeek)), view.sort)
        : view.tab === "receivables"
          ? sortRows(foundReceivables.filter((row) => receivableFilterMatches(view.filter as ReceivableFilter, row, today)), view.sort)
          : [];
    const openAt = view.open && raw.page === undefined ? listed.findIndex((row) => row.id === view.open) : -1;
    const page = pageOf(listed, openAt >= 0 ? Math.floor(openAt / PAGE_SIZE) + 1 : view.page);
    // The cards opened from here: the rows on the page, and a bill the address opens wherever it is.
    const detailIds = [...new Set([...page.rows.map((row) => row.id), ...(view.open ? [view.open] : [])])];
    const detailInvoices = detailIds.map((id) => invoicesById.get(id)).filter((invoice): invoice is InvoiceRow => invoice !== undefined);

    // Where each payable shown is in its payment, from its payment intent, the entries about it and the bill (settlement
    // lifecycle L7, L8). Read only with a payable to show. Best effort: a read that fails is logged and the cards show no track.
    const payments = detailInvoices.some((invoice) => invoice.direction === "payable")
      ? await readInvoicePayments(db()).catch((error: unknown) => {
          console.error("invoices: payment intents not read", error instanceof Error ? error.message : error);
          return new Map<string, PaymentRecord>();
        })
      : new Map<string, PaymentRecord>();
    // The entries answer in one request, newest first: one cut at its limit may hold no entry for an older payable.
    const settlements = settlementsByBill({ payments: payments.values(), invoices: detailInvoices.filter((invoice) => invoice.direction === "payable"), entries, entriesComplete: !ledgerReadMayBeCut(entries), now: asOf });
    const decisionOf = (invoice: InvoiceRow) => invoiceDecision(invoice, counterpartiesById.get(invoice.counterparty_id), entries, { network, deciding, verdicts, settlements, asOf, allocations });
    const shownDecisions = new Map(detailInvoices.map((invoice) => [invoice.id, decisionOf(invoice)]));

    // A paid payable with a transaction on chain offers its receipt to an owner or admin (payment receipts P6).
    const shareable = canWrite
      ? new Set(
          detailInvoices
            .filter((invoice) => invoice.direction === "payable" && receiptShareable(invoice, shownDecisions.get(invoice.id) as Decision))
            .map((invoice) => invoice.id)
        )
      : new Set<string>();
    const shared = await sharedReceipts([...shareable]);
    const receiptFor = (decision: Decision) => (shareable.has(decision.id) ? <ReceiptControl orgSlug={slug} invoiceId={decision.id} shared={shared.has(decision.id)} /> : undefined);
    // An open receivable in a live workspace offers a pay link for its client (receivables on Arc §2);
    // a sandbox has no real wallet to be paid into (R4).
    const payLinkable = new Set(
      canWrite && access.membership.mode === "live"
        ? detailInvoices.filter((invoice) => invoice.direction === "receivable" && (invoice.status === "pending" || invoice.status === "matched")).map((invoice) => invoice.id)
        : []
    );
    // Its link, kept so it can be copied again, and the agent's reminders to the client (collections R1, R2). Best effort.
    const linkStates = await payLinkStates([...payLinkable]).catch((error: unknown) => {
      console.error("invoices: pay links not read", error instanceof Error ? error.message : error);
      return new Map<string, PayLinkState>();
    });
    const dealContext = (decision: Decision) => {
      const link = dealLinks.get(decision.id);
      return link ? `Deal · ${link.title} · ${link.line}` : undefined;
    };
    const payLinkFor = (decision: Decision) => {
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
    const appliedAndPayLink = (decision: Decision) => {
      const allocation = allocations.get(decision.id);
      const invoice = invoicesById.get(decision.id);
      const link = payLinkFor(decision);
      if (!allocation || allocation.lines.length === 0 || !invoice) return link;
      const lines = (
        <AllocationLines orgSlug={slug} network={network} view={allocation} label={receivableLabel({ memo: invoice.memo, dueDate: invoice.due_date })} canWrite={canWrite} />
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
    const receivableFooter = (decision: Decision) => {
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
    const owedNote = (decision: Decision): string | null => {
      const allocation = allocations.get(decision.id);
      if (!allocation || allocation.state !== "part_paid") return null;
      const money = (value: number) => `${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })} ${allocation.currency}`;
      return `Part paid · ${money(allocation.outstanding)} still owed`;
    };

    // A payable waiting for a person: the purchase order and goods receipt on file, and what a person added since
    // the agent's decision. Its row says what it needs; its card lets an owner or admin add it, and opens it in
    // Approvals (complete held invoice).
    const waiting = new Map(
      invoices
        .filter((invoice) => invoice.direction === "payable" && WAITING_STATUSES.has(invoice.status))
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
    const ruleOf = (decision: Decision) => decision.guardrail?.rule ?? (decision.heldForCash ? CASH_SHORTFALL : decision.heldForVerdict ? SHADOW_VERDICT : null);
    const needsYouFor = (decision: Decision) => {
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
          rule={ruleOf(decision)}
          canFix={canWrite}
        />
      );
    };
    // The verdict first: a payment held for it asks for nothing else; any other card keeps its own footer below it.
    const withVerdict =
      (footerFor?: (decision: Decision) => ReactNode) =>
      function verdictFirst(decision: Decision): ReactNode {
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
    // A payable's card keeps the footer it always had: its verdict, then what a waiting bill needs or its receipt.
    const payableFooter = withVerdict(needsYouFor);

    // Each card shown, in the detail panel (B7): the decision card, with its footer, as it always was.
    const details: Record<string, PanelContent> = Object.fromEntries(
      detailInvoices.map((invoice) => {
        const decision = shownDecisions.get(invoice.id) as Decision;
        const footer = invoice.direction === "payable" ? payableFooter(decision) : receivableFooter(decision);
        return [invoice.id, { title: `${decision.action} ${decision.subject}`, node: <DecisionCard decision={decision} orgSlug={slug} footerAction={footer} /> }];
      })
    );

    const sortAsked = query.sort;
    const slugHref = (path: string) => orgHref(slug, path);
    const here = viewHref(slugHref, view, sortAsked);
    const pageItems: Page<BillRowItem> = {
      ...page,
      rows: page.rows.map((row) => {
        const invoice = invoicesById.get(row.id) as InvoiceRow;
        const decision = shownDecisions.get(row.id) as Decision;
        return billRowItem({
          invoice,
          decision,
          row,
          today,
          inAWeek,
          waiting: waiting.get(row.id),
          rule: ruleOf(decision),
          canWrite: canWrite && invoice.tx_ref === null,
          canDecide,
          owedNote: owedNote(decision),
          dealContext: dealContext(decision),
          link: linkStates.get(row.id),
          justAdded: view.sort === "added" && Boolean(invoice.created_at) && asOf - Date.parse(invoice.created_at as string) < JUST_ADDED_MS,
          href: here({ open: row.id }),
        });
      }),
    };
    const listOf = (tab: "bills" | "receivables"): ListData =>
      listData({
        tab,
        view,
        sortAsked,
        page: pageItems,
        counts: tab === "bills" ? billCounts : receivableCounts,
        slugHref,
        canWrite,
        totals: { payables: payableRows.length, receivables: receivableRows.length },
        otherMatches: tab === "bills" ? foundReceivables.length : foundPayables.length,
      });

    // The figures above the tabs count every bill and receivable, whatever the tab, filter or search shows (B10).
    const summary = summaryData({ payableRows, receivableRows, invoicesById, today, inAWeek, owedOf: (invoice) => stillOwed(invoice, book?.rows ?? []), slugHref });

    // What waits for a person to review, each opening its existing review (B11).
    const waitingItems: WaitingItem[] = [];
    const reviews: Partial<Record<ReviewPanel, PanelContent>> = {};
    for (const [provider, review] of [
      ["xero", fromXero],
      ["quickbooks", fromQuickBooks],
    ] as const) {
      if (review.state !== "list") continue;
      const changed = review.closed.length + review.partlyPaid.length;
      if (review.items.length === 0 && changed === 0) continue;
      const label = PROVIDER_LABELS[provider];
      waitingItems.push({ key: provider, review: provider, label: review.items.length > 0 ? `${review.items.length} from ${label}` : `${changed} changed in ${label}` });
      reviews[provider] = {
        title: `From ${label}`,
        node: (
          <AccountingBillsReview
            provider={provider}
            orgSlug={slug}
            connectionId={review.connectionId}
            organisation={review.organisation}
            items={review.items}
            closed={review.closed}
            partlyPaidSince={review.partlyPaid}
            canAdd={canWrite}
          />
        ),
      };
    }
    for (const booking of toBook) {
      if (booking.state !== "list" || (booking.toReview.length === 0 && booking.done.length === 0)) continue;
      const key = `book-${booking.provider}` as ReviewPanel;
      if (booking.toReview.length > 0) waitingItems.push({ key, review: key, label: `${booking.toReview.length} to book in ${PROVIDER_LABELS[booking.provider]}` });
      reviews[key] = {
        title: `To book in ${PROVIDER_LABELS[booking.provider]}`,
        node: (
          <AccountingBookings
            provider={booking.provider}
            orgSlug={slug}
            connectionId={booking.connectionId}
            organisation={booking.organisation}
            scopeMissing={booking.scopeMissing}
            accountChosen={booking.accountChosen}
            toReview={booking.toReview}
            done={booking.done}
            canBook={canBook}
          />
        ),
      };
    }
    if (emailed.length > 0) {
      waitingItems.push({ key: "email", review: "email", label: `${emailed.length} by email` });
      reviews.email = {
        title: "From email",
        node: <InboxEmails orgSlug={slug} emails={emailed} canAdd={canWrite} counterparties={counterparties.map(({ id, name, role }) => ({ id, name, role }))} />,
      };
    }
    if (fromHubSpot.state === "list") {
      const toPlan = fromHubSpot.won.filter((row) => row.linkedDeal === null && row.plan.ok).length;
      const changed = fromHubSpot.won.filter((row) => row.changes.length > 0).length;
      const href = orgHref(slug, `${billsHref({ tab: "receivables" })}#from-hubspot`);
      if (toPlan > 0) waitingItems.push({ key: "hubspot", href, label: `${toPlan} won ${plural(toPlan, "deal", "deals")} in HubSpot` });
      else if (changed > 0) waitingItems.push({ key: "hubspot", href, label: `${changed} changed in HubSpot` });
    }

    // The customers, as the New deal form offers them; and the currencies a deal may be in.
    const customers = counterparties
      .filter((counterparty) => counterparty.role === "client")
      .map(({ id, name }) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const dealCurrencies = ["USDC", "EURC", ...(billCurrencyOf(verdicts.shadow) ? [billCurrencyOf(verdicts.shadow) as string] : [])];

    // The tab shown, and only it, is read and built (B5).
    let tabContent: Pick<Parameters<typeof BillsScreen>[0], "bills" | "plan" | "receivables"> = {};
    if (view.tab === "bills") {
      tabContent = {
        bills: { list: listOf("bills"), below: schedules.length > 0 ? <RecurringSummary schedules={schedules} orgSlug={slug} canWrite={canWrite} /> : undefined },
      };
    } else if (view.tab === "plan") {
      // The next 14 days of payments, in the order the cash allows (payment plan design P1), from the invoices and
      // counterparties read above, over every open bill. Best effort: a plan that cannot be read says so, and nothing else changes.
      const paymentPlan = await readPaymentPlan({
        invoices,
        counterparties,
        // Deal lines not invoiced yet, listed apart from the plan's balances (deal schedule D14).
        planned: Array.isArray(deals) ? plannedLinesOf(deals) : deals === "not_ready" ? [] : null,
        // A part-paid receivable, a released deal line among them, is expected for what is still owed (allocations L11).
        owed: new Map(invoices.filter((invoice) => invoice.direction === "receivable").map((invoice) => [invoice.id, stillOwed(invoice, book?.rows ?? [])] as const)),
      }).catch((error: unknown) => {
        console.error("invoices: payment plan not read", error instanceof Error ? error.message : error);
        return null;
      });
      const paymentOutcomes = planOutcomes({ now: asOf, invoices, entries });
      // Whoever entered a bill approves its day only as the workspace's only approver (payment plan P10); asked only then.
      const soleApprover =
        canDecide && paymentPlan?.lines.some((line) => line.move !== null && line.createdBy === access.user.id) ? await isSoleApprover(access.user.id) : false;
      tabContent = {
        plan: <PaymentPlanSection plan={paymentPlan} outcomes={paymentOutcomes} orgSlug={slug} canDecide={canDecide} viewerId={access.user.id} soleApprover={soleApprover} />,
      };
    } else {
      // A HubSpot deal picked to plan: the New deal form filled in from it (HubSpot connector H11). Read again on confirm.
      // One planned already, right after its Plan collections or from an old link, shows the deal it became instead.
      const crmPlan = fromHubSpot.state === "list" ? crmPlanState(view.hubspot, fromHubSpot.won) : null;
      const planFromHubSpot: CrmPrefillRead | null =
        crmPlan?.kind === "form" && canWrite && Array.isArray(deals)
          ? await crmPrefillFor({ rowId: crmPlan.rowId, customers, workspace: { shadowOn: verdicts.shadow !== null }, today }).catch((error: unknown): CrmPrefillRead => {
              console.error("invoices: a HubSpot deal was not read to plan", error instanceof Error ? error.message : error);
              return { ok: false, message: "That deal could not be read. Reload the page in a moment." };
            })
          : null;
      tabContent = {
        receivables: {
          list: listOf("receivables"),
          above: (
            <>
              {/* Before migration 0103 runs, receivables show as before, and say applying payments waits for it (allocations L11). */}
              {book && !book.available && receivableRows.length > 0 && <p className="text-xs text-ink-3">Applying payments is not set up on this deployment yet.</p>}
              {toApply.length > 0 && receivableRows.length > 0 && <ApplyPayments orgSlug={slug} network={network} payments={toApply} canWrite={canWrite} />}
            </>
          ),
          below: (
            <div className="pt-6">
              <DealsSection
                deals={deals}
                orgSlug={slug}
                today={today}
                fromCrm={
                  fromHubSpot.state === "list" ? (
                    <>
                      {crmPlan?.kind === "planned" && (
                        <div id="plan-from-hubspot" className="scroll-mt-6">
                          <PlannedFromCrm rowId={crmPlan.rowId} title={crmPlan.title} cancelled={crmPlan.cancelled} dealHref={orgHref(slug, `/invoices/deals/${crmPlan.dealId}`)} />
                        </div>
                      )}
                      {planFromHubSpot && (
                        <div id="plan-from-hubspot" className="scroll-mt-6">
                          {planFromHubSpot.ok ? (
                            <IntakeFold label={`Plan collections: ${planFromHubSpot.name}`} meta={`from ${planFromHubSpot.label}: pick how it is billed, check the rest, and confirm`} defaultOpen>
                              <PlanFromCrmForm rowId={planFromHubSpot.rowId}>
                                <DealForm
                                  orgSlug={slug}
                                  customers={customers}
                                  currencies={dealCurrencies.includes(planFromHubSpot.prefill.currency) ? dealCurrencies : [...dealCurrencies, planFromHubSpot.prefill.currency]}
                                  idempotencyKey={randomUUID()}
                                  today={today}
                                  prefill={{ crmRowId: planFromHubSpot.rowId, label: planFromHubSpot.label, ...planFromHubSpot.prefill }}
                                />
                              </PlanFromCrmForm>
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
              />
            </div>
          ),
        },
      };
    }

    const needsYouCount = summary.needsYou.count;
    return (
      <ProductShell network={access.membership.network} day={dashboardStats.day} clockMode={dashboardStats.clockMode} lastCycleAt={dashboardStats.lastCycleAt} chainModes={shellModes()} status={await shellStatus()}>
        <PageHead
          title={sectionTitle("invoices")}
          sub="Your bills, what the agent decided on each, and why."
          right={
            <AgentControls
              orgSlug={slug}
              nextDay={dashboardStats.day + 1}
              headSeq={headEntries[0]?.seq ?? 0}
              clockMode={dashboardStats.clockMode}
              leading={
                canWrite ? (
                  // New ▾: every way to add something, each the form it always was (B13).
                  <NewMenu
                    orgSlug={slug}
                    counterparties={counterparties.map(({ id, name, role }) => ({ id, name, role }))}
                    billCurrency={billCurrencyOf(verdicts.shadow)}
                    importWorkspace={{ shadowOn: verdicts.shadow !== null, shadowCurrency: billCurrencyOf(verdicts.shadow) ?? null, network }}
                    deal={Array.isArray(deals) ? { customers, currencies: dealCurrencies, idempotencyKey: randomUUID(), today } : null}
                  />
                ) : (
                  <p className="max-w-56 text-xs text-ink-3">Only an owner or admin of this workspace can add or import invoices.</p>
                )
              }
            />
          }
        />
        {/* The agent decides within a minute of an event (an invoice added, a payable returned): the page
            re-reads its data every 20 s, and at once on return to the tab, so the decision appears without a reload. */}
        <AutoRefresh intervalMs={20_000} />

        <BillsScreen
          slugHref={slugHref}
          tab={view.tab}
          tabs={[
            { key: "bills", label: "Bills", href: orgHref(slug, billsHref({ tab: "bills" })), count: needsYouCount },
            { key: "plan", label: "Payment plan", href: orgHref(slug, billsHref({ tab: "plan" })) },
            { key: "receivables", label: "Receivables", href: orgHref(slug, billsHref({ tab: "receivables" })) },
          ]}
          summary={summary}
          waiting={waitingItems}
          reviews={reviews}
          details={details}
          {...tabContent}
        />
      </ProductShell>
    );
  });
}
