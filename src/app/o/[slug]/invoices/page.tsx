import { FileSpreadsheet, FileText, ListFilter, PenLine } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { AutoRefresh } from "@/components/AutoRefresh";
import AgentControls from "@/components/AgentControls";
import InvoiceCsvImport from "@/components/intake/InvoiceCsvImport";
import InvoiceDocumentIntake from "@/components/intake/InvoiceDocumentIntake";
import InvoiceIntake from "@/components/intake/InvoiceIntake";
import { PayLinkControl } from "@/components/PayLinkControl";
import { ReceiptControl } from "@/components/ReceiptControl";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { DecisionCard } from "@/components/vx/DecisionCard";
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
import { listCounterparties, listInvoices, stats } from "@/lib/queries";
import { receiptShareable } from "@/lib/receipts/facts";
import { sharedReceipts } from "@/lib/receipts/share";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: sectionTitle("invoices") };

type InvoiceSearchParams = Promise<{
  status?: string | string[];
}>;

type InvoicePageProps = {
  params: Promise<{ slug: string }>;
  searchParams: InvoiceSearchParams;
};

export default async function InvoicesPage({ params, searchParams }: InvoicePageProps) {
  const { slug } = await params;
  const access = await requireMembership(slug);
  return inOrg(access, async () => {
    const query = await searchParams;
    const [invoices, counterparties, headEntries, dashboardStats, canWrite] = await Promise.all([
      listInvoices(),
      listCounterparties(),
      listLedgerEntries(1),
      stats(),
      viewerCan(slug, "records.write"),
    ]);
    const entries = await listLedgerEntriesForTargets({ invoiceIds: invoices.map((invoice) => invoice.id) });
    const filter = typeof query.status === "string" ? query.status : undefined;
    const shown = filter ? invoices.filter((invoice) => invoice.status === filter) : invoices;
    const counterpartiesById = new Map(counterparties.map((counterparty) => [counterparty.id, counterparty]));
    const decisions = shown.map((invoice) => invoiceDecision(invoice, counterpartiesById.get(invoice.counterparty_id), entries));
    const payables = decisions.filter((decision) => decision.domain === "ap");
    const receivables = decisions.filter((decision) => decision.domain === "ar");
    const refused = payables.filter((decision) => decision.outcome === "refused");
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

        <section className="mb-8">
          <SectionHeader title="Invoice intake" meta="typed in, read from a document, or imported from a CSV, and confirmed" />
          {canWrite ? (
            <Card className="p-4 sm:p-6">
              <Tabs defaultValue="manual">
                <TabsList aria-label="Invoice intake">
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
              </Tabs>
            </Card>
          ) : (
            <Callout>Only an owner or admin of this workspace can add or import invoices.</Callout>
          )}
        </section>

        <div className="space-y-8">
          {refused.length > 0 && (
            <section>
              <SectionHeader title="Guardrail overrides" meta="the model said pay; code stopped execution" />
              <div className="space-y-4">{refused.map((decision) => <DecisionCard key={decision.id} decision={decision} orgSlug={slug} />)}</div>
            </section>
          )}
          <InvoiceSection title="Payables" meta={`${payables.length} invoices`} decisions={ordinaryPayables} orgSlug={slug} footerFor={receiptFor} />
          <InvoiceSection title="Receivables" meta={`${receivables.length} invoices`} decisions={receivables} orgSlug={slug} footerFor={payLinkFor} />
        </div>
      </ProductShell>
    );
  });
}

function InvoiceSection({
  title,
  meta,
  decisions,
  orgSlug,
  footerFor,
}: {
  title: string;
  meta: string;
  decisions: ReturnType<typeof invoiceDecision>[];
  orgSlug: string;
  footerFor?: (decision: ReturnType<typeof invoiceDecision>) => React.ReactNode;
}) {
  return (
    <section>
      <SectionHeader title={title} meta={meta} />
      {decisions.length === 0 ? (
        <EmptyState compact title={`No ${title.toLowerCase()} here`} body="There are no records in this view." />
      ) : (
        <div className="space-y-4">
          {decisions.map((decision) => (
            <DecisionCard key={decision.id} decision={decision} orgSlug={orgSlug} footerAction={footerFor?.(decision)} />
          ))}
        </div>
      )}
    </section>
  );
}
