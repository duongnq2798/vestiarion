# Commissions on money received

Date: 2026-10-14. Status: decided (autonomy grant 2026-10-05). Roadmap: F27.

## Why

A small business that pays a sales partner or a referrer a commission usually pays it when a deal is won, then has to
ask for it back when the customer pays late, pays part, or never pays. Vestiarion already knows when a customer's money
is confirmed on Arc and which invoice of which deal it was applied to (allocations, 2026-10-12; deals, 2026-10-12). So a
commission can be earned on that money, and only on it: a part payment earns its part, a payment undone takes its
commission back from the next one, and the payout is a payable the agent pays under the same rules as any other.

## What this does, and what it does not

- An owner or admin sets a **commission plan** for a partner on file: the rate, the basis (net or gross), the deals it
  covers and a hold window.
- When a customer's payment is applied to an invoice of a covered deal, Vestiarion records an **accrual** of the rate
  times exactly the amount applied, with the formula.
- When an application is undone, it records a negative **adjustment** of exactly that accrual.
- After the hold window, a person reviews what each partner is due and **creates one payable** for it. The agent decides
  and pays that payable like any other, under every guardrail. The partner never approves their own payout.
- Not in this change: payroll, tax withholding, tiered or capped rates, splits between partners on one plan, a
  commission on money that did not arrive on Arc, and taking money back from a partner's wallet (C9).

## Decisions

Each decision names what it costs if it turns out wrong.

**C1. Four tenant tables, migration 0118.**
- `commission_plans`: one row per version of a partner's plan. `beneficiary_id` (a counterparty), `beneficiary_member`
  (the workspace member who is this partner, when one is), `rate_bps` (1 to 10000: 12.5% is 1250), `basis` (`net` or
  `gross`), `scope` (`all_deals` or `chosen_deals`), `hold_days` (0 to 365), `reference` (optional, up to 80
  characters), `started_at`, `ended_at`, `replaces` (the version before), `created_by`, `ended_by`.
- `commission_plan_deals`: the deals a `chosen_deals` version covers, one row per deal.
- `commission_lines`: accruals (`amount > 0`) and adjustments (`amount < 0`), append-only. Each names its plan version,
  its partner, the receivable and its deal, its source (`payment`, `fee` or `whole_match`), the allocation row or the
  whole-matched transfer it is on, the base, the rate, the amount, the currency, when the money was applied
  (`applied_at`), when it is due (`due_at`), the accrual an adjustment adjusts (`adjusts`), and the payout it went into
  (`payout_id`).
- `commission_payouts`: one row per payable created from a review: the partner, the payable (`invoice_id`, unique), the
  currency, the amount, how many lines, a statement number (`CS-` and 8 characters), who created it.
- Every foreign key is composite with `org_id`, as since 0019. Row-level security as 0108: the permissive and the
  restrictive `tenant_isolation` policies. The tenant role reads and inserts every table; it updates only a plan's
  `ended_at` and `ended_by` and a line's `payout_id` (column grants), and the guards below hold the rest. Nothing is
  deleted but with its workspace, its partner or its invoice.
- Additive and re-runnable, as every migration: `if not exists`, `create or replace`, policies and triggers dropped
  first, `notify pgrst`.
- Cost if wrong: a later migration adds a column or a kind; the history stays.

**C2. A plan, and its versions.**
- The partner is a counterparty on file whose role is vendor or contractor. A client pays the business, and the agent
  never pays a client on its own (client payables R1), so a client is refused as a partner.
- The rate is typed in percent with up to two decimals (0.01 to 100) and kept in basis points. The hold window is a
  whole number of days, 0 to 365, 30 by default. The reference is the agreement's name or number, shown on the payable.
- One plan is in force per partner (`commission_plans_one_active`, a partial unique index on `ended_at is null`).
  Changing it ends the version in force and starts the next at the same instant, in one transaction
  (`set_commission_plan`), under a lock per partner; a change from a version that is no longer the one in force is
  refused (`commission_plan_changed`). Ending a plan (`end_commission_plan`) sets `ended_at`.
- A version is never edited: `commission_plans_guard` refuses any change but ending it once, and a foreign key's own
  `set null` when a person's account is deleted.
- A plan covers money applied from its start: never money applied before it was set.
- Cost if wrong: a business wanting a back-dated plan sets it and records the earlier commissions as a payable by hand.

**C3. What earns a commission: money confirmed on Arc and applied to a receivable of a covered deal.**
- A receivable belongs to a deal when it was released from one (`invoices.deal_id`, deal schedule D10). A plan covers
  every deal of the workspace (`all_deals`) or the deals it names (`chosen_deals`).
- Three sources, each the money as it was applied:
  1. a `payment` row of `receivable_allocations` (allocations L1): part or all of one payment applied to the receivable,
     by a person or by the agent;
  2. a `fee` row (allocations L7), under the gross basis only (C4);
  3. a whole match (allocations L3): a transfer matched to the receivable in full, which has no allocation row; its base
     is the transfer's amount, and its time is the transfer's arrival.
- The plan version that counts is the one in force when the money was applied (the row's `created_at`, the whole
  match's `received_at`). A row already reversed when the commissions are first recorded earns nothing and needs no
  adjustment.
- Nothing else earns a commission: a receivable marked received by a person with no payment on Arc, a receivable that
  is not from a deal, a bank statement's money-in line (allocations L2), or money applied before the plan.
- Cost if wrong: a business that collects outside Arc pays those commissions by hand.

**C4. The formula, shown on every line.**
- `commission = base × rate`, rounded down to the millionth (the 6 places `numeric(20,6)` keeps), so a commission is
  never more than the rate gives. A commission below one millionth is not recorded.
- **Net** (the default): the base is the money that arrived on Arc and was applied: payment rows and whole matches.
- **Gross**: the base also counts what a person recorded as a fee on the invoice (allocations L7): the part of the
  invoice the customer paid but that was lost on the way. So on a 1,000.00 USDC invoice settled by a 999.50 USDC
  payment and a 0.50 USDC fee, 10% net is 99.95 USDC and 10% gross is 100.00 USDC.
- A part payment earns exactly its part: 300.00 USDC applied of a 1,000.00 USDC invoice at 10% earns 30.00 USDC, and
  the next 700.00 USDC applied earns 70.00 USDC when it comes. The line says "300.00 USDC received × 10% = 30.00 USDC",
  and names the invoice's amount beside it.
- A commission is in the currency of the money: USDC or EURC. Currencies are never added together.
- Cost if wrong: one line of SQL and one of TypeScript, with the tests that hold them to each other.

**C5. Recording is idempotent, in the database.**
- `record_commissions(p_org_id)` (security invoker, for the tenant role) inserts every accrual and adjustment not
  recorded yet, and answers the rows it inserted. A partial unique index allows one accrual per partner and allocation
  row, one per partner and whole-matched transfer, and one adjustment per accrual, and the inserts say `on conflict do
  nothing`: replaying the same allocation event, or two callers at once, never accrues twice, and each inserted row is
  answered to one caller only.
- It is called by the agent's cycle in its receipts stage, after money in is recorded and matched, in every mode, and
  right after a person applies or reverses a payment (allocations L8, L10), so the review shows it at once. Both are
  best effort: a failure is a log line, and the next call records what was missed.
- The app signs one entry per row it was answered (C12), after `assertLedgerCanSign`; with no signing key, nothing is
  recorded until there is one.
- Cost if wrong: an entry whose append failed leaves a line with no entry; the review still shows it.

**C6. The hold window.**
- An accrual is due `hold_days` after the money was applied (`due_at`). Until then it is held: the review shows it with
  the day it falls due, and it cannot be paid. The window is the time a business wants before paying on money that may
  still be undone.
- Cost if wrong: a business wanting no wait sets 0 days.

**C7. An undone application takes its commission back, from the next payout.**
- When an allocation row an accrual is on is reversed (allocations L8; reversing a payment also reverses the fees beside
  it), an adjustment of exactly minus that accrual is recorded, never recomputed.
- An adjustment of an accrual not paid out yet is due with it, so the two cancel in the same review. One of an accrual
  already in a payable is due at once, and is **carried forward**: it lowers the partner's next payout. A payable
  created before the reversal is not changed: it is paid as it was approved, or a person rejects it in Approvals.
- A whole match is not undone in the product (allocations L3). Should the cycle ever release one it had made, its
  accrual is adjusted the same way.
- Cost if wrong: a business that wants a held payout cut instead rejects it and reviews again (C10).

**C8. Refunds and returns: what exists, and what is handled.**
- **Handled**: a person reversing a payment or a fee applied to a receivable (allocations L8), and the agent releasing a
  whole match it made in the same cycle (receivables on Arc). These are the only events in Vestiarion today that take
  money back off a receivable.
- **Not handled, because nothing records it**: a USDC transfer on Arc has no refund, return, chargeback or dispute
  (settlement lifecycle L4); a refund is a new transfer back. A refund paid to a customer as a payable (client
  payables R1) names no receivable, so it adjusts no commission. A deal whose price was lowered after an invoice was
  released keeps a credit line owed to the customer (deal schedule), which moves no money. A receivable rejected after
  money was applied keeps its money, and its commission. In each case a person who wants the commission back reverses
  the application, which adjusts it (C7).
- Cost if wrong: a refund paid outside these steps keeps its commission until a person reverses the application.

**C9. Never money back from a partner's wallet.**
- Vestiarion pays commissions and never pulls one back. A negative balance stays on the partner, shown as **Carried
  forward**, and lowers their next payout. Nothing is sent to ask for it.
- Cost if wrong: a partner who leaves with a negative balance is a matter for the business and the partner.

**C10. Review, then one payable per partner and currency.**
- **Bills & receivables › Receivables › Commissions** opens `/o/[slug]/invoices/commissions`: the plans, then each
  partner's commissions per currency, in three parts:
  - **Due now**: accruals past their hold window and adjustments, not in a payable, each with its formula;
  - **Held**: accruals still in their hold window, each with the day it falls due;
  - **In payables**: what went into each payable, by statement number, with the payable's status.
- When what is due now adds up to more than zero, **Create payable** creates one payable for it. When it adds up to zero
  or less, the page says what is carried forward, and nothing can be created.
- `create_commission_payout` (security invoker) does it in one transaction, under the same lock per partner: it takes
  exactly the lines the person saw, refuses when they changed since the page was read (`commission_changed`), when
  they add up to nothing (`commission_nothing_due`) or when the person is the partner (C11), inserts the payable, the
  payout row and the lines' link, and answers the payable's id. Two people pressing at once create one payable.
- The payable: the partner as counterparty, the net amount and currency, the memo "Commission statement CS-… for N
  payments received", the statement number as its purchase order, goods received (the review is the receipt of the
  work), due today, created by the person who reviewed it. It is an ordinary payable: it shows on Bills, its
  `create_invoice` entry carries `via: "commission"`, and nothing else about it is special.
- A payable rejected in Approvals gives its lines back to the review (`commission_lines_guard` lets a line move from a
  payout whose payable is rejected to a new one, and nowhere else). Paid, it keeps them.
- `commission_lines_guard` keeps every term of a line; only `payout_id` changes, from none, or from a rejected payable.
- Cost if wrong: a partner paid monthly reviews monthly; a business wanting one payout per deal reviews per deal later.

**C11. The partner never approves their own payout.**
- A plan may name the workspace member who is this partner. That person:
  - cannot approve the payout: `approveAndPay` refuses before anything is claimed or recorded
    (`beneficiary_approval`: "This payable pays your own commission, so someone else must approve it."), for one
    approval and for either of two approvals; and the database refuses it too: `claim_invoice_decision` (redefined in
    0118, otherwise 0077's) refuses an approval of a payout by any member a plan of its partner ever named, and
    `payment_approvals_not_beneficiary` refuses their approval row. Being the workspace's sole approver does not lift
    it;
  - cannot create their own payable from the review, nor set, change or end their own plan.
- Whoever created the payable is already refused its approval unless they are the sole approver (sole approver R1).
- The agent may still pay it on its own, within every guardrail, since the agent is nobody's partner.
- Cost if wrong: a refusal a business must route around by naming another approver, which is the point.

**C12. Signed entries, domain `ap`.**
- `commission_plan_set` (actor `human`): `{ by, planId, replaces, beneficiaryId, beneficiaryName, beneficiaryMember,
  rateBps, ratePercent, basis, scope, dealIds, holdDays, reference, startedAt }`.
- `commission_plan_ended` (actor `human`): `{ by, planId, beneficiaryId, beneficiaryName, endedAt }`.
- `commission_accrued` (actor `agent`): `{ lineId, planId, beneficiaryId, receivableId, dealId, source, allocationId,
  transferId, base, rateBps, basis, amount, currency, appliedAt, dueAt, formula }`.
- `commission_adjusted` (actor `agent`): `{ lineId, adjusts, planId, beneficiaryId, receivableId, dealId, source,
  reversalId, transferId, amount, currency, appliedAt, dueAt, carriedForward, reason }`, `reason` being
  `allocation_reversed` or `whole_match_released`.
- `commission_payable_created` (actor `human`): `{ by, payoutId, statement, payableId, beneficiaryId, beneficiaryName,
  amount, currency, lineIds, accrued, adjusted }`; the payable's own `create_invoice` entry comes first.
- An entry names the receivable as `receivableId`, never `invoiceId`, so it is never read as a decision on that
  receivable.
- Cost if wrong: an entry's field added later; the history stays.

**C13. Who.**
- `commission.set_plan`, `commission.end_plan` and `commission.create_payable` need `records.write`: owners and
  admins, from the console, as adding a bill is. Everyone in the workspace reads the page. An accountant reads it and
  changes nothing: creating a payable is adding a bill to pay.
- Cost if wrong: one line in the permission map.

**C14. Before migration 0118 runs.**
- The page says "Commissions are not set up on this deployment yet."; the commands refuse `not_ready`; the cycle and the
  allocation commands record nothing and carry on; Approvals reads no payout, and the claim is 0077's.
- Cost if wrong: none: there is nothing to pay before the tables exist.

**C15. The API and webhooks.**
- No new endpoint. The new entries are listed by `GET /api/v1/ledger` and sent as `ledger.appended`; a commission
  payable is in `GET /api/v1/invoices` as any payable. The API changelog says so.

## Not in this change

- Payroll, tax withholding, tiered or capped rates, several partners on one plan, a commission per deal stage.
- A commission on money not received on Arc, or on receivables that are not from a deal (C3).
- Automatic adjustments for refunds paid as payables, deal credit lines and rejected receivables (C8).
- Taking money back from a partner (C9).
- A commission payable in the payment plan's approvals: it is moved like any other bill, and the agent decides it.
