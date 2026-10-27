import { ArrowLeft, Download, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { DEADLINE_DAYS, moneyWords, totalsWords, type BillCheck, type Deadline, type DuplicateFinding } from "@/lib/bill-check/findings";
import { MAX_CHECK_BILLS, type ListBill } from "@/lib/bill-check/read";

/**
 * What the free bill list check found (docs/superpowers/specs/2026-10-28-check-bills-design.md CB5–CB8): the summary the
 * page announces, then the likely duplicates by vendor, the runs of the same amount about a month apart, the deadlines of
 * the next 7 days and the rows that could not be read, each with the rows of the list it is about.
 */

const plural = (count: number, one: string, many: string) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

const CARD = "rounded-xl border border-line bg-surface px-4 py-3";

/** The headline and the counts under it: the one part announced when the check runs. */
export function BillCheckSummary({ result }: { result: BillCheck }) {
  const found = result.duplicates.reduce((count, vendor) => count + vendor.findings.length, 0);
  const total = result.bills.length + result.leftOut;
  const vendors = plural(result.vendors, "vendor", "vendors");
  const parts = [
    result.checked === total ? `Checked ${plural(total, "bill", "bills")}, from ${vendors}.` : `Checked ${result.checked.toLocaleString("en-US")} of ${plural(total, "bill", "bills")}, from ${vendors}.`,
    result.atStake.length > 0 ? `${totalsWords(result.atStake)} at stake.` : null,
    result.monthApart.length > 0 ? `${plural(result.monthApart.length, "run", "runs")} of the same amount about a month apart.` : null,
    result.terms.discount || result.terms.lateFee ? `${result.deadlines.length === 0 ? "No" : result.deadlines.length} ${result.deadlines.length === 1 ? "deadline" : "deadlines"} in the next ${DEADLINE_DAYS} days.` : null,
  ];
  return (
    <Callout tone={found > 0 ? "held" : "neutral"} title={found === 0 ? "No likely duplicates" : `${found} likely ${found === 1 ? "duplicate" : "duplicates"}`}>
      {parts.filter(Boolean).join(" ")}
    </Callout>
  );
}

/** A row of the list as the findings name it: its number, invoice number, due date and amount. */
function BillLine({ bill }: { bill: ListBill }) {
  const details = [bill.invoiceNumber, bill.dueDate ? `due ${bill.dueDate}` : null, bill.amount && bill.currency ? moneyWords(bill.amount, bill.currency) : null];
  return (
    <li className="flex flex-wrap gap-x-2 text-sm text-ink-2">
      <span className="font-mono text-ink-3">{`Row ${bill.line}`}</span>
      <span>{details.filter(Boolean).join(" · ")}</span>
    </li>
  );
}

function Finding({ finding }: { finding: DuplicateFinding }) {
  return (
    <li className={CARD}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-ink">{`Row ${finding.bill.line} may repeat row ${finding.other.line}`}</p>
        <Badge tone={finding.confidence >= 0.75 ? "held" : "neutral"} size="sm">
          {`Confidence ${finding.confidence.toFixed(2)}`}
        </Badge>
      </div>
      <ul className="mt-2 space-y-0.5">
        <BillLine bill={finding.other} />
        <BillLine bill={finding.bill} />
      </ul>
      {finding.explanation && <p className="mt-2 text-sm leading-relaxed text-ink-2">{finding.explanation}</p>}
      {finding.numberWords && <p className="mt-1 text-sm leading-relaxed text-ink-2">{finding.numberWords}</p>}
      <p className="mt-2 text-xs text-ink-3">{`At stake if both are paid: ${moneyWords(finding.atStake.amount, finding.atStake.currency)}`}</p>
    </li>
  );
}

function when(deadline: Deadline): string {
  if (deadline.daysLeft === 0) return "Today";
  if (deadline.daysLeft === 1) return "Tomorrow";
  return `In ${deadline.daysLeft} days`;
}

/** What the deadlines section says when it lists none: which terms the list has, and that none falls in the next days. */
function noDeadlines(terms: BillCheck["terms"]): string {
  if (!terms.discount && !terms.lateFee) {
    return "Your list has no early-payment discount or late fee columns, so there are no deadlines to check. If it has them, choose them under Columns.";
  }
  if (!terms.lateFee) return `No early-payment discount ends in the next ${DEADLINE_DAYS} days. Your list has no late fee column.`;
  if (!terms.discount) return `No late fee starts in the next ${DEADLINE_DAYS} days. Your list has no early-payment discount column.`;
  return `No early-payment discount ends and no late fee starts in the next ${DEADLINE_DAYS} days.`;
}

function Section({ id, title, intro, children }: { id: string; title: string; intro?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <div>
        <h2 id={id} className="text-base font-semibold tracking-[-0.01em] text-ink">
          {title}
        </h2>
        {intro && <p className="mt-1 text-sm leading-relaxed text-ink-3">{intro}</p>}
      </div>
      {children}
    </section>
  );
}

export function BillCheckResults({ result, onBack, onRestart, onDownload }: { result: BillCheck; onBack: () => void; onRestart: () => void; onDownload: () => void }) {
  const unread = result.bills.filter((bill) => bill.problems.length > 0);
  return (
    <div className="space-y-8">
      <Section
        id="check-bills-duplicates"
        title="Likely duplicates"
        intro="Bills of one vendor compared by amount, purchase order, invoice number, description and due date, with the rule Vestiarion's agent uses before it pays."
      >
        {result.duplicates.length === 0 ? (
          <p className="text-sm text-ink-2">None in this list.</p>
        ) : (
          <div className="space-y-5">
            {result.duplicates.map((vendor) => (
              <div key={vendor.vendor} className="space-y-2">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <h3 className="text-sm font-semibold text-ink">{vendor.vendor}</h3>
                  <p className="text-xs text-ink-3">{`${totalsWords(vendor.atStake)} at stake`}</p>
                </div>
                <ul className="space-y-2">
                  {vendor.findings.map((finding) => (
                    <Finding key={finding.bill.line} finding={finding} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section
        id="check-bills-month-apart"
        title="Same amount, about a month apart"
        intro="Usually a monthly charge, which the duplicate rule leaves out. Check each is a new month's bill, not the same bill sent again."
      >
        {result.monthApart.length === 0 ? (
          <p className="text-sm text-ink-2">None in this list.</p>
        ) : (
          <ul className="space-y-2">
            {result.monthApart.map((run) => (
              <li key={run.bills[0].line} className={CARD}>
                <p className="text-sm font-semibold text-ink">{`${run.vendor}: ${moneyWords(run.amount, run.currency)}, ${plural(run.bills.length, "bill", "bills")}`}</p>
                <ul className="mt-2 space-y-0.5">
                  {run.bills.map((bill) => (
                    <BillLine key={bill.line} bill={bill} />
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="check-bills-deadlines" title={`Deadlines in the next ${DEADLINE_DAYS} days`}>
        {result.deadlines.length === 0 ? (
          <p className="text-sm text-ink-2">{noDeadlines(result.terms)}</p>
        ) : (
          <ul className="space-y-2">
            {result.deadlines.map((deadline) => (
              <li key={`${deadline.bill.line}-${deadline.kind}`} className={CARD}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-ink">{`${deadline.bill.vendor}, row ${deadline.bill.line}`}</p>
                  <Badge tone={deadline.daysLeft <= 1 ? "held" : "neutral"} size="sm">
                    {when(deadline)}
                  </Badge>
                </div>
                <p className="mt-1 text-sm leading-relaxed text-ink-2">{deadline.words}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {(unread.length > 0 || result.leftOut > 0) && (
        <Section id="check-bills-unread" title="Rows to look at" intro="What could not be read. A row without a counterparty, an amount or a due date it can read is not checked.">
          <ul className="space-y-1.5">
            {unread.map((bill) => (
              <li key={bill.line} className="text-sm leading-relaxed text-ink-2">
                <span className="font-mono text-ink-3">{`Row ${bill.line}`}</span>
                {bill.vendor ? `, ${bill.vendor}` : ""}: {bill.problems.join(" ")}
                {bill.checked ? "" : <strong className="font-semibold text-ink"> Not checked.</strong>}
              </li>
            ))}
            {result.leftOut > 0 && (
              <li className="text-sm leading-relaxed text-ink-2">{`The ${plural(result.leftOut, "bill", "bills")} after the first ${MAX_CHECK_BILLS.toLocaleString("en-US")} were not checked.`}</li>
            )}
          </ul>
        </Section>
      )}

      <div className="flex flex-col gap-3 border-t border-line pt-5 sm:flex-row sm:flex-wrap sm:items-center">
        <Button type="button" icon={<Download />} onClick={onDownload}>
          Download the list with a flag column
        </Button>
        <Button type="button" variant="secondary" icon={<ArrowLeft />} onClick={onBack}>
          Change columns
        </Button>
        <Button type="button" variant="ghost" icon={<RotateCcw />} onClick={onRestart}>
          Check another list
        </Button>
      </div>
    </div>
  );
}
