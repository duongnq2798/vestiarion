import type { Metadata } from "next";
import Link from "next/link";
import { refreshOnChainBalanceAction } from "@/app/actions/treasury";
import { AutoRefresh } from "@/components/AutoRefresh";
import AgentControls from "@/components/AgentControls";
import { AgentBudgetPanel } from "@/components/AgentBudgetPanel";
import AgentPauseControl from "@/components/AgentPauseControl";
import { GatewayPanel } from "@/components/GatewayPanel";
import { ServiceBudgetPanel } from "@/components/ServiceBudgetPanel";
import { SampleDataLoaded, SampleDataOffer } from "@/components/SampleDataPanel";
import ShadowModeSummary from "@/components/ShadowModeSummary";
import VerdictControl from "@/components/VerdictControl";
import { WaitingPayableAction } from "@/components/WaitingPayableAction";
import { CycleReport } from "@/components/vx/CycleReport";
import { DecisionCard } from "@/components/vx/DecisionCard";
import { GettingStarted } from "@/components/vx/GettingStarted";
import { invoiceDecision, treasuryActionDecision, treasuryDecisionEntries, treasuryLedgerDecision } from "@/components/vx/map";
import { Money } from "@/components/vx/Primitives";
import { CashOutlookPanel, SafeToSpendFigure } from "@/components/vx/CashOutlook";
import { ScheduledPayments, scheduledPaymentRows } from "@/components/vx/ScheduledPayments";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { sectionTitle } from "@/components/vx/nav";
import { AccountsList, BalanceTile, balanceTileMode, ForecastPanel, MoreLink, StatTile } from "@/components/vx/Treasury";
import type { Account, Forecast } from "@/components/vx/types";
import { agentBudgetStatus } from "@/lib/agent-budget";
import { listWaitingPayables } from "@/lib/agent/approvals";
import { addedSince, latestDecision, recordedFacts } from "@/lib/added-details";
import { CASH_SHORTFALL, SHADOW_VERDICT } from "@/lib/next-step";
import { requireMembership } from "@/lib/auth/membership";
import { orgHref } from "@/lib/auth/org-paths";
import { can } from "@/lib/auth/roles";
import { chainModes, paymentsHeld } from "@/lib/circle";
import { readGatewayState } from "@/lib/circle/gateway-funding";
import { spendingLimitStatus } from "@/lib/circle/spending-limit-setup";
import { readServiceBudget } from "@/lib/service-budget";
import { db } from "@/lib/dal";
import { inOrg } from "@/lib/dal/scope";
import { gettingStarted, ownBillCount, ownDecidedCount, ownPayableCount } from "@/lib/getting-started";
import { listLedgerEntries, listLedgerEntriesAfter, listLedgerEntriesByDomain, listLedgerEntriesForTargets } from "@/lib/ledger";
import { pauseStateOf } from "@/lib/platform/pause";
import { cashOutlook } from "@/lib/cash-outlook";
import { latestForecast, listAccounts, listCounterparties, listInvoices, listMilestones, listTreasuryActions, stats } from "@/lib/queries";
import { readShadowMode, SHADOW_NOT_STARTED } from "@/lib/shadow-mode";
import { readShadowSummary, verdictFacts } from "@/lib/verdicts";
import { readTestUsdcWeek, testUsdcAvailable } from "@/lib/test-usdc";
import { testUsdcView } from "@/lib/test-usdc-rules";
import { txUrl } from "@/lib/payee-chains";
import { offerSampleData } from "@/lib/sample-data-offer";
import { workspaceNetwork } from "@/lib/workspace-network";
import { networkProfile } from "@/lib/network";
import { currentOrgConfig } from "@/lib/context";
import { walletTreasuryAvailable } from "@/lib/config";
import { shellStatus } from "@/lib/shell-status";

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
    // A workspace paying from its owner's own wallet (wallet treasury W12): its operating account is that wallet's address.
    const walletHost = currentOrgConfig().chain.walletHost ?? null;
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
    // Gateway, and the service budget it funds, exist only on a network that has it (mainnet copy C3).
    const gatewayHere = access.membership.mode === "live" && Boolean(networkProfile(access.membership.network).gateway);
    const [invoiceEntries, treasuryEntries, cycleEntries, gateway, serviceBudget] = await Promise.all([
      listLedgerEntriesForTargets({ invoiceIds: invoices.map((invoice) => invoice.id) }),
      // The latest two decisions, read from enough entries that swaps and Gateway steps in between do not crowd them out.
      listLedgerEntriesByDomain("treasury", 30),
      since == null ? Promise.resolve([]) : listLedgerEntriesAfter(since),
      // A live workspace's Gateway balance (Gateway payouts G5), read alongside the ledger rather than
      // after it (review M4). Best effort: a read that fails shows no panel.
      gatewayHere
        ? readGatewayState().catch((error: unknown) => {
            console.error("console: Gateway state not loaded", access.membership.orgId, error instanceof Error ? error.message : error);
            return null;
          })
        : Promise.resolve(null),
      // The agent's service budget (x402 payee history R4), once the workspace has a Gateway signer. Best effort.
      gatewayHere
        ? readServiceBudget().catch((error: unknown) => {
            console.error("console: service budget not loaded", access.membership.orgId, error instanceof Error ? error.message : error);
            return null;
          })
        : Promise.resolve(null),
    ]);
    const canDecide = can(access.membership.role, "approval.decide");
    // In shadow mode, each card carries a person's verdict on the agent's decision (shadow mode S3), and the console
    // says how often people agreed (S5). Best effort, like the reads above.
    const [verdicts, shadow] = await Promise.all([
      verdictFacts(db(), invoiceEntries, canDecide),
      readShadowMode(db()).catch((error: unknown) => {
        console.error("console: shadow mode not loaded", access.membership.orgId, error instanceof Error ? error.message : error);
        return null;
      }),
    ]);
    // In shadow mode the section also offers test USDC for what the open bills need (test USDC T8); best effort too.
    const [shadowSummary, testUsdcWeek] = shadow
      ? await Promise.all([
          readShadowSummary(db(), shadow).catch((error: unknown) => {
            console.error("console: shadow summary not loaded", access.membership.orgId, error instanceof Error ? error.message : error);
            return null;
          }),
          readTestUsdcWeek().catch((error: unknown) => {
            console.error("console: test USDC not loaded", access.membership.orgId, error instanceof Error ? error.message : error);
            return null;
          }),
        ])
      : [null, null];
    const invoiceDecisions = invoices.map((invoice) =>
      invoiceDecision(invoice, counterpartiesById.get(invoice.counterparty_id), invoiceEntries, { network, verdicts })
    );
    const stopped = invoiceDecisions.filter((decision) => decision.outcome === "refused" || decision.outcome === "held");
    // A stopped payable's card says what stopped it and where to handle it (agent activity spec R5), as on Bills & receivables.
    const invoicesById = new Map(invoices.map((invoice) => [invoice.id, invoice]));
    const canWrite = can(access.membership.role, "records.write");
    const waitingStepFor = (decision: (typeof stopped)[number]) => {
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
          rule={decision.guardrail?.rule ?? (decision.heldForCash ? CASH_SHORTFALL : decision.heldForVerdict ? SHADOW_VERDICT : null)}
          canFix={canWrite}
        />
      );
    };
    // The verdict first: a payment held for it asks for nothing else; any other card keeps its next step below it.
    const nextStepFor = (decision: (typeof stopped)[number]) => {
      const step = waitingStepFor(decision);
      if (!decision.verdict) return step;
      const verdict = <VerdictControl orgSlug={slug} view={decision.verdict} />;
      if (decision.verdict.heldForVerdict && decision.verdict.open) return verdict;
      return step ? (
        <div className="space-y-3">
          {verdict}
          {step}
        </div>
      ) : (
        verdict
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
    // What the open bills need beyond the wallet, and for an owner or admin the test USDC to cover it (test USDC T8).
    const operatingAccount = accountsRows.find((account) => account.kind === "operating");
    const testUsdc = testUsdcWeek
      ? {
          view: testUsdcView({
            safeToSpend: outlook.safeToSpend,
            takenThisWeek: testUsdcWeek.takenThisWeek,
            weeklyLimit: testUsdcWeek.weeklyLimit,
            available: access.membership.mode === "live" && network === "arc-testnet" && testUsdcAvailable() && Boolean(operatingAccount?.address),
            canAdd: can(access.membership.role, "records.write"),
          }),
          latest: testUsdcWeek.latest,
          operatingAddress: operatingAccount?.address ?? null,
          latestTxUrl: testUsdcWeek.latest?.txHash ? txUrl(network, testUsdcWeek.latest.txHash) : null,
        }
      : undefined;
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
    // admins add records, and an owner takes the workspace live. In shadow mode it has steps of its own: suppliers, real
    // bills and a first verdict, from the shadow mode and verdicts read above. A sandbox with no wallet starts with its
    // first bill and the agent's decision on it, from the invoices read above.
    const checklist = can(role, "records.write")
      ? gettingStarted({
          mode: access.membership.mode,
          accounts: accountsRows,
          counterparties,
          payableCount: ownPayableCount(invoices, counterparties),
          billCount: ownBillCount(invoices, counterparties),
          decidedCount: ownDecidedCount(invoices, counterparties),
          onchainPayments: dashboardStats.onchainTransfers,
          waitingCount: needsReview,
          network,
          walletHost,
          walletTreasuryAvailable: walletTreasuryAvailable(currentOrgConfig(), networkProfile(network)),
          shadow: shadow
            ? { currency: shadow.currency, verdictsGiven: (shadowSummary?.agreed ?? 0) + (shadowSummary?.disagreed ?? 0), billCount: ownBillCount(invoices, counterparties) }
            : null,
        })
      : null;
    // Sample data (sample-data design §1): offered in an empty simulated sandbox, and called out while it is loaded.
    const sampleOffered = offerSampleData({
      canWrite: can(role, "records.write"),
      mode: access.membership.mode,
      chainMode: modes.mode,
      counterpartyCount: counterparties.length,
      network: access.membership.network,
    });
    const sampleLoaded = counterparties.some((counterparty) => counterparty.sample);

    return (
      <ProductShell network={access.membership.network} day={dashboardStats.day} clockMode={dashboardStats.clockMode} lastCycleAt={dashboardStats.lastCycleAt} chainModes={{ ...modes, held: paymentsHeld() }} status={await shellStatus()}>
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

        {/* Shadow mode asked for as the workspace was created, and not turned on: the workspace is there, and Settings turns it on. */}
        {query.shadow === SHADOW_NOT_STARTED && !shadow && (
          <Callout tone="held" className="mb-8">
            Your workspace is ready, but shadow mode did not turn on.{" "}
            <Link href={orgHref(slug, "/settings#shadow-mode-title")} className="font-medium text-agent underline-offset-2 hover:underline">
              Turn it on in Settings
            </Link>
            .
          </Callout>
        )}

        {checklist && <GettingStarted slug={slug} checklist={checklist} isOwner={can(role, "org.administer")} />}

        {sampleOffered && <SampleDataOffer orgSlug={slug} />}
        {sampleLoaded && <SampleDataLoaded orgSlug={slug} canRemove={can(role, "records.write")} />}

        {since != null && <CycleReport entries={cycleEntries} day={dashboardStats.day} since={since} clockMode={dashboardStats.clockMode} completedAt={dashboardStats.lastCycleAt} orgSlug={slug} />}

        {/* One container for the figures and the columns under them: from 64rem of content the last figure sits over the
            aside, the same width, so the page reads in two clean columns (workspace shell design S8). */}
        <div className="@container">
          <div className="mb-8 grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 @4xl:grid-cols-4 @5xl:grid-cols-[repeat(3,minmax(0,1fr))_22rem] @5xl:gap-6 @7xl:grid-cols-[repeat(3,minmax(0,1fr))_24rem]">
            <BalanceTile
              accounts={accounts}
              mode={balanceTileMode(modes.mode, accountsRows, walletHost)}
              orgSlug={slug}
              refreshAction={refreshOnChainBalanceAction}
              syncedAt={accountsRows.find((account) => account.kind === "operating" && (account.circle_wallet_id || (walletHost === "external" && account.address)))?.balance_synced_at ?? null}
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

          <div className="grid grid-cols-1 gap-8 @5xl:grid-cols-[minmax(0,1fr)_22rem] @5xl:gap-6 @7xl:grid-cols-[minmax(0,1fr)_24rem]">
            <div className="min-w-0 space-y-8">
              {shadow && shadowSummary && <ShadowModeSummary orgSlug={slug} mode={shadow} summary={shadowSummary} testUsdc={testUsdc} simulated={modes.mode !== "live" && !paymentsHeld()} />}

              {stopped.length > 0 && (
                <section>
                  <SectionHeader
                    title="Stopped"
                    meta="refused by code, or waiting for you"
                    action={stopped.length > 3 ? <MoreLink href={orgHref(slug, "/invoices")}>{`See all ${stopped.length}`}</MoreLink> : undefined}
                  />
                  <div className="space-y-4">
                    {stopped.slice(0, 3).map((decision) => (
                      <DecisionCard key={decision.id} decision={decision} orgSlug={slug} footerAction={nextStepFor(decision)} />
                    ))}
                  </div>
                </section>
              )}

              {scheduledPayments.length > 0 && <ScheduledPayments payments={scheduledPayments} allHref={orgHref(slug, "/invoices")} />}

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
            <aside className="min-w-0 space-y-6 @3xl:grid @3xl:grid-cols-2 @3xl:items-start @3xl:gap-6 @3xl:space-y-0 @5xl:block @5xl:space-y-6">
              {budget && (
                <AgentBudgetPanel
                  walletTreasury={walletHost === "external"}
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
        </div>
      </ProductShell>
    );
  });
}
