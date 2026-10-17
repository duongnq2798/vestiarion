# The agent offers customers a discount to pay early (design)

The receivables side of the agent's cash. When bills are held because the operating wallet cannot pay them, the agent
already asks suppliers for more time ([term requests](2026-10-17-term-requests-design.md)). Here it also brings money in
sooner: it offers a customer a small discount to pay an open receivable within days instead of on its due date. A
customer who accepts pays the discounted amount through the receivable's pay link, the agent matches it as it matches any
payment, and the bills held for cash are decided again with the money in.

It mirrors [the agent's early-payment offers](2026-10-16-agent-early-payment-offers-design.md) to suppliers: there the
business pays early for a discount when cash is plenty; here it is paid early for a discount when cash is short.

## Requirements

- **C1 Opt-in, per workspace.**
  - Off by default. An owner or admin turns it on with the most the agent may give, `customer_offers_max_pct`, from
    0.5% to 5%, and can turn it off.
  - Both changes are signed: `customer_offers_on` and `customer_offers_off`.
  - Live workspaces only: a sandbox has no wallet to receive a payment in, and its customers are sample data.
  - Nothing is offered while the agent is paused, or when email is not configured.
- **C2 What code allows.** The agent weighs offers only while cash is short: the payables whose latest decision held
  them for want of cash add up to more than the operating USDC left after this cycle's payments and the receivables
  already accepted at a discount and not yet paid. That difference is the shortfall. Code then allows an offer on a
  receivable only when all of these hold:
  - it is open, in USDC, and nothing has been applied to it;
  - it falls due at least **7 days** after today;
  - it has never had an offer, and the agent's last answer on it does not still stand;
  - its customer has a billing email, no other open offer, and declined no offer in the last 30 days;
  - its pay link is kept, so the offer can carry it.

  The largest go first, until what they would bring in at the ceiling covers the shortfall; at most 3 per cycle.
- **C3 The decision.**
  - The model answers `{ action: "offer" | "skip", pct, reasoning }`. It is given the receivable, the days early, the
    shortfall and the bills held for it, the suggested discount and the ceiling, the customer's past offers, and the
    written policy's answer.
  - The written policy offers at the suggestion: 1% for each 30 days early, to the nearest 0.25%, at least 0.25% and no
    more than the ceiling.
  - Code keeps `pct` between 0.25% and the ceiling, to the nearest 0.25%. Without a model, the written policy decides.
  - A skip is signed (`customer_discount_skipped`) and the receivable is weighed again after 7 days.
- **C4 The link.**
  - A `vxd_` token of 32 random bytes; only its SHA-256 is kept.
  - One open offer per receivable, open until its pay-by day: five days after the offer, and always before the due date.
  - The customer's page (`/discount/[token]`, no account) names who offers, for which invoice, the full amount and due
    date, the discounted amount and the pay-by day, with **Accept** and **No thanks**.
- **C5 The answer, in one step.**
  - **Accepted:** only while the offer is open, the receivable is still open with the same amount and nothing applied to
    it. The discount goes on the receivable, ending on the pay-by day, and the page sends the customer to its pay link.
  - **Declined:** nothing changes.
  - Signed: `customer_discount_accepted` or `customer_discount_declined`.
- **C6 Paid, or back to the full amount.**
  - A payment of exactly the discounted amount, received after the offer was made and by the end of the pay-by day
    (UTC), settles the receivable as any matched payment does, and is signed `customer_discount_taken` with what the
    discount cost. Money that came in before the offer was never paid at its discount.
  - Only an accepted offer lowers what pays a receivable. A discount typed on a receivable from a form, an import or the
    API changes nothing about what pays it, as before.
  - A discount accepted and then paid in full, or by a person's allocation, no longer counts as money to come in.
  - After the pay-by day the discount no longer applies: the receivable is owed in full again, and a payment of the
    discounted amount then is left for a person, as any payment that matches nothing.
- **C7 One email, once.** The same pattern as the supplier offers (AO4): each receivable's review is claimed before the
  offer is made; the email is a fixed template sent under the offer's own idempotency key; a failed send withdraws the
  offer; one left unsent for 15 minutes is withdrawn.
- **C8 Never more than a discount.** An offer only ever lowers what a customer owes, until a set day. It never changes
  who pays, where the money goes, or the receivable's due date, and it is paid to the same operating wallet as before.

## Why the discount goes on the receivable, not its amount

Lowering a receivable's amount would let the exact-amount matcher settle the discounted payment unchanged, but deal
collection, cash readiness and the HubSpot and Pipedrive write-back read the invoice's amount against the deal line's,
and would show the discount as money never invoiced. The discount columns payables already use (`early_pay_discount_pct`,
`discount_due_date`, migration 0038) say instead what pays the receivable until a day, and the amount stays what was
invoiced. The matcher (`src/lib/agent/receipts.ts`) takes the discounted amount for money that arrived by the end of
that day, as well as the full amount, reading the accepted offer itself (its discounted amount as the database worked
it out, when it was made, its pay-by day), never the columns alone; nothing else that reads a receivable changes.

## Storage (migration 0129)

- **`orgs`:** `customer_offers_on_at`, `customer_offers_on_by`, `customer_offers_max_pct`, set by `set_customer_offers`,
  which runs with the service role.
- **`customer_discount_offers`:** org, invoice, customer, discount, amount and discounted amount, token hash, status
  (`open`, `accepted`, `declined`, `withdrawn`, `paid`), pay-by day, created, expires (the end of the pay-by day, UTC),
  decided and paid at.
  - Tenant select only.
  - Writes go through service-role functions: `customer_discount_eligible`, `create_customer_discount_offer`,
    `customer_discount_preview`, `decide_customer_discount`, `withdraw_customer_discount_offer`,
    `settle_customer_discount`; `customer_discounts_ready` answers the tenant too.
- **`customer_discount_reviews`:** one per receivable (offer or skip, discount, offer id, emailed at). Tenant CRUD within
  its own workspace.

## Told as it happens

The activity toasts, Telegram and Slack tell an offer the agent emailed and a receivable paid at the discount
(`CUSTOMER_DISCOUNT_ACTIONS` in `src/lib/agent-activity.ts`). A customer's acceptance or decline is recorded by the system
and shown on Bills & receivables.
