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
  in the text, else the first "net N", and the percent kept as written.
- `parseTerms` reads what someone types into the calculator with the same reader, and also:
  - "n/30" written for "net 30", as in "2/10 n/30";
  - "EOM" or "end of month": the days count from the last day of the invoice's month, not the invoice date, for the
    discount and the due date alike.
- It says what is wrong instead of guessing: no terms it can read; a discount not above 0% and below 100%; net days
  above 365; discount days not fewer than the net days. The invoice reader is unchanged: it does not count EOM terms
  from the month's end.
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
- a percent a month, more than 0 and at most 10 (`LATE_FEE_MAX_PERCENT`, as a bill's late fee), charged either for
  each month or part of one, a month counted as 30 days, or by the day, at the monthly percent × 12 ÷ 365 for each day;
- or a fixed amount, charged once.
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
- Amounts in the sentence are shown with 2 decimals (the policy keeps USDC's 6).
- The currency is a label only: USD, EUR, GBP, CAD, AUD, USDC or EURC. Nothing is converted.

**PT6. The calculator** (`PaymentTermsCalculator`, `src/components/payment-terms/PaymentTermsCalculator.tsx`).
- Fields: invoice date (today by default, once the page has loaded in the browser), amount, currency, terms with
  presets (2/10 net 30, 1/10 net 30, net 30, net 60, net 30 EOM), the yearly rate (optional) and the late fee
  (optional: its value, a percent a month or a fixed amount, for each month or part of one or by the day, days of
  grace), and a number of days late (optional).
- Results as someone types: the decision, the due date and discount deadline, what paying by the deadline saves (or
  that the discount ended), the three costs of skipping it with their formulas, the break-even rate, and the late fee
  at 7, 30 and 60 days and the chosen number of days.
- Only the decision is announced to screen readers as it changes. Each field's problem is shown under it.
- There is no form, so nothing typed can be submitted or land in the address bar. Nothing is sent, put in a URL or
  kept in storage or a cookie; `tests/payment-terms-page.test.tsx` fails if the calculator or its rules gain a request,
  an address-bar read or a storage call.
- Fields are 16 px on a phone, and the layout holds at 375 px.

**PT7. The page** (`/payment-terms`).
- Public and static, outside `/tools` (which serves downloads); `requiresSession` is false for it.
- Title "Payment terms calculator: due date, 2/10 net 30 and late fees", its own description and canonical address,
  and the heading "Payment terms calculator".
- Below the calculator: how it works, what it does not do (read an invoice or contract, know local rules on late fees,
  move a due date off a weekend or holiday or roll a late-month invoice into the next month, convert currencies), links
  to the term pages, and the call to action.

**PT8. The term pages** (`/payment-terms/[term]`): 2-10-net-30, 1-10-net-30, 2-10-net-60, 3-10-net-30, net-30, net-60
and net-30-eom, from `generateStaticParams`; any other term is a 404 (`dynamicParams = false`).
- Each says what the term means, the formula, and a worked example: an invoice for 1,000.00 USD dated Nov 2, 2026, its
  dates, and for a discount term what it saves and the cost of skipping it on the three bases; for a net term, a 1.5% a
  month late fee 10 and 45 days late.
- Then the calculator with that term filled in, links to the other terms, and the call to action. Only the public term
  is in the path.

**PT9. The call to action and how the tool is found.**
- `PaymentTermsCta` (`src/components/payment-terms/PaymentTermsCta.tsx`), one small component on both pages: "Vestiarion
  reads the terms on every bill and pays on the right day, within limits you set.", **Try it on your bills** to the
  landing's own address (`TRY_HREF`) with `data-cta="payment-terms-start"`, and "In shadow mode it decides on your real
  bills while you keep paying them as you do now." The first-touch credit for free tools is a separate change; it will
  swap this link for its shared component.
- The sitemap lists `/payment-terms` and the term pages after `/check-address`; the footer's Resources lists the
  calculator after the address checker; the first payment guide links to it from "When the agent pays" and "A late
  fee".

## Not in this change

- Crediting a workspace to the tool it started from (the shared tool call to action and its first-touch cookie).
- EOM terms in the invoice reader, "n/30" in the invoice reader, and the rule that invoices dated late in a month roll
  to the next one under EOM terms.
- Late fees charged on fees, or compounded; legal caps on late fees by place.

## Tests

`tests/payment-terms.test.ts`:
- `readWrittenTerms` on each form, and what the invoice reader read before;
- `parseTerms`: each form, EOM, "n/30", every refusal; `termsWords` and `termSlug`;
- `termDates` with and without EOM, across a month and a year;
- the costs on three bases for the four discount terms, the formulas, and the break-even rate;
- the late fee: per month or part of one, by the day, fixed, grace, at 7, 30 and 60 days;
- the decision: the discount deadline below the break-even rate, the due date above it, today when overdue, the
  discount ended, the late fee named, amounts with 2 decimals;
- the term pages: each slug's terms and worked example.

`tests/payment-terms-page.test.tsx`:
- the calculator in a DOM: results as someone types, the decision in the live region, presets, field problems, no form;
- the page and a term page: static, public, title and canonical, heading, the call to action, the worked example, the
  term filled in, 404 for an unknown term;
- nothing sent: the calculator, its rules and the pages hold no request, address-bar read, storage or cookie.

`tests/invoice-document-extract.test.ts` keeps passing unchanged. `tests/docs-content.test.ts` pins the sitemap's order
and the app pages a guide may link to; `tests/site-footer.test.tsx` the footer's Resources.

No migration.
