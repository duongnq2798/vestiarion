# Project budgets and the money set aside for each project

Date: 2026-10-13. Status: decided (autonomy grant 2026-10-05). Roadmap: F24, with I23 (the same purchase order or
deliverable on a bill and a milestone is one obligation). Builds on deals (`2026-10-12-deal-schedule-design.md`), deal
costs (`2026-10-13-deal-cash-readiness-design.md`), the payment plan (`2026-10-11-payment-plan-design.md`) and the
agent's spending limit (`2026-10-02-outflow-budget-design.md`). Migration 0111.
Pictures: `project-budgets-shots/`, from the flag-gated `/docs-shots/projects/<state>` (`DOCS_SCREENSHOTS=1`).

## Why

Several projects share one treasury, so the same balance gets promised to several places. A project gives one job,
client or launch its own budget, and the agent sets each bill's money aside in it before paying it, so two projects, or
two decisions at the same moment, never spend the same money.

## What it is, and is not

- **An earmark in the application.** Not escrow, not locked on chain. The treasury stays one pool; the spending limit
  contract on Arc still enforces only the workspace-wide caps; every payment still needs its cash when it is sent. Every
  page that shows a budget says so (`EarmarkNote`), and so do the guide and the controls guide.
- **USDC.** A project counts bills in USDC and milestones; a EURC bill cannot be put in one. A deal in any currency can
  be; its collected revenue in another currency is shown apart, never added.

## Decisions

- **P1 Projects.** A name (one active name per workspace), `budget_minor` and `buffer_minor` in USDC cents, the buffer
  within the budget, `active` or `archived`. Made and changed by `agent.budget` (owner, admin), as the agent's spending
  limit; archived only once nothing open is left in it.
- **P2 Changes keep what is set aside.** Lowering a budget below what is reserved and paid makes the project over; the
  agent then sets nothing more aside in it. Nothing already reserved is undone.
- **P3 Membership.** `invoices.project_id` (payables in USDC only), `milestones.project_id`, `deals.project_id`, set
  from Bill to pay, Add milestone, or the project's page (`project.assign`, `records.write`). A bill paid or being paid
  (`paid`, `matched`, `processing`), or a paid milestone, keeps its project.
- **P4 Reservations, serialized.** `reserve_project_budget` locks the bill or milestone, then the project's row, and
  counts reserved and paid in one statement, then inserts only when the budget less its buffer holds the full amount
  (to the cent above). A trigger on insert takes the same locks, in the same order (the bill or milestone, then the
  project), and makes the same check, so no path overspends and no two paths deadlock; one live reservation per bill and
  per milestone. Reserved at entry, at assignment, and by the agent when it decides to pay or
  schedule. A person's own payment reserves nothing and is not held by the budget; it counts as paid.
- **P5 The guardrail, `project.budget_exceeded`.** After every existing guardrail, for a pay, schedule or release they
  let through, the agent reserves; `over`, `archived` or a failed call holds it for a person, with the figures. It only
  holds: `afterGuardrails` returns any blocked result unchanged, and a bill in no project is never asked about. The
  reservation comes before the shadow hold, the cash check and the transfer, so a bill the budget holds still waits for
  cash as before; a hold the model decides reserves nothing, and a release then held for want of cash keeps what it set
  aside, found again when it is decided.
- **P6 Release.** In the transaction that changes the bill or milestone: paid (now counted as paid, at `paid_amount`),
  rejected, closed, amount changed, moved. The follow-up reopens a payment held for its project once the project has room
  or it left the project (`execution.heldBecause: "project_budget"`).
- **P7 Figures.** Budget, set aside, paid, available, over; commitments covered (the open bills and milestones, by
  amount, that hold a reservation); payments held for the budget now and in 30 days, from the agent's entries; collected
  revenue from the project's deals (`dealCollection`).
- **P8 Per project views.** The project's lines of the 14-day payment plan (the whole treasury's plan, filtered: days and
  balances stay the treasury's), and the treasury it shares (cash, what every project set aside, this project's share,
  what it pays in 14 days). Treasury lists each project's money set aside.
- **P9 The same work, `obligation.duplicate_reference`.** A bill and a milestone are one obligation when they name the
  same purchase order for the same payee (`milestones.po_reference`, new; one written as none, such as N/A, TBD or 0,
  names no order), or link the same delivered work (a URL in the bill's memo equal to the milestone's verification
  source, but for its scheme, `www.`, a trailing slash and tracking parameters, so two documents behind one page stay
  two; GitHub pull requests compared by number). The second
  entered waits for a person; the first goes as usual. A rejected bill or closed milestone counts for nothing. Runs after
  every other guardrail, before the project's budget, so a held duplicate reserves nothing. A person pays it when both are
  owed. Two bills are `findDuplicates`'s, unchanged.

## Concurrency proof

A test database (PGlite) runs one transaction at a time, so it cannot race. `npm run fixture:project-budget`, against a
throwaway Postgres on the same machine, races ten deciders on ten connections, each holding its transaction open after
reserving: exactly the four 200.00 bills a 1,000.00 budget with a 100.00 buffer holds are reserved, six are over, every
decider after the first waited on the project's row, and the same race through a check-then-insert with no lock sets
aside 2,000.00. It then pays a reserved bill while another decider reserves (counted once), and rejects one to free room
for the bill that was over. Last, an insert that skips the function arrives while the function holds the same bill:
both lock the bill before the project, so the insert waits and is refused as a second live reservation rather than
deadlock. The AP stage's own test (`tests/project-ap-stage.test.ts`) shows the cash side: a bill the
budget holds and the cash does not still waits for cash, and reserves nothing.

## Screenshots

From `/docs-shots/projects/<state>` in a production build, headless Edge, at 1440 and 390 px wide:

- `01-projects-list`: every project, one with a bill held for its budget, one on track, one a person paid past its
  budget; the earmark note; Treasury's Projects card.
- `02-project-page`: Website rebuild's figures, its bills and milestones, its days in the payment plan, the treasury it
  shares, its deal, and Add to this project.
- `03-held-for-budget`: the launch video held for the project's budget, in Approvals and on its card.
- `04-same-work`: a bill naming the same purchase order as a verified milestone, held for a person.
