# Payments whose outcome is not clean: checking first, and a runbook for each state

Date: 2026-10-14. Status: decided (autonomy grant 2026-10-05). Roadmap: I18 (a payment whose outcome is not known yet
says it is being checked; no retry sends a new transfer before the earlier one is reconciled) and I27 (a runbook for a
payment that is stuck, failed, returned or of unknown outcome, with who acts and the trail).

## Why

Vestiarion already keeps a payment from being sent twice. `executePayment` only reconciles a transfer Circle has an id
for; a new attempt opens only on a person's Approve and pay or Pay now, only when Circle, read right then, says the last
one ended (`begin_payment_retry`, 0036); a send Circle never answered is looked for by its reference before anything is
sent again (payment safety R4); the transfer watch tells people about a payment not confirmed after the network's wait
and sends nothing (stuck-transfer alert); the settlement track says where each payment is (settlement lifecycle L10).

What is missing is in the words and in one state:

- **The moment of acting says "pay".** Approve and pay on a payable whose earlier transfer is in flight or unknown
  opens a confirmation titled "Pay 12.50 USDC to Jiren now?", whose button reads "Pay now", and the notice raised while
  it runs reads "Sending to Jiren". The body says nothing new is sent, but the title, the button and the notice say the
  opposite. Pay now on a held milestone, and Approve and pay from Slack ("Pays 12.50 USDC to Jiren"), are the same.
- **A send left `submitting` past its claim** is an unknown outcome to `executePayment` (`unknownSend`, payment safety
  R4) and to the settlement track (L3), but not to the decisions a person makes: `transferUnknown` reads only a `failed`
  row. Approvals says "A payment was already sent; Approve and pay records it.", its confirmation says "Nothing new is
  sent", and Reject and Return refuse it as sent without looking for it (R6), though Approve and pay may send it once
  Circle shows none. A function stopped between the claim and Circle's answer leaves exactly this row.
- **The evidence page calls an unknown outcome a failure.** Its payment step reads "The transfer failed." with
  "Approvals shows what to do next." for any `failed` intent: a send Circle never answered, a read of ours that failed,
  Gateway's failure, and a milestone's (which is decided on Contractors).
- **No runbook.** Each exceptional state is described where it shows, but nowhere says, state by state, who acts, what
  Vestiarion already did, what to do next and where the trail is.

## Requirements

**E1. Verified, not changed: no new transfer before the earlier one is reconciled.** `executePayment`,
`begin_payment_retry`, `lookForUnknownSend`, the lost-batch lookup, `approveAndPay` (`retryTerminalFailure` only when no
transfer may exist) and `releaseHeldMilestone` keep their rules. New tests pin, for each pay path a person has
(Approve and pay, Pay now, Approve and pay from Slack, which calls the same command), that a payment in flight or of
unknown outcome is read or looked for, and that nothing is sent while Circle has not answered.

**E2. A send left `submitting` past its claim is an unknown outcome where people decide.**
- `IntentState` gains `updated_at`. `transferUnknown` is true for a `submitting` row with no Circle id whose
  `updated_at` is older than the claim (2 minutes, as `unknownSend` and the track read it). A row read without
  `updated_at` keeps today's answer, so the cycle's own reads are unchanged.
- The reads behind Approvals, Approve and pay, Reject, Return, Add details, Pay now and Close select `updated_at`.
- So Approvals shows "Circle did not answer when this payment was sent…", Reject and Return look for it first (R6),
  Approve and pay skips only the funds check (R3), and a held milestone is "Transfer to look for".
- A `submitting` row inside its claim stays a payment being sent: Reject and Return refuse it as sent.

**E3. The moment of acting says it checks first.** One pure helper (`src/lib/payment-exceptions.ts`) names what a
person's pay action will do with the earlier attempt: `send` (none), `send_again` (Circle ended it), `check` (a transfer
in flight, confirmed, or Gateway's failure, which is only read) or `look_first` (an unknown outcome). For `check` and
`look_first`:
- the confirmation's title is "Check the payment of 12.50 USDC to Jiren already sent?" / "Look for the earlier payment
  of 12.50 USDC to Jiren first?", never "Pay … now?";
- its button reads "Check it" / "Look first", never "Pay now";
- the notice while it runs reads "Checking the transfer already sent to Jiren" / "Looking for the earlier transfer to
  Jiren on Circle first", never "Sending to Jiren";
- Slack's Approve and pay confirmation says the same, from the payable's payment intent read with its card.
The card's own button keeps its name (Approve and pay, Pay now): it is how the guides and the people name it.

**E4. After acting.** Approve and pay, or Pay now, on an unknown outcome looks for the earlier send first (review
R2 below). While Circle has not listed it yet, it refuses before any claim: "Vestiarion looked for the earlier transfer
on Circle first: Circle has not listed it yet, so nothing was sent. Try again from 10:30 UTC: …", never "Submitted".

**E5. One runbook, in code.** `src/lib/payment-exceptions.ts` defines the exceptional states and, for each, who acts,
what Vestiarion already did, the next step and where the trail is. The screens and the guide read the same words
(`tests/payment-exceptions.test.ts` pins that the guide quotes each one):
- **Slow to confirm**: in flight past the network's `stuckAfterMinutes`, Circle's `STUCK` included.
- **Outcome unknown**: Circle never answered the send.
- **Failed or cancelled**: Circle ended it `FAILED`, `DENIED` or `CANCELLED`, on chain or before.
- **Not sent**: it stopped before Circle took the transfer.
- **Gateway reported it failed**: Gateway's `GATEWAY_FAILED`, which may still be minted.
- **Returned or reversed**: no such state on Arc. The runbook says so, and that money sent back is a new transfer in.
Who acts follows who comes back to the bill (`followUpOf`): the agent's cycle, a person in Approvals, a person on
Contractors. People are named by role: owners, admins and approvers, who may approve payments.

**E6. Where it shows.**
- **Where the payment is** (the card's track on Bills & receivables): a short **What to do** block under the stages, for
  a payment in one of these states, with who acts, what was done, the next step, the trail (Circle's id for the
  transfer when it has one, the decision trail and its audit log entries) and a link to the runbook. Not a dialog.
- **Payments in flight** (Treasury): a "What to do" line on each payment slow to confirm or of unknown outcome, and a
  Docs link to the runbook beside the heading.
- **Approvals**: the failed attempt's callout names the next step (fix the reason first, then a new transfer).
- **The evidence page**: the payment step tells an unknown outcome, a failed read and Gateway's failure apart from a
  failure, and names where to act (Approvals for a payable, Contractors for a milestone).
- **The transfer watch's email** links the runbook.

**E7. No migration, no new write.** The runbook is words over what is already recorded. `Settlement` carries the
current attempt's Circle id (`circleId`, read from the intent), optional, so the track can show it. No `/api/v1` or
webhook change, so no API changelog entry.

## Testing

- `tests/payment-exceptions.test.ts`: the pay action for every last attempt and held reason; the dialog words and the
  notice for each; the state of every settlement status (late or not); the runbook's words for each state and follow-up;
  the guide quotes every state's heading, owner, next step and trail, and each anchor the screens link exists.
- `tests/approvals.test.ts`: a stale `submitting` send is unknown (`transferUnknown`, `lastAttemptOf`), Reject looks for
  it first, Approve and pay skips the funds check and looks for it before any send; a fresh one stays sent.
- `tests/control-ui.test.tsx`, `tests/held-milestone-actions.test.tsx`, `tests/payment-toast.test.tsx`: the title, the
  button and the notice for each pay action.
- `tests/slack-notify.test.ts`: the card's confirmation for a payable whose earlier transfer is in flight or unknown.
- `tests/settlement-track.test.tsx`, `tests/payments-in-flight.test.tsx`: the What to do block and line, by state and
  by who comes back to the bill.
- `tests/evidence-chain.test.ts`: the payment step for each intent state.
- `tests/docs-content.test.ts`, `tests/docs-links.test.tsx`, `tests/docs-guides.test.ts`: the guide's place, its links,
  and the app text it quotes.

## After review (2026-10-15)

An independent review of the first version found one important gap and five smaller ones. These rulings replace the
parts of E1-E4 they name.

- **R1. A batch member is looked for by its batch.** The agent releases milestones in one Arc transaction whose refId is
  the batch's key (batch payouts R5). `settleUnknownSend`, which Reject, Return, Close and now Approve and pay and Pay
  now ask first, looked a member up by its own memo, so 15 minutes after a lost batch it could record "never sent" and
  let Close finish on a milestone the batch had paid. It now looks a first attempt with a `batch_key` and no Circle id
  up as `executePayment` does (`resolveLostBatch`): found, every member records it; not listed yet, or not asked,
  nothing concludes; Circle has no batch 15 minutes after it, the batch is left and the member was never sent alone.
  `transferUnknown` reads such a member as unknown whatever its status or error, from `batch_key` and
  `transfer_attempt`, which the people's reads now select. Before this, a member recorded `failed` with the batch's own
  error was even called "not sent" there.
- **R2. Look first, then check as a new payment.** Approve and pay and Pay now on an unknown send ask
  `lookForUnknownSend` before any other check, and re-read the intent: found, it is only recorded (no funds check, no
  new transfer); never taken, the payment is new, so the shadow verdict gate, screening, limits, two approvals and the
  funds apply to it, as to any first payment; not listed yet, or not asked, they refuse before any claim with when to
  try again. Before this they went ahead with the funds check skipped (payment safety R3), and a lookup that later
  found nothing sent a new payment without those checks.
- **R3. Pay now never sends anew while only checking.** `releaseHeldMilestone` takes `retryTerminalFailure`, and
  `payHeldMilestone` passes it only when it ran a new payment's checks, as `approveAndPay` already did. A Pay now on a
  transfer in flight that Circle reports failed by then records the failure and holds the milestone again; the next
  Pay now sends a new transfer after every check. So "Nothing new is sent" is true.
- **R4. Slack's confirmation within Slack's limits.** Its text is clipped to 300 characters, never through an escape,
  the payee's name to 60, and its title and button say what it does: "Check the payment already sent?" / **Check it**,
  "Look for the earlier payment first?" / **Look first**.
- **R5. A payout to another chain, said as it is.** It cannot be looked up by its reference, so it is asked for again
  under its own payment key, which Circle takes only once. `settleUnknownSend` answers `unlookable` for it; Reject and
  Return say so and that Approve and pay settles it; the runbook, Treasury's line, the card and Approve and pay's
  confirmation say it is asked for again, never that it is looked up.
- **R6. A send that may still be running says so.** A send's tick can take about two to four minutes, so a row left
  `submitting` for over two minutes may still be under way. Approvals and Contractors say "it may still be sending, or
  its answer was lost" of it. No behaviour changes: it is looked for first, and nothing concludes while Circle has not
  listed it.

A second review (2026-10-15) added two rulings:

- **R7. "Never sent" is written only over the row the lookup read.** Two approvals at once (the console and Slack, or a
  double submit) on an unknown send 15 minutes old could both conclude it was never sent; the second write could land
  after the first request's claim and overwrite its send in flight with `failed`, so a later Reject would close over a
  transfer Circle had. `recordNotSent` now writes `NO_EARLIER_SEND` only while the row has the status and `updated_at`
  the lookup read and no Circle id. A lost compare-and-set answers undecided: nothing is sent, and the person tries
  again, by when the other request's send is recorded.
- **R8. No operating account says so.** With no operating account, nothing can be looked up nor paid: Approve and pay
  and Pay now refuse with `no_operating_account` ("This workspace has no operating account."), never "try again".

The re-ask of a payout to another chain under its own key (R5) stays as it is: it skips the funds check and the verdict
gate, since sending under the same key is the only thing that settles it, and shadow mode pays on Arc only.

## Docs

- New guide **When a payment does not settle** (`content/docs/guides/payment-exceptions.mdx`), under Everyday work after
  Know where a payment is: each state with who acts, what Vestiarion already did, the next step and the trail.
- `CHANGELOG.md` [Unreleased]; `ARCHITECTURE.md` beside the read model.
