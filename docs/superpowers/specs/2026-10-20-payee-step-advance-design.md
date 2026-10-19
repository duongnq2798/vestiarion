# A payee link moves on as the action answers

Date: 2026-10-20. Status: built. Branch `claude/gracious-raman-b15c14`. No migration. Follows
[2026-10-19-payee-invoice-link-design.md](2026-10-19-payee-invoice-link-design.md) (P4) and the freelancer journey
([2026-10-02-freelancer-journey-design.md](2026-10-02-freelancer-journey-design.md) §4).

## Why

On Oct 19, in the production test of the payee invoice link (a team test workspace, a link with **Also ask for their
invoice** ticked), the payee sent its address and the page stayed on "Step 1 of 4" with "Thanks. *business* will
confirm your address before paying you." Only a reload showed Step 2, "Send *business* your invoice". A payee could read
the thanks as the end, and never send the invoice. After **Send my invoice**, the button said "Sending…" for several
seconds before the page moved to Step 3.

Each form asked the router to refresh the page once its action succeeded (`router.refresh()` in `useActionForm`'s
`onSuccess`), and the next step came from that second request. The production request log shows the address action
(POST at 17:15:34 UTC) and the refresh after it (`/payee/[token].rsc`, 200, at 17:15:39), then nothing until the reload
at 17:15:56, and no error logged. The refresh was made, and its page did not show. Neither the dev server nor a local
production build reproduced it, with the same components and an action stubbed to take 1.5 seconds; the real action
takes about five. So the cause is not pinned, and the fix does not depend on it: the step the payee moves to no longer
waits on a second request.

## The rules (decided here)

- **S1. The action answers with where the link now stands.** `submitPayeeAddressAction`, `keepPayeeAddressAction` and
  `submitPayeeInvoiceAction` read the link's status once the submission is accepted (`payeeLinkStatus`, the read the
  page itself makes) and return it as `status` beside the message. A refusal reads nothing.
- **S2. Best effort.** What was sent is kept whatever the read does. A read that fails, or finds no link, answers
  without `status` and logs one fixed line; the form then refreshes the page, as it did before.
- **S3. The page shows the further of two reads.** `PayeeJourney` is now a client component. It keeps the status the
  last accepted action answered with, and shows it while it is further along than the page's own read
  (`payeeProgress`: the stage, then whether the invoice arrived), so the step changes in the same moment as the action's
  answer. Once the page's own read catches up, the answer is dropped, and the page's reads alone say where the link
  stands, including one that goes back (a business that changes an address it had confirmed). With no refresh after an
  answer, the page next reads itself when its 30-second refresh runs, as before.
- **S4. Without JavaScript.** Nothing changes: a form posted without JavaScript renders the page again on the server,
  from the link's status as it now stands. `today`, the first day the invoice's due date may fall on, still comes from
  the server (the page passes it), so the form and the check agree.
- **S5. Copy.** No visible text changes. The thanks line still shows, for the moment before the next step replaces it.

## Considered and not done

- Calling `refresh()` from `next/cache` in the actions, so the action's response carries the page. It removes the
  second request too, but the step would still come from the router applying a new page, the part that did not show in
  production; and the form that answered would unmount in the same render as its answer (the repo's known pattern for a
  client component gated on a server prop).
- Keeping `router.refresh()` after an answer. It costs a request that renders the same step, and a read that arrives
  stale could not move the page back anyway (S3); the 30-second refresh already keeps the page current.
- Building the next status on the client from what the payee sent. The link's dates (30 days after use) and the
  confirmation state are the server's; reading them back keeps one source.

## Tests

- `tests/payee-link-steps-dom.test.tsx`: in a DOM, sending the address through the page shows Step 2 of 4, "Send Acme
  your invoice", the masked address and the new date, with no refresh; the page keeps that step while its own read is
  behind, then follows its reads; sending the invoice shows Step 3 of 4 and "Invoice sent."; keeping the address moves
  on; an answer without `status` refreshes.
- `tests/payee-links-actions.test.tsx`: each action returns the status read after an accepted submission, none for a
  refusal, and still thanks the payee when the read fails.
- `tests/payee-journey.test.ts`: `payeeProgress` orders the stages and counts the invoice within one; `moveOn`.
