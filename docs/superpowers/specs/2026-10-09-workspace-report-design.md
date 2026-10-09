# Workspace report

Date: 2026-10-09. Status: decided (autonomy grant 2026-10-05). Roadmap: IR1 (tameion-roadmap).

## Why

A business that runs its bills through Vestiarion has no single place that says what the agent did for it: how many
bills it handled, how fast it decided, what it paid and with what proof, what it stopped and why, how often a person
had to step in, and what an early-payment discount actually saved. The console shows today's cards; Insights shows
cycle telemetry; the audit log shows every entry. None of them answers "what did I get from this?".

A business in shadow mode also has no way to see what is left before it trusts the agent with a slice of real USDC.

The report answers both from facts the workspace already records. It is also what a founder walks through on a call
with a business, and what the business would show to someone else.

## Decisions

**R1. A workspace section, "Report", for every member.**
- `/o/<slug>/report`, in the Overview group after Insights. Every member may read it (`requireMembership`), as they
  may read the audit log.
- No migration, no new write. It reads the workspace's own rows inside its organization scope.
- Cost if wrong: one more section in the navigation.

**R2. What counts.**
- Bills: the workspace's payables whose counterparty is not sample data (as /open counts them, 0037 and 0049).
- The agent's decisions: ledger entries by the agent with an AP decision action (`AGENT_DECISION_ACTIONS`) about one
  of those bills.
- Payments: a bill's confirmed live Circle payment (`payment_intents`: invoice, provider circle, provider_mode live,
  status confirmed). Its amount is what the transfer carried; its transaction hash links to the explorer of the
  workspace's network.
- Everything since the workspace opened. No period picker in this version.

**R3. Every figure says what kind of figure it is.**
- Counted: bills, decisions, payments, holds, people's actions, verdicts. Read from the ledger and the transfers.
- On Arc testnet a payment is test USDC: the page says no real money moved. On Arc mainnet it is real USDC.
- In shadow mode a payment mirrors a bill the business paid itself in its own currency. A payment counts as a mirror
  when its deciding decision was made in shadow mode (`detail.shadow`), carries a verdict, or was made while shadow
  mode was on. The page says so above the figures, and each mirrored payment row is tagged.
- The one estimate is the early-payment discount on offer: the sum of amount × percent over bills with valid terms
  (`invoiceDiscount`). It is labelled "on offer, from the bills' terms".
- The discount captured is measured: for a paid bill with discount terms, the bill's amount minus what its confirmed
  transfer carried, when that is above zero. Never a model's claim, never a ledger summary.
- Nothing on the page says "saved" except the captured discount.

**R4. The figures.**
- Bills handled; decided by the agent, with the median minutes from a bill being added to its first decision.
- Paid on Arc: count, sum per currency, and how many on or before the due day (UTC), as 0049 counts on time.
- Stopped before paying: bills whose newest agent decision held, flagged or asked for information, split into
  refused by code (`guardrailBlocked`), held for an operational reason (`heldBecause` cash, pause or budget), and the
  agent's own call. A decision held for a verdict in shadow mode is not a stop.
- Needed a person: bills a person approved, rejected or returned (`approval_paid`, `approval_rejected`,
  `approval_returned`); paid with no one stepping in: paid bills with no such entry and no reviewer.
- Verdicts: agreed and disagreed, and the bills whose newest decision waits for one (only when any verdict exists or
  shadow mode is on).
- Early-payment discounts: captured (measured) and on offer (estimated).

**R5. Two lists.**
- What it stopped: the newest ten stopped bills: day, payee, amount, the reason in plain words (the guardrail rule's
  words, the hold's marker, or the first sentence of the agent's reasoning), and what happened since (paid by a person,
  rejected, still open).
- Payments and their proof: the newest ten payments: day, payee, amount (and the bill's own amount when it was in
  another currency), who decided (the agent alone, a person, or a verdict in shadow mode), and the transaction.
- Both link to the audit log for the rest.

**R6. Before a live slice (shadow mode only).**
Shown while shadow mode is on. Suggestions, said as suggestions, each with its state from the same reads:
1. Verdicts on at least five decisions (n of 5).
2. No decision waiting for a verdict.
3. Suppliers paid at their own address: the count of suppliers paid at a mirror address, which a live workspace
   cannot use; done when there are none.
4. A workspace on Arc mainnet for the slice: links to the shadow mode guide; the page does not open it.
The page never moves money, opens a workspace or changes a setting.

**R7. Failure.**
A read that fails shows the page's error state (`error.tsx`), as the audit log does: a report with missing rows would
understate what happened.

## Not now

- A public, shareable copy of the report (SM4). It needs a link table (a migration) and the business's consent per
  link. The report's facts are built so that copy can reuse them with names hidden.
- A period picker and CSV export of the report (the audit export already exports every entry).
- Contractor milestones in the figures.

## Testing

- `tests/workspace-report.test.ts`: the pure function over hand-made rows: sample bills left out, mirror tagging,
  stop classification (code, operational, agent, verdict hold excluded), on-time, captured vs on-offer discount,
  median time to decision, readiness states.
- `tests/navigation.test.ts` and the docs tests keep the new section, its guide and its quoted labels in step.
