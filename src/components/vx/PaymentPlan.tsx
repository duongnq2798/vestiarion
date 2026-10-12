import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import Link from "next/link";
import { DocsLink } from "@/components/DocsLink";
import { ApproveAllShown, ApprovePlanLine, RefreshPlanBalance } from "@/components/PaymentPlanControls";
import { Badge, type BadgeProps } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { Disclosure } from "@/components/ui/Disclosure";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import { orgHref } from "@/lib/auth/org-paths";
import { utcDay } from "@/lib/copy";
import type { PaymentPlan, PlanFlagCode, PlanLine } from "@/lib/payment-plan";
import type { PlanOutcomes } from "@/lib/payment-plan-outcomes";
import { Money } from "./Primitives";

/**
 * Bills & receivables' payment plan (docs/superpowers/specs/2026-10-11-payment-plan-design.md), its own tab
 * (docs/superpowers/specs/2026-10-12-bills-tabs-design.md B14): the figures in one row, then the next 14 days of what
 * leaves the operating wallet, in the order the cash allows, grouped by day with the balance after each; each line opens
 * on why it is on its day, what would stop it and, for someone who approves payments, Approve where the plan would move
 * it. The cash effect and the money expected in are folded below. Every figure is a projection but the last 30 days'.
 */

const dayLabel = (day: string) => utcDay(`${day}T00:00:00.000Z`);

/** Each flag's short name: the line says the whole sentence beside it, so the badge is never the only carrier. */
const FLAG_BADGE: Record<PlanFlagCode, { label: string; tone: NonNullable<BadgeProps["tone"]> }> = {
  short: { label: "Short of cash", tone: "held" },
  below_cushion: { label: "Under the cushion", tone: "neutral" },
  over_agent_limit: { label: "Over the agent's limit", tone: "held" },
  two_approvals: { label: "Two approvals", tone: "held" },
  payment_limit: { label: "Above payment limit", tone: "held" },
  high_risk: { label: "High risk", tone: "refused" },
  same_as_milestone: { label: "May be the same payment", tone: "held" },
  due_unreadable: { label: "Due date unreadable", tone: "held" },
};

/** Where a line stands with the agent, in a few words. */
function standing(line: PlanLine, today: string): string | null {
  if (line.kind === "milestone") return line.title;
  if (line.state === "on_its_way") return "On its way";
  if (line.state === "waiting") return line.status === "processing" ? "Being decided in Approvals" : "Waits for a person";
  if (line.state === "not_counted") return "Not counted";
  if (line.status === "pending") return "Not decided by the agent yet";
  if (line.move) return `The agent scheduled it for ${line.move.from === today ? "today" : dayLabel(line.move.from)}`;
  if (line.agentOn && line.agentOn <= today) return "The agent decides it again at its next cycle";
  return "Scheduled by the agent for this day";
}

function LineRow({
  line,
  plan,
  orgSlug,
  canDecide,
  viewerId,
  soleApprover,
  blockedId,
}: {
  line: PlanLine;
  plan: PaymentPlan;
  orgSlug: string;
  canDecide: boolean;
  viewerId: string | null;
  soleApprover: boolean;
  blockedId: string;
}) {
  const own = line.createdBy !== null && line.createdBy === viewerId && !soleApprover;
  const note = standing(line, plan.today);
  // A line the plan would move says so on its row; approving it is in its details, beside the reason (B14).
  const moves = canDecide && line.move ? `Moves from ${line.move.from === plan.today ? "today" : dayLabel(line.move.from)}` : null;
  return (
    <li>
      <Disclosure
        variant="bare"
        summaryClassName="grid grid-cols-[minmax(0,1fr)_auto_1rem] items-start gap-x-4 gap-y-1 px-4 py-3 transition-colors duration-150 ease-standard hover:bg-ground/50 sm:px-5"
        summary={
          <>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-ink">{line.payee}</span>
              <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
                {note && <span>{note}</span>}
                {line.flags.map((flag) => (
                  <Badge key={flag.code} size="sm" tone={FLAG_BADGE[flag.code].tone}>
                    {FLAG_BADGE[flag.code].label}
                  </Badge>
                ))}
                {moves && <span className="font-medium text-agent">{moves}</span>}
              </span>
            </span>
            <span className="flex items-baseline gap-2 text-sm">
              {line.pays !== line.amount && line.on !== null && (
                <>
                  <span className="sr-only">Billed</span>
                  <Money value={line.amount} struck className="text-xs text-ink-3" />
                  <span className="sr-only">, pays</span>
                </>
              )}
              <Money value={line.on === null ? line.amount : line.pays} className="font-semibold text-ink" />
            </span>
            <ChevronRight aria-hidden className="mt-0.5 size-4 text-ink-3 transition-transform duration-200 ease-standard group-open/disclosure:rotate-90" />
          </>
        }
      >
        <div className="space-y-2 border-t border-line bg-ground/40 px-4 py-3 sm:px-5">
          {/* A discount the day takes is in the reason, with its value: never a second line saying it again. */}
          <p className="text-[0.8125rem] leading-snug text-ink-2">{line.reason}</p>
          {line.flags.length > 0 && (
            <ul className="space-y-1 text-xs text-ink-2">
              {line.flags.map((flag) => (
                <li key={flag.code}>
                  <span className="font-medium text-ink">{FLAG_BADGE[flag.code].label}:</span> {flag.text}
                </li>
              ))}
            </ul>
          )}
          {line.state === "waiting" && line.kind === "bill" && (
            <Button asChild variant="link" className="text-xs">
              <Link href={orgHref(orgSlug, "/approvals")}>Decide in Approvals</Link>
            </Button>
          )}
          {canDecide && line.move && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2">
              <p className="text-xs text-ink-2">
                Move it from {line.move.from === plan.today ? "today" : dayLabel(line.move.from)} to the plan&apos;s day, {dayLabel(line.move.to)}.
              </p>
              {line.approvable && !own ? (
                <ApprovePlanLine
                  orgSlug={orgSlug}
                  planFingerprint={plan.fingerprint}
                  line={{ id: line.id, fingerprint: line.fingerprint }}
                  label={`Approve paying ${line.payee} on ${dayLabel(line.move.to)}`}
                  disabled={plan.blocked !== null}
                  describedBy={plan.blocked !== null ? blockedId : undefined}
                />
              ) : own && line.approvable ? (
                <p className="max-w-[16rem] text-xs text-ink-3">You created this bill, so someone else must approve its day.</p>
              ) : (
                <p className="max-w-[16rem] text-xs text-ink-3">Clear what stops it before approving its day.</p>
              )}
            </div>
          )}
        </div>
      </Disclosure>
    </li>
  );
}

/** A day's payments, headed by the day and the balance after it: the plan's own figure for that day. */
function LineGroup({ title, lines, balance, ...rest }: { title: string; lines: PlanLine[]; balance?: number | null } & Omit<Parameters<typeof LineRow>[0], "line">) {
  if (lines.length === 0) return null;
  const under = balance != null && balance < rest.plan.cushion;
  return (
    <div>
      <h3 className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-t border-line bg-raised/40 px-4 py-2 sm:px-5">
        <span className="font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.11em] text-ink-3">{title}</span>
        {balance != null && (
          <span className={cn("text-xs font-normal", under ? "font-semibold text-held" : "text-ink-2")}>
            Balance after: <Money value={balance} />
            {under && <span className="sr-only">, under the cushion</span>}
          </span>
        )}
      </h3>
      <ol className="divide-y divide-line border-t border-line">
        {lines.map((line) => (
          <LineRow key={line.id} line={line} {...rest} />
        ))}
      </ol>
    </div>
  );
}

/** The figures the plan starts from and ends with, in one row. */
function PlanSummary({ plan }: { plan: PaymentPlan }) {
  const rows: Array<{ label: string; value: ReactNode; note?: string; tone?: "held" }> = [
    { label: "Cash now", value: <Money value={plan.cash} />, note: plan.reserve > 0 ? "Operating wallet and USYC reserve" : "Operating wallet" },
    { label: "Cushion", value: <Money value={plan.cushion} />, note: "15% of what leaves within 7 days" },
    ...(plan.lowest ? [{ label: "Lowest balance with this plan", value: <Money value={plan.lowest.balance} />, note: dayLabel(plan.lowest.day) }] : []),
    { label: "Discounts this plan would take", value: <Money value={plan.discountsPlanned} />, note: "An estimate, if paid as planned" },
    ...(plan.stillOwed > 0 ? [{ label: "Not covered by the cash", value: <Money value={plan.stillOwed} />, note: "Bills marked short, still owed", tone: "held" as const }] : []),
  ];
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 min-[420px]:grid-cols-2 lg:grid-cols-5">
      {rows.map((row) => (
        <div key={row.label} className="min-w-0">
          <dt className={cn("text-xs text-ink-3", row.tone === "held" && "text-held")}>{row.label}</dt>
          <dd className={cn("mt-0.5 text-base font-semibold text-ink", row.tone === "held" && "text-held")}>{row.value}</dd>
          {row.note && <dd className="text-xs text-ink-3">{row.note}</dd>}
        </div>
      ))}
    </dl>
  );
}

/** The cash effect: each day money leaves, the balance as the bills are scheduled now and with this plan. */
export function PlanCashEffect({ plan }: { plan: PaymentPlan }) {
  if (plan.days.length === 0) return null;
  return (
    <div className="border-t border-line px-4 py-4 sm:px-5">
      <h3 className="text-sm font-semibold text-ink">Cash effect</h3>
      <p className="mb-2 text-xs text-ink-3">Projected, before any receivable arrives.</p>
      <Table label="Cash effect, day by day">
        <TableHeader>
          <TableRow>
            <TableHead className="px-2 sm:px-3">Day</TableHead>
            <TableHead className="px-2 text-right sm:px-3">Leaves</TableHead>
            <TableHead className="px-2 text-right sm:px-3">As scheduled now</TableHead>
            <TableHead className="px-2 text-right sm:px-3">With this plan</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {plan.days.map((day) => (
            <TableRow key={day.day}>
              <TableCell className="whitespace-nowrap px-2 py-2 font-mono text-xs text-ink-2 sm:px-3">{dayLabel(day.day)}</TableCell>
              <TableCell className="px-2 py-2 text-right sm:px-3">
                <Money value={day.out} />
              </TableCell>
              <TableCell className="px-2 py-2 text-right text-ink-2 sm:px-3">
                <Money value={day.balanceNow} />
              </TableCell>
              <TableCell className={cn("px-2 py-2 text-right sm:px-3", day.balance < plan.cushion && "font-semibold text-held")}>
                <Money value={day.balance} />
                {day.balance < plan.cushion && <span className="sr-only">, under the cushion</span>}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {plan.days.some((day) => day.balance < plan.cushion) && (
        <p className="mt-2 text-xs text-ink-3">A balance under the cushion is in bold.</p>
      )}
    </div>
  );
}

/**
 * Money expected in during the 14 days, apart from every balance above (docs/superpowers/specs/2026-10-12-deal-schedule-
 * design.md D14): the open receivables, a deal's released lines among them, and the deal lines not invoiced yet.
 */
export function PlanIncomingList({ incoming }: { incoming: PaymentPlan["incoming"] }) {
  if (incoming.expected.length === 0 && incoming.planned.length === 0 && incoming.plannedRead) return null;
  const group = (title: string, note: string, lines: PaymentPlan["incoming"]["expected"]) =>
    lines.length > 0 && (
      <div className="mt-3">
        <h4 className="text-xs font-semibold text-ink-2">{title}</h4>
        <p className="text-xs text-ink-3">{note}</p>
        <ul className="mt-1 divide-y divide-line">
          {lines.map((line) => (
            <li key={line.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1.5 text-[0.8125rem]">
              <span className="min-w-0 text-ink">
                {line.from}
                {line.what && <span className="text-ink-3"> · {line.what}</span>}
              </span>
              <span className="flex items-baseline gap-3">
                <span className={cn("font-mono text-xs", line.overdue ? "text-held" : "text-ink-2")}>{line.overdue ? `Overdue, ${dayLabel(line.on)}` : dayLabel(line.on)}</span>
                <Money value={line.amount} token={line.currency} className="text-ink" />
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  return (
    <div className="border-t border-line px-4 py-4 sm:px-5">
      <h3 className="text-sm font-semibold text-ink">Money expected in</h3>
      <p className="text-xs text-ink-3">Not counted in any balance above: money expected is not cash until it arrives.</p>
      {group("Receivables due", "Invoiced, a deal's released lines included.", incoming.expected)}
      {group("Planned from deals", "Deal lines not invoiced yet, by their due day.", incoming.planned)}
      {!incoming.plannedRead && <p className="mt-2 text-xs text-ink-3">The deal lines could not be read.</p>}
    </div>
  );
}

/** The plan's three measures over the last 30 days, all counted from what happened. */
export function PlanOutcomesStrip({ outcomes }: { outcomes: PlanOutcomes }) {
  const rows: Array<{ label: string; value: ReactNode }> = [
    { label: "Paid by the due day", value: <span className="tabular-nums">{`${outcomes.paidOnTime} of ${outcomes.paid}`}</span> },
    { label: "Overdue now", value: <span className="tabular-nums">{outcomes.overdueNow}</span> },
    { label: "Discounts taken", value: <Money value={outcomes.discountsTaken} /> },
    { label: "Days moved by a person", value: <span className="tabular-nums">{outcomes.moves}</span> },
  ];
  return (
    <div className="border-t border-line px-4 py-4 sm:px-5">
      <h3 className="text-sm font-semibold text-ink">Last 30 days</h3>
      <p className="mb-2 text-xs text-ink-3">Counted from what was paid and recorded, not from a plan.</p>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        {rows.map((row) => (
          <div key={row.label} className="min-w-0">
            <dt className="text-xs text-ink-3">{row.label}</dt>
            <dd className="text-sm font-semibold text-ink">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** A part of the plan folded until opened: the figures behind the days, kept one click away. */
function PlanFold({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <Disclosure
      variant="bare"
      className="border-t border-line"
      summaryClassName="flex items-center gap-2 px-4 py-3 text-sm font-medium text-ink-2 transition-colors duration-150 ease-standard hover:text-ink sm:px-5"
      summary={
        <>
          <ChevronRight aria-hidden className="size-4 text-ink-3 transition-transform duration-200 ease-standard group-open/disclosure:rotate-90" />
          {summary}
        </>
      }
      contentClassName="[&>div]:border-t-0 [&>div]:pt-0"
    >
      {children}
    </Disclosure>
  );
}

export function PaymentPlanSection({
  plan,
  outcomes,
  orgSlug,
  canDecide,
  viewerId,
  soleApprover = false,
}: {
  plan: PaymentPlan | null;
  outcomes: PlanOutcomes | null;
  orgSlug: string;
  canDecide: boolean;
  viewerId: string | null;
  /** The viewer is the workspace's only approver: they may approve the day of a bill they created. */
  soleApprover?: boolean;
}) {
  const header = (
    <SectionHeader
      id="payment-plan-title"
      title="Payment plan"
      meta="the next 14 days, in the order the cash allows"
      action={<DocsLink href="/docs/guides/payment-plan" topic="the payment plan" />}
    />
  );
  if (!plan) {
    return (
      <section id="payment-plan" aria-labelledby="payment-plan-title" className="scroll-mt-6">
        {header}
        <Callout tone="held">The payment plan could not be read. Reload the page in a moment.</Callout>
      </section>
    );
  }

  const blockedId = "payment-plan-blocked";
  const rowProps = { plan, orgSlug, canDecide, viewerId, soleApprover, blockedId };
  const inWindow = plan.lines.filter((line) => line.state !== "not_counted" && line.inWindow);
  const later = plan.lines.filter((line) => line.state !== "not_counted" && !line.inWindow);
  const notCounted = plan.lines.filter((line) => line.state === "not_counted");
  const days = [...new Set(inWindow.map((line) => line.on as string))];
  const approvable = plan.lines.filter((line) => line.approvable && !(line.createdBy !== null && line.createdBy === viewerId && !soleApprover));
  const balanceStale = plan.freshness.state === "stale" || plan.freshness.state === "unread";
  // Each day's balance once its payments leave, as the plan worked it out (its cash effect's "With this plan").
  const balanceAfter = new Map(plan.days.map((day) => [day.day, day.balance] as const));

  return (
    <section id="payment-plan" aria-labelledby="payment-plan-title" className="scroll-mt-6">
      {header}
      <Card className="overflow-hidden">
        <div className="space-y-4 px-4 py-4 sm:px-5">
          {plan.blocked ? (
            <div id={blockedId}>
              <Callout tone="held" title={balanceStale ? "The balance is not fresh" : "Part of the plan could not be read"}>
                <p>{plan.blocked}</p>
                <p className="mt-1">The plan below uses the last figures read. Approving is off until they are fresh.</p>
                {balanceStale && (
                  <div className="mt-2">
                    <RefreshPlanBalance orgSlug={orgSlug} />
                  </div>
                )}
              </Callout>
            </div>
          ) : (
            <p className="text-xs text-ink-3">
              {plan.freshness.state === "simulated"
                ? "Sandbox: the balance is simulated."
                : `Balance read from the chain ${plan.freshness.minutes === 0 ? "less than a minute" : `${plan.freshness.minutes} min`} ago.`}
            </p>
          )}
          <PlanSummary plan={plan} />
          <p className="text-[0.8125rem] leading-relaxed text-ink-2">
            Nothing here pays a bill. Approving a line moves the day the agent pays a scheduled bill; on that day the agent checks it again with every rule.
          </p>
          <Disclosure variant="bare" summaryClassName="text-[0.8125rem] font-medium text-agent hover:underline" summary="How the plan chooses days">
            <p className="mt-2 text-[0.8125rem] leading-relaxed text-ink-2">
              {/* P4: only what holds of every move offered. A day the agent chose after the due date is brought back to the
                  due date, not before it; the cushion is left to each line, since it is not weighed for that, nor for a
                  discount day that is the only way the cash covers the bill. */}
              Each bill is paid on its due date, or on an earlier day the agent chose. The plan proposes paying before that only for a discount worth at least
              what the cash would earn until then; each line says why it is on its day. Open a line for its reason, what would stop it and, where the plan
              moves it, Approve.
            </p>
          </Disclosure>
          {canDecide
            ? approvable.length > 1 && (
                <ApproveAllShown
                  orgSlug={orgSlug}
                  planFingerprint={plan.fingerprint}
                  lines={approvable.map((line) => ({ id: line.id, fingerprint: line.fingerprint }))}
                  disabled={plan.blocked !== null}
                  describedBy={plan.blocked !== null ? blockedId : undefined}
                />
              )
            : plan.moves > 0 && <p className="text-xs text-ink-3">Only someone who can approve payments approves the plan.</p>}
        </div>

        {inWindow.length === 0 && later.length === 0 && notCounted.length === 0 ? (
          <div className="border-t border-line p-4 sm:p-5">
            <EmptyState compact title="Nothing leaves in the next 14 days" body={`No bill or milestone is due by ${dayLabel(plan.through)}.`} />
          </div>
        ) : (
          <>
            {days.map((day) => (
              <LineGroup
                key={day}
                title={day === plan.today ? `Today, ${dayLabel(day)}` : dayLabel(day)}
                lines={inWindow.filter((line) => line.on === day)}
                balance={balanceAfter.get(day) ?? null}
                {...rowProps}
              />
            ))}
            <LineGroup title={`After ${dayLabel(plan.through)}`} lines={later} {...rowProps} />
            <LineGroup title="Listed, not counted" lines={notCounted} {...rowProps} />
          </>
        )}

        <PlanFold summary="Cash effect, day by day">
          <PlanCashEffect plan={plan} />
        </PlanFold>
        {(plan.incoming.expected.length > 0 || plan.incoming.planned.length > 0 || !plan.incoming.plannedRead) && (
          <PlanFold summary="Money expected in">
            <PlanIncomingList incoming={plan.incoming} />
          </PlanFold>
        )}
        {plan.eurc.count > 0 && (
          <p className="border-t border-line px-4 py-3 text-xs text-ink-3 sm:px-5">
            {plan.eurc.count} {plan.eurc.count === 1 ? "bill" : "bills"} in EURC (<Money value={plan.eurc.amount} token="EURC" />) {plan.eurc.count === 1 ? "is" : "are"} paid from the EURC balance and{" "}
            {plan.eurc.count === 1 ? "is" : "are"} not in this plan.
          </p>
        )}
        {outcomes && <PlanOutcomesStrip outcomes={outcomes} />}
      </Card>
    </section>
  );
}
