import { ChevronRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { DocsLink } from "@/components/DocsLink";
import { Badge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { orgHref } from "@/lib/auth/org-paths";
import { utcDay } from "@/lib/copy";
import { dealSummary } from "@/lib/deals/lines";
import type { DealRecord } from "@/lib/deals/read";
import { DealMoney } from "./DealMoney";

const dayWords = (day: string) => utcDay(`${day}T00:00:00.000Z`);

/** Where a deal stands, in a word: cancelled, every line paid, or running. */
export function dealStanding(deal: DealRecord, today: string): { label: string; tone: "agent" | "proof" | "neutral" } {
  if (deal.facts.status === "cancelled") return { label: "Cancelled", tone: "neutral" };
  const summary = dealSummary(deal.facts, today);
  if (summary.plannedMinor === 0 && summary.outstandingMinor === 0) return { label: "Paid in full", tone: "proof" };
  return { label: "Active", tone: "agent" };
}

/**
 * Bills & receivables' Deals (docs/superpowers/specs/2026-10-12-deal-schedule-design.md): each signed deal with what of
 * it was released, paid, is still expected and is planned, and its next line; New deal for owners and admins. Before
 * migration 0104 runs it says deals are not set up, and nothing else on the page changes (D15).
 */
export function DealsSection({
  deals,
  orgSlug,
  today,
  newDeal,
  fromCrm,
}: {
  deals: DealRecord[] | "not_ready" | "unread";
  orgSlug: string;
  today: string;
  newDeal?: ReactNode;
  /** A CRM's won deals, and the New deal form filled in from one (HubSpot connector H20). */
  fromCrm?: ReactNode;
}) {
  const header = (
    <SectionHeader
      id="deals-title"
      title="Deals"
      meta={Array.isArray(deals) ? `${deals.length} ${deals.length === 1 ? "deal" : "deals"} · each one's collection schedule` : "collection schedules"}
      action={<DocsLink href="/docs/guides/deals" topic="deals" />}
    />
  );
  if (deals === "not_ready") {
    return (
      <section id="deals" aria-labelledby="deals-title" className="scroll-mt-6">
        {header}
        <Callout>Deals are not set up on this deployment yet.</Callout>
      </section>
    );
  }
  if (deals === "unread") {
    return (
      <section id="deals" aria-labelledby="deals-title" className="scroll-mt-6">
        {header}
        <Callout tone="held">The deals could not be read. Reload the page in a moment.</Callout>
      </section>
    );
  }
  return (
    <section id="deals" aria-labelledby="deals-title" className="scroll-mt-6">
      {header}
      {fromCrm}
      {newDeal}
      {deals.length === 0 ? (
        <EmptyState compact title="No deals yet" body="Confirm a signed deal and its schedule: each line becomes a receivable when you release it." />
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">
            {deals.map((deal) => {
              const summary = dealSummary(deal.facts, today);
              const standing = dealStanding(deal, today);
              const money = (minor: number) => <DealMoney minor={minor} digits={deal.digits} currency={deal.facts.currency} />;
              return (
                <li key={deal.facts.id}>
                  <Link
                    href={orgHref(orgSlug, `/invoices/deals/${deal.facts.id}`)}
                    className="grid grid-cols-[minmax(0,1fr)_1rem] items-center gap-x-4 gap-y-1 px-4 py-3 transition-colors duration-150 ease-standard hover:bg-ground/50 sm:px-5"
                  >
                    <span className="min-w-0 space-y-1">
                      <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span className="text-sm font-medium text-ink">{deal.title}</span>
                        <span className="text-xs text-ink-3">{deal.customer.name}</span>
                        <Badge size="sm" tone={standing.tone} dot>
                          {standing.label}
                        </Badge>
                      </span>
                      <span className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-ink-2">
                        <span>Total {money(summary.totalMinor)}</span>
                        <span>Released {money(summary.releasedMinor)}</span>
                        <span>Paid {money(summary.paidMinor)}</span>
                        <span className={summary.overdueMinor > 0 ? "text-held" : undefined}>Outstanding {money(summary.outstandingMinor)}</span>
                        <span>Planned {money(summary.plannedMinor)}</span>
                      </span>
                      <span className="block text-xs text-ink-3">
                        {summary.next ? (
                          <>
                            Next: {summary.next.label}, {dayWords(summary.next.invoiceOn)}, {money(summary.next.amountMinor)}
                            {deal.facts.autoRelease ? " · released by the agent on its day" : ""}
                          </>
                        ) : deal.facts.status === "cancelled" ? (
                          "Nothing more is invoiced."
                        ) : (
                          "Every line is released."
                        )}
                      </span>
                    </span>
                    <ChevronRight aria-hidden className="size-4 text-ink-3" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </section>
  );
}
