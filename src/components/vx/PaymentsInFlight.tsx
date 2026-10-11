import Link from "next/link";
import type { ReactNode } from "react";
import { Card } from "@/components/ui/Card";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { orgHref } from "@/lib/auth/org-paths";
import { plural } from "@/lib/copy";
import { ageText, paymentsInFlight, type PaymentsInFlight as Summary } from "@/lib/settlement";
import type { FlightRow } from "@/lib/settlement-facts";
import { fmt, Money } from "./Primitives";
import { MISMATCH_SENTENCE, settlementAnchor, settlementSummary, unknownOutcome } from "./SettlementTrack";

/**
 * Treasury's "Payments in flight" (docs/superpowers/specs/2026-10-11-settlement-lifecycle-design.md L7): every payment
 * sent and not confirmed, the oldest first, with how long ago it was sent and where it is, and every payment whose books
 * do not match its transfer. The line over it gives the pending-aging and outstanding-mismatch figures. A payment past
 * the network's wait says so in words, never by colour alone. Hidden when there is nothing to show.
 */

/** The section's line: how many, the sum per currency, the oldest's age, how many are past the wait, how many do not match. */
export function flightLine(summary: Summary<FlightRow>, stuckAfterMinutes: number): string {
  const parts: string[] = [];
  if (summary.inFlight.length > 0) {
    parts.push(`${summary.inFlight.length} in flight`);
    // Two currencies are never added: each is summed apart.
    parts.push(summary.totals.map((total) => `${fmt(total.amount)} ${total.currency}`).join(" + "));
    if (summary.oldestMs !== null) parts.push(`oldest sent ${ageText(summary.oldestMs)} ago`);
    if (summary.late > 0) parts.push(`${summary.late} past the ${stuckAfterMinutes} min wait`);
  }
  const mismatched = summary.mismatched.length;
  if (mismatched > 0) parts.push(`${mismatched} ${plural(mismatched, "payment", "payments")} not matching the books`);
  return parts.join(" · ");
}

/** Where a payment's own card is: its track on Bills & receivables, or a milestone's contractor page. */
function cardHref(orgSlug: string, row: FlightRow): string {
  return row.source.type === "invoice" ? orgHref(orgSlug, `/invoices#${settlementAnchor(row.source.id)}`) : orgHref(orgSlug, "/contractors");
}

function Row({ row, orgSlug, children }: { row: FlightRow; orgSlug: string; children: ReactNode }) {
  return (
    <li className="px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <Link href={cardHref(orgSlug, row)} className="min-w-0 truncate text-sm font-medium text-ink underline-offset-2 hover:underline">
          {row.name}
        </Link>
        <Money value={row.amount} token={row.currency} className="text-sm text-ink" />
      </div>
      {children}
    </li>
  );
}

export function PaymentsInFlight({ payments, now, stuckAfterMinutes, orgSlug }: { payments: readonly FlightRow[]; now: number; stuckAfterMinutes: number; orgSlug: string }) {
  const summary = paymentsInFlight(payments, now, stuckAfterMinutes);
  // A payment in flight whose books disagree says so on its own row; the rest are listed under the books.
  const booksOnly = summary.mismatched.filter((row) => row.settlement.inFlightSince === null);
  if (summary.inFlight.length === 0 && booksOnly.length === 0) return null;
  return (
    <Card asChild className="overflow-hidden">
      <section aria-labelledby="payments-in-flight-title">
        <div className="px-4 pt-4 sm:px-5">
          <SectionHeader id="payments-in-flight-title" title="Payments in flight" meta={<span className="tabular-nums">{flightLine(summary, stuckAfterMinutes)}</span>} />
          <p className="-mt-1 mb-3 text-xs text-ink-3">Sent and not confirmed by Circle yet, the oldest first. Nothing here is in the payee&apos;s wallet until Circle confirms it.</p>
        </div>
        {summary.inFlight.length > 0 && (
          <ul className="divide-y divide-line border-t border-line">
            {summary.inFlight.map((row) => {
              const state = row.settlement.stages.pending?.state;
              return (
                <Row key={`${row.source.type}:${row.source.id}`} row={row} orgSlug={orgSlug}>
                  <p className="mt-0.5 text-xs tabular-nums text-ink-3">
                    {settlementSummary(row.settlement, now)}
                    {state ? ` · Circle: ${state}` : ""}
                    {row.late && <span className="font-medium text-held">{` · past the ${stuckAfterMinutes} min wait`}</span>}
                  </p>
                  {row.settlement.status === "unknown" && <p className="mt-0.5 text-xs text-ink-2">{unknownOutcome(row.settlement)}</p>}
                </Row>
              );
            })}
          </ul>
        )}
        {booksOnly.length > 0 && (
          <div className="border-t border-line">
            <p className="px-4 pt-3 text-xs font-medium text-ink sm:px-5">Not matching the books</p>
            <ul className="divide-y divide-line">
              {booksOnly.map((row) => (
                <Row key={`${row.source.type}:${row.source.id}`} row={row} orgSlug={orgSlug}>
                  <p className="mt-0.5 text-xs text-ink-2">{row.settlement.mismatch ? MISMATCH_SENTENCE[row.settlement.mismatch] : null}</p>
                </Row>
              ))}
            </ul>
          </div>
        )}
      </section>
    </Card>
  );
}
