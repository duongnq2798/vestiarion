import type { Metadata } from "next";
import AgentControls from "@/components/AgentControls";
import { CycleReport } from "@/components/vx/CycleReport";
import { DecisionCard } from "@/components/vx/DecisionCard";
import { invoiceDecision, treasuryActionDecision, treasuryLedgerDecision } from "@/components/vx/map";
import { Money, SectionHead } from "@/components/vx/Primitives";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { sectionTitle } from "@/components/vx/nav";
import { AccountsList, BalanceTile, ForecastPanel, MoreLink, StatTile } from "@/components/vx/Treasury";
import type { Account, Forecast } from "@/components/vx/types";
import { requireMembership } from "@/lib/auth/membership";
import { orgHref } from "@/lib/auth/org-paths";
import { chainModes } from "@/lib/circle";
import { inOrg } from "@/lib/dal/scope";
import { listLedgerEntries, listLedgerEntriesAfter, listLedgerEntriesByDomain, listLedgerEntriesForTargets } from "@/lib/ledger";
import { latestForecast, listAccounts, listCounterparties, listInvoices, listTreasuryActions, stats } from "@/lib/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: sectionTitle("treasury") };

export default async function DashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const access = await requireMembership(slug);
  return inOrg(access, async () => {
    const query = await searchParams;
    const [accountsRows, actionRows, forecastRow, dashboardStats, invoices, counterparties, headEntries] = await Promise.all([
      listAccounts(),
      listTreasuryActions(),
      latestForecast(),
      stats(),
      listInvoices(),
      listCounterparties(),
      listLedgerEntries(1),
    ]);
    // Modes, not the provider: the page must still render when the
    // organization's Circle credentials cannot be read (R12).
    const modes = chainModes();
    const counterpartiesById = new Map(counterparties.map((counterparty) => [counterparty.id, counterparty]));
    const accounts: Account[] = accountsRows.map((account) => ({
      ...account,
      simulated: account.kind === "reserve" && modes.earnMode !== "live",
    }));
    const forecast: Forecast | undefined = forecastRow
      ? {
          horizonDays: forecastRow.horizon_days,
          inflow: forecastRow.projected_inflow,
          outflow: forecastRow.projected_outflow,
          liquid: forecastRow.liquid_balance,
          recommendation: forecastRow.recommendation ?? "",
        }
      : undefined;
    const sinceValue = typeof query.since === "string" ? Number(query.since) : undefined;
    const since = Number.isFinite(sinceValue) ? sinceValue : undefined;
    const [invoiceEntries, treasuryEntries, cycleEntries] = await Promise.all([
      listLedgerEntriesForTargets({ invoiceIds: invoices.map((invoice) => invoice.id) }),
      listLedgerEntriesByDomain("treasury", 2),
      since == null ? Promise.resolve([]) : listLedgerEntriesAfter(since),
    ]);
    const invoiceDecisions = invoices.map((invoice) =>
      invoiceDecision(invoice, counterpartiesById.get(invoice.counterparty_id), invoiceEntries)
    );
    const stopped = invoiceDecisions.filter((decision) => decision.outcome === "refused" || decision.outcome === "held");
    const treasuryDecisions = treasuryEntries.map(treasuryLedgerDecision);
    const executedReserveMoves = actionRows.slice(0, 2).map(treasuryActionDecision);
    const headSeq = headEntries[0]?.seq ?? 0;
    const needsReview = stopped.length;

    return (
      <ProductShell day={dashboardStats.day} clockMode={dashboardStats.clockMode} lastCycleAt={dashboardStats.lastCycleAt} chainModes={modes}>
        <PageHead
          title={sectionTitle("treasury")}
          sub="What the agent holds, what it decided, and why."
          right={<AgentControls orgSlug={slug} nextDay={dashboardStats.day + 1} headSeq={headSeq} clockMode={dashboardStats.clockMode} />}
        />

        {since != null && <CycleReport entries={cycleEntries} day={dashboardStats.day} since={since} clockMode={dashboardStats.clockMode} completedAt={dashboardStats.lastCycleAt} orgSlug={slug} />}

        <div className="mb-8 grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 xl:grid-cols-4">
          <BalanceTile accounts={accounts} mode={access.membership.mode} />
          <StatTile label="Paid out to date" sub={`${dashboardStats.onchainTransfers} settled on-chain`}>
            <Money value={dashboardStats.totalPaidOut} />
          </StatTile>
          <StatTile label="Decisions logged" href={orgHref(slug, "/audit")} sub="Every entry is hash-linked and signed">
            <span className="tabular-nums">{dashboardStats.decisionsLogged}</span>
          </StatTile>
          <StatTile label="Needs you" tone={needsReview > 0 ? "held" : "default"} href={orgHref(slug, "/invoices")} sub={needsReview > 0 ? "Held or flagged — the agent will not act alone" : "Nothing waiting"}>
            <span className="tabular-nums">{needsReview}</span>
          </StatTile>
        </div>

        <div className="grid grid-cols-1 gap-8 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0 space-y-8">
            {stopped.length > 0 && (
              <section>
                <SectionHead title="Stopped" meta="refused by code, or waiting for you" />
                <div className="space-y-4">{stopped.slice(0, 3).map((decision) => <DecisionCard key={decision.id} decision={decision} orgSlug={slug} />)}</div>
              </section>
            )}

            <section>
              <SectionHead title="Treasury decisions" meta="yield moves include their economics" action={<MoreLink href={orgHref(slug, "/audit?domain=treasury")}>Full audit log</MoreLink>} />
              {treasuryDecisions.length === 0 ? (
                <p className="rounded-lg border border-dashed border-line-strong p-5 text-sm text-ink-2">Run an agent cycle to see why cash was swept, redeemed, or held liquid.</p>
              ) : (
                <div className="space-y-4">{treasuryDecisions.map((decision) => <DecisionCard key={decision.id} decision={decision} orgSlug={slug} />)}</div>
              )}
            </section>

            {executedReserveMoves.length > 0 && (
              <section>
                <SectionHead title="Executed reserve movements" meta="recorded treasury actions" />
                <div className="space-y-4">{executedReserveMoves.map((decision) => <DecisionCard key={decision.id} decision={decision} compact orgSlug={slug} />)}</div>
              </section>
            )}
          </div>

          <aside className="min-w-0 space-y-6 md:grid md:grid-cols-2 md:items-start md:gap-6 md:space-y-0 xl:block xl:space-y-6">
            <AccountsList accounts={accounts} />
            {forecast && <ForecastPanel forecast={forecast} />}
          </aside>
        </div>
      </ProductShell>
    );
  });
}
