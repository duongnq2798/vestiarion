import { Badge } from "@/components/ui/Badge";
import { StatTile } from "@/components/vx/StatTile";
import { utcDay } from "@/lib/copy";
import { dealSummary, inForce } from "@/lib/deals/lines";
import type { DealRecord } from "@/lib/deals/read";
import { dealStanding } from "./DealsSection";
import { DealMoney } from "./DealMoney";

/** Under a deal's title: its customer, where it stands, its version, when it was signed, its terms and reference. */
export function DealHeadSub({ deal, today }: { deal: DealRecord; today: string }) {
  const { facts } = deal;
  const standing = dealStanding(deal, today);
  const signedAt = deal.versions[0]?.createdAt ?? deal.createdAt;
  return (
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
  );
}

/** A deal's figures: its total, what was released, paid, is outstanding and is planned, with its next line. */
export function DealFigures({ deal, today }: { deal: DealRecord; today: string }) {
  const { facts, digits } = deal;
  const summary = dealSummary(facts, today);
  const money = (minor: number) => <DealMoney minor={minor} digits={digits} currency={facts.currency} />;
  return (
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
  );
}
