/**
 * What skipping an early-payment discount costs, as a yearly rate (docs/superpowers/specs/2026-10-28-payment-terms-design.md
 * PT3). Skipping a discount of d percent means paying the full amount t days later than the discounted one, which is
 * like borrowing the discounted amount for t days and paying d for it. Lenders and textbooks state that rate on
 * different bases, so all three are given, each with its formula. Never `annualPct` (src/lib/early-pay/offers-words.ts),
 * which divides by the full amount rather than the discounted one. Pure and browser-safe.
 */

import { percentWords, plainFigure } from "./terms";

export type DayBasis = "simple365" | "simple360" | "compounded";

export interface SkipCost {
  basis: DayBasis;
  label: string;
  /** A fraction a year: 0.372 for 37.2%. */
  rate: number;
  /** The formula with the numbers filled in: "2 ÷ 98 × 365 ÷ 20 = 37.2%". */
  formula: string;
}

/**
 * The cost of skipping the discount, simple on a 365-day year, simple on a 360-day year and compounded over a year, in
 * that order. `netDays` is more than the discount's days, as `parseTerms` holds it.
 */
export function costOfSkipping(discount: { pct: number; days: number }, netDays: number): SkipCost[] {
  const rest = 100 - discount.pct;
  const days = netDays - discount.days;
  const perPeriod = discount.pct / rest;
  const simple365 = (perPeriod * 365) / days;
  const simple360 = (perPeriod * 360) / days;
  const compounded = Math.pow(1 + perPeriod, 365 / days) - 1;
  const d = plainFigure(discount.pct);
  const r = plainFigure(rest);
  return [
    { basis: "simple365", label: "Simple, 365-day year", rate: simple365, formula: `${d} ÷ ${r} × 365 ÷ ${days} = ${percentWords(simple365)}` },
    { basis: "simple360", label: "Simple, 360-day year", rate: simple360, formula: `${d} ÷ ${r} × 360 ÷ ${days} = ${percentWords(simple360)}` },
    { basis: "compounded", label: "Compounded over a year", rate: compounded, formula: `(1 + ${d} ÷ ${r}) ^ (365 ÷ ${days}) − 1 = ${percentWords(compounded)}` },
  ];
}

/**
 * The yearly rate at which taking the discount and holding the cash to the due date come out the same: the simple
 * 365-day cost. Below it, paying by the discount deadline comes out ahead; the calculator's decision turns there (PT5).
 */
export function breakEvenRate(discount: { pct: number; days: number }, netDays: number): number {
  return costOfSkipping(discount, netDays)[0].rate;
}
