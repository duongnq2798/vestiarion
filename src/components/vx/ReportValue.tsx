import type { ReactNode } from "react";
import { Card } from "@/components/ui/Card";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { amountText } from "@/components/vx/ActualsComparison";
import { minutesInWords } from "@/components/vx/WorkspaceReport";
import { plural, utcDay } from "@/lib/copy";
import type { ReportValueGroups } from "@/lib/report-value";
import type { CurrencyAmount } from "@/lib/workspace-report";

/**
 * What the agent was worth, on the report and on its shared copy (docs/superpowers/specs/2026-10-10-shared-report-
 * design.md S8): three labelled groups, measured, estimated from the business's answer, and not counted, with no total
 * across them. The estimate is said as one, with what it rests on; without an answer there is none. Presentational: the
 * page reads the answer and `reportValue` groups the figures; an owner's form to answer comes in as `answer`.
 */

const amounts = (items: CurrencyAmount[]) => items.map((item) => amountText(item.amount, item.currency)).join(" + ");

/** A sum per currency, "hidden" where a shared copy hides amounts, or what to say when there is none. */
function sums(items: CurrencyAmount[] | null, count: number, none: string): string {
  if (count === 0) return none;
  if (items === null) return `${count} ${plural(count, "bill", "bills")}, amounts hidden`;
  return `${amounts(items)} on ${count} ${plural(count, "bill", "bills")}`;
}

/** The estimated time saved, in hours to one decimal; under an hour, in minutes. */
export function savedWords(decided: number, minutesPerBill: number, hours: number): string {
  const minutes = decided * minutesPerBill;
  return minutes < 60 ? `About ${minutes} min` : `About ${hours.toLocaleString("en-US", { maximumFractionDigits: 1 })} h`;
}

function Group({ id, title, note, children }: { id: string; title: string; note: string; children: ReactNode }) {
  return (
    <Card className="flex min-w-0 flex-col gap-4 p-4 sm:p-5">
      <div className="space-y-1">
        <h3 id={id} className="text-sm font-semibold text-ink">
          {title}
        </h3>
        <p className="text-xs leading-relaxed text-ink-3">{note}</p>
      </div>
      {children}
    </Card>
  );
}

function Figure({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold tabular-nums text-ink">{value}</dd>
      {note && <dd className="mt-0.5 text-xs leading-relaxed text-ink-2">{note}</dd>}
    </div>
  );
}

export function ReportValue({
  value,
  audience,
  answer,
  answeredBy,
}: {
  value: ReportValueGroups;
  /** A member reading the workspace's own report, or anyone reading a shared copy. */
  audience: "member" | "public";
  /** An owner's form to give or change the answer; absent for everyone else. */
  answer?: ReactNode;
  /** Who answered, by email, on the workspace's own report; a shared copy never names a person. */
  answeredBy?: string | null;
}) {
  const { measured, estimate, notCounted } = value;
  const member = audience === "member";
  return (
    <section aria-labelledby="report-value" className="space-y-3">
      <SectionHeader id="report-value" title="Value" meta="Three kinds of figures, never added together" />
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <Group id="value-measured" title="Measured" note="Counted from the signed ledger and the confirmed transfers.">
          <dl aria-labelledby="value-measured" className="grid gap-3">
            <Figure label="Bills handled" value={measured.handled} note={`${measured.decided} decided by the agent`} />
            <Figure
              label="Time to a first decision"
              value={measured.medianMinutesToDecision === null ? "—" : minutesInWords(measured.medianMinutesToDecision)}
              note="Median, from a bill arriving"
            />
            <Figure label="Paid on or before the due day" value={measured.paid === 0 ? "Nothing paid yet" : `${measured.onTime} of ${measured.paid}`} />
            <Figure
              label="Discounts taken"
              value={sums(measured.discountsTaken.byCurrency, measured.discountsTaken.count, "None yet")}
              note="The bill less what its transfer carried."
            />
          </dl>
        </Group>

        <Group
          id="value-estimate"
          title={member ? "From your answer" : "From the business's answer"}
          note="An estimate, not a measurement: it rests on how long one bill took before Vestiarion."
        >
          {estimate.kind === "answered" ? (
            <div className="grid gap-3">
              <dl aria-labelledby="value-estimate" className="grid gap-3">
                <Figure
                  label="Time saved, estimated"
                  value={estimate.decided === 0 ? "None yet" : savedWords(estimate.decided, estimate.minutesPerBill, estimate.hours)}
                  note={`${estimate.decided} ${plural(estimate.decided, "bill", "bills")} the agent decided × ${estimate.minutesPerBill.toLocaleString("en-US")} min, the time one bill took before. A bill it has not decided saved nothing.`}
                />
                <Figure
                  label="People who touched a bill before"
                  value={estimate.peoplePerBill}
                  note="Context only: the estimate is not multiplied by it."
                />
              </dl>
              <p className="text-xs leading-relaxed text-ink-2">A person&apos;s verdict still takes time, and it is not taken off.</p>
              <p className="text-xs text-ink-3">
                {member && answeredBy ? `Answered by ${answeredBy} on ${utcDay(estimate.answeredAt)}.` : `Answered on ${utcDay(estimate.answeredAt)}.`}
              </p>
              {answer}
            </div>
          ) : estimate.kind === "not_ready" && member ? (
            <p className="text-sm text-ink-2">Your answer is not set up on this deployment yet.</p>
          ) : member ? (
            <div className="grid gap-3">
              <p className="text-sm text-ink-2">
                {answer
                  ? "How long did one bill take you before Vestiarion? Answer once, and the time saved is estimated here, apart from what was measured."
                  : "No answer given yet, so nothing is estimated. An owner answers how long one bill took before Vestiarion."}
              </p>
              {answer}
            </div>
          ) : (
            <p className="text-sm text-ink-2">The business has not said how long one bill took before Vestiarion, so nothing is estimated.</p>
          )}
        </Group>

        <Group id="value-not-counted" title="Not counted" note="Never counted as saved, here or in the groups beside it.">
          <dl aria-labelledby="value-not-counted" className="grid gap-3">
            <Figure label="Bills not paid yet" value={notCounted.unpaid} note="No saving is projected onto a bill before it is paid." />
            <Figure label="Flagged, or refused as a repeat" value={notCounted.repeats} note="Stopping one is not money saved." />
            <Figure
              label="Discounts on offer, not taken"
              value={sums(notCounted.discountsNotTaken.byCurrency, notCounted.discountsNotTaken.count, "None")}
              note="Estimated from the bills' terms."
            />
          </dl>
        </Group>
      </div>
    </section>
  );
}
