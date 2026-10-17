# Early-payment offers in a sandbox (design)

Builds on [the agent's early-payment offers](2026-10-16-agent-early-payment-offers-design.md) and
[counters](2026-10-17-offer-counters-design.md). Until now, the agent made no offers in a sandbox (AO1), because a
sandbox's suppliers are sample data with no address. So nobody trying the product in a sandbox could see it.

## Requirements

- **S1 Who gets the emails.** In a sandbox, the agent's offers and its answers to counters go to the member who turned
  the offers on (`orgs.early_offers_on_by`), who answers as the supplier.
  - The emails' subjects start "[Sandbox]".
  - Each email first says it is a sandbox, whose supplier it stands in for, and that payments are simulated.
  - The ledger entry carries `sandbox: true`, and `to` is that member's masked address.
  - When the member has left the workspace, or the members cannot be read, no offer is made.
  - Every other rule stands as in a live workspace: the agent's cover, the ceiling, the pause and email.
- **S2 Payments.** A sandbox's payments are simulated, as before. An accepted offer or counter starts a sandbox cycle.
- **S3 Something to offer.** The sample data adds Kestrel Print Co's "Catalogue print run": 300 USDC, PO-3312, goods
  received, due in 21 days, with no discount. The agent schedules it for its due date, and offers it once the offers are on.
- **S4 No migration.**
