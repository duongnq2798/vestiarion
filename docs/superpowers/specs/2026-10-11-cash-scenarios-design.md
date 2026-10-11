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
- No migration: 0096, reserved for this feature, stays unused.
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
- Bank balances: Vestiarion holds none, so nothing from a bank is ever added to or taken from a USDC figure, and the
  section says "No bank balance is counted." beside the cash it counts. EURC bills
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
  exactly Safe to spend today's cushion, unless a recurring period not billed yet falls within those 7 days (its bill
  is created up to 7 days before, so only one created late does).
- The bills that fall due while the scenario's balance is below zero, and how much is missing at its lowest.
- The base case assumes every receivable arrives on its due day (an overdue one today). It is named by that
  assumption, **If clients pay on time**, never "as things stand", with a line under it: "Each receivable on its due
  day, an overdue one today. Next 30 days counts none." Next 30 days, right above, counts no receivable, so it can say
  the wallet runs short on a day this case does not; the scenario with every receivable set to Never arrives is Next
  30 days' own balance (tested).
- Cost if wrong: a wrong day; the engine is pure and tested day by day, including a single due day moved.

**C7. Suggestions are advice, in words, from fixed rules.**
- At most three, only when the scenario runs short: how much USDC the wallet would need by the short day; a bill
  scheduled before its due day, paid before the short day, that could be paid on its due day instead (with the
  early-payment discount it was scheduled for lost); the receivable whose arrival would matter most for the short day.
- The scheduled bill is advised only when it helps. For each candidate the scenario is worked out again with the bill
  paid on its due day (out of the horizon when that is past it); it is advised only when the short day then comes
  later or the gap at the lowest is smaller, and the advice says which: "the balance runs short on X rather than Y",
  "the wallet needs A more by Y rather than B", or that it no longer runs short within the horizon. Of several, the
  one that leaves the smallest gap, then the latest short day. Moving a bill later can only raise the balance between
  the two days, so the gap never grows; a bill that only moves its amount to a day that is short anyway is not advised, since following
  it would lose the discount for nothing (tested with the guide's studio, Northwind Cloud due on day 20: the gap of
  1,309.50 stays; due on day 25, after a receivable arrives, it falls to 449.50, which the guide shows).
- No button, no link to an action. The words "borrow", "loan", "credit", "invest" and "sweep" never appear in the
  section (a test reads the source). A short day is not an instruction to borrow or to invest, and the what-if moves no
  money.
- Cost if wrong: a what-if reads as an order.

**C8. Coverage and the three biggest drivers (I19).**
- **What this is built from**: bills (count, amount, the latest due day), recurring payments projected, milestones with
  no payment day (counted today), receivables and how many come from clients with a payment record, and what is left
  out (EURC). The latest due day is a scheduled bill's own due day, not the day it is scheduled for.
- Its badge, **Bills on record in N of W weeks**, counts the weeks from today (the last one may be short: 5, 9 or 13
  weeks) in which a bill or recurring payment leaves. A milestone has no day, and a bill or recurring period due before
  today (by its own due day, so a held or scheduled one too; the basis marks it `overdue`) leaves today but says
  nothing about the days ahead, so neither fills a week. Measured by weeks, not by the latest bill's day, so one far bill (an annual insurance bill
  entered early) fills one week, not the horizon. Fewer than half the weeks puts the badge in the held tone. A sentence
  says bills not added yet are not counted, so the weeks with none on record may look better than they will be.
- Client records come from the workspace's received receivables (`settled_at` against `due_date`, in UTC days), the
  rule collections uses: paid on time, paid late, the average days late. Counts only; no percentage, no likelihood.
- **What moves it most**: on the scenario's short day, or its lowest day when it never runs short, the three sources that
  pull the balance down most, grouped by counterparty: bills, recurring payments and milestones paid by then; a
  receivable the scenario moves past that day or drops; and the change in bill costs as one source.
- A client's receivables are grouped by its counterparty id (a receivable with no client stands alone), never by the
  name shown, so two clients sharing a name stay apart. Each group keeps how many never arrive, how many arrive after
  the horizon, and the latest day the rest arrive, and is worded to match: "2 receivables that arrive by Oct 21", or
  "2 receivables: 1 arrives on Oct 21; 1 never arrives".
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
  ones skipped, EURC left out, past ones today), a bill or period due before today marked `overdue` by its own due day
  (held and scheduled ones too), client records, EURC apart.
- `tests/cash-scenarios.test.ts`: the base case equals Next 30 days' balance with receivables expected, and the
  scenario with none arriving equals its balance and short day; late, on time and never; late from today for an
  overdue receivable; past the horizon; cost changes on every bill or on bills in another currency; short day, cushion
  day, lowest point, bills affected; one due day moved; suggestions and their rules (a scheduled bill only when moving
  it helps, the one that helps most); the three drivers (a client's receivables together by its id, two clients with
  one name apart, each group's arrivals kept); coverage (weeks with a bill on record, one far bill filling one week, a
  scheduled bill's due day as the latest); no receivable counted before it arrives.
- `tests/cash-scenarios-ui.test.tsx`: the section's words and states; its copy has no instruction to borrow or invest;
  no module that moves money imports the scenario modules; the console renders it under Next 30 days.
- The guide `content/docs/guides/cash-scenarios.mdx`, with its quotes pinned in `tests/docs-guides.test.ts`, and four
  screenshots from `/docs-shots`: `cash-scenarios` (the levers, drawn with `outcome={false}`), `cash-scenarios-cases`
  (`ScenarioCases`), `cash-scenarios-findings` (`ScenarioFindings`) and `cash-scenarios-coverage` (`CoverageList`).
  One picture of the whole open section is too large for the guides' 250 KB limit.
