import { randomUUID } from "node:crypto";
import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CrmDealChanges } from "@/components/CrmDealChanges";
import { DocsLink } from "@/components/DocsLink";
import { DealCashReadiness } from "@/components/deals/DealCashReadiness";
import { DealChangeForm } from "@/components/deals/DealChangeForm";
import { DealCosts } from "@/components/deals/DealCosts";
import { AutoReleaseSwitch, CancelDealButton } from "@/components/deals/DealControls";
import { DealSchedule, DealVersions } from "@/components/deals/DealSchedule";
import { DealFigures, DealHeadSub } from "@/components/deals/DealHead";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { IntakeFold } from "@/components/vx/IntakeFold";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { viewerCan } from "@/lib/auth/authorize";
import { requireMembership } from "@/lib/auth/membership";
import { orgHref } from "@/lib/auth/org-paths";
import { shellModes } from "@/lib/circle";
import { utcDay } from "@/lib/copy";
import { crmChangesFor, type CrmDealChanges as CrmChangesRead } from "@/lib/connectors/crm-review";
import { db } from "@/lib/dal";
import { inOrg } from "@/lib/dal/scope";
import type { DealCost } from "@/lib/deals/costs";
import { readDealCosts, readLinkCandidates, type LinkCandidate } from "@/lib/deals/costs-read";
import { inForce } from "@/lib/deals/lines";
import { formatMinor } from "@/lib/deals/money";
import { readDeal } from "@/lib/deals/read";
import { billsHref } from "@/lib/bills-view";
import { listCounterparties, stats } from "@/lib/queries";
import { shellStatus } from "@/lib/shell-status";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Deal" };

type DealPageProps = {
  params: Promise<{ slug: string; id: string }>;
  /** `from=hubspot`: Change deal opens filled in from HubSpot's changes (HubSpot connector H12). */
  searchParams: Promise<{ from?: string | string[] }>;
};

/**
 * One deal (docs/superpowers/specs/2026-10-12-deal-schedule-design.md): its cash readiness against its costs
 * (docs/superpowers/specs/2026-10-13-deal-cash-readiness-design.md), its schedule with each line's state, its costs,
 * Release now, the agent's release switch, Change deal, Cancel deal and Reopen deal for an owner or admin, and every
 * version with what it changed, for every member. An id the workspace does not hold is the workspace's not-found page.
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
    // The deal's costs, each with what it became (deal cash readiness K2). Best effort: before migration 0108, or when
    // they cannot be read, the page stands without them and the margin says there is not enough data.
    const costs: DealCost[] | null = await readDealCosts([deal], db(), facts.id)
      .then((read) => (read.available ? (read.byDeal.get(facts.id) ?? []) : null))
      .catch((error: unknown) => {
        console.error("deal: costs not read", error instanceof Error ? error.message : error);
        return null;
      });
    // What a cost may be linked to, and who a new one may be for: an owner's or admin's forms only.
    const [candidates, payees] =
      canWrite && costs !== null
        ? await Promise.all([
            readLinkCandidates(deal, ({ name, amountMinor, status, dueOn }) =>
              [name, `${formatMinor(amountMinor, digits)} ${facts.currency}`, dueOn ? `due ${utcDay(`${dueOn}T00:00:00Z`)}` : null, status].filter(Boolean).join(" · ")
            )
              .then((read): LinkCandidate[] => (read.available ? read.candidates : []))
              .catch((error: unknown): LinkCandidate[] => {
                console.error("deal: bills to link not read", error instanceof Error ? error.message : error);
                return [];
              }),
            listCounterparties()
              .then((rows) => rows.filter((row) => row.role !== "client").map(({ id, name }) => ({ id, name })))
              .catch(() => []),
          ])
        : [[], []];
    const stopping = inForce(facts.lines).filter((line) => line.status === "planned" && line.kind === "charge");

    return (
      <ProductShell {...shell}>
        <PageHead
          title={deal.title}
          sub={<DealHeadSub deal={deal} today={today} />}
          right={
            <div className="flex shrink-0 items-center gap-3">
              <DocsLink href="/docs/guides/deals" topic="deals" />
              {back}
            </div>
          }
        />

        <DealFigures deal={deal} today={today} />

        <div className="space-y-8">
          {crm && <CrmDealChanges orgSlug={slug} dealId={facts.id} label={crm.label} words={crm.words} seen={crm.seen} canWrite={canWrite} active={facts.status === "active"} />}
          <DealCashReadiness facts={facts} digits={digits} costs={costs} today={today} {...(canWrite && facts.status === "active" ? { changeHref: "#change" } : {})} />
          <DealSchedule orgSlug={slug} deal={deal} today={today} canWrite={canWrite} />
          <DealCosts
            orgSlug={slug}
            dealId={facts.id}
            costs={costs}
            today={today}
            digits={digits}
            currency={facts.currency}
            canWrite={canWrite}
            candidates={candidates}
            payees={payees}
            idempotencyKey={randomUUID()}
          />

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
                        {...(changeFromCrm ? { fromCrm: { ...crm.prefill, seen: crm.seen } } : {})}
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
