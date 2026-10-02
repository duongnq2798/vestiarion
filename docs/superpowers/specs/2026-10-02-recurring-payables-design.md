# Recurring payments

Date: 2026-10-02. Status: shipped with this PR (design decided under the standing autonomy grant;
rulings below carry their cost if wrong). Roadmap T9.

## 1. Why

A business's most regular bills repeat: a retainer, a subscription, a monthly fee to a freelancer.
Today each one is a new invoice someone types in every period. Worse, the duplicate check
(`src/lib/agent/duplicates.ts`) is built to catch exactly what a recurring bill looks like: the same
vendor, the same amount and often the same contract reference. A standing order billed every week
would be refused as duplicate billing.

## 2. What it does

- An owner or admin sets up a **recurring payment**: who, how much, in USDC or EURC, what for, an
  optional contract or PO reference, and how often (every N days, weeks or months). They also set
  the first due date, an optional last one, and whether each period counts as delivered.
- Each cycle, a new stage, **recurring**, creates the invoice for each period as it comes near. The
  AP stage then decides it like any other: when to pay (payment timing A1), within every guardrail.
- Invoices of the same schedule are never taken for duplicates of each other. A typed invoice that
  repeats one of them still is.
- A schedule can be stopped. What it already created stays.

## 3. Rulings

- **R1 — one invoice per period, by construction.**
  - Each created invoice carries `recurring_id` and `recurring_period`, its due date, and `(recurring_id,
    recurring_period)` is unique (migration 0055). A retried or overlapping cycle cannot create a period twice.
  - That uniqueness is what lets R4 exempt the schedule's own invoices from the duplicate check.
- **R2 — periods are counted from the first due date, never from the last.** The n-th due date is
  the first plus n periods. A monthly schedule anchored on the 31st falls on the last day of shorter
  months and goes back to the 31st after, so it never drifts.
- **R3 — when a period's invoice is created.**
  - It is created ahead of its due date by the period's length less a day, at most 7 days. A daily
    one is created on its day; a weekly one 6 days ahead; a monthly one 7.
  - That gives the agent room to schedule it for its day, or for a discount.
  - A schedule that fell behind creates at most 3 periods a cycle.
  - Past its last due date, it ends.
- **R4 — the duplicate exemption is narrow.** Two invoices are exempt only when they come from the
  same schedule and are for different periods. The check still applies to anything else, including
  a typed invoice that repeats a scheduled one.
- **R5 — who made it.**
  - Created invoices carry the schedule's creator as `created_by`, so the maker-checker rule holds:
    whoever set up the schedule cannot approve its held invoices.
  - Each is signed as `recurring_invoice_created` by the agent, naming the schedule and period.
  - Setting a schedule up and stopping it are signed as `recurring_payable_created` and
    `recurring_payable_stopped`, by the person.
- **R6 — "delivered every period".**
  - When ticked (the default), each period's invoice is created as received, the person attesting at
    setup that the service continues. Otherwise each one asks for confirmation, as an invoice without
    receipt does.
  - Cost if wrong: a stopped service keeps being paid until someone stops the schedule. The schedule
    list shows each next due date, so it is in view.
- **R7 — the model is told.** An invoice from a schedule reaches the model with `recurring: { every,
  unit, period }`, so its reasoning can say so.

## 4. What a person sees

- **AP / AR → Recurring payments.** The form, and the list of schedules: each with its cadence, its
  next due date and status, and **Stop**.
- **Each created invoice** appears under Payables like any other, its memo naming the period.
- **The guide** (Your first payment) gains "Pay something every period".
