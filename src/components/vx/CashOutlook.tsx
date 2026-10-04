import { Callout } from "@/components/ui/Callout";
import { Card, CardContent } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { SectionHeader } from "@/components/ui/SectionHeader";
import type { CashOutlook, OutlookItem } from "@/lib/cash-outlook";
import { utcDay } from "@/lib/copy";
import { Money } from "./Primitives";

/**
 * Safe to spend today, and the next 30 days of money moving
 * (docs/superpowers/specs/2026-10-02-safe-to-spend-design.md): the figure, how it was reached from what
 * the agent counts as owed, and the days money is due or expected, with the wallet's balance after each.
 */

const dayLabel = (day: string) => utcDay(`${day}T00:00:00Z`);
const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

/**
 * How Safe to spend today is reached: the wallet and the USYC reserve, less what is owed, with what is left out and
 * the first short day.
 */
function SafeToSpendBreakdown({ outlook, columns = false }: { outlook: CashOutlook; columns?: boolean }) {
  const rows: Array<{ label: string; value: number; sign?: "−" }> = [
    { label: "In the operating wallet", value: outlook.cash },
    ...(outlook.reserve > 0 ? [{ label: "In the USYC reserve, back in seconds", value: outlook.reserve }] : []),
    { label: `Due within 30 days (${plural(outlook.dueCount, "invoice")})`, value: outlook.dueIn30d, sign: "−" },
    { label: `Open milestones (${outlook.milestoneCount})`, value: outlook.milestonesOpen, sign: "−" },
    { label: "Cushion: 15% of the next 7 days", value: outlook.cushion, sign: "−" },
  ];
  return (
    <>
      <dl className={cn("space-y-1.5 text-[0.8125rem]", columns && "sm:grid sm:grid-cols-2 sm:gap-x-8 sm:gap-y-1.5 sm:space-y-0")}>
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-3">
            <dt className="min-w-0 text-ink-2">{row.label}</dt>
            <dd className="shrink-0 text-ink">
              <Money value={row.value} sign={row.value > 0 ? row.sign : undefined} />
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs leading-5 text-ink-3">
        {outlook.expectedIn30d > 0 ? (
          <>
            Receivables expected within 30 days, <Money value={outlook.expectedIn30d} />, are not counted until they arrive.
          </>
        ) : (
          "No receivable is expected within 30 days."
        )}
        {outlook.eurcLeftOut > 0 && (
          <>
            {" "}
            <Money value={outlook.eurcLeftOut} token="EURC" /> due in EURC is paid from the EURC balance, so it is left out.
          </>
        )}
      </p>
      {outlook.shortOn && (
        <Callout tone="held" title={`The wallet runs short on ${dayLabel(outlook.shortOn)}`} className="mt-4">
          That is before any receivable arrives, with the USYC reserve brought back. Fund the operating wallet, or the agent holds what it cannot cover.
        </Callout>
      )}
    </>
  );
}

/** The figure itself: an amount, or how short the wallet is. */
export function SafeToSpendFigure({ outlook }: { outlook: CashOutlook }) {
  return outlook.safeToSpend < 0 ? (
    <>
      Short by <Money value={-outlook.safeToSpend} />
    </>
  ) : (
    <Money value={outlook.safeToSpend} />
  );
}

export function SafeToSpendPanel({ outlook }: { outlook: CashOutlook }) {
  const short = outlook.safeToSpend < 0;
  return (
    <Card asChild>
      <section aria-labelledby="safe-to-spend">
        <CardContent className="p-4 sm:p-5">
          <SectionHeader title="Safe to spend today" meta="after everything already owed" />
          <p id="safe-to-spend" className={cn("text-2xl font-semibold tracking-[-0.02em]", short ? "text-held" : "text-ink")}>
            <SafeToSpendFigure outlook={outlook} />
          </p>
          <div className="mt-3">
            <SafeToSpendBreakdown outlook={outlook} />
          </div>
        </CardContent>
      </section>
    </Card>
  );
}

/**
 * The console's one picture of money owed (safe to spend design, console layout): how Safe to spend today is
 * reached, then the next 30 days day by day. The figure itself is the console's headline tile, which links here.
 */
export function CashOutlookPanel({ outlook }: { outlook: CashOutlook }) {
  return (
    <Card asChild className="overflow-hidden">
      <section id="cash-outlook" aria-labelledby="cash-outlook-title" className="scroll-mt-6">
        <div className="px-4 pt-4 sm:px-5">
          <SectionHeader id="cash-outlook-title" title="Next 30 days" meta="how Safe to spend today is reached, then day by day" />
          <div className="pb-4">
            <SafeToSpendBreakdown outlook={outlook} columns />
          </div>
        </div>
        {outlook.days.length > 0 && <CalendarDays outlook={outlook} />}
      </section>
    </Card>
  );
}

const SIGN: Record<OutlookItem["kind"], "+" | "−"> = { out: "−", milestone: "−", in: "+" };

/** A balance, with its minus sign when below zero (Money writes the magnitude). */
function Balance({ value }: { value: number }) {
  return <Money value={value} sign={value < 0 ? "−" : undefined} />;
}

/** Each day money is due or expected, with the wallet's balance after it. */
function CalendarDays({ outlook }: { outlook: CashOutlook }) {
  return (
    <ol className="divide-y divide-line border-t border-line">
      {outlook.days.map((day) => (
        <li key={day.day} className="px-4 py-3 sm:px-5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <span className="font-mono text-xs text-ink-3">{dayLabel(day.day)}</span>
            <span className={cn("text-xs", day.balance < 0 ? "font-medium text-held" : "text-ink-2")}>
              Balance after <Balance value={day.balance} />
              {day.balanceWithExpected !== day.balance && (
                <span className="text-ink-3">
                  {" "}
                  (<Balance value={day.balanceWithExpected} /> with expected)
                </span>
              )}
            </span>
          </div>
          <ul className="mt-1 space-y-0.5">
            {day.items.map((item, index) => (
              <li key={`${item.kind}-${item.label}-${index}`} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate text-ink">
                  {item.label} <span className="text-xs text-ink-3">{item.note}</span>
                </span>
                <Money value={item.amount} sign={SIGN[item.kind]} className={cn("shrink-0", item.kind === "in" ? "text-proof" : "text-ink")} />
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

export function CashCalendar({ outlook }: { outlook: CashOutlook }) {
  if (outlook.days.length === 0) return null;
  return (
    <Card asChild className="overflow-hidden">
      <section>
        <div className="px-4 pt-4 sm:px-5">
          <SectionHeader title="Next 30 days" meta="money due and expected, day by day" />
        </div>
        <CalendarDays outlook={outlook} />
      </section>
    </Card>
  );
}
