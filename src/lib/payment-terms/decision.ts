/**
 * The calculator's one decision, "Pay on <date>" with one sentence why (docs/superpowers/specs/2026-10-28-payment-terms-design.md
 * PT5), from the agent's own written policy, `planPaymentTiming` (src/lib/agent/payment-timing.ts, payment timing §1):
 * take a discount on its last day when it is worth at least what the cash would earn to the due date, otherwise hold the
 * cash to the due date, and pay a bill that is due or overdue at once. Pure and browser-safe.
 */

import { utcDay } from "@/lib/copy";
import { amountToPay, discountApplies, invoiceDiscount, planPaymentTiming } from "@/lib/agent/payment-timing";
import { plannerLateFee, type CalculatorLateFee } from "./late-fee";
import { money, termDates, type PaymentTerms } from "./terms";

/** The currencies an amount can be labelled in. A label only: nothing is converted. */
export const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "USDC", "EURC"] as const;

export interface PayDecisionInput {
  /** The person's own calendar day, `YYYY-MM-DD`. */
  today: string;
  invoiceDate: string;
  amount: number;
  /** One of `CURRENCIES`. */
  currency: string;
  terms: PaymentTerms;
  /** The yearly rate the cash earns or the borrowing costs, in percent; null counts as 0. */
  ratePct: number | null;
  lateFee: CalculatorLateFee | null;
}

export interface PayDecision {
  /** "Pay on Nov 7, 2026", or "Pay today, Oct 28, 2026". */
  headline: string;
  /** The policy's sentence, its amounts with 2 decimals. */
  reason: string;
  payOn: string;
  payNow: boolean;
  countFrom: string;
  dueOn: string;
  discountDeadline: string | null;
  /** Whether the discount still applies today, what paying by its deadline pays, and what it saves; null without one. */
  discount: { open: boolean; paid: number; saves: number } | null;
}

const noon = (day: string) => `${day}T12:00:00.000Z`;

/**
 * The day to pay. The yearly rate goes in as `reserveApy`, applied to the discounted amount, the cash paying early would
 * have used, so the decision turns exactly at the break-even rate the page shows (`breakEvenRate`, PT3), and the yield
 * the sentence names is the yield on that cash. The cash is unlimited and nothing else is owed, so there is never a
 * shortfall.
 */
export function payDecision(input: PayDecisionInput): PayDecision {
  const { countFrom, discountDeadline, dueOn } = termDates(input.invoiceDate, input.terms);
  const now = new Date(noon(input.today));
  const discount =
    input.terms.discount && discountDeadline
      ? invoiceDiscount({ early_pay_discount_pct: input.terms.discount.pct, discount_due_date: noon(discountDeadline) })
      : null;
  const rate = (input.ratePct ?? 0) / 100;
  const timing = planPaymentTiming({
    now,
    amount: input.amount,
    dueDate: noon(dueOn),
    discount,
    operatingBalance: Number.POSITIVE_INFINITY,
    reserveApy: discount ? rate * (1 - discount.pct / 100) : rate,
    reserveBalance: 0,
    earlierObligations: 0,
    currency: input.currency,
    lateFee: input.lateFee ? plannerLateFee(input.lateFee, dueOn) : null,
  });
  const payNow = timing.recommendation.action === "pay";
  const payOn = timing.recommendation.action === "schedule" ? timing.recommendation.payOn : timing.today;
  const byDeadline = discount ? amountToPay(input.amount, discount, new Date(discount.deadline)) : null;
  return {
    headline: payNow ? `Pay today, ${utcDay(noon(payOn))}` : `Pay on ${utcDay(noon(payOn))}`,
    reason: moneyInSentence(timing.reason, input.currency),
    payOn,
    payNow,
    countFrom,
    dueOn,
    discountDeadline,
    discount: discount && byDeadline ? { open: discountApplies(discount, now), paid: byDeadline.amountPaid, saves: byDeadline.discountTaken } : null,
  };
}

/**
 * Every amount in `currency` in a sentence with 2 decimals, as the page shows amounts: the policy keeps USDC's 6
 * ("2.684932 USD" is "2.68 USD"). `currency` is one of `CURRENCIES`, letters only.
 */
export function moneyInSentence(sentence: string, currency: string): string {
  const amount = new RegExp(String.raw`(\d[\d,]*(?:\.\d+)?) ${currency}\b`, "g");
  return sentence.replace(amount, (_, figure: string) => `${money(Number(figure.replaceAll(",", "")))} ${currency}`);
}
