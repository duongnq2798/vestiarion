# Activation funnel

Date: 2026-10-09. Status: decided (autonomy grant 2026-10-05). Roadmap: FN1 (tameion-roadmap).

## Why

On 2026-10-09 a one-off read-only query of production showed how far the customers' workspaces got: six opened, four
added a real bill, four got the agent's decision on it, three paid, none paid on a second day, and none had a second
person. That was the most useful number of the day, and nothing in the product could repeat it: /open counts payments
and people, not how far each workspace got. The team needs it every few days to see whether its calls and fixes move
anyone past the step where they stop.

## Decisions

**F1. One database function, aggregates only.** `open_funnel(p_since, p_network)` (migration 0089), security definer,
the service role's alone, like `open_verdicts`. It counts the workspaces of one network opened since the period's start,
split as every open number is (customers when the creator is not on the team, ours otherwise, and the total), and for
each how many reached a step. No workspace, slug or person leaves it.

**F2. The steps.**
1. Opened.
2. A real bill: a payable whose counterparty is not sample data.
3. The agent's decision on one: an agent ledger entry with an AP decision action about such a bill.
4. A confirmed payment: a live Circle payment intent, confirmed, for such a bill or for a milestone whose contractor is
   not sample data. A simulated payment never counts.
5. Payments on two UTC days or more: the same payments, counted by day (`executed_at`, else `confirmed_at`, else
   `updated_at`, as 0049).
6. A verdict in shadow mode.
7. Two people or more in the workspace.
Steps 2 and 3 nest; the others need not (a milestone is paid with no bill), so the printed drop is shown only for
steps 2 to 4 and never as a negative.

**F3. Read by `npm run numbers` only.** `src/lib/platform/funnel.ts` validates the document and lays it out as rows;
the script prints it per network after the open numbers, apart, so a database without 0089 still prints the rest and
says the migration adds it. /open does not show it: whether to publish it is the partner's call.

## Not now

- The funnel on /open.
- Per-workspace detail (it would cross the workspace boundary the DAL keeps; a one-off read-only query does that job).
- Time between steps.

## Testing

- `tests/open-funnel-migration.test.ts` (PGlite): each step on seeded workspaces, sample data and simulated payments
  left out, the period, each network apart, the service role only.
- `tests/funnel.test.ts`: the RPC call, validation, the rows and their drops.
