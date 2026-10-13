"use client";

import { RotateCcw } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { StatTile } from "@/components/vx/StatTile";
import { utcDay } from "@/lib/copy";
import { dealCashReadiness, depositLever, percentWords, tryDeposit, type CashDay, type CashItem, type CashReadiness } from "@/lib/deals/cash";
import type { DealCost } from "@/lib/deals/costs";
import type { DealFacts } from "@/lib/deals/lines";
import { formatMinor } from "@/lib/deals/money";
import { DealMoney } from "./DealMoney";

const dayWords = (day: string) => utcDay(`${day}T00:00:00.000Z`);

const KIND: Record<CashItem["kind"], string> = { planned: "planned", expected: "expected", due: "to pay" };

/** The headline: short and when, no gap, or not enough data; with how the short day's figure is made. */
function Headline({ readiness, money, label }: { readiness: CashReadiness; money: (minor: number) => string; label?: string }) {
  const short = readiness.short;
  if (short) {
    const index = readiness.days.findIndex((day) => day.day === short.day);
    const day = index >= 0 ? readiness.days[index] : null;
    const before = index > 0 ? readiness.days[index - 1].positionMinor : readiness.toDateMinor;
    return (
      <Callout tone="held" title={`${label ?? ""}Short by ${money(short.byMinor)} on ${dayWords(short.day)}`}>
        <p>
          {day
            ? `${dayWords(short.day)}: ${money(before)} before it, + ${money(day.inMinor)} in, − ${money(day.outMinor)} out = ${money(day.positionMinor)}.`
            : `To date: ${money(readiness.collected.totalMinor)} collected − ${money(readiness.paidOut.totalMinor)} paid out = ${money(readiness.toDateMinor)}.`}
          {short.deepest.day !== short.day && ` The deepest gap is ${money(short.deepest.byMinor)} on ${dayWords(short.deepest.day)}.`}
        </p>
        <p className="text-ink-2">This much has to come from elsewhere before the customer pays, or the costs have to wait.</p>
      </Callout>
    );
  }
  if (readiness.costs.entered === 0) {
    return (
      <Callout title={`${label ?? ""}Not enough data`}>
        {readiness.costs.read ? (
          <p>
            No cost is entered for this deal, so nothing says when it needs cash. <a href="#costs" className="font-medium text-agent underline-offset-2 hover:underline">Add its costs</a>, such as a contractor or a vendor it pays.
          </p>
        ) : (
          <p>Costs are not set up on this deployment yet.</p>
        )}
      </Callout>
    );
  }
  return (
    <Callout tone="proof" title={`${label ?? ""}No cash gap`}>
      <p>
        The position stays at or above zero on every day, if the customer pays each line on its due day. It ends at {money(readiness.endMinor)}.
      </p>
    </Callout>
  );
}

function ItemLine({ item, money }: { item: CashItem; money: (minor: number) => string }) {
  return (
    <li className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className={cn("shrink-0 font-mono text-xs tabular-nums", item.direction === "in" ? "text-proof" : "text-held")}>
        {item.direction === "in" ? "+" : "−"}
        {money(item.amountMinor)}
      </span>
      <span className="text-[0.8125rem] font-medium text-ink">{item.label}</span>
      <span className="text-[0.6875rem] uppercase tracking-wide text-ink-3">{item.source === "line" ? `schedule, ${KIND[item.kind]}` : `cost, ${KIND[item.kind]}`}</span>
      <span className="basis-full text-xs text-ink-3">{item.basis}</span>
    </li>
  );
}

function DayRow({ day, money }: { day: CashDay; money: (minor: number) => string }) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 px-4 py-3 sm:grid-cols-[8rem_minmax(0,1fr)_9rem] sm:px-5">
      <span className="font-mono text-xs text-ink-2 sm:pt-0.5">{dayWords(day.day)}</span>
      <span className={cn("text-right font-mono text-xs font-semibold tabular-nums sm:order-last sm:pt-0.5", day.positionMinor < 0 ? "text-held" : "text-ink")}>
        {money(day.positionMinor)}
        <span className="block font-sans text-[0.6875rem] font-normal text-ink-3">position after the day</span>
      </span>
      <ul className="col-span-2 space-y-1.5 sm:col-span-1">
        {day.items.map((item) => (
          <ItemLine key={`${item.source}-${item.id}`} item={item} money={money} />
        ))}
      </ul>
    </li>
  );
}

/**
 * A deal's cash readiness (docs/superpowers/specs/2026-10-13-deal-cash-readiness-design.md K4-K7): what was collected
 * and paid out to date, then day by day the money its schedule brings in against what its costs take out, the first
 * day it would be short, and an estimated margin; with a try of another deposit day or percent, worked out here as it
 * is typed and never saved. Planned and expected money is never called cash.
 */
export function DealCashReadiness({
  facts,
  digits,
  costs,
  today,
  changeHref,
  initialTry,
}: {
  facts: DealFacts;
  digits: number;
  /** Null when the costs could not be read, or before they are set up. */
  costs: DealCost[] | null;
  today: string;
  /** Where Change deal is, for a person who may save a try as a new version. */
  changeHref?: string;
  /** A try to start from: a guide's picture. */
  initialTry?: { depositOn?: string; depositPct?: string };
}) {
  const money = (minor: number) => `${minor < 0 ? "−" : ""}${formatMinor(Math.abs(minor), digits)} ${facts.currency}`;
  const amount = (minor: number) => <DealMoney minor={minor} digits={digits} currency={facts.currency} />;
  const lever = depositLever(facts);
  const startPct = lever ? String(Number((lever.basisPoints / 100).toFixed(2))) : "";
  const [depositOn, setDepositOn] = useState(initialTry?.depositOn ?? lever?.invoiceOn ?? "");
  const [depositPct, setDepositPct] = useState(initialTry?.depositPct ?? startPct);

  const base = dealCashReadiness({ facts, digits }, costs, today);
  const trying = lever !== null && (depositOn !== lever.invoiceOn || depositPct.trim() !== startPct);
  const tried = trying ? tryDeposit(facts, { depositOn: depositOn !== lever?.invoiceOn ? depositOn : undefined, depositPct: depositPct.trim() !== startPct ? depositPct : undefined }, digits) : null;
  const triedReadiness = tried?.ok ? dealCashReadiness({ facts: tried.facts, digits }, costs, today) : null;
  const shown = triedReadiness ?? base;
  const margin = shown.margin;
  const lowest = shown.days.reduce((low, day) => Math.min(low, day.positionMinor), shown.toDateMinor);

  return (
    <section id="cash-readiness" aria-labelledby="deal-cash-title" className="scroll-mt-6 space-y-4">
      <SectionHeader
        id="deal-cash-title"
        title="Cash readiness"
        meta="what comes in against what the costs take out, if the customer pays each line on its due day; planned and expected money is not cash"
        action={triedReadiness ? <Badge tone="agent" size="sm">Showing a try, not saved</Badge> : undefined}
      />
      <Headline readiness={shown} money={money} />

      <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Collected to date"
          sub={shown.collected.lines.length > 0 ? shown.collected.lines.map((line) => `${line.label} ${formatMinor(line.amountMinor, digits)}`).join(" + ") : "Nothing paid by the customer yet"}
        >
          {amount(shown.collected.totalMinor)}
        </StatTile>
        <StatTile label="Paid out to date" sub={shown.paidOut.costs.length > 0 ? shown.paidOut.costs.map((cost) => `${cost.label} ${formatMinor(cost.amountMinor, digits)}`).join(" + ") : "No cost paid yet"}>
          {amount(shown.paidOut.totalMinor)}
        </StatTile>
        <StatTile label="Lowest position" tone={lowest < 0 ? "held" : "default"} sub={`Collected − paid out to date, then each day's money in − out. It ends at ${money(shown.endMinor)}.`}>
          {amount(lowest)}
        </StatTile>
        <StatTile
          label="Estimated margin"
          sub={
            margin.state === "estimated"
              ? `${money(margin.totalMinor)} total − ${money(margin.costsMinor)} in ${margin.costCount} ${margin.costCount === 1 ? "cost" : "costs"}${margin.withoutDocument > 0 ? `, ${margin.withoutDocument} with no document yet` : ""}`
              : margin.why === "no_costs"
                ? "No cost is entered for this deal"
                : "The costs could not be read"
          }
        >
          {margin.state === "estimated" ? (
            <span className="flex flex-wrap items-baseline gap-x-2">
              {amount(margin.marginMinor)}
              {margin.basisPoints !== null && <span className="text-sm font-medium text-ink-2">{percentWords(margin.basisPoints)}</span>}
            </span>
          ) : (
            <span className="text-base text-ink-2">Not enough data</span>
          )}
        </StatTile>
      </div>

      {lever && (
        <Card className="space-y-3 px-4 py-4 sm:px-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold text-ink">Try a different deposit</h3>
            <span className="text-xs text-ink-3">
              {lever.label}: {money(lever.amountMinor)}, {percentWords(lever.basisPoints)}, invoiced {dayWords(lever.invoiceOn)}. Nothing here is saved.
            </span>
          </div>
          <div className="grid gap-3 sm:grid-cols-[12rem_10rem_auto] sm:items-end">
            <Field id="cash-try-day" label="Deposit invoiced on" error={tried && !tried.ok && tried.field === "depositOn" ? tried.message : undefined} description={`Due ${facts.termsDays} ${facts.termsDays === 1 ? "day" : "days"} later`}>
              <Input type="date" value={depositOn} min={facts.startsOn} onChange={(event) => setDepositOn(event.target.value)} />
            </Field>
            <Field id="cash-try-pct" label="Deposit (%)" error={tried && !tried.ok && tried.field === "depositPct" ? tried.message : undefined}>
              <Input inputMode="decimal" value={depositPct} onChange={(event) => setDepositPct(event.target.value)} />
            </Field>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              icon={<RotateCcw />}
              disabled={!trying}
              onClick={() => {
                setDepositOn(lever.invoiceOn);
                setDepositPct(startPct);
              }}
              className="sm:mb-0.5"
            >
              Back to the deal
            </Button>
          </div>
          {triedReadiness && tried?.ok && (
            <div aria-live="polite" className="space-y-2 rounded-xl border border-agent-line bg-agent-soft/50 px-3 py-2.5 text-[0.8125rem] text-ink">
              <p className="font-medium">
                With this try: {triedReadiness.short ? `short by ${money(triedReadiness.short.byMinor)} on ${dayWords(triedReadiness.short.day)}` : triedReadiness.costs.entered === 0 ? "no cost to compare" : "no cash gap"}. Now:{" "}
                {base.short ? `short by ${money(base.short.byMinor)} on ${dayWords(base.short.day)}` : base.costs.entered === 0 ? "no cost to compare" : "no cash gap"}.
              </p>
              {tried.changes.length > 0 && (
                <ul className="list-disc space-y-0.5 pl-5 text-xs text-ink-2">
                  {tried.changes.map((change) => (
                    <li key={change}>{change}</li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-ink-2">
                Nothing is saved.{" "}
                {changeHref ? (
                  <>
                    To keep it, <a href={changeHref} className="font-medium text-agent underline-offset-2 hover:underline">change the deal</a>: it is saved as a new version.
                  </>
                ) : (
                  "An owner or admin keeps it by changing the deal, as a new version."
                )}
              </p>
            </div>
          )}
        </Card>
      )}

      <Card className="overflow-hidden">
        <ol aria-label="Day by day" className="divide-y divide-line">
          <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 bg-raised/40 px-4 py-3 sm:grid-cols-[8rem_minmax(0,1fr)_9rem] sm:px-5">
            <span className="font-mono text-xs font-semibold text-ink-2">To date</span>
            <span className={cn("text-right font-mono text-xs font-semibold tabular-nums sm:order-last", shown.toDateMinor < 0 ? "text-held" : "text-ink")}>{money(shown.toDateMinor)}</span>
            <span className="col-span-2 text-xs text-ink-2 sm:col-span-1">
              {money(shown.collected.totalMinor)} collected − {money(shown.paidOut.totalMinor)} paid out: money that moved.
            </span>
          </li>
          {shown.days.map((day) => (
            <DayRow key={day.day} day={day} money={money} />
          ))}
          {shown.days.length === 0 && <li className="px-4 py-3 text-xs text-ink-3 sm:px-5">Nothing else is planned or expected to move.</li>}
        </ol>
        <p className="border-t border-line px-4 py-2.5 text-xs text-ink-3 sm:px-5">
          Money in: each line of the schedule on its due day, planned until it is invoiced, expected until it is paid; an overdue one counts today. Money out: each cost on its
          day, or the bill or milestone it became. A credit owed to the customer is neither. No line is weighted by how likely it is.
        </p>
      </Card>
    </section>
  );
}
