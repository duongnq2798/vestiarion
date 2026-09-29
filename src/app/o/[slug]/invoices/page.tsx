import { FileSpreadsheet, PenLine } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import AgentControls from "@/components/AgentControls";
import InvoiceCsvImport from "@/components/intake/InvoiceCsvImport";
import InvoiceIntake from "@/components/intake/InvoiceIntake";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { DecisionCard } from "@/components/vx/DecisionCard";
import { invoiceDecision } from "@/components/vx/map";
import { SectionHead } from "@/components/vx/Primitives";
import { EmptyState, PageHead, ProductShell } from "@/components/vx/Shell";
import { sectionTitle } from "@/components/vx/nav";
import { viewerCan } from "@/lib/auth/authorize";
import { requireMembership } from "@/lib/auth/membership";
import { orgHref } from "@/lib/auth/org-paths";
import { chainModes } from "@/lib/circle";
import { inOrg } from "@/lib/dal/scope";
import { listLedgerEntries, listLedgerEntriesForTargets } from "@/lib/ledger";
import { listCounterparties, listInvoices, stats } from "@/lib/queries";

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

    return (
      <ProductShell day={dashboardStats.day} clockMode={dashboardStats.clockMode} lastCycleAt={dashboardStats.lastCycleAt} chainModes={chainModes()}>
        <PageHead
          title={sectionTitle("invoices")}
          sub="Three-way match, counterparty risk, and payment authority — with the agent’s complete reasoning on every line."
          right={<AgentControls orgSlug={slug} nextDay={dashboardStats.day + 1} headSeq={headEntries[0]?.seq ?? 0} clockMode={dashboardStats.clockMode} />}
        />

        {filter && (
          <div className="mb-6 flex items-center gap-3 rounded-md border border-held-line bg-held-soft px-3 py-2 text-sm text-held">
            Showing status: <span className="font-mono">{filter}</span>
            <Link href={orgHref(slug, "/invoices")} className="ml-auto text-ink-2 underline hover:text-ink">Clear filter</Link>
          </div>
        )}

        <section className="mb-8">
          <SectionHead title="Invoice intake" meta="manual entry or CSV preview and confirm" />
          {canWrite ? (
            <Card className="p-4 sm:p-6">
              <Tabs defaultValue="manual">
                <TabsList aria-label="Invoice intake">
                  <TabsTrigger value="manual">
                    <PenLine aria-hidden />
                    Enter one invoice
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
              <SectionHead title="Guardrail overrides" meta="the model said pay; code stopped execution" />
              <div className="space-y-4">{refused.map((decision) => <DecisionCard key={decision.id} decision={decision} orgSlug={slug} />)}</div>
            </section>
          )}
          <InvoiceSection title="Payables" meta={`${payables.length} invoices`} decisions={ordinaryPayables} orgSlug={slug} />
          <InvoiceSection title="Receivables" meta={`${receivables.length} invoices`} decisions={receivables} orgSlug={slug} />
        </div>
      </ProductShell>
    );
  });
}

function InvoiceSection({ title, meta, decisions, orgSlug }: { title: string; meta: string; decisions: ReturnType<typeof invoiceDecision>[]; orgSlug: string }) {
  return (
    <section>
      <SectionHead title={title} meta={meta} />
      {decisions.length === 0 ? (
        <EmptyState title={`No ${title.toLowerCase()} here`} body="There are no records in this view." />
      ) : (
        <div className="space-y-4">{decisions.map((decision) => <DecisionCard key={decision.id} decision={decision} orgSlug={orgSlug} />)}</div>
      )}
    </section>
  );
}
