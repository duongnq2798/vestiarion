import type { Metadata } from "next";
import { refreshOnChainBalanceAction } from "@/app/actions/treasury";
import { AutoRefresh } from "@/components/AutoRefresh";
import AgentControls from "@/components/AgentControls";
import AgentPauseControl from "@/components/AgentPauseControl";
import { SampleDataLoaded, SampleDataOffer } from "@/components/SampleDataPanel";
import { CycleReport } from "@/components/vx/CycleReport";
import { DecisionCard } from "@/components/vx/DecisionCard";
import { GettingStarted } from "@/components/vx/GettingStarted";
import { invoiceDecision, treasuryActionDecision, treasuryLedgerDecision } from "@/components/vx/map";
import { Money } from "@/components/vx/Primitives";
import { ScheduledPayments, scheduledPaymentRows } from "@/components/vx/ScheduledPayments";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { sectionTitle } from "@/components/vx/nav";
import { AccountsList, BalanceTile, balanceTileMode, ForecastPanel, MoreLink, StatTile } from "@/components/vx/Treasury";
import type { Account, Forecast } from "@/components/vx/types";
import { listWaitingPayables } from "@/lib/agent/approvals";
import { requireMembership } from "@/lib/auth/membership";
import { orgHref } from "@/lib/auth/org-paths";
import { can } from "@/lib/auth/roles";
import { chainModes } from "@/lib/circle";
import { inOrg } from "@/lib/dal/scope";
import { gettingStarted, ownInvoiceCount } from "@/lib/getting-started";
import { listLedgerEntries, listLedgerEntriesAfter, listLedgerEntriesByDomain, listLedgerEntriesForTargets } from "@/lib/ledger";
import { pauseStateOf } from "@/lib/platform/pause";
import { latestForecast, listAccounts, listCounterparties, listInvoices, listTreasuryActions, stats } from "@/lib/queries";
import { offerSampleData } from "@/lib/sample-data-offer";

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
    const [accountsRows, actionRows, forecastRow, dashboardStats, invoices, counterparties, headEntries, waiting, pause] = await Promise.all([
      listAccounts(),
      listTreasuryActions(),
      latestForecast(),
      stats(),
      listInvoices(),
      listCounterparties(),
      listLedgerEntries(1),
      listWaitingPayables(),
      // Best effort, as in the layout: an unreadable pause shows the agent as running. A cycle is still
      // refused server-side while paused, so this only affects which buttons show.
      pauseStateOf(access.membership.orgId).catch((error: unknown) => {
        console.error("console: pause state not loaded", access.membership.orgId, error);
        return null;
      }),
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
    // What the agent will pay next, soonest first (payment timing design §1):
    // derived from the invoices already loaded above, no extra query.
    const scheduledPayments = scheduledPaymentRows(invoices);
    const treasuryDecisions = treasuryEntries.map(treasuryLedgerDecision);
    const executedReserveMoves = actionRows.slice(0, 2).map(treasuryActionDecision);
    const headSeq = headEntries[0]?.seq ?? 0;
    // What the approvals inbox holds for a person, so the tile and the page it links to agree. A row
    // someone else is deciding right now does not need you; one whose claim did not finish does.
    const needsReview = waiting.filter((payable) => payable.status !== "processing" || payable.reclaimable).length;
    const paused = pause !== null;
    const role = access.membership.role;
    // Computed from the rows above, with no extra read (getting-started design G1, G2). Only people who
    // can act on it see it: owners and admins add records, and an owner takes the workspace live.
    const checklist = can(role, "records.write")
      ? gettingStarted({ mode: access.membership.mode, accounts: accountsRows, counterparties, invoiceCount: ownInvoiceCount(invoices, counterparties) })
      : null;
    // Sample data (sample-data design §1): offered in an empty simulated sandbox, and called out while it is loaded.
    const sampleOffered = offerSampleData({ canWrite: can(role, "records.write"), mode: access.membership.mode, chainMode: modes.mode, counterpartyCount: counterparties.length });
    const sampleLoaded = counterparties.some((counterparty) => counterparty.sample);

    return (
      <ProductShell day={dashboardStats.day} clockMode={dashboardStats.clockMode} lastCycleAt={dashboardStats.lastCycleAt} chainModes={modes}>
        <PageHead
          title={sectionTitle("treasury")}
          sub="What the agent holds, what it decided, and why."
          right={
            <AgentControls
              orgSlug={slug}
              nextDay={dashboardStats.day + 1}
              headSeq={headSeq}
              clockMode={dashboardStats.clockMode}
              paused={paused}
              leading={<AgentPauseControl orgSlug={slug} paused={paused} canPause={can(role, "agent.pause")} canResume={can(role, "agent.resume")} />}
            />
          }
        />
        {/* The agent decides within a minute of an event (an invoice added, a payable returned): the page
            re-reads its data every 20 s, and at once on return to the tab, so the decision appears without a reload. */}
        <AutoRefresh intervalMs={20_000} />

        {checklist && <GettingStarted slug={slug} checklist={checklist} isOwner={can(role, "org.administer")} />}

        {sampleOffered && <SampleDataOffer orgSlug={slug} />}
        {sampleLoaded && <SampleDataLoaded orgSlug={slug} canRemove={can(role, "records.write")} />}

        {since != null && <CycleReport entries={cycleEntries} day={dashboardStats.day} since={since} clockMode={dashboardStats.clockMode} completedAt={dashboardStats.lastCycleAt} orgSlug={slug} />}

        <div className="mb-8 grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 xl:grid-cols-4">
          <BalanceTile
            accounts={accounts}
            mode={balanceTileMode(modes.mode, accountsRows)}
            orgSlug={slug}
            refreshAction={refreshOnChainBalanceAction}
            syncedAt={accountsRows.find((account) => account.kind === "operating" && account.circle_wallet_id)?.balance_synced_at ?? null}
          />
          <StatTile label="Paid out to date" sub={`${dashboardStats.onchainTransfers} settled on-chain`}>
            <Money value={dashboardStats.totalPaidOut} />
          </StatTile>
          <StatTile label="Decisions logged" href={orgHref(slug, "/audit")} sub="Every entry is hash-linked and signed">
            <span className="tabular-nums">{dashboardStats.decisionsLogged}</span>
          </StatTile>
          <StatTile label="Needs you" tone={needsReview > 0 ? "held" : "default"} href={orgHref(slug, "/approvals")} sub={needsReview > 0 ? "Waiting for a person's decision" : "Nothing waiting"}>
            <span className="tabular-nums">{needsReview}</span>
          </StatTile>
        </div>

        <div className="grid grid-cols-1 gap-8 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0 space-y-8">
            {stopped.length > 0 && (
              <section>
                <SectionHeader title="Stopped" meta="refused by code, or waiting for you" />
                <div className="space-y-4">{stopped.slice(0, 3).map((decision) => <DecisionCard key={decision.id} decision={decision} orgSlug={slug} />)}</div>
              </section>
            )}

            {scheduledPayments.length > 0 && <ScheduledPayments payments={scheduledPayments} />}

            <section>
              <SectionHeader title="Treasury decisions" meta="yield moves include their economics" action={<MoreLink href={orgHref(slug, "/audit?domain=treasury")}>Full audit log</MoreLink>} />
              {treasuryDecisions.length === 0 ? (
                <EmptyState compact title="No treasury decisions yet" body="Run an agent cycle to see why cash was swept, redeemed, or held liquid." />
              ) : (
                <div className="space-y-4">{treasuryDecisions.map((decision) => <DecisionCard key={decision.id} decision={decision} orgSlug={slug} />)}</div>
              )}
            </section>

            {executedReserveMoves.length > 0 && (
              <section>
                <SectionHeader title="Executed reserve movements" meta="recorded treasury actions" />
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
