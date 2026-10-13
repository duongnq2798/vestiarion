# Currency provenance and multi-currency planning

Date: 2026-10-13. Status: decided (autonomy grant 2026-10-05). Roadmap: F15, with I02 (money on business screens says
its currency, its source and a status a business reads). Builds on shadow mode (`2026-10-07-shadow-mode-design.md` S6,
the bill's `original_*` and its rate), the workspace report (`2026-10-09-workspace-report-design.md`), what the business
really paid (`2026-10-10-actual-payments-design.md`) and cash scenarios (`2026-10-11-cash-scenarios-design.md`).
Migration 0113. Pictures: `currency-provenance-shots/`, from the flag-gated `/docs-shots/currency/<state>`
(`DOCS_SCREENSHOTS=1`).

## Why

Small businesses in the US, Singapore, Japan, Korea, the Philippines and Malaysia write and receive invoices in USD,
SGD, JPY, KRW, PHP and MYR (and EUR). Vestiarion pays in USDC, or EURC on Arc testnet. Until now each module handled a
currency its own way: shadow mode kept a bill's own amount and the rate it was converted at, the report and the
comparison kept currencies apart, and planning counted USDC only. Nobody could read a total in the business's own
currency, see which rate a figure used, or see what a rate that moved between the bill and its payment cost.

## What it is, and is not

- **Reporting and planning only.** Payments still settle in USDC (or EURC on Arc testnet). The executable amount is
  what the agent pays, as before; nothing that decides or pays reads anything added here. `/api/v1` keeps USDC and
  EURC; no currency is added to it.
- **Never a guess.** A rate that was not recorded is unknown, and a total that needs it is unknown. Nothing falls back
  to 1:1.

## Decisions

**M1. One money shape, `src/lib/money/`.** Browser-safe and pure.
- `Money` is `{ minor: bigint, currency }`. Digits: 0 for JPY, KRW and the other zero-decimal ISO codes `billDigits`
  knows; 6 for USDC and EURC, the tokens' own decimals on Arc, since what left can carry a discount's micro-units; 2
  for every other currency. Parsing a decimal is exact (no float), a value read from the database goes through its
  shortest decimal text, and formatting writes a currency's own digits (a token at least 2 and at most 6).
- Totals are only ever per currency (`totalsByCurrency`), or in the reporting currency with the rates shown (M4).
  Adding two currencies throws.
- Rounding is half away from zero, once, at the target currency's digits.
- Cost if wrong: an amount in a currency the table does not know gets 2 digits.

**M2. Three kinds of rate, never one in place of another.** `FxRate` is `{ from, to, value, kind, source, at }`, the
value a decimal string, `to` per one `from`:
- `reference`: a market rate a feed published (ExchangeRate-API's daily rates, which shadow mode already reads). Reports
  and planning use it.
- `quote`: the provider's executable quote for what moves on Arc (Circle's EURC quote, recorded on a EURC decision).
- `accounting`: the rate the books used (Xero's or QuickBooks' own). Named so a figure can say it; not read yet.
- And two that a figure says by name: `peg`, 1 USDC = 1 USD or 1 EURC = 1 EUR, the tokens' redemption at par, said as
  such wherever it is used and never a market rate; and `manual`, a rate a person typed (a scenario's).
Every converted figure carries the rates it used, and every place that shows one names its kind, source and time.

**M3. A figure's provenance.** `MoneyFigure` keeps apart the amount as on the document and where it came from, the
executable amount (what moves on Arc), the rate that took one to the other, and the reporting value: the same currency,
converted with its rates, unknown with a reason, or no reporting currency set. A figure has full provenance when it has
all that applies: the document's amount, the executable amount once there is one, the conversion's source and time when
the two currencies differ, a reporting value when a reporting currency is set, and the rate at payment when a converted
bill was paid. The report's KPI is the share of its amounts with full provenance.

**M4. A reporting currency per workspace.** `reporting_currencies` (0113), one row: USD, EUR, SGD, JPY, KRW, PHP or
MYR, who set it and when. An owner or admin sets it in Settings (`workspace.reporting_currency`, permission
`reporting.manage`); each change is a signed `reporting_currency_changed`. Until one is set, each figure stays in its
own currency and the report says where to set one.
- Conversion to it: through the US dollar, exactly (the cross rate is a fraction of the two reference rates, rounded
  once). USDC and EURC reach the dollar and the euro by the peg, said. The newest reference rate published within 3
  days counts; an older or missing one makes the figure unknown, with the last rate's day when there was one.

**M5. Rates are stored.** `fx_rates` (0113), append-only for the tenant role: base, quote, the value, kind, source, when
the source published it, when it was recorded and by whom (a person for a manual rate). One row per workspace, kind,
source, pair and publication. Reference rates are recorded from the feed (`recordReferenceRates`) by the report and
Treasury when they need one, and every hour by `POST /api/platform/fx-rates` for each workspace with a reporting
currency or shadow mode in a currency of its own. The feed is read at most once an hour per server, as before.

**M6. FX variance on a paid bill.** A shadow-mode bill in a currency of its own was converted at its decision rate
(the bill's `fx_rate`, on the day it was entered); its payment on Arc carried USDC. The rate at payment is the newest
recorded reference rate published at or before the payment and at most 36 hours before it (the feed publishes daily);
none means unknown.
- Value at payment = what the transfer carried × decision rate ÷ payment-day rate, to the cent. Variance = what it
  carried less that value, in USDC: more than zero means the business paid more than the bill was worth that day.
  A discount is in both sides, so it is never a variance. A bill in US dollars has none: the dollar's rate does not
  move against itself.
- Recorded once per bill in `fx_variances` (0113, append-only), with every input copied (the decision rate and its
  source and day, the payment-day rate's row and value, what moved and when), by the hourly job and by the report.
  Shown on the bill's card and in the report, per currency.

**M7. Rates in a cash scenario are versions.** Treasury's What if section gains **Exchange rates** when an open bill
was written in another currency: a rate per currency, empty for each bill at its own conversion, today's reference
rate offered beside it. A rate typed there values that currency's bills at it (the bill's own amount ÷ the rate, to the
cent), before the cost lever. **Save as a version** keeps the levers and rates as the next version of that scenario in
`cash_scenario_versions` (0113, append-only), each typed rate as a `manual` row of `fx_rates`, and signs
`cash_scenario_saved`; a version is never changed, a change is the next version. Saved versions are listed and opened
from the same section. Permission `reporting.manage`. The KPI "manual FX adjustments" counts the manual rates.

**M8. The report says it.** `/o/[slug]/report` gains **Currencies and rates**: the reporting currency, the two KPIs,
per currency the bills as written, paid on Arc and recorded paid by the business, each in the reporting currency with
its rates or unknown, the total (unknown when one currency has no rate, with what is known said apart), the FX variance
on paid bills, and every rate used, with its kind, source and time.

**M9. Business screens (I02).** On a bill's card the bill reads as written with its conversion (`converted at 1.3500
SGD per USD, reference rate from ExchangeRate-API, published …`), a JPY or KRW amount with no decimals, a EURC
bill's USDC value with Circle's quote named, and a paid bill's FX variance. Token and chain words stay where a decision
needs them.

**M10. External obligations need no new column.** A bill from Xero or QuickBooks (`accounting_bills`), a HubSpot deal
(`crm_deals`), a deal and its costs, an imported bill list and a recorded payment (`payment_actuals`) already keep their
amount and currency as written; a bill taken in another currency keeps its conversion on the invoice (`original_*`,
0084); where a bill came from is its `create_invoice` entry's `via`. What was missing, the rate at payment, the rates
used, the reporting currency and saved scenarios, is what 0113 adds.

**M11. Before 0113 runs.** A missing table or column (`42P01`, `PGRST205`, `PGRST204`, `42703`) reads as not set up:
Settings says the reporting currency is not set up yet, the report shows its figures per currency with rates read but
not stored, variances unknown, and saving a scenario says it is not set up. Nothing fails for it.

## Screenshots

`currency-provenance-shots/`, each at 1440 and 390 px, from `/docs-shots/currency/<state>`:

1. `01-setting`: the reporting currency in Settings, for an owner or admin and for a member who cannot change it.
2. `02-report`: Currencies and rates with bills in SGD, JPY, KRW, PHP, MYR and USDC, the rates used, and KRW unknown
   (its last rate is 11 days old), so the total is unknown with the total without it.
3. `03-variance`: a paid shadow-mode bill of 1,350.00 SGD, converted at 1.3500 and paid when the rate was 1.3600:
   +7.35 USDC FX variance.
4. `04-scenario`: What if with SGD typed at 1.4000 against today's 1.3512, the cash in SGD, and two saved versions of
   "SGD weakens".

## Operations

- Migration 0113 is the partner's to apply. Until then every part says it is not set up, and nothing fails.
- The hourly job is a new line in `supabase/cron/watches.sql` (`vestiarion-fx-rates`, 41 minutes past each hour), run by
  hand in the SQL editor as the others are. Until it runs, rates are recorded when the report or Treasury is opened.

## Left for later

- Reading Xero's and QuickBooks' own rate (`accounting`) on their bills.
- Reporting-currency totals on the payment plan, deal cash readiness, projects and the accountant hand-off; they keep
  each currency apart, as before.
- Rate history from a paid feed: today the rate at a past payment is known only if it was recorded within 36 hours.
