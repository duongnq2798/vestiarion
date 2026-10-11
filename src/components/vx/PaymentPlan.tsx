import type { ReactNode } from "react";
import Link from "next/link";
import { DocsLink } from "@/components/DocsLink";
import { ApproveAllShown, ApprovePlanLine, RefreshPlanBalance } from "@/components/PaymentPlanControls";
import { Badge, type BadgeProps } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import { orgHref } from "@/lib/auth/org-paths";
import { utcDay } from "@/lib/copy";
import type { PaymentPlan, PlanFlagCode, PlanLine } from "@/lib/payment-plan";
import type { PlanOutcomes } from "@/lib/payment-plan-outcomes";
import { Money } from "./Primitives";

/**
 * Bills & receivables' payment plan (docs/superpowers/specs/2026-10-11-payment-plan-design.md): the next 14 days of what
 * leaves the operating wallet, in the order the cash allows, each line with why it is on its day, what would stop it,
 * and the balance after it; the cash effect day by day against the schedule as it stands; and, for someone who
 * approves payments, Approve on a line the plan would move. Every figure is a projection but the last 30 days'.
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
  if (line.agentOn && line.agentOn <= today) return "The agent pays it at its next cycle";
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
  const counted = line.on !== null && line.inWindow && line.state !== "not_counted";
  const short = line.flags.some((flag) => flag.code === "short");
  const note = standing(line, plan.today);
  return (
    <li className="px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-64">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <span className="min-w-0 text-sm font-medium text-ink">{line.payee}</span>
            <span className="flex items-baseline gap-2 text-sm">
              {line.pays !== line.amount && line.on !== null && <Money value={line.amount} struck className="text-xs text-ink-3" />}
              <Money value={line.on === null ? line.amount : line.pays} className="text-ink" />
            </span>
          </div>
          {note && <p className="mt-0.5 text-xs text-ink-3">{note}</p>}
          <p className="mt-1 text-[0.8125rem] leading-snug text-ink-2">{line.reason}</p>
          {line.discount?.taken && counted && !short && (
            <p className="mt-1 text-xs text-ink-2">
              Takes the {line.discount.pct}% discount, <Money value={line.discount.value} />, if paid on this day.
            </p>
          )}
          {line.flags.length > 0 && (
            <ul className="mt-2 space-y-1">
              {line.flags.map((flag) => (
                <li key={flag.code} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-ink-2">
                  <Badge size="sm" tone={FLAG_BADGE[flag.code].tone}>
                    {FLAG_BADGE[flag.code].label}
                  </Badge>
                  <span>{flag.text}</span>
                </li>
              ))}
            </ul>
          )}
          {line.state === "waiting" && line.kind === "bill" && (
            <Button asChild variant="link" className="mt-1 text-xs">
              <Link href={orgHref(orgSlug, "/approvals")}>Decide in Approvals</Link>
            </Button>
          )}
          {counted && !short && line.balanceAfter !== null && (
            <p className="mt-1 text-xs text-ink-3">
              Balance after: <Money value={line.balanceAfter} />
            </p>
          )}
        </div>
        {canDecide && line.move && (
          <div className="flex shrink-0 flex-col items-end gap-1 text-right">
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
    </li>
  );
}

function LineGroup({ title, lines, ...rest }: { title: string; lines: PlanLine[] } & Omit<Parameters<typeof LineRow>[0], "line">) {
  if (lines.length === 0) return null;
  return (
    <div>
      <h3 className="border-t border-line bg-raised/40 px-4 py-2 font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.11em] text-ink-3 sm:px-5">{title}</h3>
      <ol className="divide-y divide-line border-t border-line">
        {lines.map((line) => (
          <LineRow key={line.id} line={line} {...rest} />
        ))}
      </ol>
    </div>
  );
}

/** The figures the plan starts from and ends with. */
function PlanSummary({ plan }: { plan: PaymentPlan }) {
  const rows: Array<{ label: string; value: ReactNode; note?: string; tone?: "held" }> = [
    { label: "Cash now", value: <Money value={plan.cash} />, note: plan.reserve > 0 ? "The operating wallet and the USYC reserve" : "The operating wallet" },
    { label: "Cushion", value: <Money value={plan.cushion} />, note: "15% of the next 7 days, as Safe to spend keeps" },
    ...(plan.lowest ? [{ label: "Lowest balance with this plan", value: <Money value={plan.lowest.balance} />, note: dayLabel(plan.lowest.day) }] : []),
    ...(plan.stillOwed > 0 ? [{ label: "Not covered by the cash", value: <Money value={plan.stillOwed} />, note: "Bills marked short, still owed", tone: "held" as const }] : []),
    { label: "Discounts this plan would take", value: <Money value={plan.discountsPlanned} />, note: "An estimate, if paid as planned" },
  ];
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 min-[420px]:grid-cols-2 lg:grid-cols-3">
      {rows.map((row) => (
        <div key={row.label} className="min-w-0">
          <dt className={cn("text-xs text-ink-3", row.tone === "held" && "text-held")}>{row.label}</dt>
          <dd className="mt-0.5 text-base font-semibold text-ink">{row.value}</dd>
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
              <TableCell className={cn("px-2 py-2 text-right sm:px-3", day.balance < plan.cushion && "font-medium text-held")}>
                <Money value={day.balance} />
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

/** The plan's three measures over the last 30 days, all counted from what happened. */
function PlanOutcomesStrip({ outcomes }: { outcomes: PlanOutcomes }) {
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
            Each bill is paid on its due date, or earlier only to take an early-payment discount while the balance stays above the cushion. Approving a line moves
            the day the agent pays a scheduled bill; on that day the agent checks the bill again, with every rule, before it pays. Nothing here pays a bill.
          </p>
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
                {...rowProps}
              />
            ))}
            <LineGroup title={`After ${dayLabel(plan.through)}`} lines={later} {...rowProps} />
            <LineGroup title="Listed, not counted" lines={notCounted} {...rowProps} />
          </>
        )}

        <PlanCashEffect plan={plan} />
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
