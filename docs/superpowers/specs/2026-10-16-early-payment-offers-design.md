# Early-payment offers

*2026-10-16. A small business pays a supplier early in exchange for a discount it asks for, and the agent pays the
discounted amount the day the supplier accepts.*

## Why

The agent already pays a bill whose invoice carries an early-payment discount on the discount's last day, when the
discount is worth more than the yield the cash would earn in the reserve until the due date. Most invoices carry no
discount, so the agent pays them on their due date, and the cash earns the reserve's yield in the meantime: about 4% a
year.

A supplier waiting 30 days for money is often glad to take 1% less today. For the business, 1% for paying 20 days
early is worth about 18% a year, far more than the reserve. Large companies run this as "dynamic discounting" through
platforms built for their size. Vestiarion can run it for a small business, because on Arc a payment is final in a
second and costs a cent, so "today" really means today.

## Decisions

**E1. Which bills.** A payable is eligible for an offer when:
- it is a bill to pay, scheduled by the agent for a later day or not decided yet (status `scheduled` or `pending`);
- its invoice carries no early-payment discount;
- no payment for it has started;
- it falls due at least 3 days from now;
- it has no offer already open.

Bills held, flagged or waiting for information are a person's to decide first.

**E2. What to ask.** For each eligible bill, Vestiarion suggests a discount from the reserve's yield. The break-even is
`yield × days / 365`, the share of the bill the cash would earn by its due date. The suggestion is twice that, rounded up
to the next 0.25%, at least 0.5% and at most 5%. The card says what it is worth: "Paying 20 days early for 1.00% is
like earning 18.3% a year, above the reserve's 4.2%." A person may ask any discount from 0.1% to 10%.

**E3. Who offers.** An owner or admin makes the offer, never the agent on its own: it is a message to a supplier on the
business's behalf. Making it records `early_payment_offered` and gives a one-time link (`vxo_` and 43 base64url
characters). Only the link's SHA-256 is kept, as for a payee link, and it is shown once. An offer is open for 7 days, or
until the day before the bill falls due if that comes sooner. Making a new offer for a bill withdraws its open one.

**E4. The supplier's page.** `/offer/<token>` needs no account. It names the business, the bill's reference, its
amount and due date, the discount asked and what the supplier receives today. It offers **Accept** and **Decline**. It
shows nothing else about the business, and a link that is used, withdrawn, expired or malformed says only that it is no
longer valid.

**E5. Accepting.** In one database step, Accept checks that the offer is still open and that its bill is still
eligible: same amount, no discount, no payment started, still scheduled or pending. It then:
- sets the bill's early-payment discount to the discount asked, with today (UTC) as its last day;
- returns a scheduled bill to `pending`;
- marks the offer accepted.

The ledger records `early_payment_offer_accepted`, and a cycle starts at once. The agent then decides the bill as any
bill with a discount ending today. It runs every check (screening, the three-way match, limits, guardrails, two approvals,
a bank payout's person) and pays the discounted amount today, or holds it for a person as it would any bill. Accepting
never changes the payee, its address, or the amount upward. If the bill changed, the supplier is told the offer is no
longer valid, and nothing changes.

**E6. Declining and withdrawing.** Decline marks the offer declined (`early_payment_offer_declined`), and the bill keeps
its plan. An owner or admin may withdraw an open offer (`early_payment_offer_withdrawn`).

**E7. Migration 0125.** `early_payment_offers` (one open per invoice) with tenant read under RLS. Every write goes
through `security definer` functions:
- `create_early_payment_offer`, `withdraw_early_payment_offer`: workspace-scoped, service role;
- `early_payment_offer_preview`, `decide_early_payment_offer`: by token hash, service role;
- `early_payment_offers_ready(p_org_id)`: the probe.

Additive and re-runnable.

**E8. Plain words.**
- The section on Bills & receivables is "Pay early for a discount".
- Each bill reads "Paying 20 days early for 1.00% is like earning 18.3% a year, above the reserve's 4.2%." and has
  "Offer 1.00% for paying today".
- The supplier sees "Northwind Supply offers to pay invoice INV-108 today: 990.00 USDC instead of 1,000.00 USDC on
  Oct 30, 2026."
