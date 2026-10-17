# Requests for more time, followed up (design)

Builds on [the agent asks suppliers for more time](2026-10-17-term-requests-design.md). There, a bill held for want of
cash gets a request: the same amount on a later day. Here the agent follows each request through: it takes back one the
business no longer needs, it tells the people watching each step as it happens, and it answers a supplier who proposes
fewer days.

## Requirements

- **F1 Taken back when no longer needed.** Each cycle, a request still open whose bill is being paid (paid, or a payment
  started) or is no longer held for want of cash is withdrawn. Its supplier is emailed a fixed template saying so: the
  bill is being paid on time, or it stays due on its date, as before; the earlier link no longer works. The email goes
  under the withdrawal's own idempotency key, and a send that fails is logged, never retried with a new link. Signed
  `term_request_withdrawn` with `reason: "paid"` or `"not_needed"` and `supplierTold`. A request still being emailed (its
  review not yet marked emailed) is left to its run.
- **F2 Even when turned off.** Turning the requests off stops new ones; the ones out are still followed up.
- **F3 Told as it happens.** The activity toasts, Telegram and Slack tell each request the agent sent and who decided it,
  a supplier's agreement or decline (recorded by the system), and each withdrawal with its reason. A bill the agent chose
  not to ask about is not news, and none draws a card for a person.
- **F4 Asked again after an unsent request.** A request withdrawn before its email went was never seen by the supplier,
  so its bill may be asked about again; a bill whose request the agent signed as sent is not.
- **F5 A supplier proposes fewer days.** On the request's page, beside Agree and Decline, the supplier may propose fewer
  days: a whole number from 1 to fewer than asked. One step in the database: the request becomes `countered`, keeps
  `counter_days`, and its link works no more. Signed `term_request_countered` (system), and a cycle starts at once.
- **F6 The agent answers.** In the term requests stage, before anything else and whether or not the requests are on, each
  countered request (10 a cycle) is answered once:
  - a bill being paid needs no more time: declined by code, without a model;
  - otherwise the model answers `{ action: "accept" | "decline", reasoning }`, given the bill, the days asked and
    proposed, and the cash picture. The written policy accepts when the bill is covered by the new date the fewer days
    give (the operating USDC now, less what falls due before, then what customers owe, each counted the day after it is
    expected), and declines otherwise, rather than promise a date the business cannot keep;
  - accepted, the bill's due date moves by the counter's days and it returns to pending, if its amount and due date are
    unchanged and no payment started; otherwise the request is declined.
  - Signed `term_counter_accepted` or `term_counter_declined`, with the decision, the written policy's answer and whether
    the supplier was told.
- **F7 The answer, by email.** A fixed template under the answer's own idempotency key: accepted, the new due date and the
  full amount; declined, that the invoice stays due on its date; a bill being paid, that no more time is needed.

## Storage (migration 0130)

`payment_term_requests` gains `counter_days` and the status `countered`. Two service-role functions:
`counter_term_request(p_token_hash, p_days)` and `answer_term_counter(p_org_id, p_request_id, p_accept)`.

