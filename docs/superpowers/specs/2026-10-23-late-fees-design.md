# Late fees in the agent's decisions (2026-10-23)

## Why

Many supplier invoices carry a late-payment term: "1.5% per month on overdue balances", or a flat fee. Vestiarion knows a
bill's early-payment discount end to end, but not its late fee. So it cannot:
- say on the approval card what waiting costs;
- give the bill with the heaviest fee first claim on short cash;
- warn the person who is holding a bill that the fee is about to start.

The agent already never schedules after the due date, since every target is clamped to it (payment-timing P2). What runs
a bill into a fee is a hold (a person, short cash, missing details, a shadow verdict) and the order in which short cash
is spent. That is where this change acts.

## Rules

**LF1. The term.** Three nullable columns on `invoices`, migration 0141:
- `late_fee_kind`: `'percent_month'` or `'fixed'`;
- `late_fee_value numeric(20,6)`:
  - a percentage per month, more than 0 and at most 10;
  - or a fixed amount in the invoice's currency, more than 0 and at most the invoice's amount;
- `late_fee_starts_on date`: the first day the fee applies. It is on or after the due date (UTC dates, as
  `invoices_discount_before_due` compares). When a term is given without it, it is the day after the due date.

Checks:
- all three are set or none are;
- the value's range for its kind;
- the start on or after the due date.

Receivables are not affected; the term is for payables only.

**LF2. Every entry path.** `invoiceInputSchema` gains `lateFee { kind, value, startsOn? }`, validated by one rule
(`checkLateFee`). The paths:
- the invoice form (`InvoiceIntake`: "Late fee", % a month or a fixed amount, "starting on"). On a bill in the
  business's own currency, taken at its USDC amount in shadow mode, a fixed fee is refused, as CSV import refuses it:
  it would be in that currency, not USDC;
- `POST /api/v1/invoices` and the invoice payload (`lateFee`, or null);
- CSV import (columns `late_fee_percent_month`, `late_fee_amount`, `late_fee_starts_on`). A header that writes a
  percent ("Late fee (%)") is the percent a month; a bare "Late fee" matches no field, and the person chooses;
- the email and Chrome drafts;
- deals and chat drafts, where they carry discount terms today;
- accounting imports (Xero, QuickBooks, Zoho Books), whose `ReadRow` gets `lateFee: null`.

Document capture: the extraction prompt asks for the late-fee term, and the rule-based reader recognises "x% per month"
or "x% monthly" on overdue amounts, and "late fee of N" (not "of N%", nor "of N per day"). The term is verified against
the document text, as the discount is: a fixed amount the text writes only as a percent, or one above the invoice's
amount, is left out with a note. A start the document does not give is left blank, so the form starts the fee the day
after the due date it is given, even one the member corrected. The term is listed among the fields a member changed from
what was read, a blank start read as the day after the submitted due date.

**LF3. Signed.**
- `create_invoice` carries `lateFee` when the bill has one, and so do the agent's `ap_*` decisions, in `terms`.
- The API changelog lists the new invoice field and the ledger detail.
- `sdk/src/types.ts` is regenerated; the SDK version goes 0.3.6 to 0.3.7, with the README badge; the Postman collections
  are rebuilt.

**LF4. What waiting costs.** `lateFeeOf(invoice, on)` (pure, `src/lib/agent/late-fee.ts`) gives what waiting costs in
the coming month, the 30 days from `on`: a month of the percentage of the amount still to pay, or the fixed amount while
it is still ahead. A fixed fee that has started is owed already, and a fee that starts after that month costs nothing in
it: both are 0. It is never negative. A month of the fee, `aMonth` and the cost box's figure, is the percentage of the
amount or the fixed amount, whatever the day.
- **The approval card's cost box.** It shows "Late after Oct 30: 1.5% a month (1.50 USDC)" or "Late after Oct 30: 25.00
  USDC". This is both in `approvalCost` and in `bankPayoutCost`, so a bank payout shows it too.
- **The bills list's terms line.** It names the fee beside the discount.
- **Slack's decision card confirmation.** It names the fee, as it names the discount. The fee never changes what is paid.
- **The amount is never changed.** A late fee is not added to the transfer. A bill paid late is paid at its amount, and
  the person settles any fee with the vendor.

**LF5. Holds and the decide-by day.** A late fee never delays or hides what a bill without one gets: it only adds a
warning.
- **The day does not move.** `decideByOf` (`src/lib/exceptions.ts`) gives the same day as without the fee: the discount's
  deadline while it is still ahead and earlier, else the due date. So the priority, the ageing, the order and the
  escalation's key are unchanged for every bill. For a bill past its due date that has a late fee, the result carries the
  reason `late_fee` and `lateFee { dueOn, startsOn, rate, started }`, for the words only. A bill with no fee, or not yet
  past its due date, gets exactly what it got before.
- **The words.** "Decide by Oct 20, 2026; a late fee of 1.5% a month starts Oct 30, 2026", or "applies since Oct 21,
  2026" once it has (`decideByWords`, `lateFeeDayWords`). Approvals and the Bills rows show them. Past the day, the
  accountant console says "Its decide-by day was Oct 20, 2026; a late fee of 1.5% a month starts Oct 30, 2026".
- **Escalations** (`pastDecideBy`, `src/lib/notifications/escalations.ts`): at most one item per bill per day.
  - Once its decide-by day has passed, as before: an item with that day, which names the fee when the bill has one.
  - On the fee's eve, one more: the fee has not started, its last day without the fee is after the due date, and today is
    that day. The item's day is that last day. The dedupe key stays (org, invoice, decide_by), so this is a new key, sent
    even though the bill was escalated past its due date earlier. Its line says the fee starts tomorrow, with the day and
    the rate.
  - The day escalations started in the workspace filters each item by its own day, as before; an eve's day is today.
  - The email words each item on its own. A batch of past items reads as before ("passed its decide-by day"); an eve
    alone says "A late fee starts tomorrow on 1 payment"; a mixed batch says how many passed their day and how many have
    a fee from tomorrow, and never rewords a past item.
- Example, due Oct 20 with the fee from Oct 30: escalated on Oct 21 for Oct 20, as without the fee; nothing more from
  Oct 22 to Oct 28; on Oct 29 for Oct 29, the fee's eve; and nothing more once the fee has started. A fee from the due
  date or the day after it has no eve.

**LF6. Short cash.**
- The written policy's `referenceOrder` (`src/lib/agent/cash-priority.ts`) puts first, among bills due or overdue, the one
  whose fee is heaviest in USDC for the coming month (`lateFeeOf`), then keeps today's order.
- The cash-priority prompt's bill facts carry the fee and its start, and `PRIORITY_SYSTEM_PROMPT` says to weigh them.
- The `cash_priority_set` entries' order items carry the bill's term, `lateFee { kind, value, startsOn }` as
  `create_invoice` signs it, when it has one. The plan's fingerprint and a person's carried order (order design O4) go
  by the term, never by what the fee costs on the day: a fixed fee reaching its first day is the same bill.
- Code still accepts the model's order, as today. Only USDC bills compete, and shadow mode skips the plan, as today.

**LF7. Reasoning.**
- The AP model's terms carry the late fee, and the system prompt tells it to name a fee the payment avoids: one paid
  before the fee's first day, which is late already (LF1).
- The written policy's reason (`buildReason`) names it when the bill is paid before the fee's start ("before a 1.5%
  monthly late fee (1.50 USDC) starts Oct 30"), never on that day or after.
- Code does not rewrite the model's words.

**LF8. Sample data and docs.**
- Sample data gives one supplier bill a late fee.
- Guides: invoices and capture, the approval card, payment timing, the accountant console's decide-by words.
- The API docs, the API changelog, the CHANGELOG and ARCHITECTURE.

## Not in this change

- Charging or paying a late fee.
- Interest compounding.
- Late fees on receivables.

## Tests

- The migration (PGlite): the checks and the default start.
- `checkLateFee` and every entry path.
- Extraction, from text and from the model.
- `lateFeeOf`.
- `decideByOf` with `late_fee`: the same day as without the fee, and a bill with none exactly as before.
- Escalations with a late fee: past the due date as before, once more on the fee's eve, and each item worded on its own
  in a mixed batch.
- `referenceOrder` with fees.
- The cost box, for a USDC payout and a bank payout.
- The API payload and schema.
- The SDK types.
- The Postman build.
- The create_invoice and decision ledger detail.
- Missing-column fallbacks: the code runs before 0141, when several columns are missing.
