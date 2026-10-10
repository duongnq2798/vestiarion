# Cash scenarios: what if clients pay late

Date: 2026-10-11. Status: decided (autonomy grant 2026-10-05). Roadmap: F19, with I19 (data coverage and the three
biggest drivers).

## Why

A founder asks: if two clients pay 14 days late, can I still pay my contractors on time? Treasury answers part of it.
**Safe to spend today** and **Next 30 days** (`2026-10-02-safe-to-spend-design.md`) count what is already owed against
the wallet and the USYC reserve, and show receivables as expected without counting them. Nothing lets a person move a
receivable, drop one, change what bills cost, or look further than 30 days, and nothing says how much of the picture is
actually known: over 60 or 90 days most bills have not been added yet, so a long forecast looks better than it will be.

## Decisions

Each decision names what it costs if it turns out wrong.

**C1. A folded "What if" section on Treasury, under Next 30 days.**
- No new page, route, server action, write or migration. It is on the Treasury page (`/o/<slug>/console`), right under
  the Next 30 days card, folded until someone opens it. Every member who can read Treasury can use it.
- It is computed in the browser from rows the page already passed, so changing a lever never calls the server.
- Cost if wrong: one more card on Treasury, closed by default.

**C2. One set of rules: the outlook's own.**
- `outlookMoves(input, windowDays)` is taken out of `cashOutlook` (`src/lib/cash-outlook.ts`): open payable statuses
  (`OPEN_PAYABLE_STATUSES`; a held bill counts), a scheduled bill on `scheduled_for`, an overdue one today, open
  milestones today unless escrowed, open USDC receivables (`pending`, `matched`) on their due day, an overdue one today,
  EURC apart. `cashOutlook` calls it with 30 days and returns exactly what it did (its tests are unchanged); the what-if
  calls it with 90.
- Cost if wrong: the what-if and Next 30 days disagree about the same rows.

**C3. Three buckets, kept apart.**
- **Cash**: the operating wallet's USDC and the USYC reserve's, as Safe to spend counts it. The only money counted as
  held.
- **Receivables**: open USDC receivables, already invoiced. They add to the what-if's balance only on the day they arrive
  in that case, and are shown as their own figure.
- **Pipeline**: deals not invoiced yet. The workspace keeps no record of them, so this version counts none and never
  makes one up; the section says only invoiced receivables are counted.
- Bank balances: Vestiarion holds none, so nothing from a bank is ever added to or taken from a USDC figure. EURC bills
  and receivables are paid from and into the EURC balance: listed as left out, never converted, never summed with USDC.
- Cost if wrong: money expected reads as money held.

**C4. A horizon of 30, 60 or 90 days, and recurring payments projected.**
- 60 days by default. The base case is every row the outlook counts, within the horizon, plus each active recurring
  payment's periods not billed yet, from its schedule (`dueOn` from `next_period`; a period whose invoice exists is
  skipped; one already due counts today, as an overdue bill does; EURC schedules are left out). Their amount and day are
  known; their invoice is created up to 7 days before each due day, so over 60 or 90 days most of them are not billed
  yet.
- This is the one way the base case differs from Next 30 days, which counts only bills already created. Each projected
  payment is marked "recurring, not billed yet", and the coverage counts them apart.
- The one new read on Treasury is the recurring schedules (`listRecurringPayables`), best effort: if it fails, the
  coverage says they could not be read and none is projected.
- Cost if wrong: the base case differs from Next 30 days by the recurring payments, said on each.

**C5. The levers: what a person sets, never a probability.**
- **Clients pay late by** N days (0 to 90, 14 by default). Each receivable in the horizon is **Late**, **On time** or
  **Never arrives**; every one is Late until someone changes it. Late counts from the due day, or from today for one
  already overdue. One that lands after the horizon is out of it.
- **Bills cost** P% more (from −50 to 100; a minus is less), on **Every bill** or on **Bills written in another currency**
  (shadow mode bills taken in the business's own currency, whose USDC amount was worked out at a rate). Milestones keep
  their amounts: they are agreed in USDC.
- Nothing is weighted by how likely it is. The client records in the coverage (C8) are counts and an average, to help
  pick a number, not a prediction.
- Cost if wrong: a person reads a lever as a forecast; each is a plain setting with its words beside it.

**C6. What it works out.**
- Every day of the horizon, the balance after that day's movements, in the base case and in the scenario: cash, less
  bills, recurring payments and milestones on their days, plus receivables on the day they arrive in that case.
- The first short day (the balance below zero), the first day below the cushion, the lowest balance and its day, for
  both cases. The cushion on a day is 15% of what leaves in the 7 days from it: the treasury's 1.15 buffer. On today it is
  exactly Safe to spend today's cushion.
- The bills that fall due while the scenario's balance is below zero, and how much is missing at its lowest.
- Cost if wrong: a wrong day; the engine is pure and tested day by day, including a single due day moved.

**C7. Suggestions are advice, in words, from fixed rules.**
- At most three, only when the scenario runs short: how much USDC the wallet would need by the short day; a bill
  scheduled before its due day, paid before the short day, that could be paid on its due day instead (with the
  early-payment discount it was scheduled for lost); the receivable whose arrival would matter most for the short day.
- No button, no link to an action. The words "borrow", "loan", "credit", "invest" and "sweep" never appear in the
  section (a test reads the source). A short day is not an instruction to borrow or to invest, and the what-if moves no
  money.
- Cost if wrong: a what-if reads as an order.

**C8. Coverage and the three biggest drivers (I19).**
- **What this is built from**: bills (count, amount, the latest due day), recurring payments projected, milestones with
  no payment day (counted today), receivables and how many come from clients with a payment record, and what is left
  out (EURC). Its badge, **Bills known for N of H days**, counts from today to the latest bill's day. A sentence says
  bills not added yet are not counted, so later days may look better than they will be.
- Client records come from the workspace's received receivables (`settled_at` against `due_date`, in UTC days), the
  rule collections uses: paid on time, paid late, the average days late. Counts only; no percentage, no likelihood.
- **What moves it most**: on the scenario's short day, or its lowest day when it never runs short, the three sources that
  pull the balance down most, grouped by counterparty: bills, recurring payments and milestones paid by then; a
  receivable the scenario moves past that day or drops; and the change in bill costs as one source.
- Cost if wrong: coverage read as a score. It is a list of counts.

**C9. Nothing feeds payments, the agent or a guardrail.**
- Pure functions (`src/lib/cash-scenarios.ts`, `src/lib/cash-scenario-basis.ts`), run on the page and in the browser.
  No server action, no write, no ledger entry, nothing the cycle reads. Safe to spend today, the treasury's buffer, cash
  holds and every guardrail still count no receivable.
- A test reads every file under `src/lib/agent`, `src/lib/commands` and `src/app/actions` and fails if one imports
  either module.
- Cost if wrong: an expected payment becomes money a payment is allowed to use.

**C10. It recomputes from the rows each time.**
- Treasury re-reads every 20 seconds (`AutoRefresh`). The section derives its result from the rows and the levers on
  every render (`useMemo`), never from a copy kept in state; the levers stay. A bill whose due day moves moves its day;
  a receivable that is paid or removed drops out, and its choice with it.
- Cost if wrong: a stale answer after a change; tested by moving one due day.

## Not now

- A pipeline of deals not yet invoiced, with its own records (a table, so a migration).
- Lateness per client from its own history as a lever; a probability per client needs far more history than a small
  business has.
- Saving or sharing a scenario; the chats' `/today`.
- FX on EURC: EURC bills are paid from the EURC balance.

## Testing

- `tests/cash-outlook.test.ts` unchanged: the 30-day outlook is the same.
- `tests/cash-scenario-basis.test.ts`: the 90-day window with the outlook's rules, recurring periods projected (billed
  ones skipped, EURC left out, past ones today), client records, EURC apart.
- `tests/cash-scenarios.test.ts`: the base case equals Next 30 days on the same rows; late, on time and never; late from
  today for an overdue receivable; past the horizon; cost changes on every bill or on bills in another currency; short
  day, cushion day, lowest point, bills affected; one due day moved; suggestions and their rules; the three drivers;
  coverage; no receivable counted before it arrives.
- `tests/cash-scenarios-ui.test.tsx`: the section's words and states; its copy has no instruction to borrow or invest;
  no module that moves money imports the scenario modules; the console renders it under Next 30 days.
- The guide `content/docs/guides/cash-scenarios.mdx`, with its quotes pinned in `tests/docs-guides.test.ts`, and a
  screenshot from `/docs-shots/cash-scenarios`.
