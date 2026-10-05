import type { Metadata } from "next";
import { refreshOnChainBalanceAction } from "@/app/actions/treasury";
import { AutoRefresh } from "@/components/AutoRefresh";
import AgentControls from "@/components/AgentControls";
import { AgentBudgetPanel } from "@/components/AgentBudgetPanel";
import AgentPauseControl from "@/components/AgentPauseControl";
import { GatewayPanel } from "@/components/GatewayPanel";
import { ServiceBudgetPanel } from "@/components/ServiceBudgetPanel";
import { SampleDataLoaded, SampleDataOffer } from "@/components/SampleDataPanel";
import { WaitingPayableAction } from "@/components/WaitingPayableAction";
import { CycleReport } from "@/components/vx/CycleReport";
import { DecisionCard } from "@/components/vx/DecisionCard";
import { GettingStarted } from "@/components/vx/GettingStarted";
import { invoiceDecision, treasuryActionDecision, treasuryDecisionEntries, treasuryLedgerDecision } from "@/components/vx/map";
import { Money } from "@/components/vx/Primitives";
import { CashOutlookPanel, SafeToSpendFigure } from "@/components/vx/CashOutlook";
import { ScheduledPayments, scheduledPaymentRows } from "@/components/vx/ScheduledPayments";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { sectionTitle } from "@/components/vx/nav";
import { AccountsList, BalanceTile, balanceTileMode, ForecastPanel, MoreLink, StatTile } from "@/components/vx/Treasury";
import type { Account, Forecast } from "@/components/vx/types";
import { agentBudgetStatus } from "@/lib/agent-budget";
import { listWaitingPayables } from "@/lib/agent/approvals";
import { addedSince, latestDecision, recordedFacts } from "@/lib/added-details";
import { CASH_SHORTFALL } from "@/lib/next-step";
import { requireMembership } from "@/lib/auth/membership";
import { orgHref } from "@/lib/auth/org-paths";
import { can } from "@/lib/auth/roles";
import { chainModes } from "@/lib/circle";
import { readGatewayState } from "@/lib/circle/gateway-funding";
import { spendingLimitStatus } from "@/lib/circle/spending-limit-setup";
import { readServiceBudget } from "@/lib/service-budget";
import { inOrg } from "@/lib/dal/scope";
import { gettingStarted, ownPayableCount } from "@/lib/getting-started";
import { listLedgerEntries, listLedgerEntriesAfter, listLedgerEntriesByDomain, listLedgerEntriesForTargets } from "@/lib/ledger";
import { pauseStateOf } from "@/lib/platform/pause";
import { cashOutlook } from "@/lib/cash-outlook";
import { latestForecast, listAccounts, listCounterparties, listInvoices, listMilestones, listTreasuryActions, stats } from "@/lib/queries";
import { offerSampleData } from "@/lib/sample-data-offer";
import { workspaceNetwork } from "@/lib/workspace-network";

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
    const network = workspaceNetwork().id;
    const query = await searchParams;
    const [accountsRows, actionRows, forecastRow, dashboardStats, invoices, counterparties, headEntries, waiting, pause, milestones, budget, onChainLimit] = await Promise.all([
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
      listMilestones(),
      // The agent's spending limit and what it paid against it (outflow budget spec §4). Best effort: the
      // limit is enforced in the cycle either way; an unreadable one here only hides the panel.
      agentBudgetStatus().catch((error: unknown) => {
        console.error("console: spending limit not loaded", access.membership.orgId, error instanceof Error ? error.message : error);
        return null;
      }),
      // The same limit on Arc, as its contract counts it (onchain spending limit R14). Best effort: the contract
      // enforces it either way; one that cannot be read shows as not set up here.
      spendingLimitStatus().catch((error: unknown) => {
        console.error("console: spending limit on Arc not loaded", access.membership.orgId, error instanceof Error ? error.message : error);
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
    const [invoiceEntries, treasuryEntries, cycleEntries, gateway, serviceBudget] = await Promise.all([
      listLedgerEntriesForTargets({ invoiceIds: invoices.map((invoice) => invoice.id) }),
      // The latest two decisions, read from enough entries that swaps and Gateway steps in between do not crowd them out.
      listLedgerEntriesByDomain("treasury", 30),
      since == null ? Promise.resolve([]) : listLedgerEntriesAfter(since),
      // A live workspace's Gateway balance (Gateway payouts G5), read alongside the ledger rather than
      // after it (review M4). Best effort: a read that fails shows no panel.
      access.membership.mode === "live"
        ? readGatewayState().catch((error: unknown) => {
            console.error("console: Gateway state not loaded", access.membership.orgId, error instanceof Error ? error.message : error);
            return null;
          })
        : Promise.resolve(null),
      // The agent's service budget (x402 payee history R4), once the workspace has a Gateway signer. Best effort.
      access.membership.mode === "live"
        ? readServiceBudget().catch((error: unknown) => {
            console.error("console: service budget not loaded", access.membership.orgId, error instanceof Error ? error.message : error);
            return null;
          })
        : Promise.resolve(null),
    ]);
    const invoiceDecisions = invoices.map((invoice) =>
      invoiceDecision(invoice, counterpartiesById.get(invoice.counterparty_id), invoiceEntries, { network })
    );
    const stopped = invoiceDecisions.filter((decision) => decision.outcome === "refused" || decision.outcome === "held");
    // A stopped payable's card says what stopped it and where to handle it (agent activity spec R5), as on AP / AR.
    const invoicesById = new Map(invoices.map((invoice) => [invoice.id, invoice]));
    const canWrite = can(access.membership.role, "records.write");
    const canDecide = can(access.membership.role, "approval.decide");
    const nextStepFor = (decision: (typeof stopped)[number]) => {
      const invoice = invoicesById.get(decision.id);
      if (!invoice || invoice.direction !== "payable" || !["held", "flagged", "awaiting_info"].includes(invoice.status)) return undefined;
      const onFile = {
        poReference: invoice.po_reference ?? null,
        goodsReceived: invoice.goods_received === true,
        // A counterparty paid without purchase orders is never asked for one (three-way match design M2).
        purchaseOrderRequired: counterpartiesById.get(invoice.counterparty_id)?.purchase_order_required !== false,
      };
      return (
        <WaitingPayableAction
          orgSlug={slug}
          invoice={{ id: invoice.id, counterpartyName: invoice.counterparty_name, counterpartyId: invoice.counterparty_id, ...onFile }}
          added={addedSince(recordedFacts(latestDecision(invoiceEntries, invoice.id)), onFile)}
          canAddDetails={canWrite && invoice.tx_ref === null}
          canDecide={canDecide}
          rule={decision.guardrail?.rule ?? (decision.heldForCash ? CASH_SHORTFALL : null)}
          canFix={canWrite}
        />
      );
    };
    // What the agent will pay next, soonest first (payment timing design §1):
    // derived from the invoices already loaded above, no extra query.
    const scheduledPayments = scheduledPaymentRows(invoices);
    // Safe to spend today and the next 30 days (safe to spend design), from the rows already loaded: the
    // operating wallet's USDC and the USYC reserve's, less what the agent counts as owed.
    const outlook = cashOutlook({
      now: Date.now(),
      operatingUsdc: Number(accountsRows.find((account) => account.kind === "operating")?.balance ?? 0),
      reserveUsdc: Number(accountsRows.find((account) => account.kind === "reserve")?.balance ?? 0),
      payables: invoices
        .filter((invoice) => invoice.direction === "payable")
        .map((invoice) => ({ ...invoice, counterparty: invoice.counterparty_name, currency: invoice.currency ?? null, scheduled_for: invoice.scheduled_for ?? null })),
      milestones: milestones.map((milestone) => ({ ...milestone, contractor: milestone.contractor_name })),
      receivables: invoices
        .filter((invoice) => invoice.direction === "receivable")
        .map((invoice) => ({ ...invoice, counterparty: invoice.counterparty_name, currency: invoice.currency ?? null })),
    });
    const treasuryDecisions = treasuryDecisionEntries(treasuryEntries, 2).map((entry) => treasuryLedgerDecision(entry, network));
    const executedReserveMoves = actionRows.slice(0, 2).map((action) => treasuryActionDecision(action, network));
    const headSeq = headEntries[0]?.seq ?? 0;
    // What the approvals inbox holds for a person, so the tile and the page it links to agree. A row
    // someone else is deciding right now does not need you; one whose claim did not finish does.
    const needsReview = waiting.filter((payable) => payable.status !== "processing" || payable.reclaimable).length;
    const paused = pause !== null;
    const role = access.membership.role;
    // Computed from the rows above, with no extra read (getting-started design G1, G2), until the first
    // payment on Arc testnet (first-payment design §2). Only people who can act on it see it: owners and
    // admins add records, and an owner takes the workspace live.
    const checklist = can(role, "records.write")
      ? gettingStarted({
          mode: access.membership.mode,
          accounts: accountsRows,
          counterparties,
          payableCount: ownPayableCount(invoices, counterparties),
          onchainPayments: dashboardStats.onchainTransfers,
          waitingCount: needsReview,
        })
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
          {/* The figure; how it is reached, and the 30 days behind it, are the Next 30 days section below. */}
          <StatTile label="Safe to spend today" tone={outlook.safeToSpend < 0 ? "held" : "default"} href="#cash-outlook" sub={outlook.reserve > 0 ? "After everything already owed, the USYC reserve included" : "After everything already owed"}>
            <SafeToSpendFigure outlook={outlook} />
          </StatTile>
          <StatTile label="Paid out to date" sub={`${dashboardStats.onchainTransfers} settled on-chain`}>
            <Money value={dashboardStats.totalPaidOut} />
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
                <div className="space-y-4">
                  {stopped.slice(0, 3).map((decision) => (
                    <DecisionCard key={decision.id} decision={decision} orgSlug={slug} footerAction={nextStepFor(decision)} />
                  ))}
                </div>
              </section>
            )}

            {scheduledPayments.length > 0 && <ScheduledPayments payments={scheduledPayments} />}

            <CashOutlookPanel outlook={outlook} />

            <section>
              <SectionHeader
                title="Treasury decisions"
                meta={`${dashboardStats.decisionsLogged} decisions logged, each hash-linked and signed`}
                action={<MoreLink href={orgHref(slug, "/audit?domain=treasury")}>Full audit log</MoreLink>}
              />
              {treasuryDecisions.length === 0 ? (
                <EmptyState compact title="No treasury decisions yet" body="Run an agent cycle to see why cash was swept, redeemed, or held liquid." />
              ) : (
                // Scanned, not read: each shows its first lines, with "View reasoning" for the rest.
                <div className="space-y-4">{treasuryDecisions.map((decision) => <DecisionCard key={decision.id} decision={decision} orgSlug={slug} collapseReasoning />)}</div>
              )}
            </section>

            {executedReserveMoves.length > 0 && (
              <section>
                <SectionHeader title="Executed reserve movements" meta="recorded treasury actions" />
                <div className="space-y-4">{executedReserveMoves.map((decision) => <DecisionCard key={decision.id} decision={decision} compact orgSlug={slug} collapseReasoning />)}</div>
              </section>
            )}
          </div>

          {/* Short by design: the limits and accounts people check, then the funds outside the wallet, whose
              explanations and forms stay folded until someone opens them. */}
          <aside className="min-w-0 space-y-6 md:grid md:grid-cols-2 md:items-start md:gap-6 md:space-y-0 xl:block xl:space-y-6">
            {budget && (
              <AgentBudgetPanel
                network={network}
                orgSlug={slug}
                canEdit={can(role, "agent.budget")}
                live={access.membership.mode === "live"}
                onChain={onChainLimit ? { ...onChainLimit, reading: onChainLimit.reading?.state === "read" ? onChainLimit.reading : null } : null}
                view={{
                  dailyUsdc: budget.budget?.dailyUsdc ?? null,
                  weeklyUsdc: budget.budget?.weeklyUsdc ?? null,
                  spentToday: budget.spent.today,
                  spentThisWeek: budget.spent.week,
                  remaining: budget.room?.remaining ?? null,
                }}
              />
            )}
            <AccountsList accounts={accounts} />
            {forecast && <ForecastPanel forecast={forecast} />}
            {gateway && (
              <GatewayPanel
                orgSlug={slug}
                signerAddress={gateway.signerAddress}
                balanceUsdc={gateway.balanceUsdc}
                canFund={can(role, "treasury.manage")}
                requestId={crypto.randomUUID()}
              />
            )}
            {serviceBudget && (
              <ServiceBudgetPanel orgSlug={slug} budget={serviceBudget} canFund={can(role, "treasury.manage")} requestId={crypto.randomUUID()} />
            )}
          </aside>
        </div>
      </ProductShell>
    );
  });
}
