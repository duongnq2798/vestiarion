# Early-payment offer results, and offers kept covered (design)

Builds on [early-payment offers](2026-10-16-early-payment-offers-design.md), [the agent's offers](2026-10-16-agent-early-payment-offers-design.md)
and [counters](2026-10-17-offer-counters-design.md).

## Requirements

- **R1 What the offers came to.** **Pay early for a discount** on Bills says, once a workspace has made an offer:
  - how many offers were made, and how many of those by the agent;
  - how many were accepted, and how many of those after a counter;
  - how many were declined;
  - what the bills paid early saved: their amounts less what was paid. It is shown as an amount and as a yearly rate on the cash paid early, weighted by how many days before the due date each one went.

  It reads the workspace's last 60 offers (`offerResults`, `offerResultsLine`).
- **R2 Offers kept covered.** At each cycle, the early-payment offers stage first checks the cash. It takes the operating USDC left after the cycle's payments and subtracts what falls due within 7 days. While that no longer covers every open offer, the agent withdraws its own open offers, the largest first, until it does.
  - Each withdrawal is signed: `early_payment_offer_withdrawn` with `via: "agent"`, `reason: "cash"`, the amount offered and the cash that covered.
  - A person's offer is never withdrawn by the agent.
  - The supplier's link then says it is no longer valid.
  - That bill is not offered again, since a bill that had an offer is never offered by the agent (AO2).
- **R3 No migration.** Everything reads the tables of migrations 0125-0127.
