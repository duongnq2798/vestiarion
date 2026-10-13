import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccountingBillsReview } from "@/components/AccountingBillsReview";
import { AccountingBookings } from "@/components/AccountingBookings";
import { HubSpotDeals } from "@/components/HubSpotDeals";
import { WaitingPayableAction } from "@/components/WaitingPayableAction";
import { BillsScreen } from "@/components/bills/BillsScreen";
import type { PanelContent } from "@/components/bills/BillsPanels";
import type { WaitingItem } from "@/components/bills/BillsSummary";
import { billRowItem, countBills, countReceivables, homeOf, listData, listRowOf, summaryData, viewHref } from "@/components/bills/build";
import { NewMenu } from "@/components/bills/NewMenu";
import { DealsSection } from "@/components/deals/DealsSection";
import { FromCustomers } from "@/components/portal/FromCustomers";
import { StatementLinks } from "@/components/portal/StatementLinks";
import { cn } from "@/components/ui/cn";
import { MotionProvider } from "@/components/ui/MotionProvider";
import { DecisionCard } from "@/components/vx/DecisionCard";
import { CONTENT_FRAME } from "@/components/vx/frame";
import { invoiceDecision } from "@/components/vx/map";
import { PaymentPlanSection } from "@/components/vx/PaymentPlan";
import { RecurringSummary } from "@/components/vx/RecurringSummary";
import { PageHead } from "@/components/vx/Shell";
import { sectionTitle } from "@/components/vx/nav";
import type { Decision } from "@/components/vx/types";
import { addedSince, latestDecision, recordedFacts } from "@/lib/added-details";
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
  type ReceivableFilter,
  type ReviewPanel,
} from "@/lib/bills-view";
import { invoiceMatch, parseSearch } from "@/lib/invoice-search";
import { CASH_SHORTFALL, SHADOW_VERDICT } from "@/lib/next-step";
import type { InvoiceRow } from "@/lib/queries";
import type { RecurringPayableView } from "@/lib/recurring-payables";
import { DESIGN_SLUG } from "../../../design/fixtures";
import { dealShot, dealShotCollected } from "../../deals-fixture";
import { PAYMENT_PLAN_OUTCOMES, PAYMENT_PLAN_VIEWER, paymentPlanShot } from "../../payment-plan-fixture";
import { customerNotesShot, fromCustomersShot, PORTAL_CUSTOMERS, statementLinksShot } from "../../portal-fixture";

const CUSTOMER_NOTES = customerNotesShot();
import {
  BILLS_COUNTERPARTIES,
  BILLS_ENTRIES,
  BILLS_INVOICES,
  BILLS_LINKS,
  BILLS_NOW,
  HUBSPOT_WON,
  QUICKBOOKS_ITEMS,
  XERO_BOOKING,
  XERO_ITEMS,
} from "../../bills-fixture";

/**
 * Bills & receivables in a given state, with sample data, for the redesign's pictures
 * (docs/superpowers/specs/2026-10-12-bills-tabs-design.md, `docs/superpowers/specs/bills-tabs-shots/`): `workspace`, a
 * busy workspace, and `empty`, a new one. The address chooses the tab, filter, search, open detail and review list as on
 * the page, and every row, list and figure is built by the page's own functions (`components/bills/build`). Like
 * /docs-shots, it answers only where `DOCS_SCREENSHOTS=1` is set, read per request: everywhere else, a 404.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Bills & receivables states", robots: { index: false, follow: false } };

const STATES = ["workspace", "empty"] as const;

type Props = { params: Promise<{ state: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function BillsStatePage({ params, searchParams }: Props) {
  if (process.env.DOCS_SCREENSHOTS !== "1") notFound();
  const { state } = await params;
  if (!(STATES as readonly string[]).includes(state)) notFound();
  const busy = state === "workspace";
  const slug = DESIGN_SLUG;
  const slugHref = (path: string) => `/docs-shots/bills/${state}${path.replace(/^\/invoices/, "")}`;
  const network = "arc-testnet" as const;
  const invoices: InvoiceRow[] = busy ? BILLS_INVOICES : [];
  const counterparties = busy ? BILLS_COUNTERPARTIES : [];
  const entries = busy ? BILLS_ENTRIES : [];
  const asOf = BILLS_NOW;
  const today = new Date(asOf).toISOString().slice(0, 10);
  const inAWeek = new Date(asOf + 7 * 86_400_000).toISOString().slice(0, 10);
  const raw = await searchParams;
  const query = readBillsQuery(raw);
  const search = parseSearch(query.q ?? undefined);

  const counterpartiesById = new Map(counterparties.map((row) => [row.id, row]));
  const invoicesById = new Map(invoices.map((row) => [row.id, row]));
  const decided = new Map(invoices.map((row) => [row.id, invoiceDecision(row, counterpartiesById.get(row.counterparty_id), entries, { network, asOf })]));
  const rowOf = (row: InvoiceRow) => listRowOf(row, decided.get(row.id) as Decision);
  const matches = (row: InvoiceRow) => !search || invoiceMatch(search, row) !== null;
  const payableRows = invoices.filter((row) => row.direction === "payable").map(rowOf);
  const receivableRows = invoices.filter((row) => row.direction === "receivable").map(rowOf);
  const foundPayables = payableRows.filter((row) => matches(invoicesById.get(row.id) as InvoiceRow));
  const foundReceivables = receivableRows.filter((row) => matches(invoicesById.get(row.id) as InvoiceRow));
  const billCounts = countBills(foundPayables, today, inAWeek);
  const receivableCounts = countReceivables(foundReceivables, today);
  const view = resolveBillsView(query, {
    directionOf: (id) => (invoicesById.get(id)?.direction as "payable" | "receivable" | undefined) ?? null,
    homeOf: (id) => {
      const row = invoicesById.get(id);
      return row ? homeOf(row, rowOf(row), today, inAWeek) : null;
    },
    billCounts,
    receivableCounts,
    searchHits: { payables: foundPayables.length, receivables: foundReceivables.length },
  });
  const listed =
    view.tab === "bills"
      ? sortRows(foundPayables.filter((row) => billFilterMatches(view.filter as BillFilter, row, today, inAWeek)), view.sort)
      : view.tab === "receivables"
        ? sortRows(foundReceivables.filter((row) => receivableFilterMatches(view.filter as ReceivableFilter, row, today)), view.sort)
        : [];
  const openAt = view.open && raw.page === undefined ? listed.findIndex((row) => row.id === view.open) : -1;
  const page = pageOf(listed, openAt >= 0 ? Math.floor(openAt / PAGE_SIZE) + 1 : view.page);
  const detailIds = [...new Set([...page.rows.map((row) => row.id), ...(view.open ? [view.open] : [])])];

  const waiting = new Map(
    invoices
      .filter((row) => row.direction === "payable" && WAITING_STATUSES.has(row.status))
      .map((row) => {
        const onFile = { poReference: row.po_reference ?? null, goodsReceived: row.goods_received === true, purchaseOrderRequired: counterpartiesById.get(row.counterparty_id)?.purchase_order_required !== false };
        return [row.id, { onFile, added: addedSince(recordedFacts(latestDecision(entries, row.id)), onFile) }] as const;
      })
  );
  const ruleOf = (decision: Decision) => decision.guardrail?.rule ?? (decision.heldForCash ? CASH_SHORTFALL : decision.heldForVerdict ? SHADOW_VERDICT : null);
  const details: Record<string, PanelContent> = Object.fromEntries(
    detailIds.map((id) => {
      const row = invoicesById.get(id) as InvoiceRow;
      const decision = decided.get(id) as Decision;
      const facts = waiting.get(id);
      const footer = facts ? (
        <WaitingPayableAction
          orgSlug={slug}
          invoice={{ id, counterpartyName: row.counterparty_name, counterpartyId: row.counterparty_id, ...facts.onFile }}
          added={facts.added}
          canAddDetails
          canDecide
          rule={ruleOf(decision)}
          canFix
        />
      ) : undefined;
      return [id, { title: `${decision.action} ${decision.subject}`, node: <DecisionCard decision={decision} orgSlug={slug} footerAction={footer} /> }];
    })
  );
  const here = viewHref(slugHref, view, query.sort);
  const pageItems = {
    ...page,
    rows: page.rows.map((row) => {
      const invoice = invoicesById.get(row.id) as InvoiceRow;
      const decision = decided.get(row.id) as Decision;
      return billRowItem({ invoice, decision, row, today, inAWeek, waiting: waiting.get(row.id), rule: ruleOf(decision), canWrite: true, canDecide: true, link: BILLS_LINKS.get(row.id), owedNote: busy ? (CUSTOMER_NOTES.get(row.id) ?? null) : null, href: here({ open: row.id }) });
    }),
  };
  const listOf = (tab: "bills" | "receivables") =>
    listData({
      tab,
      view,
      sortAsked: query.sort,
      filterAsked: query.filter !== null,
      page: pageItems,
      counts: tab === "bills" ? billCounts : receivableCounts,
      slugHref,
      canWrite: true,
      totals: { payables: payableRows.length, receivables: receivableRows.length },
      otherMatches: tab === "bills" ? foundReceivables.length : foundPayables.length,
    });

  const waitingItems: WaitingItem[] = busy
    ? [
        { key: "xero", review: "xero", label: `${XERO_ITEMS.length} from Xero` },
        { key: "quickbooks", review: "quickbooks", label: `${QUICKBOOKS_ITEMS.length} from QuickBooks` },
        { key: "hubspot", href: `${slugHref(billsHref({ tab: "receivables" }))}#from-hubspot`, label: "1 won deal in HubSpot" },
        { key: "book-xero", review: "book-xero", label: "1 to book in Xero" },
        { key: "customers", href: `${slugHref(billsHref({ tab: "receivables" }))}#from-customers`, label: "4 from customers" },
      ]
    : [];
  const reviews: Partial<Record<ReviewPanel, PanelContent>> = busy
    ? {
        xero: { title: "From Xero", node: <AccountingBillsReview provider="xero" orgSlug={slug} connectionId="bills-shot-xero" organisation="Demo Company (Global)" items={XERO_ITEMS} closed={[]} canAdd /> },
        quickbooks: { title: "From QuickBooks", node: <AccountingBillsReview provider="quickbooks" orgSlug={slug} connectionId="bills-shot-qb" organisation="Sandbox Company_US_1" items={QUICKBOOKS_ITEMS} closed={[]} canAdd /> },
        "book-xero": {
          title: "To book in Xero",
          node: <AccountingBookings provider="xero" orgSlug={slug} connectionId="bills-shot-xero" organisation="Demo Company (Global)" scopeMissing={false} accountChosen toReview={[XERO_BOOKING]} done={[]} canBook />,
        },
      }
    : {};

  const schedules: RecurringPayableView[] = busy
    ? [
        { id: "rec-1", counterpartyName: "Cobalt Cloud", amount: 420, currency: "USDC", memo: "Hosting", cadence: "Every month", nextDueOn: "2026-11-15", endsOn: null, status: "active" },
        { id: "rec-2", counterpartyName: "Orbit Telecom", amount: 89.9, currency: "USDC", memo: "Phone lines", cadence: "Every month", nextDueOn: "2026-11-18", endsOn: null, status: "active" },
      ]
    : [];

  const tabContent =
    view.tab === "bills"
      ? {
          bills: {
            list: listOf("bills"),
            below: schedules.length > 0 ? <RecurringSummary schedules={schedules} orgSlug={slug} canWrite /> : undefined,
          },
        }
      : view.tab === "plan"
        ? { plan: <PaymentPlanSection plan={paymentPlanShot({ short: true })} outcomes={PAYMENT_PLAN_OUTCOMES} orgSlug={slug} canDecide viewerId={PAYMENT_PLAN_VIEWER} /> }
        : {
            receivables: {
              list: listOf("receivables"),
              above: busy ? <FromCustomers orgSlug={slug} items={fromCustomersShot((id) => here({ open: id }))} canWrite /> : undefined,
              below: (
                <div className="space-y-10 pt-6">
                  <StatementLinks orgSlug={slug} customers={busy ? PORTAL_CUSTOMERS : []} links={busy ? statementLinksShot() : []} canWrite available />
                  <DealsSection
                    deals={busy ? [dealShot()] : []}
                    collected={busy ? dealShotCollected() : null}
                    orgSlug={slug}
                    today={today}
                    fromCrm={busy ? <HubSpotDeals orgSlug={slug} organisation="granite-labs.example" won={HUBSPOT_WON} open={[]} emails={[]} canWrite /> : undefined}
                  />
                </div>
              ),
            },
          };

  return (
    <MotionProvider>
      <main id="main" data-bills-state={state} className="min-h-dvh bg-ground">
        <div className={cn(CONTENT_FRAME, "pb-10 pt-6")}>
          <PageHead
            title={sectionTitle("invoices")}
            sub="Your bills, what the agent decided on each, and why."
            right={
              <NewMenu
                orgSlug={slug}
                counterparties={counterparties.map(({ id, name, role }) => ({ id, name, role }))}
                importWorkspace={{ shadowOn: false, shadowCurrency: null, network }}
                deal={{ customers: counterparties.filter((row) => row.role === "client").map(({ id, name }) => ({ id, name })), currencies: ["USDC", "EURC"], idempotencyKey: "bills-shot", today }}
              />
            }
          />
          <BillsScreen
            slugHref={slugHref}
            tab={view.tab}
            tabs={[
              { key: "bills", label: "Bills", href: slugHref(billsHref({ tab: "bills" })), count: billCounts["needs-you"] },
              { key: "plan", label: "Payment plan", href: slugHref(billsHref({ tab: "plan" })) },
              { key: "receivables", label: "Receivables", href: slugHref(billsHref({ tab: "receivables" })) },
            ]}
            summary={summaryData({ payableRows, receivableRows, invoicesById, today, inAWeek, owedOf: (row) => Number(row.amount), slugHref })}
            waiting={waitingItems}
            reviews={reviews}
            details={details}
            {...tabContent}
          />
        </div>
      </main>
    </MotionProvider>
  );
}
