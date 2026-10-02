import { FileSpreadsheet, FileText, ListFilter, PenLine, Plus, Repeat } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { AutoRefresh } from "@/components/AutoRefresh";
import AgentControls from "@/components/AgentControls";
import InvoiceCsvImport from "@/components/intake/InvoiceCsvImport";
import InvoiceDocumentIntake from "@/components/intake/InvoiceDocumentIntake";
import InvoiceIntake from "@/components/intake/InvoiceIntake";
import RecurringPayableIntake, { RecurringPayablesList } from "@/components/intake/RecurringPayableIntake";
import { PayLinkControl } from "@/components/PayLinkControl";
import { ReceiptControl } from "@/components/ReceiptControl";
import { Callout } from "@/components/ui/Callout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { Disclosure } from "@/components/ui/Disclosure";
import { DecisionRows, RowGroupHeading, type DecisionRowItem } from "@/components/vx/DecisionRows";
import { Money } from "@/components/vx/Primitives";
import { StatTile } from "@/components/vx/StatTile";
import { invoiceDecision } from "@/components/vx/map";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { sectionTitle } from "@/components/vx/nav";
import { viewerCan } from "@/lib/auth/authorize";
import { requireMembership } from "@/lib/auth/membership";
import { orgHref } from "@/lib/auth/org-paths";
import { chainModes } from "@/lib/circle";
import { inOrg } from "@/lib/dal/scope";
import { listLedgerEntries, listLedgerEntriesForTargets } from "@/lib/ledger";
import { listCounterparties, listInvoices, stats, type InvoiceRow } from "@/lib/queries";
import { utcDay } from "@/lib/copy";
import { listRecurringPayables } from "@/lib/recurring-payables";
import { receiptShareable } from "@/lib/receipts/facts";
import { sharedReceipts } from "@/lib/receipts/share";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: sectionTitle("invoices") };

type InvoiceSearchParams = Promise<{
  status?: string | string[];
  /** `all` shows every settled invoice; otherwise the latest ten. */
  history?: string | string[];
}>;

/** Payables still to be paid: decided or not, held or scheduled. */
const OPEN = new Set(["pending", "matched", "scheduled", "held", "flagged", "awaiting_info"]);
/** Payables waiting for a person (Approvals). */
const WAITING = new Set(["held", "flagged", "awaiting_info"]);
/** Settled rows shown before "Show all". */
const HISTORY_SHOWN = 10;

type InvoicePageProps = {
  params: Promise<{ slug: string }>;
  searchParams: InvoiceSearchParams;
};

export default async function InvoicesPage({ params, searchParams }: InvoicePageProps) {
  const { slug } = await params;
  const access = await requireMembership(slug);
  return inOrg(access, async () => {
    const query = await searchParams;
    const [invoices, counterparties, headEntries, dashboardStats, canWrite, schedules] = await Promise.all([
      listInvoices(),
      listCounterparties(),
      listLedgerEntries(1),
      stats(),
      viewerCan(slug, "records.write"),
      // Best effort: a list that cannot be read hides its section, nothing else.
      listRecurringPayables().catch((error: unknown) => {
        console.error("invoices: recurring payments not loaded", error instanceof Error ? error.message : error);
        return [];
      }),
    ]);
    const entries = await listLedgerEntriesForTargets({ invoiceIds: invoices.map((invoice) => invoice.id) });
    const filter = typeof query.status === "string" ? query.status : undefined;
    const shown = filter ? invoices.filter((invoice) => invoice.status === filter) : invoices;
    const counterpartiesById = new Map(counterparties.map((counterparty) => [counterparty.id, counterparty]));
    const decisions = shown.map((invoice) => invoiceDecision(invoice, counterpartiesById.get(invoice.counterparty_id), entries));
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
    const payLinkFor = (decision: ReturnType<typeof invoiceDecision>) =>
      payLinkable.has(decision.id) ? <PayLinkControl orgSlug={slug} invoiceId={decision.id} /> : undefined;

    // The work, not the documents (AP / AR layout): what waits for a person, what is coming, what is settled.
    const today = new Date().toISOString().slice(0, 10);
    const inAWeek = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const row = (decision: ReturnType<typeof invoiceDecision>, footerFor?: (decision: ReturnType<typeof invoiceDecision>) => React.ReactNode): DecisionRowItem => {
      const invoice = invoicesById.get(decision.id) as InvoiceRow;
      return { decision, date: rowDate(invoice, today), footerAction: footerFor?.(decision) };
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
      <ProductShell day={dashboardStats.day} clockMode={dashboardStats.clockMode} lastCycleAt={dashboardStats.lastCycleAt} chainModes={chainModes()}>
        <PageHead
          title={sectionTitle("invoices")}
          sub="Three-way match, counterparty risk, and payment authority — with the agent’s complete reasoning on every line."
          right={<AgentControls orgSlug={slug} nextDay={dashboardStats.day + 1} headSeq={headEntries[0]?.seq ?? 0} clockMode={dashboardStats.clockMode} />}
        />
        {/* The agent decides within a minute of an event (an invoice added, a payable returned): the page
            re-reads its data every 20 s, and at once on return to the tab, so the decision appears without a reload. */}
        <AutoRefresh intervalMs={20_000} />

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

        {canWrite ? (
          // Folded until it is needed; open on a workspace with no invoice yet, where adding one is the next step.
          <Disclosure
            className="mb-8"
            defaultOpen={invoices.length === 0}
            summary={
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className="inline-flex items-center gap-1.5 text-ink">
                  <Plus aria-hidden className="size-4" />
                  New invoice
                </span>
                <span className="text-[0.8125rem] font-normal text-ink-3">typed in, read from a document, imported from a CSV, or recurring</span>
              </span>
            }
          >
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
                <TabsTrigger value="csv">
                  <FileSpreadsheet aria-hidden />
                  Import CSV
                </TabsTrigger>
                <TabsTrigger value="recurring">
                  <Repeat aria-hidden />
                  Recurring
                </TabsTrigger>
              </TabsList>
              {/* Both stay mounted, so switching tabs never loses what was typed. */}
              <TabsContent value="manual" forceMount className="data-[state=inactive]:hidden">
                <InvoiceIntake orgSlug={slug} counterparties={counterparties.map(({ id, name, role }) => ({ id, name, role }))} />
              </TabsContent>
              <TabsContent value="document" forceMount className="data-[state=inactive]:hidden">
                <InvoiceDocumentIntake orgSlug={slug} counterparties={counterparties.map(({ id, name, role }) => ({ id, name, role }))} />
              </TabsContent>
              <TabsContent value="csv" forceMount className="data-[state=inactive]:hidden">
                <InvoiceCsvImport orgSlug={slug} />
              </TabsContent>
              <TabsContent value="recurring" forceMount className="data-[state=inactive]:hidden">
                <RecurringPayableIntake orgSlug={slug} counterparties={counterparties.map(({ id, name, role }) => ({ id, name, role }))} />
              </TabsContent>
            </Tabs>
          </Disclosure>
        ) : (
          <Callout className="mb-8">Only an owner or admin of this workspace can add or import invoices.</Callout>
        )}

        {schedules.length > 0 && (
          <section className="mb-8">
            <SectionHeader title="Recurring payments" meta="each period's invoice is created as it comes near, and decided like any other" />
            <RecurringPayablesList schedules={schedules} orgSlug={slug} canWrite={canWrite} />
          </section>
        )}

        <div className="space-y-10">
          <section>
            <SectionHeader title="Payables" meta={`${payables.length} invoices · open one for the agent's reasoning`} />
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
                    <DecisionRows orgSlug={slug} items={needsYou.map((decision) => row(decision, receiptFor))} />
                  </>
                )}
                {upcoming.length > 0 && (
                  <>
                    <RowGroupHeading title="Upcoming" count={upcoming.length} />
                    <DecisionRows orgSlug={slug} items={upcoming.map((decision) => row(decision, receiptFor))} />
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
                    <DecisionRows orgSlug={slug} items={(showAllHistory ? settled : settled.slice(0, HISTORY_SHOWN)).map((decision) => row(decision, receiptFor))} />
                  </>
                )}
              </>
            )}
          </section>

          <section>
            <SectionHeader title="Receivables" meta={`${receivables.length} invoices`} />
            {receivables.length === 0 ? (
              <EmptyState compact title="No receivables here" body="There are no records in this view." />
            ) : (
              <>
                {openReceivables.length > 0 && (
                  <>
                    <RowGroupHeading title="Open" count={openReceivables.length} />
                    <DecisionRows orgSlug={slug} items={openReceivables.map((decision) => row(decision, payLinkFor))} />
                  </>
                )}
                {settledReceivables.length > 0 && (
                  <>
                    <RowGroupHeading title="Received and closed" count={settledReceivables.length} />
                    <DecisionRows orgSlug={slug} items={settledReceivables.slice(0, showAllHistory ? undefined : HISTORY_SHOWN).map((decision) => row(decision, payLinkFor))} />
                  </>
                )}
              </>
            )}
          </section>
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
