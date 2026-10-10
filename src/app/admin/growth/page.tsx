import { Download, Search } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CampaignForm, RevenueForm, SpendForm } from "@/components/growth/GrowthForms";
import { ApprovalCard, BreakdownTable, Definitions, FilterLinks, FunnelTable, LeadCard, RateTile, Section, Tile, WorkspacesTable } from "@/components/growth/GrowthSections";
import { LeadsCsvImport } from "@/components/growth/LeadsCsvImport";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { Disclosure } from "@/components/ui/Disclosure";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import { utcMinute } from "@/lib/copy";
import { DEFINITIONS } from "@/lib/growth/definitions";
import { ALL_STAGES, REVENUE_WORDS, REVIEW_STATUSES, REVIEW_WORDS, STAGE_WORDS, words } from "@/lib/growth/fields";
import { growthTeamUser } from "@/lib/growth/gate";
import { breakdown, furthestStages, growthMetrics, NOT_ENOUGH_DATA } from "@/lib/growth/metrics";
import { readGrowth } from "@/lib/growth/read";
import { growthHref, parseGrowthView } from "@/lib/growth/view";
import { NETWORK_IDS, networkOf, networkProfile } from "@/lib/network";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Growth",
  robots: { index: false, follow: false },
};

interface GrowthPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const money = (amount: number) => amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * The founder dashboard: where workspaces come from and how the leads the team finds progress, for the team only.
 * Anyone not signed in, or signed in but off platform_team, gets the same 404 as an address that does not exist, so
 * the page never says it is here; it is in no navigation and no sitemap, and asks not to be indexed. Read on every
 * request, every time in UTC. Nothing on it sends a message to anyone: approving a lead records a decision only.
 */
export default async function GrowthPage({ searchParams }: GrowthPageProps) {
  const user = await growthTeamUser();
  if (!user) notFound();
  const now = new Date();
  const view = parseGrowthView(await searchParams, now);
  const data = await readGrowth(view.sinceAt);

  const inWindow = <T,>(rows: T[], day: (row: T) => string) => rows.filter((row) => day(row).slice(0, 10) >= view.since);
  const windowLeads = inWindow(data.leads, (lead) => lead.created_at);
  const metrics = growthMetrics({
    leads: windowLeads,
    events: data.events,
    workspaces: data.workspaces ?? [],
    spend: inWindow(data.spend, (row) => row.spent_on),
    revenue: inWindow(data.revenue, (row) => row.occurred_on),
    now,
  });
  const furthest = furthestStages(data.leads, data.events);
  const campaignName = new Map(data.campaigns.map((campaign) => [campaign.id, campaign.name]));
  const eventsByLead = new Map<string, typeof data.events>();
  for (const event of data.events) eventsByLead.set(event.lead_id, [...(eventsByLead.get(event.lead_id) ?? []), event]);

  const queue = data.leads.filter((lead) => lead.review_status === "needs_review");
  const shownLeads = data.leads
    .filter((lead) => !view.campaign || (view.campaign === "none" ? lead.campaign_id === null : lead.campaign_id === view.campaign))
    .filter((lead) => !view.stage || lead.stage === view.stage)
    .filter((lead) => !view.review || lead.review_status === view.review)
    .reverse();
  const workspaces = (data.workspaces ?? []).filter((workspace) => workspace.side === view.side);
  const today = now.toISOString().slice(0, 10);

  return (
    <main id="main" className="mx-auto w-full max-w-6xl space-y-10 px-4 py-8 sm:px-6 sm:py-10">
      <header className="space-y-3">
        <p className="font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.11em] text-ink-3">Team only</p>
        <h1 className="text-3xl font-semibold tracking-[-0.03em] text-ink">Growth</h1>
        <p className="max-w-3xl text-sm leading-relaxed text-ink-2">
          Where workspaces come from and how leads progress. Read at {utcMinute(now.toISOString())}. Every figure counts from {view.since} (UTC). Vestiarion never
          sends outreach: everything here is a record the team keeps.
        </p>
        <form method="get" action="/admin/growth" className="flex flex-wrap items-end gap-2">
          <label htmlFor="growth-since" className="grid gap-1 text-sm font-medium text-ink">
            Since (UTC)
            <Input id="growth-since" name="since" type="date" size="sm" defaultValue={view.since} max={today} className="w-44" />
          </label>
          {view.side === "ours" && <input type="hidden" name="side" value="ours" />}
          <Button type="submit" variant="secondary" size="sm" icon={<Search />}>
            Show
          </Button>
        </form>
        {view.sinceFallback && <Callout tone="held">That day could not be read, so the default is shown.</Callout>}
        {!data.ready && (
          <Callout tone="held" title="The growth tables are not there yet">
            Migration 0099 has not run on this database. The product funnel still shows; leads, campaigns, spend and revenue appear once it runs.
          </Callout>
        )}
      </header>

      <Section id="funnel" title="Product funnel" meta="open_funnel, one network at a time, never added together">
        <div className="grid gap-4 lg:grid-cols-2">
          {NETWORK_IDS.map((network) => (
            <FunnelTable key={network} network={network} sides={data.funnels[network]} />
          ))}
        </div>
      </Section>

      <Section id="metrics" title="Figures" meta={`Since ${view.since}, UTC`}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile label="Leads sourced" value={metrics.leadsSourced} detail="Leads added in the window." />
          <Tile label="Qualified" value={metrics.qualified} detail={`${metrics.qualified} of ${metrics.leadsSourced} leads reached qualified.`} />
          <Tile label="Contacts sent" value={metrics.contacted} detail={`${metrics.contacted} of ${metrics.leadsSourced} leads reached contacted.`} />
          <RateTile label="Response rate" rate={metrics.responseRate} of="contacted leads replied" />
          <RateTile label="Qualified conversation rate" rate={metrics.conversationRate} of="contacted leads reached a conversation" />
          <RateTile label="Workspace signup conversion" rate={metrics.signupConversion} of="contacted leads opened a workspace" />
          <RateTile label="Real-invoice activation" rate={metrics.activation} of="customer workspaces had a decision on a real bill" />
          <Tile
            label="Median minutes to first decision"
            value={metrics.medianMinutesToFirstDecision.value === null ? NOT_ENOUGH_DATA : Math.round(metrics.medianMinutesToFirstDecision.value)}
            detail={`Across ${metrics.medianMinutesToFirstDecision.workspaces} customer ${metrics.medianMinutesToFirstDecision.workspaces === 1 ? "workspace" : "workspaces"} with a decision.`}
            muted={metrics.medianMinutesToFirstDecision.value === null}
          />
          <RateTile label="7-day repeat rate" rate={metrics.repeat7d} of="customer workspaces with a first real bill 7 days old added a second within 7 days" />
          <RateTile label="Paid pilot conversion" rate={metrics.paidPilotConversion} of="leads in conversation reached a paid pilot" />
          <Tile
            label="Verified software revenue"
            value={metrics.revenue.length === 0 ? "None received" : metrics.revenue.map((row) => `${money(row.amount)} ${row.currency}`).join(" · ")}
            detail="Payments received only, per currency, never converted. Not payment volume."
            muted={metrics.revenue.length === 0}
          />
          <Tile label="Cash spend" value={`${money(metrics.cashSpendUsd)} USD`} detail="Logged spend in the window." />
          <Tile label="Founder hours" value={metrics.founderHours} detail="Logged hours in the window." />
          <Tile
            label="Cost per activated customer"
            value={metrics.costPerActivated.value === null ? NOT_ENOUGH_DATA : `${money(metrics.costPerActivated.value)} USD`}
            detail={`${money(metrics.costPerActivated.spendUsd)} USD over ${metrics.costPerActivated.activated} ${metrics.costPerActivated.activated === 1 ? "lead" : "leads"} that reached real invoice reviewed.`}
            muted={metrics.costPerActivated.value === null}
          />
        </div>
        {metrics.activationByNetwork.length > 0 && (
          <p className="text-xs text-ink-3">
            Activation by network:{" "}
            {metrics.activationByNetwork
              .map(({ network, rate }) => `${networkProfile(networkOf(network)).label} ${rate.numerator} / ${rate.denominator}`)
              .join(" · ")}
          </p>
        )}
      </Section>

      <Section id="workspaces" title="Workspaces" meta={`${workspaces.length} opened since ${view.since}`}>
        <FilterLinks
          label="Whose"
          allLabel="Customers"
          options={[{ value: "ours", label: "Ours" }]}
          chosen={view.side === "ours" ? "ours" : null}
          href={(value) => growthHref(view, { side: value === "ours" ? "ours" : "customers" }, "#workspaces")}
        />
        {data.workspaces === null ? (
          <Callout tone="held">The workspaces could not be read.</Callout>
        ) : workspaces.length === 0 ? (
          <EmptyState compact title={view.side === "ours" ? "None of ours opened in the window" : "No customer workspace opened in the window"} />
        ) : (
          <WorkspacesTable workspaces={workspaces} now={now} />
        )}
      </Section>

      <Section id="breakdowns" title="Leads by source, segment and campaign" meta="Reached each stage or beyond, leads added in the window">
        {windowLeads.length === 0 ? (
          <EmptyState compact title="No leads in the window" body="Import a CSV below to start." />
        ) : (
          <div className="space-y-4">
            <BreakdownTable title="Source" rows={breakdown(windowLeads, furthest, (lead) => lead.source)} />
            <BreakdownTable title="Segment" rows={breakdown(windowLeads, furthest, (lead) => lead.segment)} />
            <BreakdownTable title="Campaign" rows={breakdown(windowLeads, furthest, (lead) => lead.campaign_id)} label={(key) => campaignName.get(key) ?? words(key)} />
          </div>
        )}
      </Section>

      <Section id="approvals" title="Approval queue" meta={`${queue.length} waiting`}>
        <Callout tone="neutral">Approving records a decision only. Vestiarion never sends outreach.</Callout>
        {queue.length === 0 ? (
          <EmptyState compact title="Nothing waiting for review" />
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {queue.map((lead) => (
              <ApprovalCard key={lead.id} lead={lead} />
            ))}
          </div>
        )}
      </Section>

      <Section id="leads" title="Leads" meta={`${shownLeads.length} of ${data.leads.length}, newest first`}>
        <div className="space-y-2">
          <FilterLinks
            label="Campaign"
            options={[...data.campaigns.map((campaign) => ({ value: campaign.id, label: campaign.name })), { value: "none", label: "No campaign" }]}
            chosen={view.campaign}
            href={(value) => growthHref(view, { campaign: value }, "#leads")}
          />
          <FilterLinks label="Stage" options={ALL_STAGES.map((stage) => ({ value: stage, label: STAGE_WORDS[stage] }))} chosen={view.stage} href={(value) => growthHref(view, { stage: value as typeof view.stage }, "#leads")} />
          <FilterLinks
            label="Review"
            options={REVIEW_STATUSES.map((status) => ({ value: status, label: REVIEW_WORDS[status] }))}
            chosen={view.review}
            href={(value) => growthHref(view, { review: value as typeof view.review }, "#leads")}
          />
        </div>
        {shownLeads.length === 0 ? (
          <EmptyState compact title="No leads match" />
        ) : (
          <div className="space-y-2">
            {shownLeads.map((lead) => (
              <LeadCard
                key={lead.id}
                lead={lead}
                events={eventsByLead.get(lead.id) ?? []}
                campaignName={lead.campaign_id ? (campaignName.get(lead.campaign_id) ?? lead.campaign_id) : null}
                viewer={user.id}
                slugs={data.workspaceSlugs}
              />
            ))}
          </div>
        )}
      </Section>

      <Section id="import" title="Import and export leads">
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="secondary" size="sm" icon={<Download />}>
            <Link href="/admin/growth/leads.csv" prefetch={false}>
              Export all leads (CSV)
            </Link>
          </Button>
        </div>
        <Card className="p-4 sm:p-5">
          <LeadsCsvImport />
        </Card>
      </Section>

      <Section id="campaigns" title="Campaigns" meta={`${data.campaigns.length} recorded`}>
        <div className="space-y-2">
          {data.campaigns.map((campaign) => (
            <Disclosure
              key={campaign.id}
              summary={
                <span className="flex flex-wrap items-baseline gap-x-3">
                  <span className="font-medium text-ink">{campaign.name}</span>
                  <span className="font-mono text-xs text-ink-3">{campaign.id}</span>
                  <span className="text-xs text-ink-3">{words(campaign.status)}</span>
                </span>
              }
            >
              <CampaignForm campaign={campaign} idPrefix={campaign.id} />
            </Disclosure>
          ))}
          <Disclosure summary="Add a campaign" defaultOpen={data.campaigns.length === 0}>
            <CampaignForm />
          </Disclosure>
        </div>
      </Section>

      <Section id="spend" title="Spend and hours">
        <Card className="p-4 sm:p-5">
          <SpendForm campaigns={data.campaigns} today={today} />
        </Card>
        {data.spend.length > 0 && (
          <Table label="Spend logged" containerClassName="rounded-xl border border-line bg-surface" className="min-w-[32rem] text-[0.8125rem]">
            <TableHeader>
              <TableRow>
                <TableHead className="px-3">Day</TableHead>
                <TableHead className="px-3">Campaign</TableHead>
                <TableHead className="px-3 text-right">USD</TableHead>
                <TableHead className="px-3 text-right">Hours</TableHead>
                <TableHead className="px-3">Note</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...data.spend].reverse().map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="px-3 whitespace-nowrap">{row.spent_on}</TableCell>
                  <TableCell className="px-3 text-ink-2">{row.campaign_id ? (campaignName.get(row.campaign_id) ?? row.campaign_id) : "None"}</TableCell>
                  <TableCell className="px-3 text-right tabular-nums">{money(row.usd)}</TableCell>
                  <TableCell className="px-3 text-right tabular-nums">{row.founder_hours}</TableCell>
                  <TableCell className="px-3 text-ink-2">{row.note}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section id="revenue" title="Revenue events" meta="Only a payment received counts as revenue">
        <Card className="p-4 sm:p-5">
          <RevenueForm leads={data.leads.map((lead) => ({ id: lead.id, name: lead.business_name }))} today={today} />
        </Card>
        {data.revenue.length > 0 && (
          <Table label="Revenue events" containerClassName="rounded-xl border border-line bg-surface" className="min-w-[36rem] text-[0.8125rem]">
            <TableHeader>
              <TableRow>
                <TableHead className="px-3">Day</TableHead>
                <TableHead className="px-3">What happened</TableHead>
                <TableHead className="px-3 text-right">Amount</TableHead>
                <TableHead className="px-3">Lead or workspace</TableHead>
                <TableHead className="px-3">Reference</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...data.revenue].reverse().map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="px-3 whitespace-nowrap">{row.occurred_on}</TableCell>
                  <TableCell className="px-3">{REVENUE_WORDS[row.kind]}</TableCell>
                  <TableCell className="px-3 text-right tabular-nums">{row.amount === null ? "None" : `${money(row.amount)} ${row.currency ?? ""}`}</TableCell>
                  <TableCell className="px-3 text-ink-2">
                    {[row.lead_id && data.leads.find((lead) => lead.id === row.lead_id)?.business_name, row.org_id && data.workspaceSlugs[row.org_id]].filter(Boolean).join(" · ") || "None"}
                  </TableCell>
                  <TableCell className="px-3 text-ink-2">{row.reference}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section id="definitions" title="Definitions" meta="Every time is UTC">
        <Definitions definitions={DEFINITIONS} />
      </Section>
    </main>
  );
}
