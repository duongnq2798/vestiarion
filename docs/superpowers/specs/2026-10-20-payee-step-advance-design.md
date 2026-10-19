# A payee link moves on as the action answers

Date: 2026-10-20. Status: built. Branch `fix/payee-step-advance`. No migration. Follows
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
  page itself makes) and return it as `status` beside the message, projected as S6 says. A refusal reads nothing.
- **S2. Best effort.** What was sent is kept whatever the read does. A read that fails, or finds no link, answers
  without `status`; one that fails also logs one fixed line. The form then refreshes the page, as it did before.
- **S3. The answer holds until the page reads itself again.** `PayeeJourney` is now a client component. It keeps the
  status the last accepted action answered with, together with the page's own read it came over, and shows the answer
  while the page still has that read, so the step changes in the same moment as the action's answer. The next read the
  page receives takes over, whether it is further along or goes back (a business that changes an address it had
  confirmed): the router runs a refresh and a server action one after the other (its action queue, `dispatchAction` in
  `next/dist/client/components/app-router-instance.js`; re-check it after a Next upgrade), and an action that does not
  revalidate leaves the page's read as it was, so any read that reaches the page after the answer was made after the
  submission was written. With no refresh after an answer, the page next reads itself when its 30-second refresh runs,
  as before.
- **S4. Without JavaScript.** Nothing changes: a form posted without JavaScript renders the page again on the server,
  from the link's status as it now stands. `today`, the first day the invoice's due date may fall on, still comes from
  the server (the page passes it), so the form and the check agree.
- **S5. Copy.** No visible text changes. The thanks line still shows, for the moment before the next step replaces it.
- **S6. What the browser receives.** A client component's props are written into the page's HTML, and an action's
  answer goes to whoever holds the link, so neither carries the status as the read returns it. `payeeView` gives the page
  and every answer the same projection: the address masked as the page shows it (R4), each payment's state one the page
  tells apart (`paid`, `matched`, `scheduled`, `verified`, `pending`) or `review` for any other, so a hold's reason stays
  the business's (R3), a payment's transaction and dates only where the page shows them, and no field the read adds now or
  later. An unused link's address on file is given only when the payee may keep it: a mirror Vestiarion made in shadow
  mode is left out, so the page no longer learns that it is one. Every screen renders from it exactly as it did from the
  full status.
- **S7. Focus.** The button the payee pressed is gone once the page moves on, so the new step's heading takes the focus
  (focusable from code only, with no outline), and a screen reader reads out where the payee now is; unless the payee
  moved the focus out of the card while the action ran, as `useActionForm` leaves it.
- **S8. The members' email after the answer (added 2026-10-20, after the production check).** With S1 to S3 live, the
  invoice step still showed **Sending…** for about five seconds on production before Step 3: the action awaited the
  members' email (reading the workspace and its members, sending, metering) before it answered. The address and invoice
  actions now pass `defer: after` (as the statement page does), so `submitPayeeAddress` and `submitPayeeInvoice` hand
  that email to `after()` and answer first. The ledger entry stays awaited: it is the record. Callers that pass no
  `defer` (the API, scripts, tests) await the email as before.

## Considered and not done

- Calling `refresh()` from `next/cache` in the actions, so the action's response carries the page. It removes the
  second request too, but the step would still come from the router applying a new page, the part that did not show in
  production; and the form that answered would unmount in the same render as its answer (the repo's known pattern for a
  client component gated on a server prop).
- Keeping `router.refresh()` after an answer. It costs a request that renders the same step; the 30-second refresh
  already keeps the page current.
- Showing whichever of the answer and the page's read is further along. It would also hide a read that rightly goes
  back, such as an address the business changed after confirming it, until the page caught up again (S3 instead).
- Building the next status on the client from what the payee sent. The link's dates (30 days after use) and the
  confirmation state are the server's; reading them back keeps one source.

A lead on the cause, not verified: while the journey was rendered on the server, the invoice form's client code was
first named by the refresh that showed the invoice step, so the browser had to load it before showing that step, and the
refresh from the invoice to the confirmation, which needed no new client code, did show. The journey now ships every
step's client code with the page, which would cover that too.

## Tests

- `tests/payee-link-steps-dom.test.tsx`: in a DOM, sending the address through the page shows Step 2 of 4, "Send Acme
  your invoice", the masked address and the new date, with no refresh, and focuses that heading; the page keeps the step
  until its next read, which then counts, further along or not; sending the invoice shows Step 3 of 4 and "Invoice
  sent."; keeping the address moves on; an answer without `status` refreshes.
- `tests/payee-links-actions.test.tsx`: each action returns the projected status read after an accepted submission
  (masked address, no hold's reason, no other field of the read), none for a refusal, and still thanks the payee when
  the read fails; the page gives `PayeeJourney` the projection, read from the props the browser receives.
- `tests/payee-journey.test.ts`: `payeeView` masks, maps and drops as S6 says and leaves every screen's stage and words
  as they were; `moveOn`.
