import { StatTile } from "@/components/vx/StatTile";
import { utcDay } from "@/lib/copy";
import type { Collection } from "@/lib/deals/collection";
import { dealSummary, inForce } from "@/lib/deals/lines";
import type { DealRecord } from "@/lib/deals/read";
import { DealMoney } from "./DealMoney";

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * A deal's figures on its page (docs/superpowers/specs/2026-10-12-deal-schedule-design.md D14): Total, Released and
 * Planned from its lines; Paid and Outstanding from what it collected (`src/lib/deals/collection.ts`), the same figure
 * written back to the CRM it was planned from as Collected and Still owed (crm-receipts R1). A part payment counts as
 * what arrived; a fee a person marked settles an invoice and is never paid; an invoice marked received with no payment on
 * Arc is not counted, and the tile says so. `collected` null: it could not be read, and the page says that rather than
 * guess.
 */
export function DealFigures({ deal, today, collected }: { deal: Pick<DealRecord, "facts" | "digits">; today: string; collected: Collection | null }) {
  const { facts, digits } = deal;
  const summary = dealSummary(facts, today);
  const money = (minor: number) => <DealMoney minor={minor} digits={digits} currency={facts.currency} />;
  const paidNotes = collected
    ? [
        collected.feesMinor > 0 ? <>fees of {money(collected.feesMinor)} settled the rest</> : null,
        collected.unverifiedMinor > 0 ? <>{money(collected.unverifiedMinor)} marked received without a payment on Arc is not counted</> : null,
        collected.leftOut > 0 ? `${plural(collected.leftOut, "invoice", "invoices")} in another currency left out` : null,
      ].filter((note) => note !== null)
    : [];
  return (
    <div className="mb-6 grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 xl:grid-cols-5">
      <StatTile label="Total" sub={summary.creditMinor < 0 ? <>Includes a credit owed of {money(-summary.creditMinor)}</> : `In ${inForce(facts.lines).length} lines`}>
        {money(summary.totalMinor)}
      </StatTile>
      <StatTile label="Released" sub="Made receivables">
        {money(summary.releasedMinor)}
      </StatTile>
      <StatTile
        label="Paid"
        sub={
          collected ? (
            <>
              Arrived on Arc, confirmed by Circle and applied
              {paidNotes.map((note, index) => (
                <span key={index}>; {note}</span>
              ))}
            </>
          ) : (
            "Not read: reload the page in a moment"
          )
        }
      >
        {collected ? money(collected.collectedMinor) : "—"}
      </StatTile>
      <StatTile
        label="Outstanding"
        tone={collected && collected.overdueMinor > 0 ? "held" : "default"}
        sub={collected ? collected.overdueMinor > 0 ? <>Expected, {money(collected.overdueMinor)} overdue</> : "Expected, not cash until paid" : "Not read: reload the page in a moment"}
      >
        {collected ? money(collected.stillOwedMinor) : "—"}
      </StatTile>
      <StatTile label="Planned" sub={summary.next ? <>Next: {summary.next.label}, {utcDay(`${summary.next.invoiceOn}T00:00:00Z`)}</> : "Nothing left to invoice"}>
        {money(summary.plannedMinor)}
      </StatTile>
    </div>
  );
}
