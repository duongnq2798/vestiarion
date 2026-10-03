# Showing what the agent does, and where to handle what it stopped

Date: 2026-10-03. Status: implemented on `feat/agent-activity`. Asked for by the partner after testing #153 and #154.

## 1. The problem

Most of what the agent does starts from a person's action: an invoice added, details added, a payable returned, an
address confirmed. The cycle starts within seconds and decides within a minute, but the page says nothing while it
runs and nothing when it ends. The only sign is a row that moves at the next 20-second refresh. In the #153 test the
agent reopened a payable, asked the model, checked the spending-limit contract on Arc and paid, in 28 seconds, and the
person saw none of it happen.

The console's **Stopped** section shows the latest decisions the agent stopped, with the rule that stopped them, and
offers nothing to do about them: a person has to know that Approvals, Counterparties or the spending limit is where the
way through is.

## 2. Rulings

- **R1 — the frame says when the agent works.** Every workspace page's frame, which said when the last cycle ran, now
  reads "The agent is working · *n* s" while a cycle runs (a `cycle_runs` row still `running`, started within the
  in-progress window), and when the last cycle completed otherwise, in UTC so the server and the browser say the same.
- **R2 — each decision is told as it lands.** Once a cycle has decided, the page raises a toast per decision: what the
  agent did, to whom, for how much ("Paid Jiren 0.30 USDC.", "Held CME 0.33 USDC for you.", "Code stopped paying …
  (rule)."), **View on Arcscan** for a transaction, and a button to the page that shows or handles it — Approvals at
  the payable's card for a stop. More than two decisions are told as one ("The agent made *n* decisions."), whose
  **See them** opens the console's report of the cycle. A treasury hold, which every cycle records, is not told. The
  page reads its data again at once.
- **R3 — told only what happens while the page is open.** A page starts at the ledger's head when it opens; nothing
  older is told. It also tells what the schedule's cycle or another member's action decided while it is open.
- **R4 — cheap to ask.** `GET /api/agent/activity?org=<slug>&since=<seq>` (members only, never cached) reads the
  running cycle, the ledger head and the last cycle's time, and the decisions after `since` only when there are any.
  A page asks every 3 seconds while a cycle runs, or for 90 seconds after a person's successful action (any form, and
  **Run cycle now**), every 20 seconds otherwise, and not while the tab is hidden. It is not part of `/api/v1`.
- **R5 — a stopped payable says what to do, and where.** Its card on the console, as on AP / AR, names the cause and
  the way through, with **Decide in Approvals** (owners, admins and approvers), which opens Approvals at the payable's
  card, and for owners and admins the page that removes the cause: **Edit limit** and **Confirm address** open the
  counterparty's row on Counterparties, **Review screening** opens Compliance, **Spending limit** the agent's spending
  limit on Treasury, **Treasury** a wallet short of EURC or a Gateway balance short of a payout. A rule only a decision
  resolves (a duplicate, a payout fee above 10%, no rate) says so and offers Approvals. A payable the model stopped for
  a missing purchase order or goods receipt offers **Add details** (complete held invoice). A link to a counterparty's
  row opens the row.
- **R6 — no popup, no email.** The wait is a minute. A toast is read where the person already is, and the frame and
  the card keep saying it after the toast is gone.

## 3. Rollout

1. Merge. No migration.
2. In testnet-2, add a payable: the frame reads "The agent is working" within seconds, then a toast says what the agent
   decided, and the page shows it without a reload. On the console, a stopped payable's card offers its next step.
