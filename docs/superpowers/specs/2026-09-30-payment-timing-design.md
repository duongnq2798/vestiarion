# Payment timing: the agent chooses when to pay, and says why

Today the AP agent answers one question per invoice: pay it now, hold it, flag it, or ask for information. It never decides *when* to pay. An invoice that is correct gets paid the moment a cycle sees it, whether it is due tomorrow or in a month. It is paid even when it offers a discount for paying by a date, and even when paying it now would leave less cash for bills that fall due first.

That is how a script behaves, not a treasurer. Deciding when to pay is the core of accounts-payable judgment:
- capture an early-payment discount on its last valid day;
- otherwise keep the cash until the bill is due;
- when cash is short, pay what falls due first.

This design gives the agent that choice, bounded in code, and records the reason.

It was decided on 2026-09-30 by the implementer under the partner's standing instruction.

## 1. What this builds

- **Payment terms on an invoice.** An invoice may carry an early-payment discount: a percentage and the date it lapses (for example "2/10 net 30": 2% off if paid within 10 days, the full amount due in 30).
  - The invoice form and the CSV import gain two optional fields: "Early-payment discount (%)" and "Discount deadline".
  - Migration 0038 adds `invoices.early_pay_discount_pct`, `discount_due_date`, `scheduled_for` and `paid_amount`, plus the status `scheduled`.
- **A new decision: schedule.** The AP decision becomes `pay | schedule | hold | flag_fraud | request_info`. `schedule` carries `payOn`, a calendar date (UTC). A scheduled invoice has status `scheduled` and `scheduled_for` set to that day, with the agent's reasoning, and the ledger records `ap_schedule` with the decision, the timing figures and the reference decision.
- **Timing policy (`planPaymentTiming`).** This pure function computes the facts and a reference answer. The model receives the facts; the reference answer (`recommendation` and `reason`) is withheld from it and recorded in the ledger for comparison (`referenceDecision`, `timing`), so agreeing with it is a measurement, not an instruction. It is also the fallback when the model is unavailable, as `planTreasury` is for treasury. Its inputs:
  - today, the due date, the discount (percent and deadline);
  - the operating balance;
  - the payables that fall due on or before this one's target date: their total and how many there are;
  - the reserve's yield.

  Its rules, in order:
  1. **Due today or overdue:** pay now.
  2. **Discount still available:**
     - The discount is worth `amount × pct`. Waiting until the due date instead is worth `amount × reserve APY × (due − deadline) / 365`, plus the cash kept.
     - When the discount is worth more (it almost always is), the target date is the discount deadline: the last day that still earns it.
     - Otherwise, the target date is the due date.
  3. **No discount:** the target date is the due date. Paying earlier gives the money away sooner for nothing: the cash stays available for obligations that fall due first, and in the reserve when there is yield.
  4. **Target date after today:** schedule for it. Otherwise, pay now.
  5. **Shortfall:** when the operating balance, less every payable due on or before this invoice's target date, cannot cover this invoice, the figures say so (`shortfall`, next to `earlierObligations: { total, count }`). The reference and the fallback then hold the invoice for a person, citing the figures, rather than schedule or pay it into a failure; the system prompt tells the model the same.
- **Code bounds the model.**
  - `payOn` must be a real date after today and no later than the due date.
  - A `payOn` after the due date is moved back to the due date, and one on or before today becomes pay now.
  - Every correction is recorded as `timingRule` in the ledger entry.
  - The guardrails treat `schedule` like `pay`: high risk, over the limit, an unconfirmed address, or a duplicate of a settled invoice block it, with the same held or flagged outcome. A payment the agent commits to must be one it would be allowed to make.
- **On the day.**
  - Each cycle loads `scheduled` payables whose `scheduled_for` has arrived, next to `pending` ones, and decides them again with every check: model, guardrails, pause, the counterparty's current risk and address.
  - The model is told it scheduled this invoice for today and why.
  - It may reschedule only within the same bounds (after today, no later than the due date), so the due date is the latest any invoice waits.
- **The discount is paid, not only noticed.** When an invoice is paid by the end of its discount deadline's day, the transfer is `amount × (1 − pct)`, rounded to 6 decimals:
  - `invoices.paid_amount` records what left;
  - the ledger's `ap_pay` (or `approval_paid`) detail carries `discountTaken` and `amountPaid`;
  - "Paid out to date" sums `paid_amount` where set.

  A person's Approve and pay applies the same rule, because it goes through the same `payInvoice`. Limits are checked against the invoice's full amount: never less.
- **Obligations.** `scheduled` joins the open payable statuses. A scheduled invoice counts toward the treasury buffer at its `scheduled_for` date, the day it will leave, and otherwise at its due date.
- **What a person sees:**
  - **Decision cards:** a scheduled invoice reads "Scheduled for <date>", with the reason.
  - **Invoices page:** the status reads "Scheduled · <date>", and the terms show as "<pct>% off if paid by <date>".
  - **Console:** a "Scheduled payments" section lists what the agent will pay next (date, counterparty, amount, and whether it takes a discount), each with its reason.
  - **Pausing the agent** stops scheduled payments like any other.
- **API and docs.**
  - `/api/v1` invoices gain `scheduledFor`, `earlyPayDiscount: { percent, deadline } | null` and `paidAmount`, and the status filter accepts `scheduled`, with the OpenAPI document and examples updated.
  - The changelog gets a dated entry.
  - The first-payment guide gains a section, "When the agent pays".
- **Sample data** shows it. The Northwind hosting invoice becomes due today, so it is still paid in the first cycle. A new Northwind invoice, "Annual support plan" (400 USDC, 2% off if paid within 10 days, due in 30), is scheduled for its discount deadline and paid at 392 USDC on that day.

## 2. Decisions

- **P1. Timing is the model's decision inside bounds, not a formula in the model's place.** The policy computes the facts (what the discount is worth, how long the cash stays, what falls due first) and a reference answer, as for treasury. The model receives the facts and decides with them, which the rubric's "an agent that chooses when to pay, and can explain why" asks for; the reference answer is withheld from it. Code bounds the date and every check still applies. The ledger records the policy's answer next to the model's, for comparison, so disagreements are measurable and agreement is the model's own.
- **P2. The latest date is the due date, always.** No invoice waits past it, whatever the model says, so scheduling can never make a business pay late.
- **P3. Checks run twice.** Scheduling commits to nothing irreversible. On the day, the invoice is decided again with current facts, because a counterparty can turn high risk or change its address in between, or the agent can be paused.
- **P4. Wall-clock dates.** Due dates, discount deadlines and `payOn` are calendar dates in UTC, compared with the wall clock, the same as obligations. The simulated day counter (`CYCLE_CLOCK_MODE=simulate`) does not move them. A scheduled payment is made by the first cycle on its day: the 6-hourly schedule for a live workspace, or a person's run in a sandbox.
- **P5. The discount lowers the transfer, never the limit check.**
- **P6. Milestones are not scheduled.** A verified milestone is released the same day by design (RFB3).
- **P7. No per-workspace switch.** A setting to "pay everything at once" would hide the behavior the feature exists for. Pausing the agent stops scheduled payments. A person action to pay a scheduled invoice now, or to cancel it, is a later slice (§6).

## 3. Components

```
supabase/migrations/0038_payment_timing.sql     invoice terms, scheduled_for, paid_amount, status 'scheduled'
src/lib/agent/payment-timing.ts                 planPaymentTiming, boundPayOn, discountedAmount (pure)
src/lib/agent/orchestrator.ts                   AP schema/prompt/fallback, scheduled loading, bounds, ap_schedule, discount on pay
src/lib/agent/guardrails.ts                     schedule treated like pay
src/lib/agent/obligations.ts                    'scheduled' open, dated by scheduled_for
src/lib/agent/pay.ts                            payInvoice pays the discounted amount by the deadline
src/lib/agent/approvals.ts                      paid_amount / discount in approval_paid
src/lib/queries.ts                              paid-out sums paid_amount
src/lib/intake-validation.ts, intake UI, actions, CSV
src/lib/api/invoices.ts, schemas, openapi, docs examples, changelog
src/lib/sample-data.ts                          due-today and 2/10-net-30 invoices
src/components/vx/*, console + invoices pages   Scheduled outcome, terms, Scheduled payments section
content/docs/guides/first-payment.mdx           When the agent pays
```

## 4. Testing

- **`planPaymentTiming`:**
  - due today or overdue → pay;
  - discount wins → the deadline, and a deadline today → pay now;
  - yield beats the discount → the due date;
  - no discount → the due date;
  - a target of today → pay now;
  - the shortfall figure;
  - rounding.
- **`boundPayOn`:** after the due date → the due date; today or earlier → pay now; not a date → pay now, with `timingRule` set.
- **Guardrails:** `schedule` is blocked exactly as `pay` is, for each rule.
- **The AP stage:**
  - a correct invoice with terms is scheduled, with the ledger entry's shape;
  - a scheduled invoice is ignored before its day and decided on it;
  - it is paid at the discounted amount by the deadline and at the full amount after it;
  - pause holds it;
  - rescheduling past the due date is refused;
  - the fallback follows the policy.
- **Obligations:** a scheduled invoice counts at `scheduled_for`.
- **Intake:** the pair of discount fields is validated together; the percent is between 0 and 100 (exclusive); the deadline is no later than the due date. CSV too.
- **API:** the fields, the status filter, and OpenAPI stays in sync with the schemas (the existing contract tests).
- **UI:** the Scheduled outcome, terms, and the console section.
- **Docs:** the guide's quoted strings are pinned.
- **Sample data:** the fixture's two new rows; spec §3 of the sample-data design is updated.

## 5. Rollout

1. Apply 0038 before the merge. It is additive: old code never selects the new columns, and nothing writes `scheduled` yet.
2. Merge on green.
3. In `testnet-2`, add a payable with terms (e.g. 5 USDC, 2% off within a few days, due later) and run a cycle. The agent should schedule it for the deadline, with its reason. On that day, a cycle pays 4.90 USDC on chain, and both entries are signed.
4. Load sample data in a sandbox and run a cycle: the new support invoice is scheduled.
5. Record the result in this spec, and post an arc-canteen product update.

## 6. Out of scope

- Collecting receivables.
- Negotiating terms with a vendor.
- Scheduling milestones.
- A person paying a scheduled invoice now, rescheduling it or cancelling it from the UI. Pausing the agent stops it.
- Late-payment penalties.
- Currencies other than USDC.
