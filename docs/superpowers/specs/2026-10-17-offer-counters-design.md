# Suppliers counter the agent's early-payment offers (design)

Builds on [the agent's early-payment offers](2026-10-16-agent-early-payment-offers-design.md). There, the agent asks a
supplier for a discount for paying today, and the supplier accepts or declines. Here, a supplier may also propose a
smaller discount. The agent then answers the counter itself, within bounds code sets, and emails the answer.

## Requirements

- **N1 Who may counter.**
  - The supplier's page offers a third answer, **Propose a smaller discount**, on an offer the agent made. The discount
    must be from 0.1% to just under the one offered.
  - An offer a person made keeps Accept and Decline only: the agent does not negotiate a person's terms.
- **N2 The counter, in one step.** `counter_early_payment_offer(token, pct)` needs all of these:
  - the offer is open and not expired;
  - the agent made it;
  - the discount is lower than the offer's.

  The offer becomes `countered` and keeps `counter_pct`. The ledger records `early_payment_offer_countered`, a cycle
  starts at once, and the link works no more. The supplier reads "Sent. *Business* answers you by email shortly."
- **N3 What code allows.** The early-payment offers stage answers each countered offer before it makes new ones.
  Accepting needs all of these:
  - the agent's offers are still on;
  - the bill is still eligible (E1);
  - the counter is more than the reserve would earn on the cash by the due date (the break-even);
  - the operating USDC left for offers (AO2) covers what the supplier would receive.

  Otherwise code declines it, and no model is asked.
- **N4 The decision.**
  - The model answers `accept | decline` with its reasoning. It is given:
    - the bill;
    - the offer and the counter;
    - the break-even;
    - what the supplier did with earlier offers;
    - the cash.
  - The written policy accepts what code allows, and is the reference and the fallback.
- **N5 The answer, in one step.** `answer_early_payment_counter(org, offer, accept)` answers only a countered offer.
  - **Accept:** the bill gets the counter as its discount, ending today, and returns to pending. The offer becomes
    accepted at the counter, with what the supplier now receives. The agent pays it at the next cycle, started at once,
    after every check.
  - **Accept, but the bill changed:** nothing changes.
  - **Decline:** the offer becomes declined.
  - The ledger records `early_payment_counter_accepted` or `early_payment_counter_declined`, with the decision.
- **N6 The supplier is told.**
  - The answer goes once to the supplier's notice email, under the offer's own idempotency key, in a fixed template:
    - "*Business* accepted your *pct*%: it pays you *amount* today, once its usual checks pass."
    - "*Business* keeps the original terms: your invoice is paid as planned, on its due date."
  - A failed email is logged. The answer stands.
- **N7 On Bills.**
  - A countered offer reads "*Supplier* proposed *pct*% instead. The agent answers it at its next cycle.", with no
    Withdraw.
  - The decided list says "accepted *pct*% off, after a counter".

## Storage (migration 0127)

- `early_payment_offers.status` adds `countered`. It is widened only while the check lacks it, so a re-run never narrows it.
- New column `counter_pct` (0.1 to 10).
- New functions, service role only:
  - `early_payment_offer_by_agent(p_token_hash)`: whether an open offer was made by the agent, so the page shows the counter;
  - `counter_early_payment_offer(p_token_hash, p_pct)`;
  - `answer_early_payment_counter(p_org_id, p_offer_id, p_accept)`.
- The functions of 0125 are untouched, so a re-run of 0125 never meets a changed signature.
