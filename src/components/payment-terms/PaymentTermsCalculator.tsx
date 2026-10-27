"use client";

import { useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { RadioGroup } from "@/components/ui/RadioGroup";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import type { LateFeeKind } from "@/lib/agent/late-fee";
import { utcDay } from "@/lib/copy";
import { breakEvenRate, costOfSkipping } from "@/lib/payment-terms/cost";
import { CURRENCIES, payDecision } from "@/lib/payment-terms/decision";
import { LATE_FEE_DAYS, MAX_DAYS_LATE, lateFeeAfter, lateFeeStartsOn, readLateFee, type CalculatorLateFee, type LateFeeCharge } from "@/lib/payment-terms/late-fee";
import { TERM_PRESETS } from "@/lib/payment-terms/pages";
import { daysBetween, isCalendarDay, money, parseTerms, percentWords, readFigure, readWholeNumber, type PaymentTerms } from "@/lib/payment-terms/terms";

/**
 * The payment terms calculator (docs/superpowers/specs/2026-10-28-payment-terms-design.md PT6): an invoice's date,
 * amount and terms, an optional yearly rate and late fee, and what they come to as someone types. There is no form to
 * submit, so nothing typed can reach an address bar or a server, and nothing is kept.
 */

const neverChanges = () => () => {};
const pad = (value: number) => String(value).padStart(2, "0");

/** Today in the browser, the person's own calendar day, as `YYYY-MM-DD`. */
function localToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const day = (value: string) => utcDay(`${value}T00:00:00.000Z`);

const AMOUNT_PROBLEM = "Enter the invoice's amount, such as 1,250.00.";
const RATE_PROBLEM = "A yearly rate is a percent from 0 to 100, such as 5.";
const DAYS_LATE_PROBLEM = `Days late are a whole number from 1 to ${MAX_DAYS_LATE.toLocaleString("en-US")}.`;

/** A term and what it comes to, the term on its own line on a phone and beside it on a wider screen. */
function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-3 first:pt-0 last:pb-0 sm:grid-cols-[11rem_1fr] sm:gap-4">
      <dt className="text-sm font-medium text-ink-3">{term}</dt>
      <dd className="text-sm leading-relaxed text-ink">{children}</dd>
    </div>
  );
}

/** A line under a figure: how it was counted. */
function Detail({ children }: { children: ReactNode }) {
  return <span className="mt-0.5 block text-xs leading-relaxed text-ink-3">{children}</span>;
}

/** What paying late costs: the fee at 7, 30 and 60 days, the days chosen, and today when the bill is already late. */
function LateFees({
  headingId,
  amount,
  currency,
  fee,
  dueOn,
  today,
  chosen,
}: {
  headingId: string;
  amount: number;
  currency: string;
  fee: CalculatorLateFee;
  dueOn: string;
  today: string;
  chosen: number | null;
}) {
  const lateToday = daysBetween(dueOn, today);
  const days = [...new Set([...LATE_FEE_DAYS, ...(chosen === null ? [] : [chosen]), ...(lateToday > 0 ? [lateToday] : [])])].sort((a, b) => a - b);
  const charged =
    fee.kind === "fixed" ? "charged once" : fee.charge === "month" ? "for each month or part of one, a month counted as 30 days" : "charged by the day";
  const rate = fee.kind === "fixed" ? `${money(fee.value)} ${currency}` : `${fee.value}% a month`;
  return (
    <section aria-labelledby={headingId} className="rounded-xl border border-line bg-surface px-4 py-4">
      <h3 id={headingId} className="text-sm font-semibold text-ink">
        If it is paid late
      </h3>
      <p className="mt-1 text-xs leading-relaxed text-ink-3">{`${rate}, ${charged}, from ${day(lateFeeStartsOn(dueOn, fee.graceDays))}. On the amount alone, never on a fee.`}</p>
      <dl className="mt-3 divide-y divide-line">
        {days.map((daysLate) => {
          const at = lateFeeAfter(amount, fee, daysLate);
          return (
            <Fact key={daysLate} term={daysLate === lateToday ? `${daysLate} days late, today` : `${daysLate} days late`}>
              {`${money(at.fee)} ${currency}`}
              <Detail>{at.formula}</Detail>
            </Fact>
          );
        })}
      </dl>
    </section>
  );
}

/** The discount's figures: its deadline, what paying by it saves, what skipping it costs a year, and the break-even rate. */
function DiscountFacts({
  terms,
  amount,
  currency,
  deadline,
  discount,
}: {
  terms: PaymentTerms & { discount: { pct: number; days: number } };
  amount: number;
  currency: string;
  deadline: string;
  discount: { open: boolean; paid: number; saves: number };
}) {
  const { pct, days } = terms.discount;
  const gained = terms.netDays - days;
  return (
    <>
      <Fact term="Discount deadline">
        {day(deadline)}
        <Detail>{`${days} days after ${terms.endOfMonth ? "the end of the invoice's month" : "the invoice date"}, the last day ${pct}% comes off.`}</Detail>
      </Fact>
      <Fact term="Paying by the deadline">
        {discount.open
          ? `${money(discount.paid)} ${currency} instead of ${money(amount)} ${currency}: it saves ${money(discount.saves)} ${currency}.`
          : `The discount ended with ${day(deadline)}: it would have saved ${money(discount.saves)} ${currency}.`}
      </Fact>
      <Fact term="Skipping the discount costs">
        {`Like borrowing ${money(discount.paid)} ${currency} for ${gained} days and paying ${money(discount.saves)} ${currency} for it. As a yearly rate:`}
        <ul className="mt-2 space-y-1.5">
          {costOfSkipping(terms.discount, terms.netDays).map((cost) => (
            <li key={cost.basis}>
              <span className="block text-xs text-ink-3">{cost.label}</span>
              <span className="font-mono text-[0.8125rem]">{cost.formula}</span>
            </li>
          ))}
        </ul>
      </Fact>
      <Fact term="Break-even rate">
        {`${percentWords(breakEvenRate(terms.discount, terms.netDays))} a year`}
        <Detail>
          If your cash earns, or your borrowing costs, less than this, paying by the discount deadline comes out ahead; more, and holding the cash to
          the due date does. Simple, on a 365-day year.
        </Detail>
      </Fact>
    </>
  );
}

export function PaymentTermsCalculator({ initialTerms = TERM_PRESETS[0] }: { initialTerms?: string }) {
  const id = useId();
  // Null while the page is drawn on the server: the date and everything counted from it come once the browser says
  // what today is, so the page drawn in advance never shows a stale day.
  const today = useSyncExternalStore(neverChanges, localToday, () => null);
  const [invoiceDate, setInvoiceDate] = useState<string | null>(null);
  const [amountText, setAmountText] = useState("1000");
  const [currency, setCurrency] = useState<string>(CURRENCIES[0]);
  const [termsText, setTermsText] = useState(initialTerms);
  const [rateText, setRateText] = useState("");
  const [feeText, setFeeText] = useState("");
  const [feeKind, setFeeKind] = useState<LateFeeKind>("percent_month");
  const [feeCharge, setFeeCharge] = useState<LateFeeCharge>("month");
  const [graceText, setGraceText] = useState("");
  const [daysLateText, setDaysLateText] = useState("");

  const dateValue = invoiceDate ?? today ?? "";
  const dateProblem = today !== null && !isCalendarDay(dateValue) ? "Enter the invoice's date." : null;
  const amount = readFigure(amountText);
  const amountProblem = amount === null || amount <= 0 || amount > 1e12 ? AMOUNT_PROBLEM : null;
  const terms = parseTerms(termsText);
  const rate = rateText.trim() === "" ? null : readFigure(rateText);
  const rateProblem = rateText.trim() !== "" && (rate === null || rate > 100) ? RATE_PROBLEM : null;
  const fee = readLateFee({ value: feeText, kind: feeKind, charge: feeCharge, grace: graceText });
  const daysLate = daysLateText.trim() === "" ? null : readWholeNumber(daysLateText);
  const daysLateProblem = daysLateText.trim() !== "" && (daysLate === null || daysLate < 1 || daysLate > MAX_DAYS_LATE) ? DAYS_LATE_PROBLEM : null;

  const ready = today !== null && !dateProblem && !amountProblem && terms.ok && !rateProblem && fee.ok && !daysLateProblem;
  const decision =
    ready && terms.ok && fee.ok && amount !== null
      ? payDecision({ today, invoiceDate: dateValue, amount, currency, terms: terms.terms, ratePct: rate, lateFee: fee.fee })
      : null;

  return (
    <div className="space-y-8">
      <div className="space-y-5">
        <div className="grid gap-5 sm:grid-cols-[1fr_1fr_8rem]">
          <Field id={`${id}-date`} label="Invoice date" error={dateProblem}>
            <Input type="date" value={dateValue} onChange={(event) => setInvoiceDate(event.target.value)} />
          </Field>
          <Field id={`${id}-amount`} label="Amount" error={amountProblem}>
            <Input value={amountText} onChange={(event) => setAmountText(event.target.value)} inputMode="decimal" autoComplete="off" />
          </Field>
          <Field id={`${id}-currency`} label="Currency" description="A label only.">
            <Select value={currency} onValueChange={setCurrency}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CURRENCIES.map((each) => (
                  <SelectItem key={each} value={each}>
                    {each}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <div className="space-y-3">
          <Field
            id={`${id}-terms`}
            label="Terms"
            description="As the invoice writes them, such as 2/10 net 30, net 45 or net 30 EOM."
            error={terms.ok ? null : terms.message}
          >
            <Input value={termsText} onChange={(event) => setTermsText(event.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} />
          </Field>
          <div role="group" aria-label="Common terms" className="flex flex-wrap gap-2">
            {TERM_PRESETS.map((preset) => (
              <Button key={preset} type="button" variant="secondary" size="touch" aria-pressed={termsText === preset} onClick={() => setTermsText(preset)}>
                {preset}
              </Button>
            ))}
          </div>
        </div>
        <Field
          id={`${id}-rate`}
          optional
          label="Yearly rate your cash earns, or your borrowing costs"
          description="In percent. Weighed against the discount to pick the day to pay; blank counts as 0%."
          error={rateProblem}
        >
          <Input value={rateText} onChange={(event) => setRateText(event.target.value)} inputMode="decimal" autoComplete="off" placeholder="5" />
        </Field>

        <div role="group" aria-labelledby={`${id}-late`} className="space-y-5 rounded-xl border border-line px-4 py-4">
          <p id={`${id}-late`} className="text-sm font-semibold text-ink">
            If the contract charges a late fee
          </p>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              id={`${id}-fee`}
              optional
              label="Late fee"
              description="As the contract states it: a percent a month, or a fixed amount."
              error={!fee.ok && fee.field === "value" ? fee.message : null}
            >
              <Input value={feeText} onChange={(event) => setFeeText(event.target.value)} inputMode="decimal" autoComplete="off" placeholder="1.5" />
            </Field>
            <Field
              id={`${id}-grace`}
              optional
              label="Days of grace"
              description="Days after the due date before the fee applies."
              error={!fee.ok && fee.field === "grace" ? fee.message : null}
            >
              <Input value={graceText} onChange={(event) => setGraceText(event.target.value)} inputMode="numeric" autoComplete="off" placeholder="0" />
            </Field>
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            <RadioGroup
              legend="Late fee is"
              value={feeKind}
              onValueChange={(value) => setFeeKind(value as LateFeeKind)}
              options={[
                { value: "percent_month", label: "% a month" },
                { value: "fixed", label: "A fixed amount" },
              ]}
            />
            {feeKind === "percent_month" && (
              <RadioGroup
                legend="Charged"
                value={feeCharge}
                onValueChange={(value) => setFeeCharge(value as LateFeeCharge)}
                options={[
                  { value: "month", label: "For each month or part of one", description: "A month counts as 30 days." },
                  { value: "day", label: "By the day", description: "The monthly percent × 12 ÷ 365, for each day." },
                ]}
              />
            )}
          </div>
          <Field
            id={`${id}-days-late`}
            optional
            label="Days late"
            description="The fee this many days after the due date, besides 7, 30 and 60."
            error={daysLateProblem}
          >
            <Input value={daysLateText} onChange={(event) => setDaysLateText(event.target.value)} inputMode="numeric" autoComplete="off" />
          </Field>
        </div>
      </div>

      <section aria-label="What the terms come to" className="space-y-4">
        {/* Only the decision is announced as it changes, not every figure under it. */}
        <div aria-live="polite">
          {decision && (
            <Callout tone="agent" title={decision.headline}>
              {decision.reason}
            </Callout>
          )}
        </div>
        {decision && terms.ok && amount !== null && (
          <>
            <dl className="divide-y divide-line rounded-xl border border-line bg-surface px-4 py-4">
              <Fact term="Due date">
                {day(decision.dueOn)}
                <Detail>
                  {terms.terms.endOfMonth
                    ? `${terms.terms.netDays} days after ${day(decision.countFrom)}, the last day of the invoice's month.`
                    : `${terms.terms.netDays} days after the invoice date, every calendar day counted.`}
                </Detail>
              </Fact>
              {terms.terms.discount && decision.discountDeadline && decision.discount && (
                <DiscountFacts
                  terms={{ ...terms.terms, discount: terms.terms.discount }}
                  amount={amount}
                  currency={currency}
                  deadline={decision.discountDeadline}
                  discount={decision.discount}
                />
              )}
            </dl>
            {fee.ok && fee.fee && today !== null && (
              <LateFees headingId={`${id}-late-fees`} amount={amount} currency={currency} fee={fee.fee} dueOn={decision.dueOn} today={today} chosen={daysLate} />
            )}
          </>
        )}
      </section>
    </div>
  );
}
