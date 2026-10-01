# Open outcomes: what the agent decided, and how it went

Date: 2026-10-01. Status: in progress (design decided under the standing autonomy grant; rulings
below carry their cost if wrong).

## 1. Why

`/open` (docs/superpowers/specs/2026-09-30-open-numbers-design.md) says how much Vestiarion is used:
workspaces, payments settled on Arc testnet, USDC paid, cycles, decisions. It does not say how the
agent's decisions turned out, which is what a business asks before it lets an agent pay its bills:

- How many payment decisions did the agent carry out itself, and how many did it hand to a person?
- When a person reviewed the agent's warning, did they agree with it?
- Were invoices paid on time, and how many without anyone touching them?
- Did it stop duplicate invoices?

Every answer is already in the ledger and the invoice rows. This adds them to `/open` and
`npm run numbers`, split the same way: customers' workspaces, ours, and the total.

## 2. What the page shows

A second table, **Outcomes**, under the usage table, with the same period switch and the same three
columns:

| Row | Figure |
|---|---|
| Payment decisions the agent carried out itself | count |
| Payment decisions it escalated to a person | count |
| Decided by the agent itself | carried out ÷ (carried out + escalated), as a percent |
| Escalations a person resolved | count |
| Flags a person upheld | upheld "of" flags a person resolved |
| Invoices paid on time on Arc testnet | on time "of" invoices paid on Arc testnet |
| Paid on time with no person involved | count |
| Duplicate invoices caught | count |

The method list under the page gains one line per row.

## 3. Rulings

- **R1 — one new function, `open_outcomes(p_since timestamptz)`** (migration 0049), `security
  definer`, empty `search_path`, executable by the service role only, returning one `jsonb` document
  of aggregates per side, by the same customer/ours rule as `open_numbers` (R3 there). A function of
  its own rather than a change to `open_numbers`, so no migration re-run can put an older
  `open_numbers` back over it (the 0040/0042 lesson). Cost if wrong: none beyond one more RPC.
- **R2 — payment decisions only.** A decision is an agent ledger entry in domain `ap` or
  `contractor` that carries a `decision`, about a payable invoice or a contractor milestone. Treasury
  decisions are left out: the agent records a treasury hold every cycle, and those would swamp the
  figure while saying nothing about obligations. Cost if wrong: a later row of their own.
- **R3 — classified by outcome, not by proposal.** The ledger action names what the decider
  proposed (`ap_pay`); `detail.execution.resultingStatus` names what happened. A model's `pay` that
  code refused is an escalation, not a payment.
- **R4 — carried out** = resulting status `paid`, `matched` (sent, awaiting confirmation) or
  `scheduled`; **escalated** = `held`, `flagged` or `awaiting_info`. Any other outcome (a wait that
  leaves the invoice pending) is neither.
- **R5 — agreement is measured on flags only.** A hold or an information request asks a person to
  decide; any answer is consistent with it, so counting them as agreement would only inflate the
  figure. A flag says "do not pay this": a person who rejects the invoice **upheld** it, a person who
  paid it overturned it, and a return to the agent is neither, so it is left out of both. What a
  person resolved is `detail.overrode` on `approval_paid`, else the outcome of the latest agent
  decision on that invoice before the person's entry. Cost if wrong: one row's definition.
- **R6 — on time** = the UTC day of the confirmed Arc testnet payment is on or before the UTC day of
  the invoice's due date (due dates are UTC days). Only payable invoices: milestones carry no due
  date. Only confirmed live Circle payments count, as everywhere on `/open` (an invoice has one payment
  intent; retries are attempts under it, 0036). The period is the payment's time.
- **R7 — no person involved** = no person ever claimed the invoice for a decision
  (`invoices.reviewed_by` is null) and the ledger holds no person's `approval_*` entry for it.
  Entering the invoice or ticking goods received is input, not a decision, so it does not count as
  touching it.
- **R8 — duplicates caught** uses the code's own definition of a confirmed duplicate
  (`isConfirmedDuplicate` in `src/lib/agent/counterparty-history.ts`): the agent's decision tripped
  `invoice.duplicate_of_settled`, or it flagged the invoice with a match against a paid or received
  invoice at confidence ≥ 0.9 (`DUPLICATE_BLOCK_CONFIDENCE`). The invoice must not have been paid
  since (status `flagged` or `rejected`). Weaker model flags do not count: the research note showed
  them to be false alarms. Counted once per invoice, in the period of its first such decision.
- **R9 — sample data and deleted rows drop out**, as on the rest of `/open`: every figure joins to
  an existing invoice or milestone whose counterparty is not sample data.
- **R10 — forecast accuracy is deferred.** Forecasts look 14 days ahead and the first is from
  24 Sep 2026, so none can be scored before 8 Oct; their projected outflow also keeps held invoices
  on purpose (an unresolved obligation is not forgiven), which a plain comparison would score as
  error. Revisit with the research note refresh (I2).
- **R11 — failure isolation.** When `open_outcomes` cannot be read (before 0049 is applied, say),
  the Outcomes table shows dashes and the rest of `/open` still shows, as with
  `open_first_payments`.

## 4. Pieces

- `supabase/migrations/0049_open_outcomes.sql` — the function and its grants.
- `src/lib/platform/open-numbers.ts` — reads `open_outcomes` beside the other two, validates it,
  merges its figures into each side (nulls when unreadable).
- `src/components/open/OpenNumbersTable.tsx` — takes its rows as a prop and gains `percent` and
  "x of y" formats; `/open` renders it twice, Usage and Outcomes.
- `scripts/open-numbers.ts` — prints the new figures with the others (they arrive in the same sides).

## 5. Tests

- PGlite (all migrations): grants; carried out vs escalated by resulting status, including a refused
  pay; treasury entries and sample counterparties excluded; resolutions and the flag rule (paid,
  rejected, returned, `overrode` vs the latest decision); on-time by UTC day, the untouched rule,
  simulated and failed payments excluded; duplicates by both branches of R8 and the not-paid-since
  rule; the period boundaries; customers vs ours.
- Unit: the merge and the fallback when `open_outcomes` fails; the percent and ratio formats.
- Render: the Outcomes table's rows and dashes.

## 6. Rollout

1. Partner runs `npm run db:migrate` from this branch after main is merged into it (0049; additive).
2. Read-only probe: grants; `open_outcomes` equals an independent SQL count for each row.
3. Merge → deploy; `/open` and `npm run numbers` show the rows; record the figures in §7.

## 7. Rollout record

(pending)
