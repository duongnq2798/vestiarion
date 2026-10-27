import { describe, expect, it } from "vitest";
import { ruleBasedExtraction } from "@/lib/invoice-document/extract";
import { breakEvenRate, costOfSkipping } from "@/lib/payment-terms/cost";
import { CURRENCIES, moneyInSentence, payDecision, sentenceDecimals } from "@/lib/payment-terms/decision";
import { LATE_FEE_DAYS, lateFeeAfter, lateFeeStartsOn, readLateFee } from "@/lib/payment-terms/late-fee";
import { EXAMPLE_INVOICE_DATE, TERM_PAGES, termPage, workedExample } from "@/lib/payment-terms/pages";
import { readWrittenTerms } from "@/lib/payment-terms/read";
import { addDays, money, parseTerms, percentWords, readFigure, termDates, termSlug, termsWords, type PaymentTerms } from "@/lib/payment-terms/terms";

/**
 * The payment terms calculator's rules (docs/superpowers/specs/2026-10-28-payment-terms-design.md PT1 to PT5, PT8):
 * reading terms, their dates, what skipping a discount costs on three bases, the late fee after a number of days, and
 * the agent's own policy picking the day to pay.
 */

const terms = (text: string): PaymentTerms => {
  const read = parseTerms(text);
  if (!read.ok) throw new Error(read.message);
  return read.terms;
};

describe("reading written terms (PT1)", () => {
  it("reads d/D net N, else net N, keeping the percent as written", () => {
    expect(readWrittenTerms("Terms: 2/10 net 30. Take 2% off if paid by 2026-10-11.")).toEqual({ discount: { pct: "2", days: 10 }, netDays: 30 });
    expect(readWrittenTerms("Terms: 1.5/15 net 45")).toEqual({ discount: { pct: "1.5", days: 15 }, netDays: 45 });
    expect(readWrittenTerms("2 / 10, Net 30")).toEqual({ discount: { pct: "2", days: 10 }, netDays: 30 });
    expect(readWrittenTerms("Payment: Net60")).toEqual({ discount: null, netDays: 60 });
    expect(readWrittenTerms("BALANCE DUE USDC 2.50 (net 30)")).toEqual({ discount: null, netDays: 30 });
    expect(readWrittenTerms("Thank you for your business")).toBeNull();
  });

  it("is what the invoice reader without a model counts its dates with, as before", () => {
    expect(ruleBasedExtraction("Acme Parts\nInvoice date: 2026-10-01\nTerms: 1.5/15 net 45\nTotal EUR 1,050.00")).toMatchObject({
      dueDate: "2026-11-15",
      earlyPayDiscountPct: "1.5",
      discountDeadline: "2026-10-16",
    });
    expect(ruleBasedExtraction("Acme Parts\nInvoice date: 2026-10-01\nTerms: net 30\nTotal EUR 10.00")).toMatchObject({ dueDate: "2026-10-31", earlyPayDiscountPct: null });
    // A discount without an invoice date keeps its percent, and no dates.
    expect(ruleBasedExtraction("Acme Parts\nTerms: 2/10 net 30\nTotal EUR 10.00")).toMatchObject({ dueDate: null, earlyPayDiscountPct: "2", discountDeadline: null });
    // A due date written on the invoice wins over one counted from its terms.
    expect(ruleBasedExtraction("Acme\nInvoice date: 2026-10-01\nDue date: 2026-10-20\nnet 30\nTotal 5 USDC")).toMatchObject({ dueDate: "2026-10-20" });
  });
});

describe("the calculator's terms (PT1)", () => {
  it("reads each usual form, n/30 for net 30, and EOM", () => {
    expect(terms("2/10 net 30")).toEqual({ discount: { pct: 2, days: 10 }, netDays: 30, endOfMonth: false });
    expect(terms("2/10 n/30")).toEqual({ discount: { pct: 2, days: 10 }, netDays: 30, endOfMonth: false });
    expect(terms("Net 45")).toEqual({ discount: null, netDays: 45, endOfMonth: false });
    expect(terms("net 30 EOM")).toEqual({ discount: null, netDays: 30, endOfMonth: true });
    expect(terms("2/10 net 30 end of month")).toEqual({ discount: { pct: 2, days: 10 }, netDays: 30, endOfMonth: true });
    expect(terms("net 0")).toEqual({ discount: null, netDays: 0, endOfMonth: false });
  });

  it("reads a discount written with a percent sign, with days, or before EOM", () => {
    const twoTen = { discount: { pct: 2, days: 10 }, netDays: 30 };
    expect(terms("2/10 EOM, n/30")).toEqual({ ...twoTen, endOfMonth: true });
    expect(terms("2/10 EOM net 30")).toEqual({ ...twoTen, endOfMonth: true });
    expect(terms("2/10 end of month, net 30")).toEqual({ ...twoTen, endOfMonth: true });
    expect(terms("1% 10 Net 30")).toEqual({ discount: { pct: 1, days: 10 }, netDays: 30, endOfMonth: false });
    expect(terms("2.5%/10 net 30")).toEqual({ discount: { pct: 2.5, days: 10 }, netDays: 30, endOfMonth: false });
    expect(terms("2% 10 days, net 30 days")).toEqual({ ...twoTen, endOfMonth: false });
    expect(terms("2/10 days net 30")).toEqual({ ...twoTen, endOfMonth: false });
  });

  it("refuses a discount it cannot read rather than dropping it", () => {
    const unread = { ok: false, message: 'A discount in these terms could not be read. Write it as "2/10 net 30" or "2% 10 net 30", with one discount at most.' };
    expect(parseTerms("net 30, 2/10")).toEqual(unread);
    expect(parseTerms("net 30 2/10")).toEqual(unread);
    expect(parseTerms("2% net 30")).toEqual(unread);
    expect(parseTerms("2% within 10 days, net 30")).toEqual(unread);
    // Two discounts, as in "2/10, 1/20, net 30": the reader would keep the second alone.
    expect(parseTerms("2/10, 1/20, net 30")).toEqual(unread);
    expect(parseTerms("2/10 EOM")).toEqual({ ok: false, message: 'These terms could not be read. Write them as "2/10 net 30", "net 45" or "net 30 EOM".' });
  });

  it("says what is wrong instead of guessing", () => {
    expect(parseTerms("  ")).toEqual({ ok: false, message: 'Enter the terms as the invoice writes them, such as "2/10 net 30", "net 45" or "net 30 EOM".' });
    expect(parseTerms("pay soon")).toEqual({ ok: false, message: 'These terms could not be read. Write them as "2/10 net 30", "net 45" or "net 30 EOM".' });
    expect(parseTerms("0/10 net 30")).toEqual({ ok: false, message: "A discount is more than 0% and less than 100%." });
    expect(parseTerms("100/10 net 30")).toEqual({ ok: false, message: "A discount is more than 0% and less than 100%." });
    expect(parseTerms("net 400")).toEqual({ ok: false, message: "Net days are at most 365." });
    expect(parseTerms("2/30 net 30")).toEqual({
      ok: false,
      message: "The discount's days must be fewer than the net days: 2/10 net 30 gives 10 days for the discount and 30 to pay.",
    });
  });

  it("writes terms back the usual way, and as a term page's path", () => {
    expect(termsWords(terms("2/10 n/30"))).toBe("2/10 net 30");
    expect(termsWords(terms("1.5 / 15 net 45 eom"))).toBe("1.5/15 net 45 EOM");
    expect(termsWords(terms("NET 60"))).toBe("net 60");
    expect(termSlug(terms("2/10 net 30"))).toBe("2-10-net-30");
    expect(termSlug(terms("net 30 EOM"))).toBe("net-30-eom");
  });
});

describe("the dates (PT2)", () => {
  it("counts the discount deadline and the due date from the invoice date, every calendar day", () => {
    expect(termDates("2026-11-02", terms("2/10 net 30"))).toEqual({ countFrom: "2026-11-02", discountDeadline: "2026-11-12", dueOn: "2026-12-02" });
    expect(termDates("2026-11-02", terms("2/10 net 60"))).toEqual({ countFrom: "2026-11-02", discountDeadline: "2026-11-12", dueOn: "2027-01-01" });
    expect(termDates("2026-11-02", terms("net 30"))).toEqual({ countFrom: "2026-11-02", discountDeadline: null, dueOn: "2026-12-02" });
  });

  it("counts EOM terms from the last day of the invoice's month, a leap February included", () => {
    expect(termDates("2026-11-02", terms("net 30 EOM"))).toEqual({ countFrom: "2026-11-30", discountDeadline: null, dueOn: "2026-12-30" });
    expect(termDates("2026-12-15", terms("2/10 net 30 EOM"))).toEqual({ countFrom: "2026-12-31", discountDeadline: "2027-01-10", dueOn: "2027-01-30" });
    expect(termDates("2028-02-03", terms("net 30 EOM"))).toEqual({ countFrom: "2028-02-29", discountDeadline: null, dueOn: "2028-03-30" });
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("reads a figure as people write it, and shows money and rates as the page does", () => {
    expect(readFigure("1,250.00")).toBe(1250);
    expect(readFigure(" 1.5% ")).toBe(1.5);
    expect(readFigure("12 345")).toBe(12345);
    expect(readFigure("abc")).toBeNull();
    expect(readFigure("1.2.3")).toBeNull();
    expect(readFigure("")).toBeNull();
    expect(money(1000)).toBe("1,000.00");
    expect(money(2.684932)).toBe("2.68");
    expect(money(2.684932, 4)).toBe("2.6849");
    expect(percentWords(0.372449)).toBe("37.2%");
  });
});

describe("what skipping the discount costs (PT3)", () => {
  it("gives 2/10 net 30 as 37.2% simple on 365 days, 36.7% on 360 and 44.6% compounded, each with its formula", () => {
    expect(costOfSkipping({ pct: 2, days: 10 }, 30).map(({ basis, label, formula }) => ({ basis, label, formula }))).toEqual([
      { basis: "simple365", label: "Simple, 365-day year", formula: "2 ÷ 98 × 365 ÷ 20 = 37.2%" },
      { basis: "simple360", label: "Simple, 360-day year", formula: "2 ÷ 98 × 360 ÷ 20 = 36.7%" },
      { basis: "compounded", label: "Compounded over a year", formula: "(1 + 2 ÷ 98) ^ (365 ÷ 20) − 1 = 44.6%" },
    ]);
    const [simple365, simple360, compounded] = costOfSkipping({ pct: 2, days: 10 }, 30);
    expect(simple365.rate).toBeCloseTo(0.37245, 5);
    expect(simple360.rate).toBeCloseTo(0.36735, 5);
    expect(compounded.rate).toBeCloseTo(0.44585, 5);
  });

  it("gives 1/10 net 30 as 18.4%, 2/10 net 60 as 14.9% and 3/10 net 30 as 56.4%, simple on 365 days", () => {
    expect(percentWords(costOfSkipping({ pct: 1, days: 10 }, 30)[0].rate)).toBe("18.4%");
    expect(percentWords(costOfSkipping({ pct: 2, days: 10 }, 60)[0].rate)).toBe("14.9%");
    expect(percentWords(costOfSkipping({ pct: 3, days: 10 }, 30)[0].rate)).toBe("56.4%");
    expect(costOfSkipping({ pct: 1.5, days: 10 }, 30)[0].formula).toBe("1.5 ÷ 98.5 × 365 ÷ 20 = 27.8%");
  });

  it("puts the break-even rate at the simple 365-day figure, not the 36.5% that divides by the full amount", () => {
    expect(breakEvenRate({ pct: 2, days: 10 }, 30)).toBeCloseTo(0.37245, 5);
    expect(percentWords(breakEvenRate({ pct: 2, days: 10 }, 30))).toBe("37.2%");
  });
});

describe("the late fee after a number of days (PT4)", () => {
  const percent = { kind: "percent_month", value: 1.5, charge: "month", graceDays: 0 } as const;

  it("charges a percent for each month or part of one, a month being 30 days", () => {
    expect(LATE_FEE_DAYS).toEqual([7, 30, 60]);
    expect(lateFeeAfter(1000, percent, 7)).toEqual({ daysLate: 7, fee: 15, formula: "1,000.00 × 1.5% × 1 month = 15.00" });
    expect(lateFeeAfter(1000, percent, 30).fee).toBe(15);
    expect(lateFeeAfter(1000, percent, 31)).toEqual({ daysLate: 31, fee: 30, formula: "1,000.00 × 1.5% × 2 months = 30.00" });
    expect(lateFeeAfter(1000, percent, 60).fee).toBe(30);
  });

  it("charges a percent by the day at the monthly percent × 12 ÷ 365", () => {
    const daily = { ...percent, charge: "day" } as const;
    expect(lateFeeAfter(1000, daily, 7)).toEqual({ daysLate: 7, fee: 3.452055, formula: "1,000.00 × 1.5% × 12 ÷ 365 × 7 days = 3.45" });
    expect(money(lateFeeAfter(1000, daily, 30).fee)).toBe("14.79");
    expect(money(lateFeeAfter(1000, daily, 45).fee)).toBe("22.19");
    expect(money(lateFeeAfter(1000, daily, 60).fee)).toBe("29.59");
    expect(lateFeeAfter(1000, daily, 1).formula).toBe("1,000.00 × 1.5% × 12 ÷ 365 × 1 day = 0.49");
  });

  it("charges a fixed fee once, and nothing in the days of grace", () => {
    const fixed = { kind: "fixed", value: 25, charge: "month", graceDays: 0 } as const;
    expect(lateFeeAfter(1000, fixed, 1)).toEqual({ daysLate: 1, fee: 25, formula: "A fixed fee, charged once: 25.00" });
    expect(lateFeeAfter(1000, fixed, 60).fee).toBe(25);
    const grace = { ...percent, graceDays: 10 };
    expect(lateFeeAfter(1000, grace, 7)).toEqual({ daysLate: 7, fee: 0, formula: "No fee yet: the first 10 days after the due date are grace." });
    expect(lateFeeAfter(1000, grace, 11)).toEqual({ daysLate: 11, fee: 15, formula: "1,000.00 × 1.5% × 1 month = 15.00" });
    expect(lateFeeAfter(1000, grace, 41).fee).toBe(30);
    expect(lateFeeStartsOn("2026-11-27", 0)).toBe("2026-11-28");
    expect(lateFeeStartsOn("2026-11-27", 10)).toBe("2026-12-08");
  });

  it("reads the fee's fields, refusing what a bill's late fee would refuse", () => {
    expect(readLateFee({ value: "", kind: "percent_month", charge: "month", grace: "", amount: 1000 })).toEqual({ ok: true, fee: null });
    expect(readLateFee({ value: "1.5%", kind: "percent_month", charge: "day", grace: "5", amount: 1000 })).toEqual({
      ok: true,
      fee: { kind: "percent_month", value: 1.5, charge: "day", graceDays: 5 },
    });
    expect(readLateFee({ value: "12", kind: "percent_month", charge: "month", grace: "", amount: 1000 })).toEqual({
      ok: false,
      field: "value",
      message: "A late fee as a percent a month is more than 0 and at most 10.",
    });
    const fixedProblem = { ok: false, field: "value", message: "A fixed late fee is more than 0 and at most the invoice's amount." };
    expect(readLateFee({ value: "0", kind: "fixed", charge: "month", grace: "", amount: 1000 })).toEqual(fixedProblem);
    // As a bill's: a fixed fee is at most the invoice's amount (src/lib/intake-validation.ts).
    expect(readLateFee({ value: "1000.01", kind: "fixed", charge: "month", grace: "", amount: 1000 })).toEqual(fixedProblem);
    expect(readLateFee({ value: "1000", kind: "fixed", charge: "month", grace: "", amount: 1000 })).toEqual({
      ok: true,
      fee: { kind: "fixed", value: 1000, charge: "month", graceDays: 0 },
    });
    // With no amount to weigh it against yet, only the amount's own field says what is wrong.
    expect(readLateFee({ value: "5000", kind: "fixed", charge: "month", grace: "", amount: null })).toMatchObject({ ok: true });
    expect(readLateFee({ value: "25", kind: "fixed", charge: "month", grace: "2.5", amount: 1000 })).toEqual({
      ok: false,
      field: "grace",
      message: "Days of grace are a whole number from 0 to 365.",
    });
  });
});

describe("the decision (PT5)", () => {
  const base = { today: "2026-10-28", invoiceDate: "2026-10-28", amount: 1000, currency: "USD", ratePct: null, lateFee: null };

  it("pays on the discount deadline below the break-even rate, naming the yield on the discounted amount", () => {
    const decision = payDecision({ ...base, terms: terms("2/10 net 30"), ratePct: 5 });
    expect(decision).toMatchObject({ headline: "Pay on Nov 7, 2026", payOn: "2026-11-07", payNow: false, dueOn: "2026-11-27", discountDeadline: "2026-11-07" });
    expect(decision.reason).toBe(
      "A 2% early-payment discount (20.00 USD) is worth more than holding the cash to the due date (2.68 USD of yield); paying on the discount deadline, Nov 7, 2026."
    );
    expect(decision.discount).toEqual({ open: true, paid: 980, saves: 20 });
    // Just under the 37.2% break-even, the discount still wins; just over it, holding the cash does.
    expect(payDecision({ ...base, terms: terms("2/10 net 30"), ratePct: 37.2 }).payOn).toBe("2026-11-07");
    expect(payDecision({ ...base, terms: terms("2/10 net 30"), ratePct: 37.3 }).payOn).toBe("2026-11-27");
  });

  it("holds the cash to the due date above it", () => {
    const decision = payDecision({ ...base, terms: terms("2/10 net 30"), ratePct: 40 });
    expect(decision.headline).toBe("Pay on Nov 27, 2026");
    expect(decision.reason).toBe(
      "Yield to the due date (21.48 USD) is worth more than the 2% early-payment discount (20.00 USD); paying on the due date, Nov 27, 2026."
    );
  });

  it("never calls one of two amounts that look equal worth more: they take the decimals that tell them apart", () => {
    // Either side of the 37.2% break-even, the discount and the yield are both 20.00 USD to 2 decimals.
    const under = payDecision({ ...base, terms: terms("2/10 net 30"), ratePct: 37.24 });
    expect(under.payOn).toBe("2026-11-07");
    expect(under.reason).toBe(
      "A 2% early-payment discount (20.000 USD) is worth more than holding the cash to the due date (19.997 USD of yield); paying on the discount deadline, Nov 7, 2026."
    );
    const over = payDecision({ ...base, terms: terms("2/10 net 30"), ratePct: 37.25 });
    expect(over.payOn).toBe("2026-11-27");
    expect(over.reason).toBe(
      "Yield to the due date (20.003 USD) is worth more than the 2% early-payment discount (20.000 USD); paying on the due date, Nov 27, 2026."
    );
    // Every amount in the sentence takes the same decimals.
    const small = payDecision({ ...base, amount: 10, terms: terms("2/10 net 30"), ratePct: 37, lateFee: { kind: "percent_month", value: 1.5, charge: "month", graceDays: 0 } });
    expect(small.reason).toBe(
      "A 2% early-payment discount (0.200 USD) is worth more than holding the cash to the due date (0.199 USD of yield); paying on the discount deadline, Nov 7, 2026, before a 1.5% monthly late fee (0.150 USD) starts Nov 28, 2026."
    );
    expect(sentenceDecimals(20, 0)).toBe(2);
    expect(sentenceDecimals(20, 20)).toBe(2);
    expect(sentenceDecimals(null, 0)).toBe(2);
    expect(sentenceDecimals(20, 19.997369)).toBe(3);
    expect(sentenceDecimals(0.0002, 0)).toBe(4);
    expect(sentenceDecimals(20, 19.999999)).toBe(6);
  });

  it("counts no yield when no rate is given, and pays net terms on the due date", () => {
    expect(payDecision({ ...base, terms: terms("2/10 net 30") }).reason).toContain("(0.00 USD of yield)");
    const net = payDecision({ ...base, currency: "EUR", terms: terms("net 30 EOM") });
    expect(net).toMatchObject({ headline: "Pay on Nov 30, 2026", discount: null, discountDeadline: null });
    expect(net.reason).toBe("No early-payment discount; paying on the due date, Nov 30, 2026, keeps 1,000.00 EUR available until then.");
  });

  it("pays today once the bill is due or overdue, and says when the discount ended", () => {
    const overdue = payDecision({ ...base, invoiceDate: "2026-09-01", terms: terms("net 30") });
    expect(overdue).toMatchObject({ headline: "Pay today, Oct 28, 2026", payNow: true, payOn: "2026-10-28" });
    expect(overdue.reason).toBe("Overdue since Oct 1, 2026; paying now.");
    const lapsed = payDecision({ ...base, invoiceDate: "2026-10-10", terms: terms("2/10 net 30") });
    expect(lapsed.discount).toEqual({ open: false, paid: 980, saves: 20 });
    expect(lapsed.reason).toBe("The 2% early-payment discount ended with Oct 20, 2026; paying on the due date, Nov 9, 2026, keeps 1,000.00 USD available until then.");
  });

  it("names the late fee the payment comes before", () => {
    const decision = payDecision({ ...base, terms: terms("net 30"), lateFee: { kind: "percent_month", value: 1.5, charge: "month", graceDays: 0 } });
    expect(decision.reason).toBe(
      "No early-payment discount; paying on the due date, Nov 27, 2026, keeps 1,000.00 USD available until then, before a 1.5% monthly late fee (15.00 USD) starts Nov 28, 2026."
    );
    const fixed = payDecision({ ...base, terms: terms("net 30"), lateFee: { kind: "fixed", value: 25, charge: "month", graceDays: 3 } });
    expect(fixed.reason).toContain("before a 25.00 USD late fee starts Dec 1, 2026.");
  });

  it("shows amounts with 2 decimals, for the currency named only", () => {
    expect(moneyInSentence("Pay 1000 USD now, not 2.684932 USD; 5 USDC stays.", "USD")).toBe("Pay 1,000.00 USD now, not 2.68 USD; 5 USDC stays.");
    expect(moneyInSentence("Pay 1000 USD now, not 2.684932 USD.", "USD", 4)).toBe("Pay 1,000.0000 USD now, not 2.6849 USD.");
    expect(CURRENCIES).toEqual(["USD", "EUR", "GBP", "CAD", "AUD", "USDC", "EURC"]);
  });
});

describe("the term pages (PT8)", () => {
  it("are the seven common terms, each read back to its own path", () => {
    expect(TERM_PAGES.map((page) => page.slug)).toEqual(["2-10-net-30", "1-10-net-30", "2-10-net-60", "3-10-net-30", "net-30", "net-60", "net-30-eom"]);
    for (const page of TERM_PAGES) expect(termSlug(page.terms)).toBe(page.slug);
    expect(termPage("net-31")).toBeNull();
  });

  it("say what each term means, with its cost in the description", () => {
    expect(termPage("2-10-net-30")).toMatchObject({
      words: "2/10 net 30",
      title: "2/10 net 30: meaning, formula and calculator",
      meaning: "2% off if you pay within 10 days of the invoice date; otherwise the full amount is due 30 days after the invoice date.",
    });
    expect(termPage("2-10-net-30")?.description).toContain("Skipping the discount costs 37.2% a year (simple, 365 days).");
    expect(termPage("net-30")).toMatchObject({ title: "Net 30: meaning, due date and calculator", meaning: "The full amount is due 30 days after the invoice date." });
    expect(termPage("net-30-eom")?.meaning).toBe("The full amount is due 30 days after the last day of the month the invoice is dated in.");
  });

  it("work an example through: a 1,000.00 USD invoice dated Nov 2, 2026", () => {
    expect(EXAMPLE_INVOICE_DATE).toBe("2026-11-02");
    const discount = workedExample(termPage("2-10-net-30")!);
    expect(discount).toMatchObject({ discountDeadline: "2026-11-12", dueOn: "2026-12-02", paid: 980, saves: 20 });
    expect(discount.costs?.map((cost) => percentWords(cost.rate))).toEqual(["37.2%", "36.7%", "44.6%"]);
    expect(discount.lateFees).toBeNull();
    const eom = workedExample(termPage("net-30-eom")!);
    expect(eom).toMatchObject({ countFrom: "2026-11-30", dueOn: "2026-12-30", costs: null, paid: null });
    expect(eom.lateFees?.map((fee) => [fee.daysLate, fee.fee])).toEqual([
      [10, 15],
      [45, 30],
    ]);
  });
});
