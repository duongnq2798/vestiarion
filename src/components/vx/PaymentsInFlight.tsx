import Link from "next/link";
import type { ReactNode } from "react";
import { DocsLink } from "@/components/DocsLink";
import { Card } from "@/components/ui/Card";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { orgHref } from "@/lib/auth/org-paths";
import { plural } from "@/lib/copy";
import type { Network } from "@/lib/network";
import { inFlightNext, runbookHref } from "@/lib/payment-exceptions";
import { ageText, paymentsInFlight, type PaymentsInFlight as Summary } from "@/lib/settlement";
import type { FlightRow } from "@/lib/settlement-facts";
import { invoiceHref } from "@/lib/bills-view";
import { fmt, Money } from "./Primitives";
import { mismatchSentence, settlementSummary, stepConfirmedLine, unknownOutcome } from "./SettlementTrack";

/**
 * Treasury's "Payments in flight" (docs/superpowers/specs/2026-10-11-settlement-lifecycle-design.md L7): every payment
 * sent and not confirmed, the oldest first, with how long ago it was sent and where it is, and every payment whose books
 * do not match its transfer. The line over it gives the pending-aging and outstanding-mismatch figures. A payment past
 * the network's wait says so in words, never by colour alone. Hidden when there is nothing to show.
 *
 * A payment slow to confirm, or of unknown outcome, says what to do next in a line, and the heading links the runbook
 * for payments that do not settle (docs/superpowers/specs/2026-10-14-payment-exceptions-design.md E6).
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
  return row.source.type === "invoice" ? orgHref(orgSlug, invoiceHref(row.source.id, "settlement")) : orgHref(orgSlug, "/contractors");
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

/** What to do next about a payment slow to confirm, or of unknown outcome, in a line, with its section of the runbook. */
function NextStep({ row }: { row: FlightRow }) {
  const state = row.settlement.status === "unknown" ? "unknown" : "stuck";
  const next = inFlightNext(state, { followUp: row.settlement.followUp, circleState: row.settlement.stages.pending?.state ?? null, crossChain: row.settlement.crossChain });
  return (
    <p className="mt-0.5 text-xs text-ink-2">
      <Link href={runbookHref(state)} className="font-medium text-ink underline-offset-2 hover:underline">
        What to do:
      </Link>{" "}
      {next}
    </p>
  );
}

export function PaymentsInFlight({
  payments,
  now,
  stuckAfterMinutes,
  orgSlug,
  network,
}: {
  payments: readonly FlightRow[];
  now: number;
  stuckAfterMinutes: number;
  orgSlug: string;
  /** The workspace's network, which a CCTP payout's step Circle confirmed is named on. */
  network: Network;
}) {
  const summary = paymentsInFlight(payments, now, stuckAfterMinutes);
  // A payment in flight whose books disagree says so on its own row; the rest are listed under the books.
  const booksOnly = summary.mismatched.filter((row) => row.settlement.inFlightSince === null);
  if (summary.inFlight.length === 0 && booksOnly.length === 0) return null;
  return (
    <Card asChild className="overflow-hidden">
      <section aria-labelledby="payments-in-flight-title">
        <div className="px-4 pt-4 sm:px-5">
          <SectionHeader
            id="payments-in-flight-title"
            title="Payments in flight"
            meta={<span className="tabular-nums">{flightLine(summary, stuckAfterMinutes)}</span>}
            action={<DocsLink href="/docs/guides/payment-exceptions" topic="what to do when a payment does not settle" />}
          />
          <p className="-mt-1 mb-3 text-xs text-ink-3">Sent and not confirmed by Circle yet, the oldest first. Nothing here is in the payee&apos;s wallet until Circle confirms it.</p>
        </div>
        {summary.inFlight.length > 0 && (
          <ul className="divide-y divide-line border-t border-line">
            {summary.inFlight.map((row) => {
              const pending = row.settlement.stages.pending;
              const step = row.settlement.stepConfirmed;
              // Circle's word, or, for a CCTP payout's burn or approve it confirmed, which step it is about (L3).
              const circle = pending && step ? ` · ${stepConfirmedLine(step, pending, network)}` : pending?.state ? ` · Circle: ${pending.state}` : "";
              return (
                <Row key={`${row.source.type}:${row.source.id}`} row={row} orgSlug={orgSlug}>
                  <p className="mt-0.5 text-xs tabular-nums text-ink-3">
                    {settlementSummary(row.settlement, now)}
                    {circle}
                    {row.late && <span className="font-medium text-held">{` · past the ${stuckAfterMinutes} min wait`}</span>}
                  </p>
                  {row.settlement.status === "unknown" && <p className="mt-0.5 text-xs text-ink-2">{unknownOutcome(row.settlement)}</p>}
                  {(row.settlement.status === "unknown" || row.late) && <NextStep row={row} />}
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
                  <p className="mt-0.5 text-xs text-ink-2">{mismatchSentence(row.settlement)}</p>
                </Row>
              ))}
            </ul>
          </div>
        )}
      </section>
    </Card>
  );
}
