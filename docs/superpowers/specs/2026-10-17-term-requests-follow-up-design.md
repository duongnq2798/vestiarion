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
