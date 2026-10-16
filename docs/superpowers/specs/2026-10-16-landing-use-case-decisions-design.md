# Landing use cases: the agent's decision beside each story

Date: 2026-10-16. Branch `feat/usecase-decision-cards`. This changes the card beside each tab of "Who it's for" on `/`
(`2026-10-11-landing-clarity-design.md` U1).

## What was wrong

Each tab tells a story in three checked steps. The card beside it showed only:
- a payee and an amount;
- a status (Paid, Held for you, Scheduled);
- one short sentence.

So it read as a payment receipt, not as the work of an agent that checks a bill before money moves. A first-time
visitor saw the outcome, but not what the agent checked to reach it, nor that a rule in code, not the model, can stop a
payment.

## Decisions

- **UD1 — A decision, not a receipt.** Each card now has:
  - "Example decision" with its status at the top;
  - the payee, what the bill is for and the amount;
  - "What the agent checked", with each check passed (a tick) or failed (a cross, in held amber, the words in ink);
  - a band with "Decision:" and why, tinted by the outcome: proof green with a shield-check, held amber with a
    shield-cross, or the ground's tone with a calendar for a scheduled payment;
  - a link to How the agent decides (`/how-it-decides`).
- **UD2 — Each case ends its own way.**
  - Software agencies: paid. Pull request merged, amount matches the milestone, not paid before, within the
    contractor's limit.
  - Creative studios: held for you. Amount and approval pass, but the bill is above the freelancer's 5,000 USDC limit:
    "Blocked by code, not by the model. A person decides it in Approvals."
  - Cloud & DevOps: scheduled. Matches purchase order PO-2210, service received, not a repeat. Set to pay on the
    discount's last day, to take 2% off, and never after the due date.
  - Web3 studios: paid. Bounty attached with /bounty 250, pull request 184 merged, within your daily limit; the
    transaction is posted on the pull request.
- **UD3 — Every check is one the product runs.** Each check restates a step on the left, which were checked against
  the guides on 2026-10-11, and the rules behind them:
  - the payee's payment limit (`counterparty.payment_limit`);
  - a bill already paid (`invoice.duplicate_of_settled`);
  - the purchase order and goods receipt (`invoice.match_incomplete`, guides/first-payment);
  - the early-payment discount's deadline (guides/first-payment);
  - a milestone verified by a merged pull request or a person (guides/pay-a-contractor);
  - bounties within the daily limit (guides/github).
- **UD4 — The card is read, not only seen.**
  - The old card was hidden from screen readers. The new one is a labelled group ("Example decision: Northwind Dev").
  - Each check says ": passed" or ": failed" to a screen reader, so a cross is never told by colour alone.
  - The section's note that payees and amounts are examples stays.

Rejected:
- "Payment permitted" and "Payment confirmed on Arc" from the review's sketch: the product says Paid, Held for you
  and Scheduled, and a sample shows no real payment.
- A dark card: the page has one dark section, Safety.

## Checked

`tests/landing-use-cases.test.tsx`:
- one decision per case, in order, each with its status, amount, every check with passed or failed, its decision and
  the link;
- the four outcomes are Paid, Held for you, Scheduled, Paid;
- a held decision has a failed check and says "Blocked by code, not by the model.", and every other decision has none;
- the examples note stays.

Headless Edge at 1440 and 390 px for each of the four tabs: no horizontal overflow, and the card stands about as tall
as the story beside it.
