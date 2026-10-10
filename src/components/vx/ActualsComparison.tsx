import { ArrowRight, Download } from "lucide-react";
import Link from "next/link";
import ActualPaymentControl from "@/components/ActualPaymentControl";
import ActualsCsvImport from "@/components/ActualsCsvImport";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Hash } from "@/components/vx/Primitives";
import { StatTile } from "@/components/vx/StatTile";
import { METHOD_WORDS } from "@/lib/actual-payment-fields";
import type { ActualsComparison as Comparison, ComparisonFlag, ComparisonRow } from "@/lib/actual-payments-compare";
import { orgHref } from "@/lib/auth/org-paths";
import { billDigits } from "@/lib/bill-amount";
import { plural, utcDay } from "@/lib/copy";
import { networkProfile } from "@/lib/network";
import { txUrl } from "@/lib/payee-chains";
import type { CurrencyAmount } from "@/lib/workspace-report";

/**
 * Agent vs what really happened, on the workspace report (docs/superpowers/specs/2026-10-10-actual-payments-design.md
 * A5, A7, A8): each bill's agent side next to what the business recorded paying, the flags worth a look, and each
 * figure linked to where it comes from: the agent's decision and the verdict to their ledger entries, the payment to its
 * transaction, the business's record to its entry, with who recorded it and when. An owner or admin records or corrects
 * a bill here, or imports a CSV. Presentational: the page reads the facts and `compareActuals` lines them up.
 */

/** How many bills show before "Show all". */
export const ROWS_SHOWN = 20;

/** An entry in the audit log, on the page that starts with it. */
export function entryHref(slug: string, seq: number): string {
  return orgHref(slug, `/audit?before=${seq + 1}#seq-${seq}`);
}

export function amountText(amount: number, currency: string): string {
  const digits = billDigits(currency);
  return `${amount.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${currency}`;
}

const amounts = (items: CurrencyAmount[]) => items.map((item) => amountText(item.amount, item.currency)).join(" + ");
const day = (date: string) => utcDay(`${date.slice(0, 10)}T00:00:00Z`);
const days = (n: number) => `${n} ${plural(n, "day", "days")}`;

/** The median days apart, said from the agent's side. */
export function daysApart(n: number | null): string {
  if (n === null) return "—";
  if (n === 0) return "Same day";
  const whole = Math.round(Math.abs(n) * 10) / 10;
  return `${whole} ${plural(whole, "day", "days")} ${n > 0 ? "earlier" : "later"}`;
}

const FLAG_WORDS: Record<ComparisonFlag, { word: (row: ComparisonRow) => string; tone: "held" | "refused" }> = {
  held_but_paid: { word: () => "Held by the agent, paid by your business", tone: "held" },
  paid_not_paid: { word: (row) => (row.agent.stance === "paid" ? "Paid on Arc, not paid by your business" : "The agent would pay it, your business did not"), tone: "refused" },
  amount_differs: { word: () => "Amount differs", tone: "held" },
};

function EntryLink({ slug, seq }: { slug: string; seq: number | null }) {
  if (seq === null) return null;
  return (
    <Link href={entryHref(slug, seq)} className="font-mono text-xs text-agent hover:underline">
      entry #{seq}
    </Link>
  );
}

/** What the agent did with the bill, in a line, with its entry. */
function agentLine(row: ComparisonRow, label: string): string {
  const agent = row.agent;
  const decided = agent.decision ? day(agent.decision.ts) : null;
  switch (agent.stance) {
    case "paid":
      return agent.payment?.simulated ? `Simulated payment on ${day(agent.payment.at)}` : `Paid on ${label} on ${day(agent.payment!.at)}`;
    case "pay":
      return agent.dayKind === "decided" && agent.day ? `Decided to pay it on ${day(agent.day)}` : `Decided to pay it on ${decided}`;
    case "schedule":
      return agent.day ? `Scheduled it for ${day(agent.day)}` : `Scheduled it on ${decided}`;
    case "held":
      return `Held it on ${decided}. ${agent.why ?? ""}`.trim();
    case "waited":
      return `Waited on ${decided}. ${agent.why ?? ""}`.trim();
    case "none":
      return "No decision yet";
  }
}

/** The days between the two sides, and the amounts, in words. */
function comparedLines(row: ComparisonRow): string[] {
  const lines: string[] = [];
  if (row.daysDiff !== null) {
    const base = row.agent.dayKind === "paidOnArc" ? "Paid on Arc" : row.agent.dayKind === "scheduled" ? "The agent's day" : "The agent decided";
    lines.push(row.daysDiff === 0 ? `${base} on the day your business paid.` : `${base} ${days(Math.abs(row.daysDiff))} ${row.daysDiff > 0 ? "before" : "after"} your business paid.`);
  }
  if (row.amount?.differs) {
    lines.push(`Your business paid ${amountText(row.amount.business, row.amount.currency)}; ${row.amount.of === "arc" ? "Arc carried" : "the bill is"} ${amountText(row.amount.against, row.amount.currency)}.`);
  } else if (row.actual?.outcome === "paid" && row.amount === null && row.actual.currency) {
    lines.push(`Paid in ${row.actual.currency} and the bill is in ${row.bill.currency}: the amounts are not compared.`);
  }
  const terms = row.discount;
  if (terms) {
    const agent = terms.agent ? `the agent took ${amountText(terms.agent.amount, terms.agent.currency)}, measured` : "the agent took none";
    const business = terms.business
      ? `your business took ${amountText(terms.business.amount, terms.business.currency)}, measured`
      : terms.businessInTime === false
        ? "your business paid after the deadline"
        : terms.businessInTime === true
          ? "your business paid in time and took none"
          : "your business: not recorded";
    lines.push(`Early-payment discount, ${terms.pct}% by ${day(terms.deadline)}: ${agent}; ${business}. On offer: ${amountText(terms.onOffer.amount, terms.onOffer.currency)}, estimated from the terms.`);
  }
  return lines;
}

function BusinessSide({ row, slug, members }: { row: ComparisonRow; slug: string; members: Record<string, string> }) {
  const actual = row.actual;
  if (!actual) return <p className="text-sm text-ink-3">Not recorded</p>;
  const who = actual.recordedBy ? (members[actual.recordedBy] ?? "a former member") : "a former member";
  return (
    <div className="space-y-1 text-sm">
      {actual.outcome === "paid" && actual.paidOn && actual.amount !== null && actual.currency ? (
        <p className="text-ink">
          Paid on {day(actual.paidOn)}: <span className="tabular-nums">{amountText(actual.amount, actual.currency)}</span>
          {actual.method ? ` by ${METHOD_WORDS[actual.method].toLowerCase()}` : ""}
          {actual.reference ? <span className="text-ink-2"> · Ref {actual.reference}</span> : null}
        </p>
      ) : (
        <p className="text-ink">Not paid: {actual.reason}</p>
      )}
      {actual.note && <p className="text-ink-2">{actual.note}</p>}
      <p className="text-xs text-ink-3">
        Recorded by {who} on {utcDay(actual.recordedAt)}
        {actual.source === "csv" ? " from a CSV" : ""}
        {row.corrections > 0 ? `, correcting ${row.corrections} earlier ${plural(row.corrections, "record", "records")}` : ""}
        {actual.entrySeq !== null && (
          <>
            {" · "}
            <EntryLink slug={slug} seq={actual.entrySeq} />
          </>
        )}
      </p>
    </div>
  );
}

function ComparisonItem({ row, slug, label, canRecord, members, network }: { row: ComparisonRow; slug: string; label: string; canRecord: boolean; members: Record<string, string>; network: Comparison["network"] }) {
  const agent = row.agent;
  const lines = comparedLines(row);
  return (
    <li className="space-y-3 px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink">{row.payee}</p>
          <p className="text-xs text-ink-3">
            Bill: <span className="tabular-nums">{amountText(row.bill.amount, row.bill.currency)}</span>
            {row.dueDate ? ` · due ${day(row.dueDate)}` : ""}
          </p>
        </div>
        {row.flags.length > 0 && (
          <span className="flex flex-wrap gap-1.5">
            {row.flags.map((flag) => (
              <Badge key={flag} size="sm" tone={FLAG_WORDS[flag].tone}>
                {FLAG_WORDS[flag].word(row)}
              </Badge>
            ))}
          </span>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Eyebrow>The agent, on {label}</Eyebrow>
          <p className="text-sm text-ink">
            {agentLine(row, label)}
            {agent.decision && (
              <>
                {" · "}
                <EntryLink slug={slug} seq={agent.decision.seq} />
              </>
            )}
          </p>
          {agent.payment && (
            <p className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
              <span className="tabular-nums">{amountText(agent.payment.amount, agent.payment.token)}</span>
              {agent.payment.simulated ? (
                <Badge size="sm" tone="simulated" title="A sandbox payment: nothing moved on chain">
                  Simulated
                </Badge>
              ) : (
                agent.payment.txHash && <Hash value={agent.payment.txHash} href={txUrl(network, agent.payment.txHash)} />
              )}
            </p>
          )}
          {row.verdict && (
            <p className="text-xs text-ink-3">
              Your verdict: {row.verdict.verdict === "agree" ? "agreed" : "disagreed"}
              {row.verdict.entrySeq !== null && (
                <>
                  {" · "}
                  <EntryLink slug={slug} seq={row.verdict.entrySeq} />
                </>
              )}
            </p>
          )}
        </div>
        <div className="space-y-2">
          <Eyebrow>Your business</Eyebrow>
          <BusinessSide row={row} slug={slug} members={members} />
          {canRecord && (
            <ActualPaymentControl
              orgSlug={slug}
              invoiceId={row.invoiceId}
              payee={row.payee}
              bill={row.bill}
              current={row.actual ? { id: row.actual.id, outcome: row.actual.outcome, paidOn: row.actual.paidOn, amount: row.actual.amount, currency: row.actual.currency, method: row.actual.method, reference: row.actual.reference, note: row.actual.note, reason: row.actual.reason } : null}
            />
          )}
        </div>
      </div>
      {lines.length > 0 && (
        <ul className="space-y-0.5 border-t border-line pt-2 text-[0.8125rem] text-ink-2">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** What the comparison is, and its figures: bills compared, agreement, days apart, what is worth a look, amounts. */
export function ActualsSummary({ comparison }: { comparison: Comparison }) {
  const label = networkProfile(comparison.network).label;
  const totals = comparison.totals;
  const given = totals.agreed + totals.disagreed;
  const flagged = comparison.rows.filter((row) => row.flags.length > 0).length;
  const offered = totals.discounts.onOffer.length > 0;
  return (
    <div className="space-y-4">
      <div className="space-y-1 text-[0.8125rem] text-ink-2">
        <p>
          What the agent decided on each bill, next to what your business recorded paying outside Vestiarion. A bill nobody has recorded says Not recorded: nothing
          here is guessed. A payment on {label} is the agent&apos;s, never your bank&apos;s.
        </p>
        {comparison.simulated && <p>Sandbox: the agent&apos;s payments here are simulated.</p>}
        {comparison.source === "sample" && <p>This workspace has no real bill yet, so this compares its sample data.</p>}
      </div>

      {comparison.rows.length > 0 && (
        <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-3">
          <StatTile label="Bills compared" sub={`${totals.notRecorded} not recorded yet`}>
            {totals.compared}
          </StatTile>
          <StatTile label="Agent and business agreed" sub={given === 0 ? "Nothing compared yet" : "Both paid it, or neither did"}>
            {given === 0 ? "—" : `${totals.agreed} of ${given}`}
          </StatTile>
          <StatTile label="Days apart" sub={totals.daysCompared === 0 ? "No paid day to compare yet" : `Median over ${totals.daysCompared} ${plural(totals.daysCompared, "bill", "bills")}: the agent against your business`}>
            {daysApart(totals.medianDays)}
          </StatTile>
          <StatTile
            label="Worth a look"
            tone={flagged > 0 ? "held" : "default"}
            sub={`${totals.flags.heldButPaid} held but paid · ${totals.flags.paidNotPaid} not paid by your business · ${totals.flags.amountDiffers} amount differs`}
          >
            {flagged}
          </StatTile>
          <StatTile label="Paid by your business" sub="As recorded, per currency">
            {totals.paidByBusiness.length === 0 ? "—" : amounts(totals.paidByBusiness)}
          </StatTile>
          <StatTile
            label="Discounts taken"
            sub={
              offered
                ? `By the agent, measured. Your business: ${totals.discounts.business.length === 0 ? "none" : amounts(totals.discounts.business)}, measured. On offer: ${amounts(totals.discounts.onOffer)}, estimated from the terms.`
                : "No bill here offered an early-payment discount"
            }
          >
            {totals.discounts.agent.length === 0 ? "None" : amounts(totals.discounts.agent)}
          </StatTile>
        </div>
      )}
    </div>
  );
}

/** The bills, each with its two sides, its flags and its links; with the record controls for someone who may record. */
export function ActualsBills({
  slug,
  comparison,
  rows,
  canRecord,
  members,
}: {
  slug: string;
  comparison: Comparison;
  rows: ComparisonRow[];
  canRecord: boolean;
  members: Record<string, string>;
}) {
  const label = networkProfile(comparison.network).label;
  if (rows.length === 0) return <EmptyState compact title="Nothing to compare yet" body="Once the agent decides on a bill, it shows here, ready for what your business paid." />;
  return (
    <Card className="overflow-hidden">
      <ul className="divide-y divide-line">
        {rows.map((row) => (
          <ComparisonItem key={row.invoiceId} row={row} slug={slug} label={label} canRecord={canRecord} members={members} network={comparison.network} />
        ))}
      </ul>
    </Card>
  );
}

export function ActualsComparison({
  slug,
  comparison,
  canRecord,
  members,
  templateCsv,
  showAll,
}: {
  slug: string;
  /** Null before migration 0090 runs on this deployment. */
  comparison: Comparison | null;
  canRecord: boolean;
  /** Members' emails, by user id, for who recorded each. */
  members: Record<string, string>;
  /** The bills not recorded yet, as a CSV to fill in. */
  templateCsv: string | null;
  showAll: boolean;
}) {
  if (!comparison) {
    return (
      <section aria-labelledby="report-actuals" id="actuals">
        <SectionHeader id="report-actuals" title="Agent vs what really happened" />
        <Callout>Recording what your business paid is not set up on this deployment yet.</Callout>
      </section>
    );
  }
  const flagged = comparison.rows.some((row) => row.flags.length > 0);
  const shown = showAll ? comparison.rows : comparison.rows.slice(0, ROWS_SHOWN);

  return (
    <section aria-labelledby="report-actuals" id="actuals" className="space-y-4">
      <SectionHeader
        id="report-actuals"
        title="Agent vs what really happened"
        meta={comparison.rows.length > shown.length ? `${flagged ? "Worth a look first, then the newest" : "Newest"} ${shown.length} of ${comparison.rows.length}` : undefined}
        action={
          comparison.rows.length > shown.length ? (
            <Button asChild size="sm" variant="ghost">
              <Link href={orgHref(slug, "/report?actuals=all#actuals")} scroll={false}>
                Show all {comparison.rows.length}
                <ArrowRight aria-hidden />
              </Link>
            </Button>
          ) : undefined
        }
      />
      <ActualsSummary comparison={comparison} />

      {canRecord && (
        <Card className="space-y-3 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium text-ink">Import what your business paid from a CSV</p>
            {templateCsv && (
              <Button asChild size="sm" variant="ghost">
                <a href={`data:text/csv;charset=utf-8,${encodeURIComponent(templateCsv)}`} download="bills-not-recorded.csv">
                  <Download aria-hidden />
                  Download the bills not recorded yet
                </a>
              </Button>
            )}
          </div>
          <ActualsCsvImport orgSlug={slug} />
        </Card>
      )}

      <ActualsBills slug={slug} comparison={comparison} rows={shown} canRecord={canRecord} members={members} />
      {!canRecord && <p className="text-xs text-ink-3">An owner or admin of this workspace records what your business paid.</p>}
    </section>
  );
}
