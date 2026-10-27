/**
 * The term pages under /payment-terms (docs/superpowers/specs/2026-10-28-payment-terms-design.md PT8): the common terms
 * people search for, what each means, and a worked example on a fixed invoice. Pure and browser-safe, so a static page
 * and the calculator read the same terms.
 */

import { amountToPay } from "@/lib/agent/payment-timing";
import { costOfSkipping, type SkipCost } from "./cost";
import { lateFeeAfter, type CalculatorLateFee, type LateFeeAt } from "./late-fee";
import { parseTerms, percentWords, termDates, termSlug, termsWords, type PaymentTerms } from "./terms";

/** The terms the calculator offers to fill in with one click. */
export const TERM_PRESETS = ["2/10 net 30", "1/10 net 30", "net 30", "net 60", "net 30 EOM"] as const;

/** The terms with a page of their own, in the order the pages list them. */
export const TERM_PAGE_TERMS = ["2/10 net 30", "1/10 net 30", "2/10 net 60", "3/10 net 30", "net 30", "net 60", "net 30 EOM"] as const;

/** The worked examples' invoice: 1,000.00 USD dated Nov 2, 2026. */
export const EXAMPLE_INVOICE_DATE = "2026-11-02";
export const EXAMPLE_AMOUNT = 1000;
export const EXAMPLE_CURRENCY = "USD";
/** The late fee a net term's example shows: 1.5% a month, for each month or part of one, 10 and 45 days late. */
export const EXAMPLE_LATE_FEE: CalculatorLateFee = { kind: "percent_month", value: 1.5, charge: "month", graceDays: 0 };
export const EXAMPLE_DAYS_LATE = [10, 45] as const;

export interface TermPage {
  slug: string;
  /** "2/10 net 30" */
  words: string;
  terms: PaymentTerms;
  /** The page's title, before the root layout's " · Vestiarion". */
  title: string;
  description: string;
  /** What the term means, in one sentence. */
  meaning: string;
}

const capitalised = (words: string) => `${words[0].toUpperCase()}${words.slice(1)}`;

/** Where a term's days count from, in words. */
function countFromWords(terms: PaymentTerms): string {
  return terms.endOfMonth ? "the last day of the month the invoice is dated in" : "the invoice date";
}

/** What terms mean, in one sentence: "2% off if you pay within 10 days of the invoice date; otherwise …". */
export function termMeaning(terms: PaymentTerms): string {
  const from = countFromWords(terms);
  if (!terms.discount) return `The full amount is due ${terms.netDays} days after ${from}.`;
  return `${terms.discount.pct}% off if you pay within ${terms.discount.days} days of ${from}; otherwise the full amount is due ${terms.netDays} days after ${from}.`;
}

function pageOf(text: string): TermPage {
  const read = parseTerms(text);
  if (!read.ok) throw new Error(`The term page's terms ${text} do not read: ${read.message}`);
  const { terms } = read;
  const words = termsWords(terms);
  const meaning = termMeaning(terms);
  if (terms.discount) {
    const yearly = percentWords(costOfSkipping(terms.discount, terms.netDays)[0].rate);
    return {
      slug: termSlug(terms),
      words,
      terms,
      title: `${words}: meaning, formula and calculator`,
      description: `${words} means ${terms.discount.pct}% off if you pay within ${terms.discount.days} days, otherwise the full amount in ${terms.netDays}. Skipping the discount costs ${yearly} a year (simple, 365 days). The formula, a worked example and a free calculator.`,
      meaning,
    };
  }
  return {
    slug: termSlug(terms),
    words,
    terms,
    title: `${capitalised(words)}: meaning, due date and calculator`,
    description: `${capitalised(words)} means the full amount is due ${terms.netDays} days after ${countFromWords(terms)}. How to count the due date, a worked example with a late fee, and a free calculator.`,
    meaning,
  };
}

export const TERM_PAGES: readonly TermPage[] = TERM_PAGE_TERMS.map(pageOf);

/** The page at /payment-terms/<slug>, or null for a term without one. */
export function termPage(slug: string): TermPage | null {
  return TERM_PAGES.find((page) => page.slug === slug) ?? null;
}

export interface WorkedExample {
  countFrom: string;
  discountDeadline: string | null;
  dueOn: string;
  /** What paying by the discount deadline pays and saves; null without a discount. */
  paid: number | null;
  saves: number | null;
  /** What skipping the discount costs on the three bases; null without one. */
  costs: SkipCost[] | null;
  /** The example late fee 10 and 45 days late, for net terms; null for a discount term. */
  lateFees: LateFeeAt[] | null;
}

/** A term's worked example on the fixed invoice: its dates, and what its discount or a late fee comes to. */
export function workedExample(page: TermPage): WorkedExample {
  const dates = termDates(EXAMPLE_INVOICE_DATE, page.terms);
  const { discount } = page.terms;
  if (discount && dates.discountDeadline) {
    const byDeadline = amountToPay(EXAMPLE_AMOUNT, { pct: discount.pct, deadline: `${dates.discountDeadline}T12:00:00.000Z` }, new Date(`${dates.discountDeadline}T12:00:00.000Z`));
    return {
      ...dates,
      paid: byDeadline.amountPaid,
      saves: byDeadline.discountTaken,
      costs: costOfSkipping(discount, page.terms.netDays),
      lateFees: null,
    };
  }
  return { ...dates, paid: null, saves: null, costs: null, lateFees: EXAMPLE_DAYS_LATE.map((days) => lateFeeAfter(EXAMPLE_AMOUNT, EXAMPLE_LATE_FEE, days)) };
}
