import { Badge, type BadgeProps } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { Disclosure } from "@/components/ui/Disclosure";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { IntakeFold } from "@/components/vx/IntakeFold";
import { utcDay } from "@/lib/copy";
import { costBasis, costCount, type CostCount, type DealCost } from "@/lib/deals/costs";
import type { LinkCandidate } from "@/lib/deals/costs-read";
import { AddCostForm, LinkCostForm, RemoveCostButton } from "./DealCostControls";
import { DealMoney } from "./DealMoney";

const dayWords = (day: string) => utcDay(`${day}T00:00:00.000Z`);

/** What a cost counts as, in a word or two. */
function countBadge(count: CostCount, cost: DealCost): { label: string; tone: NonNullable<BadgeProps["tone"]> } {
  switch (count.as) {
    case "paid":
      return { label: "Paid", tone: "proof" };
    case "due":
      return { label: cost.link?.kind === "milestone" ? "Milestone to pay" : "Bill to pay", tone: "agent" };
    case "planned":
      return count.again ? { label: "Plan stands", tone: "held" } : { label: "Planned", tone: "neutral" };
    case "removed":
      return { label: "Removed", tone: "neutral" };
  }
}

function CostRow({
  cost,
  today,
  digits,
  currency,
  orgSlug,
  dealId,
  canWrite,
  candidates,
}: {
  cost: DealCost;
  today: string;
  digits: number;
  currency: string;
  orgSlug: string;
  dealId: string;
  canWrite: boolean;
  candidates: LinkCandidate[];
}) {
  const count = costCount(cost, today);
  const badge = countBadge(count, cost);
  const counted = count.as === "removed" ? null : count.amountMinor;
  // The vendor's or contractor's own bills and milestones first.
  const options = [...candidates]
    .sort((a, b) => Number(b.counterpartyId === cost.counterparty?.id) - Number(a.counterpartyId === cost.counterparty?.id))
    .map((candidate) => ({ value: `${candidate.kind}:${candidate.id}`, name: candidate.name, group: candidate.kind }));
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 px-4 py-3 sm:px-5">
      <div className="min-w-0 space-y-1">
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-ink">{cost.label}</span>
          {cost.counterparty && <span className="text-xs text-ink-3">{cost.counterparty.name}</span>}
          <Badge size="sm" tone={badge.tone} dot>
            {badge.label}
          </Badge>
          {cost.noDocument && !cost.link && count.as !== "removed" && (
            <Badge size="sm" tone="held">
              No document yet
            </Badge>
          )}
        </p>
        <p className="text-xs text-ink-2">{costBasis(cost, count, currency)}</p>
        {cost.removedAt && <p className="text-xs text-ink-3">Removed {utcDay(cost.removedAt)}</p>}
      </div>
      <div className="text-right">
        {counted !== null ? (
          <DealMoney minor={counted} digits={digits} currency={currency} className="text-sm font-semibold text-ink" />
        ) : (
          <DealMoney minor={cost.amountMinor} digits={digits} currency={currency} className="text-sm text-ink-3 line-through" />
        )}
        {counted !== null && counted !== cost.amountMinor && (
          <span className="block text-[0.6875rem] text-ink-3">
            planned <DealMoney minor={cost.amountMinor} digits={digits} currency={currency} />
          </span>
        )}
      </div>
      {canWrite && !cost.removedAt && (
        <div className="col-span-2 flex flex-col gap-2 border-t border-dashed border-line pt-2 sm:flex-row sm:items-center sm:justify-between">
          {cost.link ? <span className="text-xs text-ink-3">Linked: it counts as what it became.</span> : <LinkCostForm orgSlug={orgSlug} dealId={dealId} costId={cost.id} label={cost.label} candidates={options} />}
          <RemoveCostButton orgSlug={orgSlug} dealId={dealId} costId={cost.id} label={cost.label} />
        </div>
      )}
    </li>
  );
}

/**
 * A deal's planned costs (docs/superpowers/specs/2026-10-13-deal-cash-readiness-design.md K1-K3): each with what it counts
 * as now (planned on its day, the bill or milestone it became, paid, or the plan standing again), and, for an owner or
 * admin, Link to the bill or milestone it became, Remove, and Add a cost. Removed costs are folded under the list.
 */
export function DealCosts({
  orgSlug,
  dealId,
  costs,
  today,
  digits,
  currency,
  canWrite,
  candidates,
  payees,
  idempotencyKey,
}: {
  orgSlug: string;
  dealId: string;
  /** Null before the costs are set up on this deployment. */
  costs: DealCost[] | null;
  today: string;
  digits: number;
  currency: string;
  canWrite: boolean;
  candidates: LinkCandidate[];
  payees: Array<{ id: string; name: string }>;
  idempotencyKey: string;
}) {
  const header = <SectionHeader id="deal-costs-title" title="Costs" meta="what this deal is expected to cost; a cost linked to its bill counts as the bill, once" />;
  if (costs === null) {
    return (
      <section id="costs" aria-labelledby="deal-costs-title" className="scroll-mt-6">
        {header}
        <Callout>Costs are not set up on this deployment yet.</Callout>
      </section>
    );
  }
  const live = costs.filter((cost) => !cost.removedAt).sort((a, b) => a.expectedOn.localeCompare(b.expectedOn) || a.createdAt.localeCompare(b.createdAt));
  const removed = costs.filter((cost) => cost.removedAt);
  const row = (cost: DealCost, write: boolean) => (
    <CostRow key={cost.id} cost={cost} today={today} digits={digits} currency={currency} orgSlug={orgSlug} dealId={dealId} canWrite={write} candidates={candidates} />
  );
  return (
    <section id="costs" aria-labelledby="deal-costs-title" className="scroll-mt-6 space-y-3">
      {header}
      {live.length === 0 ? (
        <EmptyState compact title="No costs yet" body="Add what this deal will cost, such as a contractor or a vendor, with the day the money leaves: the cash readiness above then says when the deal needs cash." />
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">{live.map((cost) => row(cost, canWrite))}</ul>
          <p className="border-t border-line px-4 py-2.5 text-xs text-ink-3 sm:px-5">
            {live.length} {live.length === 1 ? "cost" : "costs"}, first expected {dayWords(live[0].expectedOn)}. A cost with no bill yet is planned; once linked, its bill or milestone counts in its place.
          </p>
        </Card>
      )}
      {removed.length > 0 && (
        <Disclosure summary={<span className="text-sm text-ink">Removed costs ({removed.length})</span>}>
          <ul className="divide-y divide-line">{removed.map((cost) => row(cost, false))}</ul>
        </Disclosure>
      )}
      {canWrite && (
        <IntakeFold label="Add a cost" meta="a contractor, a vendor, anything this deal pays for, with the day it leaves" defaultOpen={live.length === 0} className="">
          <AddCostForm orgSlug={orgSlug} dealId={dealId} currency={currency} today={today} idempotencyKey={idempotencyKey} payees={payees} />
        </IntakeFold>
      )}
    </section>
  );
}
