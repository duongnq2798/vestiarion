import { randomUUID } from "node:crypto";
import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CrmDealChanges } from "@/components/CrmDealChanges";
import { DocsLink } from "@/components/DocsLink";
import { DealChangeForm } from "@/components/deals/DealChangeForm";
import { AutoReleaseSwitch, CancelDealButton } from "@/components/deals/DealControls";
import { DealSchedule, DealVersions } from "@/components/deals/DealSchedule";
import { dealStanding } from "@/components/deals/DealsSection";
import { DealMoney } from "@/components/deals/DealMoney";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { IntakeFold } from "@/components/vx/IntakeFold";
import { StatTile } from "@/components/vx/StatTile";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { viewerCan } from "@/lib/auth/authorize";
import { requireMembership } from "@/lib/auth/membership";
import { orgHref } from "@/lib/auth/org-paths";
import { shellModes } from "@/lib/circle";
import { utcDay } from "@/lib/copy";
import { crmChangesFor, type CrmDealChanges as CrmChangesRead } from "@/lib/connectors/crm-review";
import { inOrg } from "@/lib/dal/scope";
import { dealSummary, inForce } from "@/lib/deals/lines";
import { formatMinor } from "@/lib/deals/money";
import { readDeal } from "@/lib/deals/read";
import { billsHref } from "@/lib/bills-view";
import { stats } from "@/lib/queries";
import { shellStatus } from "@/lib/shell-status";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Deal" };

type DealPageProps = {
  params: Promise<{ slug: string; id: string }>;
  /** `from=hubspot`: Change deal opens filled in from HubSpot's changes (HubSpot connector H12). */
  searchParams: Promise<{ from?: string | string[] }>;
};

/**
 * One deal (docs/superpowers/specs/2026-10-12-deal-schedule-design.md): its schedule with each line's state, Release now,
 * the agent's release switch, Change deal, Cancel deal and Reopen deal for an owner or admin, and every version with what
 * it changed, for every member. An id the workspace does not hold is the workspace's not-found page.
 */
export default async function DealPage({ params, searchParams }: DealPageProps) {
  const { slug, id } = await params;
  const access = await requireMembership(slug);
  const { from } = await searchParams;
  return inOrg(access, async () => {
    const [read, dashboardStats, canWrite] = await Promise.all([readDeal(id), stats(), viewerCan(slug, "records.write")]);
    const shell = { network: access.membership.network, day: dashboardStats.day, clockMode: dashboardStats.clockMode, lastCycleAt: dashboardStats.lastCycleAt, chainModes: shellModes(), status: await shellStatus() };
    const back = (
      <Button asChild variant="link">
        <Link href={`${orgHref(slug, billsHref({ tab: "receivables" }))}#deals`}>
          <ArrowLeft aria-hidden />
          All deals
        </Link>
      </Button>
    );
    if (!read.available) {
      return (
        <ProductShell {...shell}>
          <PageHead title="Deal" right={back} />
          <Callout>Deals are not set up on this deployment yet.</Callout>
        </ProductShell>
      );
    }
    const deal = read.deal;
    if (!deal) notFound();

    const today = new Date().toISOString().slice(0, 10);
    const { facts, digits } = deal;
    // What HubSpot changed since the deal was planned from it (HubSpot connector H12). Best effort: the page stands without it.
    const crm: CrmChangesRead | null = await crmChangesFor({ id: facts.id, status: facts.status, currency: facts.currency }).catch((error: unknown) => {
      console.error("deal: changes from HubSpot not read", error instanceof Error ? error.message : error);
      return null;
    });
    const changeFromCrm = crm !== null && from === "hubspot" && facts.status === "active";
    const summary = dealSummary(facts, today);
    const standing = dealStanding(deal, today);
    const money = (minor: number) => <DealMoney minor={minor} digits={digits} currency={facts.currency} />;
    const stopping = inForce(facts.lines).filter((line) => line.status === "planned" && line.kind === "charge");
    const signedAt = deal.versions[0]?.createdAt ?? deal.createdAt;

    return (
      <ProductShell {...shell}>
        <PageHead
          title={deal.title}
          sub={
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>{deal.customer.name}</span>
              <Badge size="sm" tone={standing.tone} dot>
                {standing.label}
              </Badge>
              <span className="text-ink-3">
                Version {facts.version} · signed {utcDay(signedAt)} · payment terms {facts.termsDays} {facts.termsDays === 1 ? "day" : "days"}
                {deal.externalRef ? ` · reference ${deal.externalRef}` : ""}
              </span>
            </span>
          }
          right={
            <div className="flex shrink-0 items-center gap-3">
              <DocsLink href="/docs/guides/deals" topic="deals" />
              {back}
            </div>
          }
        />

        <div className="mb-6 grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 xl:grid-cols-5">
          <StatTile label="Total" sub={summary.creditMinor < 0 ? <>Includes a credit owed of {money(-summary.creditMinor)}</> : `In ${inForce(facts.lines).length} lines`}>
            {money(summary.totalMinor)}
          </StatTile>
          <StatTile label="Released" sub="Made receivables">
            {money(summary.releasedMinor)}
          </StatTile>
          <StatTile label="Paid" sub="Received from the customer">
            {money(summary.paidMinor)}
          </StatTile>
          <StatTile label="Outstanding" tone={summary.overdueMinor > 0 ? "held" : "default"} sub={summary.overdueMinor > 0 ? <>Expected, {money(summary.overdueMinor)} overdue</> : "Expected, not cash until paid"}>
            {money(summary.outstandingMinor)}
          </StatTile>
          <StatTile label="Planned" sub={summary.next ? <>Next: {summary.next.label}, {utcDay(`${summary.next.invoiceOn}T00:00:00Z`)}</> : "Nothing left to invoice"}>
            {money(summary.plannedMinor)}
          </StatTile>
        </div>

        <div className="space-y-8">
          {crm && <CrmDealChanges orgSlug={slug} dealId={facts.id} label={crm.label} words={crm.words} canWrite={canWrite} active={facts.status === "active"} />}
          <DealSchedule orgSlug={slug} deal={deal} today={today} canWrite={canWrite} />

          {canWrite ? (
            <section aria-labelledby="deal-controls-title" className="space-y-4">
              <h2 id="deal-controls-title" className="text-base font-semibold text-ink">
                Change this deal
              </h2>
              {facts.status === "active" ? (
                <>
                  <div className="flex flex-wrap items-start gap-3">
                    <AutoReleaseSwitch orgSlug={slug} dealId={facts.id} on={facts.autoRelease} />
                    <CancelDealButton
                      orgSlug={slug}
                      dealId={facts.id}
                      baseVersion={facts.version}
                      idempotencyKey={randomUUID()}
                      stops={
                        stopping.length === 0
                          ? "nothing more, as every line is released"
                          : `${stopping.length} ${stopping.length === 1 ? "line" : "lines"} not invoiced yet, ${formatMinor(
                              stopping.reduce((sum, line) => sum + line.amountMinor, 0),
                              digits
                            )} ${facts.currency}`
                      }
                    />
                  </div>
                  <p className="text-xs text-ink-3">
                    {facts.autoRelease
                      ? "The agent releases each line on its invoice day, at its next cycle that day."
                      : "A person releases each line with Release now."}
                  </p>
                  <div id="change" className="scroll-mt-6">
                    <IntakeFold
                      label="Change deal"
                      meta={changeFromCrm ? `filled in from what ${crm.label} changed: check it, then save it as a new version` : "a new price, a moved or renamed line, a line added or removed: saved as a new version"}
                      defaultOpen={changeFromCrm}
                      className=""
                    >
                      <DealChangeForm
                        orgSlug={slug}
                        facts={facts}
                        digits={digits}
                        today={today}
                        idempotencyKey={randomUUID()}
                        mode="revised"
                        {...(changeFromCrm ? { fromCrm: crm.prefill } : {})}
                      />
                    </IntakeFold>
                  </div>
                </>
              ) : (
                <IntakeFold label="Reopen deal" meta="new lines for what is left to invoice, saved as a new version" className="">
                  <DealChangeForm orgSlug={slug} facts={facts} digits={digits} today={today} idempotencyKey={randomUUID()} mode="reopened" />
                </IntakeFold>
              )}
            </section>
          ) : (
            <Callout>Only an owner or admin of this workspace can release, change or cancel a deal.</Callout>
          )}

          <DealVersions deal={deal} />
        </div>
      </ProductShell>
    );
  });
}
