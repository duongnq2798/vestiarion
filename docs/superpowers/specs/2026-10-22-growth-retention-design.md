# Retention by week on the founder dashboard

Date: 2026-10-22. Status: accepted.

## Why

The founder dashboard (`/admin/growth`) counts how fast a workspace reaches its first decision and whether a second real
bill follows within 7 days. Both look at a workspace's first days only. Whether a business keeps using Vestiarion week
after week is the question that matters after the first decision, and the dashboard cannot answer it today.

## What

**R1. What counts as active.**
- A workspace is active in a week when something real happened in it:
  - a real bill was added (a payable whose counterparty is not sample data);
  - or a person decided a payment: approved, rejected or returned it to the agent, or gave a shadow-mode verdict
    (`approval_paid`, `approval_rejected`, `approval_returned`, `decision_verdict` by a person).
- It is read from each workspace's own records, in its own scope, a few workspaces at a time.
- A workspace whose records cannot be read is left out of the table, and counted under it.
- No migration.

**R2. The table.**
- One row per UTC week, from Monday, that workspaces opened in, oldest first. It shows the number of workspaces and
  columns for week 0 to week 7.
- A workspace's week k is the 7 days from its opening plus 7k days, so each workspace has the same time to come back.
- Each cell is the share of the cohort's workspaces active in their week k, out of those whose week k has begun, with
  the count beside it:
  - a week none has reached is a dash;
  - one still running for some workspace says "so far".
- It follows the dashboard's window ("Since") and the Workspaces table's side, customers' or ours.
- The Definitions section says all of this.

## Not in this change

- Activity from the API or a connector by itself.
- Revenue retention.

## Tests

`tests/growth-retention.test.ts`:
- the week of an instant;
- cohorts and cells, including a week not reached and one still running;
- activity outside a week not counted;
- the reader's two queries per workspace, and a workspace that could not be read.
