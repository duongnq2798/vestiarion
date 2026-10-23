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
- the invoice form (`InvoiceIntake`: "Late fee", % a month or a fixed amount, "starting on");
- `POST /api/v1/invoices` and the invoice payload (`lateFee`, or null);
- CSV import (columns `late_fee_percent_month`, `late_fee_amount`, `late_fee_starts_on`);
- the email and Chrome drafts;
- deals and chat drafts, where they carry discount terms today;
- accounting imports (Xero, QuickBooks, Zoho Books), whose `ReadRow` gets `lateFee: null`.

Document capture: the extraction prompt asks for the late-fee term, and the rule-based reader recognises "x% per month"
or "x% monthly" on overdue amounts, and "late fee of N". The term is verified against the document text, as the discount
is, and listed among the fields a member changed from what was read.

**LF3. Signed.**
- `create_invoice` carries `lateFee` when the bill has one, and so do the agent's `ap_*` decisions, in `terms`.
- The API changelog lists the new invoice field and the ledger detail.
- `sdk/src/types.ts` is regenerated; the SDK version goes 0.3.6 to 0.3.7, with the README badge; the Postman collections
  are rebuilt.

**LF4. What waiting costs.** `lateFeeOf(invoice, on)` (pure, `src/lib/agent/late-fee.ts`) gives the fee for one month
past its start: the percentage of the amount still to pay, or the fixed amount. It is never negative.
- **The approval card's cost box.** It shows "Late after Oct 30: 1.5% a month (1.50 USDC)" or "Late after Oct 30: 25.00
  USDC". This is both in `approvalCost` and in `bankPayoutCost`, so a bank payout shows it too.
- **The bills list's terms line.** It names the fee beside the discount.
- **Slack's decision card confirmation.** It names the fee, as it names the discount. The fee never changes what is paid.
- **The amount is never changed.** A late fee is not added to the transfer. A bill paid late is paid at its amount, and
  the person settles any fee with the vendor.

**LF5. Holds and the decide-by day.** `decideByOf` (`src/lib/exceptions.ts`) gains the reason `late_fee`. For a bill past
its due date whose fee has not started, the decide-by day is the day before the fee starts.
- It feeds the existing surfaces: Approvals, the Bills rows, the accountant console and the escalation emails. The
  escalation's dedupe key stays (org, invoice, decide_by).
- The words: "Overdue since Oct 20; a late fee of 1.5% a month starts Oct 30".

**LF6. Short cash.**
- The written policy's `referenceOrder` (`src/lib/agent/cash-priority.ts`) puts first, among bills due or overdue, the one
  whose fee is heaviest in USDC for the coming month, then keeps today's order.
- The cash-priority prompt's bill facts carry the fee and its start, and `PRIORITY_SYSTEM_PROMPT` says to weigh them.
- Code still accepts the model's order, as today. Only USDC bills compete, and shadow mode skips the plan, as today.

**LF7. Reasoning.**
- The AP model's terms carry the late fee, and the system prompt tells it to name a fee the payment avoids.
- The written policy's reason (`buildReason`) names it when the bill is paid on or before the fee's start ("before a 1.5%
  monthly late fee (1.50 USDC) starts Oct 30").
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
- `decideByOf` with `late_fee`.
- `referenceOrder` with fees.
- The cost box, for a USDC payout and a bank payout.
- The API payload and schema.
- The SDK types.
- The Postman build.
- The create_invoice and decision ledger detail.
- Missing-column fallbacks: the code runs before 0141, when several columns are missing.
