# Payment terms calculator

Date: 2026-10-28. Status: accepted.

## Why

Every bill a small business pays carries terms: "net 30", "2/10 net 30", "net 30 EOM". People search for what those
terms mean and when the bill is due ("net 30 calculator", "invoice due date calculator", "what is net 30"). The agent
already makes this decision on every bill: when to pay, whether an early-payment discount beats holding the cash
(payment timing §1), and what a late fee costs (late fees LF1, LF4). A free public page that does the same arithmetic,
shows the formula, and ends with one dated decision helps people who do not use Vestiarion yet, and shows what the
agent weighs. Other calculators give a due date or an "annualized ROI"; none found gives one dated decision that weighs
the discount against your own rate and a late fee.

## What

**PT1. The terms** (`src/lib/payment-terms/read.ts`, `src/lib/payment-terms/terms.ts`).
- `readWrittenTerms` is the one reader of terms written as text: "d/D net N" (a percent off within D days, the full
  amount in N), else "net N". The invoice reader without a model (`ruleBasedExtraction`,
  `src/lib/invoice-document/extract.ts`) now uses it, with the same results as before: the first "d/D net N" anywhere
  in the text, else the first "net N", and the percent kept as written. `findWrittenTerms` also says where in the text
  those terms are written.
- `parseTerms` reads what someone types into the calculator with the same reader, and also:
  - "n/30" written for "net 30", as in "2/10 n/30";
  - a percent sign, "2% 10" or "2%/10" for "2/10", as in "1% 10 net 30", but never the end of a fraction ("1/2% 10" is
    not 2/10); the word "days" ("2/10 days, net 30 days");
  - "EOM", "E.O.M.", "end of month" or "end-of-month" anywhere in the terms, "2/10 EOM, n/30" as well as "2/10 net 30
    EOM": the days count from the last day of the invoice's month, not the invoice date, for the discount and the due
    date alike;
  - a few words around the terms that change nothing: "terms", "payment", "invoice", "date", "from", "of", "the",
    "after", "due", "calendar" ("Payment terms: net 30 from the invoice date").
- It says what is wrong instead of guessing:
  - no terms it can read;
  - terms it can read only in part, never read with a part dropped: a figure, a percent or a word outside that list
    beside the terms it read. Such as a discount written after the net days ("net 30, 2/10"), without its days ("2%
    net 30") or another way ("2-10 net 30", "1/2% 10 net 30", ".5/10 net 30"); more than one discount ("2/10, 1/20,
    net 30") or net term ("net 15 net 30"); a late fee or a date ("net 30, 1.5% late fee", "net 30 from 10/15/2026");
    a word that moves the day the days count from ("2/10 net 30 ROG", "net 30 upon receipt"). One message covers them,
    and says a late fee and the invoice date have fields of their own;
  - a discount not above 0% and below 100%, or with more than 2 decimal places, as a bill's;
  - net days above 365; discount days not fewer than the net days.
- The invoice reader is unchanged: it does not count EOM terms from the month's end, nor read "n/30" or "2% 10".
- `termsWords` writes terms back the usual way ("2/10 net 30", "net 30 EOM"), and `termSlug` gives a term page's path
  ("2-10-net-30").

**PT2. The dates** (`termDates`). From the invoice date, a `YYYY-MM-DD` calendar day: the day the days count from (the
invoice date, or the last day of its month for EOM), the discount deadline (that day plus the discount's days), and
the due date (plus the net days). Days are calendar days, every one counted, as the invoice reader counts them.

**PT3. What skipping the discount costs** (`src/lib/payment-terms/cost.ts`). With a discount of d percent and t days
between the discount deadline and the due date, skipping it is like borrowing the discounted amount for t days at:
- simple, 365-day year: d ÷ (100 − d) × 365 ÷ t;
- simple, 360-day year: d ÷ (100 − d) × 360 ÷ t;
- compounded over a year: (1 + d ÷ (100 − d)) ^ (365 ÷ t) − 1.

For 2/10 net 30 that is 37.2%, 36.7% and 44.6%; 1/10 net 30, 18.4% simple on 365 days; 2/10 net 60, 14.9%; 3/10 net
30, 56.4% (`tests/payment-terms.test.ts` holds each). The page shows each figure with its formula, the numbers filled
in. The break-even rate is the simple 365-day figure: below it paying by the discount deadline comes out ahead, above it
holding the cash does. The page never shows `annualPct` (`src/lib/early-pay/offers-words.ts`), which divides by the
full amount, not the discounted one (36.5% for 2/10 net 30) and matches no textbook figure.

**PT4. The late fee after N days** (`src/lib/payment-terms/late-fee.ts`). As the contract says it:
- a percent a month, more than 0 and at most 10 (`LATE_FEE_MAX_PERCENT`) with at most 2 decimal places, as a bill's
  late fee (`src/lib/intake-validation.ts`), charged either for each month or part of one, a month counted as 30 days,
  or by the day, at the monthly percent × 12 ÷ 365 for each day;
- or a fixed amount, charged once: at most the invoice's amount, as a bill's late fee, and at least 0.01
  (`MIN_FIXED_FEE`), which a bill's need not be: a fee under a cent would show as 0.00 in the page's 2-decimal figures.
- Days of grace, 0 by default: the fee applies from the day after the due date plus those days.
- On the amount alone: no fee on a fee, nothing compounded.
- `lateFeeAfter` gives the fee N days after the due date, with its formula; the page shows 7, 30 and 60 days, and a
  number of days someone chooses.

**PT5. The decision** (`src/lib/payment-terms/decision.ts`). "Pay on <date>", or "Pay today, <date>", with one sentence
why, from the agent's own written policy, `planPaymentTiming` (`src/lib/agent/payment-timing.ts`, payment timing §1):
- `now` is today in the browser, the person's own calendar day; the discount comes through `invoiceDiscount`, and
  whether it still applies today through `discountApplies`.
- The yearly rate someone's cash earns or their borrowing costs, 0 when left blank, goes in as `reserveApy`, applied to
  the discounted amount (the cash paying early would have used). So the decision turns exactly at the break-even rate
  PT3 shows, and the yield the sentence names is the yield on that cash.
- The operating balance is unlimited and nothing else is owed, so there is never a shortfall; the late fee goes in as
  `lateFee`, so the sentence names the fee a payment comes before ("before a 1.5% monthly late fee (15.00 USD) starts
  Nov 28, 2026").
- Amounts in the sentence are shown with 2 decimals (the policy keeps USDC's 6). When the discount and the yield differ
  but read the same with 2, as either side of the break-even rate (20.00 USD against 20.00 USD), every amount in the
  sentence takes as many decimals as tell the two apart, up to 6 (`sentenceDecimals`): "worth more than" never sits
  between two figures that read the same.
- The currency is a label only: USD, EUR, GBP, CAD, AUD, USDC or EURC. Nothing is converted.

**PT6. The calculator** (`PaymentTermsCalculator`, `src/components/payment-terms/PaymentTermsCalculator.tsx`).
- Fields: invoice date (today by default, once the page has loaded in the browser), amount (at least 0.01, the
  smallest amount the page's 2-decimal figures can show, though the decision's sentence may show more decimals (PT5);
  and at most 1,000,000,000,000), currency, terms with
  presets (2/10 net 30, 1/10 net 30, net 30, net 60, net 30 EOM), the yearly rate (optional) and the late fee
  (optional: its value, a percent a month or a fixed amount, for each month or part of one or by the day, days of
  grace), and a number of days late (optional).
- Results as someone types: the decision, the due date and discount deadline, what paying by the deadline saves (or
  that the discount ended), the three costs of skipping it with their formulas, the break-even rate, and the late fee
  at 7, 30 and 60 days and the chosen number of days.
- Only the decision is announced to screen readers as it changes. Each field's problem is shown under it, and says
  what is wrong: an amount that is not a figure asks for one, and one out of range gives the range. Counts of days read
  "1 day", never "1 days".
- Its one heading, the late fee's "If it is paid late", is an h3: each page puts the calculator under an h2.
- There is no form, so nothing typed can be submitted or land in the address bar. Nothing is sent, put in a URL or
  kept in storage or a cookie; `tests/payment-terms-page.test.tsx` fails if the calculator or its rules gain a request,
  an address-bar read or a storage call.
- Fields are 16 px on a phone, and the layout holds at 375 px.

**PT7. The page** (`/payment-terms`).
- Public and static, outside `/tools` (which serves downloads); `requiresSession` is false for it.
- Title "Payment terms calculator: due date, 2/10 net 30 and late fees", its own description and canonical address,
  and the heading "Payment terms calculator".
- The calculator sits under a visually hidden h2, "Work out an invoice". Below it: how it works
  (`how-the-calculator-works`), what it does not do (read an invoice or contract, know local rules on late fees, move a
  due date off a weekend or holiday or roll a late-month invoice into the next month, convert currencies), links to the
  term pages, and the call to action.
- How it works says the decision's sentence is the policy's own, with the rate applied to the discounted amount (PT5).
- Under the introduction: "Everything is worked out in this page, and nothing you type is kept." and
  `FREE_TOOL_COUNT_LINE`, as every free tool says it (free tool attribution TA6); a term page says the same above its
  calculator.
- Both pages carry the full footer, naming the tool (`<SiteFooter tool="payment-terms" />`), so its **Get started**
  credits the tool too (free tool attribution TA5). Its links to the landing page's sections (How it works, Who it's
  for, Safety, Proof) were bare `#…` addresses, which go nowhere off the landing page, as on /check-address, /studios
  and /how-it-decides before this change; they are now `/#…` on every page but the landing, which passes `landing` and
  keeps them in place. Every same-page link on both pages has its section on the page.

**PT8. The term pages** (`/payment-terms/[term]`): 2-10-net-30, 1-10-net-30, 2-10-net-60, 3-10-net-30, net-30, net-60
and net-30-eom, from `generateStaticParams`; any other term is a 404 (`dynamicParams = false`).
- Each says what the term means, the formula, and a worked example: an invoice for 1,000.00 USD dated Nov 2, 2026, its
  dates, and for a discount term what it saves and the cost of skipping it on the three bases; for a net term, a 1.5% a
  month late fee 10 and 45 days late.
- Then the calculator with that term filled in, links to the other terms, and the call to action. Only the public term
  is in the path.
- The header links to the calculator and the docs, two links as on the other public pages, so it fits a 375 px phone;
  the wordmark goes home.

**PT9. The call to action and how the tool is found.**
- `PaymentTermsCta` (`src/components/payment-terms/PaymentTermsCta.tsx`), one small component on both pages:
  "Vestiarion's agent checks every bill before it is paid, weighs an early-payment discount against holding the cash to
  the due date, and pays in USDC within the limits you set." (it claims no reading of terms: the invoice reader does
  not read EOM), **Try it on your bills**, and "In shadow mode it decides on your real bills while you keep paying them
  as you do now." Its button is the free tools' shared `ToolCta` for `payment-terms`
  (`src/components/public/ToolCta.tsx`, free tool attribution TA3): to the landing's own address (`TRY_HREF`), with
  `data-cta="payment-terms-start"`, crediting a workspace opened next to the tool.
- The tool is in `FREE_TOOLS` (`src/lib/free-tools.ts`), after the address checker, as "Payment terms calculator": the
  footer's Free tools group lists it from there, and the sitemap lists `/payment-terms` from there, followed by its
  term pages; the first payment guide links to it from "When the agent pays" and "A late fee".

## Not in this change

- EOM terms in the invoice reader, "n/30" or "2% 10" in the invoice reader, and the rule that invoices dated late in a
  month roll to the next one under EOM terms.
- Reading a discount written after the net days ("net 30, 2/10"), as "2-10", as a fraction of a percent ("1/2%"), or
  more than one; terms counted from receipt of goods (ROG) or from the next month (prox): the calculator refuses them.
- Late fees charged on fees, or compounded; legal caps on late fees by place.

## Tests

`tests/payment-terms.test.ts`:
- `readWrittenTerms` on each form, and what the invoice reader read before;
- `parseTerms`: each form, EOM before or after the net days and written with dots or hyphens, "n/30", "2% 10",
  "days", filler words, every refusal, terms read only in part refused (a discount after the net days, "2-10", a
  fraction of a percent, a second discount or net term, a late fee, a date, ROG), a discount percent with more than 2
  decimal places; `termsWords` and `termSlug`;
- `termDates` with and without EOM, across a month and a year;
- the costs on three bases for the four discount terms, the formulas, and the break-even rate;
- the late fee: per month or part of one, by the day, fixed, grace, at 7, 30 and 60 days; a percent with more than 2
  decimal places, and a fixed fee above the invoice's amount or under 0.01, refused;
- the decision: the discount deadline below the break-even rate, the due date above it, today when overdue, the
  discount ended, the late fee named, amounts with 2 decimals, and more either side of the break-even rate (37.24% and
  37.25% on 2/10 net 30);
- the term pages: each slug's terms and worked example.

`tests/payment-terms-page.test.tsx`:
- the calculator in a DOM: results as someone types, the decision in the live region, presets, field problems (an
  amount that is not a figure, one under 0.01 or above the largest, a fixed fee above the amount or under 0.01, terms
  with a late fee in them), "1 day" not "1 days", no form;
- the page and a term page: static, public, title and canonical, heading, the calculator under an h2, every same-page
  link's section on the page and the footer's landing links to the landing, two header links on a term page, the call
  to action (`ToolCta` named `payment-terms-start`, and the footer's Get started, both to the landing's start), the
  line about counting, the footer naming the tool, the worked example, the term filled in, 404 for an unknown term;
- nothing sent: the calculator, its rules and the pages hold no request, address-bar read, storage or cookie (the
  cookie a start link writes is `ToolCta`'s, outside them).

`tests/invoice-document-extract.test.ts` keeps passing unchanged. `tests/docs-content.test.ts` pins the sitemap's order
and the app pages a guide may link to; `tests/site-footer.test.tsx` the footer's Free tools group, and its landing
section links in place on the landing and as `/#…` elsewhere; `tests/free-tool-attribution.test.tsx` the tool in
`FREE_TOOLS` and its page naming it to the footer.

No migration.
