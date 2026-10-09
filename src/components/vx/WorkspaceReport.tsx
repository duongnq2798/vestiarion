import { ArrowRight, BookOpen, Check, FileText } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import { cn } from "@/components/ui/cn";
import { Hash, Money } from "@/components/vx/Primitives";
import { StatTile } from "@/components/vx/StatTile";
import { orgHref } from "@/lib/auth/org-paths";
import { billDigits } from "@/lib/bill-amount";
import { plural, utcDay } from "@/lib/copy";
import { networkProfile } from "@/lib/network";
import { txUrl } from "@/lib/payee-chains";
import type { CurrencyAmount, PaymentRow, ReadinessStep, StoppedRow, WorkspaceReport as Report } from "@/lib/workspace-report";

/**
 * The workspace report (docs/superpowers/specs/2026-10-09-workspace-report-design.md): what the agent did with the
 * workspace's real bills, each figure said as what it is — counted, measured or estimated, test or real USDC, and a
 * shadow mode mirror where it is one. Presentational: the page reads the facts and `buildReport` counts them.
 */

/** A median in minutes, said as a person would: under a minute, whole minutes, then hours. */
export function minutesInWords(minutes: number): string {
  if (minutes < 1) return "under a minute";
  if (minutes < 90) return `${Math.round(minutes)} min`;
  return `${Math.round((minutes / 60) * 10) / 10} h`;
}

const amounts = (items: CurrencyAmount[]) => items.map((item) => `${item.amount.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${item.currency}`).join(" + ");

const SINCE: Record<StoppedRow["since"], { word: string; tone: "proof" | "refused" | "held" }> = {
  paid: { word: "Paid since", tone: "proof" },
  rejected: { word: "Rejected", tone: "refused" },
  open: { word: "Still open", tone: "held" },
};

const DECIDED_BY: Record<PaymentRow["decidedBy"], string> = {
  agent: "The agent",
  person: "A person",
  verdict: "Your verdict",
};

function readinessWords(step: ReadinessStep, mainnetLabel: string): { title: string; note: string } {
  switch (step.key) {
    case "verdicts":
      return { title: `Give verdicts on at least ${step.target} decisions`, note: `${step.given} of ${step.target} given.` };
    case "waiting":
      return {
        title: "Leave no decision waiting for your verdict",
        note: step.waiting === 0 ? "None waiting." : `${step.waiting} ${plural(step.waiting, "decision waits", "decisions wait")} in AP / AR.`,
      };
    case "addresses":
      return {
        title: "Have each supplier's own Arc address",
        note:
          step.mirrorPayees === 0
            ? "Every supplier here is paid at its own address."
            : `${step.mirrorPayees} ${plural(step.mirrorPayees, "supplier is", "suppliers are")} paid at a mirror address. A live workspace pays a supplier's real address, so ask them for it.`,
      };
    case "mainnet":
      return { title: `Open a workspace on ${mainnetLabel} for the slice`, note: "Start with one supplier, or the bills under a figure you choose. The shadow mode guide says how." };
  }
}

export function WorkspaceReport({ slug, report }: { slug: string; report: Report }) {
  if (report.bills.handled === 0) {
    return (
      <EmptyState
        icon={<FileText />}
        title="No real bills yet"
        body="Add a bill in AP / AR, or forward one by email, and the agent decides on it within a minute. This report counts what it did from then on."
        action={
          <Button asChild size="sm">
            <Link href={orgHref(slug, "/invoices")}>
              Open AP / AR
              <ArrowRight aria-hidden />
            </Link>
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-8">
      <ReportSummary report={report} />
      {report.readiness && <ReportReadiness steps={report.readiness} />}
      <ReportLists slug={slug} report={report} />
    </div>
  );
}

/** The box that says what money it was, and the figures. */
export function ReportSummary({ report }: { report: Report }) {
  const profile = networkProfile(report.network);
  const given = report.verdicts ? report.verdicts.agreed + report.verdicts.disagreed : 0;
  return (
    <div className="space-y-8">
      <Callout tone={report.realMoney ? "proof" : "neutral"} title={`Payments on ${profile.label}, in ${report.realMoney ? "real" : "test"} USDC.`}>
        {report.shadow && (
          <p>
            Shadow mode since {utcDay(report.shadow.startedAt)}: your business paid these bills itself, in {report.shadow.currency}. A payment marked
            Mirror is its copy on {profile.label}.
          </p>
        )}
        <p>
          Counted from this workspace&apos;s signed ledger and its confirmed transfers{report.openedAt ? `, since it opened on ${utcDay(report.openedAt)}` : ""}. Sample data is left
          out.
        </p>
      </Callout>

      <section aria-label="Figures" className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Bills handled" sub={`${report.bills.decided} decided by the agent`}>
          {report.bills.handled}
        </StatTile>
        <StatTile label="Time to decide" sub="Median, from a bill arriving to the agent's first decision">
          {report.bills.medianMinutesToDecision === null ? "—" : minutesInWords(report.bills.medianMinutesToDecision)}
        </StatTile>
        <StatTile
          label="Paid on Arc"
          sub={report.paid.count === 0 ? "Nothing paid yet" : `${amounts(report.paid.byCurrency)} · ${report.paid.onTime} on or before the due day`}
        >
          {report.paid.count}
        </StatTile>
        <StatTile label="Stopped before paying" sub={`${report.stopped.byCode} refused by code · ${report.stopped.byAgent} the agent's call · ${report.stopped.waited} waited`}>
          {report.stopped.total}
        </StatTile>
        <StatTile label="Needed a person" sub={report.shadow ? "In shadow mode, every payment waits for your verdict" : `${report.paid.untouched} paid with no one stepping in`}>
          {report.people.steppedIn}
        </StatTile>
        {report.verdicts && (
          <StatTile
            label="Your verdicts"
            sub={`${given === 0 ? "None given yet" : `${Math.round((report.verdicts.agreed / given) * 100)}% agreed`} · ${report.verdicts.waiting} waiting`}
          >
            {report.verdicts.agreed} of {given}
          </StatTile>
        )}
        <StatTile
          label="Discounts captured"
          sub={
            report.discounts.onOffer.count === 0
              ? "No bill offered an early-payment discount"
              : `Measured from the transfers. On offer: ${amounts(report.discounts.onOffer.byCurrency)} on ${report.discounts.onOffer.count} ${plural(report.discounts.onOffer.count, "bill", "bills")}, from their terms`
          }
        >
          {report.discounts.captured.count === 0 ? "None yet" : amounts(report.discounts.captured.byCurrency)}
        </StatTile>
      </section>
    </div>
  );
}

/** What it stopped, and the payments with their transactions. */
export function ReportLists({ slug, report }: { slug: string; report: Report }) {
  return (
    <div className="space-y-8">
      <section aria-labelledby="report-stopped">
        <SectionHeader id="report-stopped" title="What it stopped" meta={report.stopped.total > report.stoppedList.length ? `Newest ${report.stoppedList.length} of ${report.stopped.total}` : undefined} />
        {report.stoppedList.length === 0 ? (
          <EmptyState compact title="Nothing stopped yet" body="When the agent, or a check in code, keeps a bill from being paid, it shows here with the reason." />
        ) : (
          <Card className="overflow-hidden">
            <Table label="Bills it stopped">
              <TableHeader>
                <TableRow>
                  <TableHead>Day</TableHead>
                  <TableHead>Payee</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Why</TableHead>
                  <TableHead>Since</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.stoppedList.map((row) => (
                  <TableRow key={row.invoiceId}>
                    <TableCell className="whitespace-nowrap text-ink-2">{utcDay(row.at)}</TableCell>
                    <TableCell>{row.payee}</TableCell>
                    <TableCell className="text-right">
                      <Money value={row.amount} token={row.currency} />
                    </TableCell>
                    <TableCell className="min-w-[16rem] text-ink-2">{row.why}</TableCell>
                    <TableCell>
                      <Badge size="sm" tone={SINCE[row.since].tone}>
                        {SINCE[row.since].word}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
      </section>

      <section aria-labelledby="report-payments">
        <SectionHeader
          id="report-payments"
          title="Payments and their proof"
          meta={report.paid.count > report.paymentList.length ? `Newest ${report.paymentList.length} of ${report.paid.count}` : undefined}
          action={
            <Button asChild size="sm" variant="ghost">
              <Link href={orgHref(slug, "/audit")}>
                Every entry, signed: Audit log
                <ArrowRight aria-hidden />
              </Link>
            </Button>
          }
        />
        {report.paymentList.length === 0 ? (
          <EmptyState compact title="No payment yet" body="Each confirmed payment shows here with its transaction on the explorer." />
        ) : (
          <Card className="overflow-hidden">
            <Table label="Payments">
              <TableHeader>
                <TableRow>
                  <TableHead>Day</TableHead>
                  <TableHead>Payee</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Decided by</TableHead>
                  <TableHead>Transaction</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.paymentList.map((row) => (
                  <TableRow key={row.invoiceId}>
                    <TableCell className="whitespace-nowrap text-ink-2">{utcDay(row.at)}</TableCell>
                    <TableCell>
                      <span className="inline-flex flex-wrap items-center gap-2">
                        {row.payee}
                        {row.mirror && (
                          <Badge size="sm" tone="simulated" title="A copy of a bill the business paid itself, in shadow mode">
                            Mirror
                          </Badge>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <Money value={row.amount} token={row.token} />
                      {row.bill && (
                        <span className="block text-xs text-ink-3">
                          Bill: {row.bill.amount.toLocaleString("en-US", { minimumFractionDigits: billDigits(row.bill.currency), maximumFractionDigits: billDigits(row.bill.currency) })}{" "}
                          {row.bill.currency}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-ink-2">{DECIDED_BY[row.decidedBy]}</TableCell>
                    <TableCell>{row.txHash ? <Hash value={row.txHash} href={txUrl(report.network, row.txHash)} /> : <span className="text-ink-3">—</span>}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
      </section>
    </div>
  );
}

/** What we suggest before a live slice, in shadow mode. */
export function ReportReadiness({ steps }: { steps: ReadinessStep[] }) {
  const mainnetLabel = networkProfile("arc-mainnet").label;
  const checked = steps.filter((step) => step.done !== null);
  const done = checked.filter((step) => step.done).length;
  return (
    <section aria-labelledby="report-readiness">
      <SectionHeader
        id="report-readiness"
        title="Before a live slice"
        meta={`${done} of ${checked.length} done`}
        action={
          <Button asChild size="sm" variant="ghost">
            <Link href="/docs/guides/shadow-mode#before-a-live-slice">
              <BookOpen aria-hidden />
              Read the guide
            </Link>
          </Button>
        }
      />
      <Card className="p-2 sm:p-3">
        <p className="px-3 pb-1 pt-2 text-[0.8125rem] text-ink-2">
          What we suggest before you move a slice of your bills to real USDC. Nothing here moves money or changes a setting.
        </p>
        <ol>
          {steps.map((step, index) => {
            const words = readinessWords(step, mainnetLabel);
            return (
              <li key={step.key} className="flex items-start gap-3 rounded-xl px-3 py-3">
                <span
                  aria-hidden
                  className={cn(
                    "mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border text-xs font-semibold tabular-nums",
                    step.done ? "border-proof-line bg-proof-soft text-proof" : "border-line text-ink-3"
                  )}
                >
                  {step.done ? <Check className="size-3.5" /> : index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className={cn("text-sm font-semibold", step.done ? "text-ink-3" : "text-ink")}>
                    {words.title}
                    {step.done && <span className="sr-only"> (done)</span>}
                  </p>
                  <p className="mt-0.5 text-[0.8125rem] text-ink-2">{words.note}</p>
                </div>
              </li>
            );
          })}
        </ol>
      </Card>
    </section>
  );
}
