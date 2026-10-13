import { Badge } from "@/components/ui/Badge";
import { utcDay } from "@/lib/copy";
import type { DealRecord } from "@/lib/deals/read";
import { dealStanding } from "./DealsSection";

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
