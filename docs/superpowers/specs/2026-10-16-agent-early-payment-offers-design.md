# The agent makes early-payment offers (design)

Builds on [early-payment offers](2026-10-16-early-payment-offers-design.md). There, an owner or admin makes an offer and
sends the supplier its one-time link. Here, once an owner or admin turns it on, the agent decides which bills to offer,
and for how much, and emails the link itself.

## What it does

A business turns on **The agent makes these offers** and sets the most it will ask (from 0.5% to 10%). Each cycle, after
the agent has decided its bills, it looks at each bill it scheduled for a later day. Where code allows an offer (AO2),
the model decides whether to offer and at what discount (AO3). If it offers, the agent emails the supplier the link
(AO4). An accepted offer then goes exactly as before: the discount goes on the bill, ending today, and the agent pays
the discounted amount after every check.

## Requirements

- **AO1 Opt-in, per workspace.**
  - Off by default. An owner or admin turns it on with a ceiling, `early_offers_max_pct`, from 0.5% to 10%, and can turn it off.
  - Both changes are recorded in the ledger: `early_offers_on` and `early_offers_off`.
  - Live workspaces only: a sandbox's suppliers are sample data, so the agent never emails them.
  - Nothing is offered while the agent is paused, or when email is not configured.
- **AO2 What code allows.** Code allows an offer on a bill only when all of these hold:
  - it is a payable the agent **scheduled** for a later day;
  - it is in USDC;
  - it is eligible as in E1: no discount, no payment started, due at least 3 days out;
  - it falls due at least **7 days** after today;
  - it has never had an offer, by a person or by the agent;
  - its supplier has a notice email, has no other open offer, and declined no offer in the last 30 days;
  - the operating wallet can pay it today: the USDC left after the AP stage, less the open offers' amounts and the
    payables due in the next 7 days, covers what the supplier would receive;
  - the suggested discount (E2) is no more than the ceiling.

  At most 3 offers go out per cycle.
- **AO3 The decision.**
  - The model answers `{ action: "offer" | "skip", pct, reasoning }`. It is given:
    - the bill;
    - the days early;
    - the reserve's yield and the break-even;
    - the suggested discount and the ceiling;
    - the cash left after the offer;
    - the supplier's past offers: made, accepted and declined, with their discounts;
    - the written policy's answer: offer at the suggestion.
  - Code keeps `pct` between the suggestion and the ceiling, rounded to 0.25%. Without a model, the written policy decides.
  - A `skip` is recorded and asked again after 7 days.
- **AO4 One email, once.**
  - Each bill's review is claimed in `early_payment_offer_reviews` (one row per bill) before the offer is made.
  - The email is a fixed template: who offers, what the supplier receives today instead of on the due date, the link,
    and until when. The model writes none of it.
  - It goes to the supplier's notice email under the Resend `Idempotency-Key` of the offer.
  - A failed send withdraws the offer and releases the review, so the next cycle tries again with a new link.
  - A review left with an unsent offer for 15 minutes is the stopped run's. Its offer is withdrawn and the review released.
- **AO5 The record.**
  - `early_payment_offered` with `via: "agent"`, the masked address, the decision, the written policy's answer, the
    decision mode and whether it agreed.
  - `early_payment_offer_skipped` for a skip.
  - On Bills, an offer the agent made says so and shows where it went.
- **AO6 Never more than an offer.** An offer changes nothing until the supplier accepts. Accepting only takes the
  discount off a bill, never raising the amount or changing who is paid or where. The payment then passes every check
  any bill gets: screening, the three-way match, the payment limit, the guardrails, the approvals.

## Storage (migration 0126)

- **`orgs`:** `early_offers_on_at`, `early_offers_on_by`, `early_offers_max_pct`, set by
  `set_agent_early_offers(p_org_id, p_on, p_max_pct, p_by)`, which runs with the service role.
- **`early_payment_offer_reviews`:**
  - columns: org, invoice, action (`offer` or `skip`), pct, offer id, decided at, emailed at;
  - unique on (org, invoice);
  - RLS: tenant select, insert, update and delete within its own workspace.
- `early_payment_offer_reviews_ready(p_org_id)` returns true once the migration has run.
