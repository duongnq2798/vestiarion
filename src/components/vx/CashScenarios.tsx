"use client";

import { useId, useMemo, useState, type PointerEvent, type ReactNode } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { Disclosure } from "@/components/ui/Disclosure";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import {
  cashScenario,
  COST_RANGE,
  DEFAULT_LEVERS,
  HORIZONS,
  MAX_LATE_DAYS,
  receivablesIn,
  type CaseSummary,
  type Driver,
  type Horizon,
  type ReceivableChoice,
  type ScenarioBasis,
  type ScenarioLevers,
  type ScenarioResult,
  type Suggestion,
} from "@/lib/cash-scenarios";
import { utcDay } from "@/lib/copy";
import { Money } from "./Primitives";

/**
 * What if clients pay late? (docs/superpowers/specs/2026-10-11-cash-scenarios-design.md): Treasury's folded section
 * under Next 30 days. A person picks a horizon, how late clients pay, which receivables are late, on time or never
 * arrive, and a change in bill costs; the section works it out in the browser from the rows the page passed, on every
 * render, so a refreshed row moves its day (C10). It shows the balance if clients pay on time and in the scenario, the first
 * short day, the bills it touches, advice in words, what moves it most and what it is built from. Nothing is saved,
 * paid or sent to the agent (C9).
 */

const dayLabel = (day: string) => utcDay(`${day}T00:00:00Z`);
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/**
 * The base case's name. It assumes every receivable arrives on its due day, so it is named by that assumption, never
 * as the status quo: Next 30 days, above, counts no receivable and can run short where this case does not.
 */
const BASE_CASE = "If clients pay on time";

/** A balance, with its minus sign when below zero (Money writes the magnitude). */
function Balance({ value, className }: { value: number; className?: string }) {
  return <Money value={value} sign={value < 0 ? "−" : undefined} className={className} />;
}

const CHOICES: Array<{ value: ReceivableChoice; label: string }> = [
  { value: "late", label: "Late" },
  { value: "on_time", label: "On time" },
  { value: "never", label: "Never arrives" },
];

const isChoice = (value: string): value is ReceivableChoice => CHOICES.some((choice) => choice.value === value);
const isHorizon = (value: number): value is Horizon => (HORIZONS as readonly number[]).includes(value);

/** A typed number, or 0 while the field is empty or half typed (the engine holds it within its range). */
const typed = (text: string) => {
  const value = Number(text.trim());
  return text.trim() === "" || !Number.isFinite(value) ? 0 : value;
};

/**
 * The section. `outcome={false}` draws the levers alone, for the guide's picture of them; the parts of the outcome
 * (`ScenarioCases`, `ScenarioFindings`, `CoverageList`) have their own pictures.
 */
export function CashScenarios({ basis, defaultOpen = false, outcome = true }: { basis: ScenarioBasis; defaultOpen?: boolean; outcome?: boolean }) {
  const id = useId();
  const [horizon, setHorizon] = useState<Horizon>(DEFAULT_LEVERS.horizon);
  const [lateText, setLateText] = useState(String(DEFAULT_LEVERS.lateDays));
  const [costText, setCostText] = useState(String(DEFAULT_LEVERS.costPct));
  const [costScope, setCostScope] = useState<ScenarioLevers["costScope"]>(DEFAULT_LEVERS.costScope);
  const [choices, setChoices] = useState<Record<string, ReceivableChoice>>({});

  const levers: ScenarioLevers = useMemo(
    () => ({ horizon, lateDays: typed(lateText), costPct: typed(costText), costScope, choices }),
    [horizon, lateText, costText, costScope, choices]
  );
  // Worked out from the rows on every render, never kept: a row the page re-reads moves its day (C10).
  const result = useMemo(() => cashScenario(basis, levers), [basis, levers]);
  const receivables = receivablesIn(basis, horizon);
  const foreignBills = basis.outflows.filter((outflow) => outflow.day < horizon && outflow.foreign).length;

  return (
    <section id="cash-scenarios" aria-labelledby={`${id}-title`} className="scroll-mt-6">
      <Disclosure
        defaultOpen={defaultOpen}
        summaryClassName="items-start px-4 py-4 sm:px-5"
        contentClassName="space-y-6 border-t border-line px-4 pt-5 pb-5 sm:px-5"
        summary={
          <span className="grid gap-0.5">
            <h2 id={`${id}-title`} className="text-base font-semibold tracking-tight text-ink">
              What if clients pay late?
            </h2>
            <span className="text-[0.8125rem] font-normal text-ink-3">Late or missing receivables and changed bill costs, 30 to 90 days ahead. Nothing here is saved or paid.</span>
          </span>
        }
      >
        <div className="grid gap-5 sm:grid-cols-2">
          <div className="grid content-start gap-1.5 sm:col-span-2">
            <p id={`${id}-horizon`} className="text-sm font-medium text-ink">
              Look ahead
            </p>
            <div role="group" aria-labelledby={`${id}-horizon`} className="flex flex-wrap gap-2">
              {HORIZONS.map((days) => (
                <Button key={days} size="sm" variant={days === horizon ? "primary" : "secondary"} aria-pressed={days === horizon} onClick={() => isHorizon(days) && setHorizon(days)}>
                  {days} days
                </Button>
              ))}
            </div>
          </div>
          <Field id={`${id}-late`} label="Clients pay late by (days)" description="Counted from each receivable's due day, or from today for one already overdue.">
            <Input type="number" inputMode="numeric" min={0} max={MAX_LATE_DAYS} step={1} value={lateText} onChange={(event) => setLateText(event.target.value)} />
          </Field>
          <Field id={`${id}-cost`} label="Change in bill costs (%)" description="10 is 10% more, -10 is 10% less. Milestones keep their amounts.">
            {/* No inputMode: a phone's decimal keypad has no minus key, and a fall in costs is typed with one. */}
            <Input type="number" min={COST_RANGE.min} max={COST_RANGE.max} step={1} value={costText} onChange={(event) => setCostText(event.target.value)} />
          </Field>
          <Field id={`${id}-scope`} label="The change applies to" className="sm:col-span-2" description="A bill written in another currency was worked out in USDC at a rate, as shadow mode takes it.">
            <Select value={costScope} onValueChange={(value) => setCostScope(value === "foreign" ? "foreign" : "all")}>
              <SelectTrigger className="sm:max-w-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Every bill</SelectItem>
                <SelectItem value="foreign">{`Bills written in another currency (${foreignBills})`}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>

        <div>
          <h3 className="text-sm font-medium text-ink">Receivables due in the next {horizon} days</h3>
          {receivables.length === 0 ? (
            <p className="mt-1.5 text-sm text-ink-3">No receivable is due in the next {horizon} days.</p>
          ) : (
            <ul className="mt-2 divide-y divide-line rounded-xl border border-line">
              {receivables.map((receivable) => (
                <li key={receivable.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-2.5">
                  <span className="min-w-0 text-sm text-ink">
                    {receivable.label} <Money value={receivable.amount} className="text-ink-2" />{" "}
                    <span className="text-xs text-ink-3">{receivable.overdue ? "overdue" : `due ${dayLabel(dayOf(basis.today, receivable.day))}`}</span>
                  </span>
                  <Select
                    value={choices[receivable.id] ?? "late"}
                    onValueChange={(value) => isChoice(value) && setChoices((current) => ({ ...current, [receivable.id]: value }))}
                  >
                    <SelectTrigger size="sm" className="w-40" aria-label={`When ${receivable.label} pays`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CHOICES.map((choice) => (
                        <SelectItem key={choice.value} value={choice.value}>
                          {choice.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </li>
              ))}
            </ul>
          )}
        </div>

        {outcome && <ScenarioOutcome result={result} />}
      </Disclosure>
    </section>
  );
}

/** `today` plus `offset` days, as a UTC day. */
function dayOf(today: string, offset: number): string {
  return new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
}

/** Everything worked out for one set of levers: the two cases, the chart, the bills touched, advice, drivers, coverage. */
export function ScenarioOutcome({ result }: { result: ScenarioResult }) {
  return (
    <div className="space-y-6">
      <ScenarioCases result={result} />
      <ScenarioFindings result={result} />
      <CoverageList result={result} />
      <DayByDay result={result} />
      <p className="text-xs leading-5 text-ink-3">
        A what-if from the bills and receivables on record, not a forecast. Nothing here is saved, changes a payment or reaches the agent: Safe to spend today and
        every payment still count no receivable.
      </p>
    </div>
  );
}

/** The two cases side by side, the buckets in words, and the chart. */
export function ScenarioCases({ result }: { result: ScenarioResult }) {
  return (
    <div className="space-y-6">
      {/* One short line for a screen reader as the levers change, not the whole section. */}
      <p className="sr-only" aria-live="polite">
        {result.scenario.shortOn
          ? `In this scenario the balance runs short on ${dayLabel(result.scenario.shortOn)}.`
          : `In this scenario the balance never runs short in the next ${result.horizon} days.`}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <CaseBox
          title={BASE_CASE}
          summary={result.base}
          horizon={result.horizon}
          assumes="Each receivable on its due day, an overdue one today. Next 30 days counts none."
        />
        <CaseBox title="In this scenario" summary={result.scenario} horizon={result.horizon} changes={<ScenarioChanges result={result} />} />
      </div>
      <p className="text-xs leading-5 text-ink-3">
        Cash today: <Money value={result.cash + result.reserve} />, in the operating wallet{result.reserve > 0 ? " and the USYC reserve" : ""}. No bank balance is counted.
        Receivables due in the next {result.horizon} days:{" "}
        <Money value={result.receivables.base} />, counted only on the day they arrive; in this scenario <Money value={result.receivables.scenario} /> arrives within the{" "}
        {result.horizon} days. Deals not invoiced yet are not counted.
      </p>
      <ScenarioChart result={result} />
    </div>
  );
}

/** What a short scenario touches, advice in words, and what moves it most; nothing when there is none of it. */
export function ScenarioFindings({ result }: { result: ScenarioResult }) {
  if (result.affected.length === 0 && result.suggestions.length === 0 && result.drivers.length === 0) return null;
  return (
    <div className="space-y-6">
      {result.affected.length > 0 && <AffectedBills result={result} />}
      {result.suggestions.length > 0 && <Suggestions result={result} />}
      {result.drivers.length > 0 && <Drivers result={result} />}
    </div>
  );
}

function CaseBox({ title, summary, horizon, assumes, changes }: { title: string; summary: CaseSummary; horizon: number; assumes?: string; changes?: ReactNode }) {
  const short = summary.shortOn !== null;
  return (
    <div className={cn("rounded-xl border p-3.5", short ? "border-held-line bg-held-soft/40" : "border-line bg-ground/40")}>
      <h3 className="text-xs font-medium text-ink-2">{title}</h3>
      {assumes && <p className="mt-0.5 text-xs text-ink-3">{assumes}</p>}
      <p className={cn("mt-1 text-sm font-semibold", short ? "text-held" : "text-ink")}>
        {short ? `Runs short on ${dayLabel(summary.shortOn as string)}` : `Never short in the next ${horizon} days`}
      </p>
      <p className="mt-1 text-xs text-ink-2">
        Lowest: <Balance value={summary.lowest.balance} /> on {dayLabel(summary.lowest.day)}
      </p>
      {summary.belowCushionOn && summary.belowCushionOn !== summary.shortOn && (
        <p className="mt-0.5 text-xs text-ink-2">Below the cushion from {dayLabel(summary.belowCushionOn)}</p>
      )}
      {changes}
    </div>
  );
}

/** What the scenario changed, in words. */
function ScenarioChanges({ result }: { result: ScenarioResult }) {
  const late = result.moved.filter((moved) => moved.arrives !== null);
  const never = result.moved.filter((moved) => moved.arrives === null);
  const outside = late.filter((moved) => moved.outside);
  const lines = [
    late.length > 0 &&
      `${plural(late.length, "receivable")} ${result.levers.lateDays} days late${outside.length > 0 ? `, ${outside.length} of them after the ${result.horizon} days` : ""}`,
    never.length > 0 && `${plural(never.length, "receivable")} never ${never.length === 1 ? "arrives" : "arrive"}`,
  ].filter((line): line is string => Boolean(line));
  if (lines.length === 0 && result.costDelta === 0) return <p className="mt-2 text-xs text-ink-3">Nothing changed yet: set a lever above.</p>;
  return (
    <ul className="mt-2 space-y-0.5 text-xs text-ink-2">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
      {result.costDelta !== 0 && (
        <li>
          Bills cost <Money value={Math.abs(result.costDelta)} /> {result.costDelta > 0 ? "more" : "less"}
        </li>
      )}
    </ul>
  );
}

const CHART = { top: 6, bottom: 94 };

/**
 * The balance every day, if clients pay on time (grey, dashed) and in the scenario (agent blue, solid), as steps: a balance
 * moves on a day, not between days. Zero is a hairline; the first short day a held line. Hover names a day's balances;
 * the day-by-day table below says the same in text.
 */
export function ScenarioChart({ result }: { result: ScenarioResult }) {
  const [hover, setHover] = useState<number | null>(null);
  const values = result.days.flatMap((day) => [day.base, day.scenario]);
  const high = Math.max(0, ...values);
  const low = Math.min(0, ...values);
  const span = high - low || 1;
  const y = (value: number) => CHART.top + ((high - value) / span) * (CHART.bottom - CHART.top);
  const last = result.days.length - 1;
  const x = (index: number) => (last === 0 ? 0 : (index / last) * 100);
  const steps = (pick: (index: number) => number) =>
    result.days.map((_, index) => (index === 0 ? `M 0 ${y(pick(0))}` : `H ${x(index)} V ${y(pick(index))}`)).join(" ") + " H 100";
  const shortIndex = result.scenario.shortOn ? result.days.findIndex((day) => day.day === result.scenario.shortOn) : -1;
  const hovered = hover === null ? null : result.days[hover];

  const move = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width <= 0) return;
    setHover(Math.min(last, Math.max(0, Math.round(((event.clientX - box.left) / box.width) * last))));
  };

  const description =
    `The balance over the next ${result.horizon} days. ${BASE_CASE}, ${result.base.shortOn ? `it runs short on ${dayLabel(result.base.shortOn)}` : "it never runs short"}. ` +
    `In this scenario, ${result.scenario.shortOn ? `it runs short on ${dayLabel(result.scenario.shortOn)}` : "it never runs short"}.`;

  return (
    <figure className="grid gap-2">
      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-2">
        <span className="inline-flex items-center gap-1.5">
          <svg aria-hidden width="20" height="4" className="overflow-visible">
            <line x1="0" y1="2" x2="20" y2="2" stroke="var(--color-ink-3)" strokeWidth="2" strokeDasharray="4 3" strokeLinecap="round" />
          </svg>
          {BASE_CASE}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <svg aria-hidden width="20" height="4" className="overflow-visible">
            <line x1="0" y1="2" x2="20" y2="2" stroke="var(--color-agent)" strokeWidth="2" strokeLinecap="round" />
          </svg>
          In this scenario
        </span>
        {shortIndex >= 0 && (
          <span className="inline-flex items-center gap-1.5">
            <svg aria-hidden width="4" height="12" className="overflow-visible">
              <line x1="2" y1="0" x2="2" y2="12" stroke="var(--color-held)" strokeWidth="1.5" strokeDasharray="3 3" />
            </svg>
            First short day
          </span>
        )}
      </figcaption>
      <div className="relative h-40 touch-pan-y select-none" onPointerMove={move} onPointerLeave={() => setHover(null)} role="img" aria-label={description}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden className="absolute inset-0 size-full overflow-visible">
          <line x1="0" y1={y(0)} x2="100" y2={y(0)} stroke="var(--color-line-strong)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          <path d={steps((index) => result.days[index].base)} fill="none" stroke="var(--color-ink-3)" strokeWidth="2" strokeDasharray="4 3" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          <path d={steps((index) => result.days[index].scenario)} fill="none" stroke="var(--color-agent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          {shortIndex >= 0 && <line x1={x(shortIndex)} y1={CHART.top} x2={x(shortIndex)} y2={CHART.bottom} stroke="var(--color-held)" strokeWidth="1.5" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />}
          {hover !== null && <line x1={x(hover)} y1="0" x2={x(hover)} y2="100" stroke="var(--color-ink-3)" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
        </svg>
        <span className="absolute left-0 -translate-y-1/2 bg-surface/80 pr-1 text-[0.6875rem] text-ink-3 tabular-nums" style={{ top: `${y(0)}%` }}>
          0
        </span>
        {hovered && hover !== null && (
          <div
            className={cn("pointer-events-none absolute top-0 z-10 w-max rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs shadow-surface", hover > last / 2 ? "-translate-x-full -ml-2" : "ml-2")}
            style={{ left: `${x(hover)}%` }}
          >
            <p className="font-medium text-ink">{dayLabel(hovered.day)}</p>
            <p className="text-ink-2">
              {BASE_CASE}: <Balance value={hovered.base} />
            </p>
            <p className="text-ink-2">
              In this scenario: <Balance value={hovered.scenario} />
            </p>
          </div>
        )}
      </div>
      <div className="flex justify-between text-[0.6875rem] text-ink-3">
        <span>{dayLabel(result.today)}</span>
        <span>{dayLabel(result.lastDay)}</span>
      </div>
    </figure>
  );
}

function AffectedBills({ result }: { result: ScenarioResult }) {
  return (
    <div>
      <h3 className="text-sm font-medium text-ink">Due while the balance is short</h3>
      <ul className="mt-2 space-y-1">
        {result.affected.map((bill) => (
          <li key={bill.id} className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
            <span className="min-w-0 text-ink">
              <span className="text-xs text-ink-3 tabular-nums">{dayLabel(bill.day)}</span> {bill.label} <span className="text-xs text-ink-3">{bill.note}</span>
            </span>
            <Money value={bill.amount} sign="−" className="shrink-0 text-ink" />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One piece of advice, in words: never an action (C7). */
function SuggestionText({
  suggestion,
  shortOn,
  shortfall,
  horizon,
  lastDay,
}: {
  suggestion: Suggestion;
  shortOn: string;
  shortfall: number;
  horizon: number;
  lastDay: string;
}) {
  if (suggestion.kind === "need") {
    return (
      <>
        To pay every bill on its day in this scenario, the wallet needs <Money value={suggestion.amount} /> more by {dayLabel(suggestion.by)}.
      </>
    );
  }
  if (suggestion.kind === "pay_on_due") {
    // What the move changes, worked out again by the engine: a later short day, a smaller gap, or both.
    const later = suggestion.shortOn !== shortOn;
    const smaller = suggestion.shortfall < shortfall;
    const effect =
      suggestion.shortOn === null ? (
        <>the balance does not run short in the next {horizon} days</>
      ) : later ? (
        <>
          the balance runs short on {dayLabel(suggestion.shortOn)} rather than {dayLabel(shortOn)}
          {smaller && (
            <>
              , and the wallet needs <Money value={suggestion.shortfall} /> more rather than <Money value={shortfall} />
            </>
          )}
        </>
      ) : (
        <>
          the wallet needs <Money value={suggestion.shortfall} /> more by {dayLabel(shortOn)} rather than <Money value={shortfall} />
        </>
      );
    return (
      <>
        {suggestion.label} is scheduled for {dayLabel(suggestion.scheduledFor)}, before its due day, {dayLabel(suggestion.dueOn)}. Paid on its due day instead,{" "}
        {effect}. Any early-payment discount it was scheduled for is lost.
      </>
    );
  }
  const when = suggestion.arrives === null ? "never arrives" : suggestion.arrives > lastDay ? `arrives after the next ${horizon} days` : `arrives on ${dayLabel(suggestion.arrives)}`;
  return (
    <>
      {suggestion.label}&apos;s <Money value={suggestion.amount} />, due {dayLabel(suggestion.expected)}, {when} in this scenario. Of the receivables, it is the one
      that matters most for {dayLabel(shortOn)}.
    </>
  );
}

function Suggestions({ result }: { result: ScenarioResult }) {
  return (
    <div>
      <h3 className="text-sm font-medium text-ink">
        What could help <span className="font-normal text-ink-3">advice only: nothing here changes a payment</span>
      </h3>
      <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm leading-6 text-ink-2 marker:text-ink-3">
        {result.suggestions.map((suggestion) => (
          <li key={suggestion.kind}>
            <SuggestionText
              suggestion={suggestion}
              shortOn={result.scenario.shortOn ?? result.lastDay}
              shortfall={result.shortfall}
              horizon={result.horizon}
              lastDay={result.lastDay}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function DriverText({ driver, result }: { driver: Driver; result: ScenarioResult }) {
  if (driver.kind === "payee") {
    const parts = [
      driver.bills > 0 && plural(driver.bills, "bill"),
      driver.recurring > 0 && plural(driver.recurring, "recurring payment"),
      driver.milestones > 0 && plural(driver.milestones, "milestone"),
    ].filter(Boolean);
    return (
      <>
        {driver.label}: <Money value={driver.amount} /> out, {parts.join(", ")}
      </>
    );
  }
  if (driver.kind === "receivable") {
    // A client's receivables in up to three groups, each said as it is: arriving by a day, after the horizon, or never.
    const verb = (count: number) => (count === 1 ? "arrives" : "arrive");
    const inside = driver.count - driver.never - driver.outside;
    const groups = [
      inside > 0 && driver.arrivesBy !== null && { count: inside, words: `${verb(inside)} ${inside === 1 ? "on" : "by"} ${dayLabel(driver.arrivesBy)}` },
      driver.outside > 0 && { count: driver.outside, words: `${verb(driver.outside)} after the next ${result.horizon} days` },
      driver.never > 0 && { count: driver.never, words: `never ${verb(driver.never)}` },
    ].filter((group): group is { count: number; words: string } => Boolean(group));
    const when =
      groups.length === 1
        ? `${driver.count === 1 ? "a receivable that" : `${driver.count} receivables that`} ${groups[0].words}`
        : `${driver.count} receivables: ${groups.map((group) => `${group.count} ${group.words}`).join("; ")}`;
    return (
      <>
        {driver.label}: <Money value={driver.amount} /> in {when}
      </>
    );
  }
  return (
    <>
      {driver.scope === "foreign" ? "Bills written in another currency" : "Bills"} costing {driver.pct}% more: <Money value={driver.amount} /> more
    </>
  );
}

function Drivers({ result }: { result: ScenarioResult }) {
  return (
    <div>
      <h3 className="text-sm font-medium text-ink">
        What moves it most <span className="font-normal text-ink-3">by {dayLabel(result.driversOn)}</span>
      </h3>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm leading-6 text-ink-2 marker:text-ink-3">
        {result.drivers.map((driver) => (
          <li key={driver.kind === "costs" ? "costs" : driver.kind === "receivable" ? `receivable-${driver.key}` : `payee-${driver.label}`}>
            <DriverText driver={driver} result={result} />
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * What the figure is built from (I19): in how many weeks a bill is on record, what is projected, client records and
 * what is left out. Weeks, not the latest bill's day, so one far bill cannot make the horizon read as known.
 */
export function CoverageList({ result }: { result: ScenarioResult }) {
  const { coverage } = result;
  const { total, withBills } = coverage.weeks;
  const thin = withBills < total / 2;
  const empty = total - withBills;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="text-sm font-medium text-ink">What this is built from</h3>
        <Badge size="sm" tone={thin ? "held" : "neutral"}>
          {`Bills on record in ${withBills} of ${total} weeks`}
        </Badge>
      </div>
      <ul className="mt-2 space-y-1 text-sm leading-6 text-ink-2">
        <li>
          {coverage.bills.count === 0 ? (
            `No bill is due in the next ${coverage.horizon} days.`
          ) : (
            <>
              Bills: {coverage.bills.count}, <Money value={coverage.bills.amount} />, the latest due {dayLabel(coverage.bills.lastDay as string)}.
            </>
          )}
        </li>
        {!coverage.recurring.read ? (
          <li>Recurring payments could not be read, so none is counted.</li>
        ) : (
          coverage.recurring.count > 0 && (
            <li>
              Recurring payments not billed yet: {coverage.recurring.count}, <Money value={coverage.recurring.amount} />, from{" "}
              {plural(coverage.recurring.schedules, "schedule")}, counted on their due days.
            </li>
          )
        )}
        {coverage.milestones.count > 0 && (
          <li>
            Open milestones: {coverage.milestones.count}, <Money value={coverage.milestones.amount} />, with no payment day, so counted today.
          </li>
        )}
        <li>
          {coverage.receivables.count === 0 ? (
            `No receivable is due in the next ${coverage.horizon} days.`
          ) : (
            <>
              Receivables: {coverage.receivables.count}, <Money value={coverage.receivables.amount} />; {coverage.receivables.withRecord} from clients who have paid
              before.
            </>
          )}
        </li>
        {coverage.records.map((record) => (
          <li key={record.label} className="pl-4 text-xs text-ink-3">
            {record.label} paid {plural(record.paidOnTime + record.paidLate, "receivable")} before: {record.paidOnTime} on time, {record.paidLate} late
            {record.averageDaysLate !== null && `, ${record.averageDaysLate} days late on average`}.
          </li>
        ))}
        {(coverage.eurc.bills.count > 0 || coverage.eurc.receivables.count > 0) && (
          <li>
            Left out, paid from and into the EURC balance: <Money value={coverage.eurc.bills.amount} token="EURC" /> in bills,{" "}
            <Money value={coverage.eurc.receivables.amount} token="EURC" /> in receivables.
          </li>
        )}
      </ul>
      <p className="mt-2 text-xs leading-5 text-ink-3">
        {withBills === 0
          ? "No bill is known for these days yet, so the balance may look better than it will be."
          : empty > 0
            ? `Bills not added yet are not counted, so ${plural(empty, "week")} with none on record may look better than ${empty === 1 ? "it" : "they"} will be.`
            : "Bills not added yet are not counted."}{" "}
        Client records are counts, not a prediction.
      </p>
    </div>
  );
}

/** The chart's table: today, then each day either balance changes. */
function DayByDay({ result }: { result: ScenarioResult }) {
  const rows = result.days.filter((day, index) => index === 0 || day.base !== result.days[index - 1].base || day.scenario !== result.days[index - 1].scenario);
  return (
    <Disclosure variant="bare" summary={<span className="text-sm font-medium text-agent underline-offset-2 hover:underline">Day by day</span>} contentClassName="mt-2">
      <Table label="Balance day by day" containerClassName="max-h-72 overflow-auto rounded-xl border border-line">
        <TableHeader className="sticky top-0 bg-surface">
          <TableRow>
            <TableHead>Day</TableHead>
            <TableHead className="text-right">{BASE_CASE}</TableHead>
            <TableHead className="text-right">In this scenario</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((day) => (
            <TableRow key={day.day}>
              <TableCell className="py-2 text-xs text-ink-3 tabular-nums">{dayLabel(day.day)}</TableCell>
              <TableCell className="py-2 text-right">
                <Balance value={day.base} />
              </TableCell>
              <TableCell className={cn("py-2 text-right", day.scenario < 0 && "text-held")}>
                <Balance value={day.scenario} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Disclosure>
  );
}
