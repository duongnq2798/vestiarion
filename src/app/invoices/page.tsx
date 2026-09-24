import AgentControls from "@/components/AgentControls";
import InvoiceCsvImport from "@/components/intake/InvoiceCsvImport";
import InvoiceIntake from "@/components/intake/InvoiceIntake";
import { DecisionCard } from "@/components/vx/DecisionCard";
import { invoiceDecision } from "@/components/vx/map";
import { SectionHead } from "@/components/vx/Primitives";
import { EmptyState, PageHead, ProductShell } from "@/components/vx/Shell";
import { hasAgentControlSession } from "@/lib/agent-session";
import { listLedgerEntries } from "@/lib/ledger";
import { listCounterparties, listInvoices, stats } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function InvoicesPage({ searchParams }: PageProps<"/invoices">) {
  const query = await searchParams;
  const [invoices, counterparties, entries, dashboardStats, canMutate] = await Promise.all([
    listInvoices(),
    listCounterparties(),
    listLedgerEntries(300),
    stats(),
    hasAgentControlSession(),
  ]);
  const filter = typeof query.status === "string" ? query.status : undefined;
  const shown = filter ? invoices.filter((invoice) => invoice.status === filter) : invoices;
  const counterpartiesById = new Map(counterparties.map((counterparty) => [counterparty.id, counterparty]));
  const decisions = shown.map((invoice) => invoiceDecision(invoice, counterpartiesById.get(invoice.counterparty_id), entries));
  const payables = decisions.filter((decision) => decision.domain === "ap");
  const receivables = decisions.filter((decision) => decision.domain === "ar");
  const refused = payables.filter((decision) => decision.outcome === "refused");
  const ordinaryPayables = payables.filter((decision) => decision.outcome !== "refused");

  return (
    <ProductShell active="invoices" day={dashboardStats.day}>
      <PageHead
        title="AP / AR"
        sub="Three-way match, counterparty risk, and payment authority — with the agent’s complete reasoning on every line."
        right={<AgentControls nextDay={dashboardStats.day + 1} headSeq={entries[0]?.seq ?? 0} />}
      />

      {filter && (
        <div className="mb-6 flex items-center gap-3 rounded-md border border-held-line bg-held-soft px-3 py-2 text-sm text-held">
          Showing status: <span className="font-mono">{filter}</span>
          <a href="/invoices" className="ml-auto text-ink-2 underline hover:text-ink">Clear filter</a>
        </div>
      )}

      <section className="mb-8">
        <SectionHead title="Invoice intake" meta="manual entry or CSV preview and confirm" />
        {canMutate ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <details open className="rounded-lg border border-line bg-surface p-4 sm:p-5">
              <summary className="cursor-pointer text-sm font-semibold text-ink">Enter one invoice</summary>
              <div className="mt-4"><InvoiceIntake counterparties={counterparties.map(({ id, name, role }) => ({ id, name, role }))} /></div>
            </details>
            <details className="rounded-lg border border-line bg-surface p-4 sm:p-5">
              <summary className="cursor-pointer text-sm font-semibold text-ink">Import CSV</summary>
              <div className="mt-4"><InvoiceCsvImport /></div>
            </details>
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-line-strong px-5 py-6 text-sm text-ink-2">Unlock controls above to add or import invoices.</p>
        )}
      </section>

      <div className="space-y-8">
        {refused.length > 0 && (
          <section>
            <SectionHead title="Guardrail overrides" meta="the model said pay; code stopped execution" />
            <div className="space-y-4">{refused.map((decision) => <DecisionCard key={decision.id} decision={decision} />)}</div>
          </section>
        )}
        <InvoiceSection title="Payables" meta={`${payables.length} invoices`} decisions={ordinaryPayables} />
        <InvoiceSection title="Receivables" meta={`${receivables.length} invoices`} decisions={receivables} />
      </div>
    </ProductShell>
  );
}

function InvoiceSection({ title, meta, decisions }: { title: string; meta: string; decisions: ReturnType<typeof invoiceDecision>[] }) {
  return (
    <section>
      <SectionHead title={title} meta={meta} />
      {decisions.length === 0 ? (
        <EmptyState title={`No ${title.toLowerCase()} here`} body="There are no records in this view." />
      ) : (
        <div className="space-y-4">{decisions.map((decision) => <DecisionCard key={decision.id} decision={decision} />)}</div>
      )}
    </section>
  );
}
