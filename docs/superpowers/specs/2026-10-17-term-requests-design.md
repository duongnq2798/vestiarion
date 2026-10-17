# The agent asks suppliers for more time (design)

The mirror of [the agent's early-payment offers](2026-10-16-agent-early-payment-offers-design.md). There, when cash is
plenty, the agent offers a supplier payment today for a discount. Here, a bill is held because the operating wallet
cannot pay it, and the agent asks the supplier for more time: the same amount, on a later day. A supplier who agrees
moves the due date, and the agent decides the bill again against it.

## Requirements

- **X1 Opt-in, per workspace.**
  - Off by default. An owner or admin turns it on with the most days the agent may ask for (`term_requests_max_days`,
    from 3 to 30), and can turn it off.
  - Both changes are signed: `term_requests_on` and `term_requests_off`.
  - No request goes while the agent is paused, or without email.
  - In a sandbox, requests go to the member who turned them on, who answers as the supplier (as for offers, S1 of the
    sandbox design).
- **X2 What code allows.** The agent asks only when all of these hold:
  - the payable is held, and its latest decision held it for want of cash (`execution.heldBecause: "cash_shortfall"`);
  - it falls due within 14 days and is not past due by more than 7;
  - it never had a request;
  - its supplier has a notice email, no other open request, and declined no request in the last 30 days.

  At most 3 requests go out per cycle.
- **X3 The decision.**
  - The model answers `{ action: "ask" | "skip", days, reasoning }`. It is given:
    - the bill;
    - its due date;
    - the operating USDC;
    - what falls due in the next 30 days;
    - what customers owe in the next 30 days, by day;
    - the supplier's earlier requests;
    - the written policy's answer.
  - The written policy asks for the days until the receivables due cover the bill after what falls due before it, from
    7 up to the most, or for the most when they never do.
  - Code keeps the days within 3 and the most.
  - A skip is signed (`term_request_skipped`) and the bill is weighed again after 7 days.
- **X4 The link.**
  - A `vxt_` token of 32 random bytes; only its SHA-256 is kept.
  - One open request per bill, open for 5 days or until the new due date, whichever comes first.
  - The supplier's page (`/more-time/[token]`, no account) names who asks, for which invoice, the new date and the full
    amount, with **Agree to the new date** and **Decline**.
- **X5 The answer, in one step.**
  - **Agreed:** the bill's due date moves to the new date, a held bill returns to pending, and a cycle starts. The agent
    then decides it against the new date, with every check it always makes.
  - **Declined:** nothing changes, and the bill stays held for a person.
  - The answer is signed: `term_request_accepted` or `term_request_declined`.
  - A bill that changed since the request (its amount or due date, or a payment started) takes nothing.
- **X6 One email, once.** The same pattern as the offers (AO4):
  - each bill's review is claimed before the request is made;
  - the email is a fixed template, sent under the request's own idempotency key;
  - a failed send withdraws the request;
  - one left unsent for 15 minutes is withdrawn.
- **X7 Never less than owed.** A request only moves a date later. It never changes the amount, who is paid, or where.

## Storage (migration 0128)

- **`orgs`:** `term_requests_on_at`, `term_requests_on_by`, `term_requests_max_days`, set by `set_term_requests`,
  which runs with the service role.
- **`payment_term_requests`:** org, invoice, counterparty, days, original and new due dates, amount, token hash, status
  (`open`, `accepted`, `declined`, `withdrawn`), created at, expires at, decided at.
  - Tenant select only.
  - Writes go through service-role functions: `create_term_request`, `term_request_preview`, `decide_term_request`,
    `withdraw_term_request`, `term_requests_ready`.
- **`payment_term_request_reviews`:** one per bill (offer or skip, request id, emailed at). Tenant CRUD within its own
  workspace.
