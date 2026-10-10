# Where a payment is: one settlement lifecycle

Date: 2026-10-11. Status: decided (autonomy grant 2026-10-05). Roadmap: F18, with I17 (the receipt says whether a
payment is confirmed or reconciled, and from which source; no notice says paid when it is only submitted) and I18 (an
outcome not known yet says it is being checked; no retry sends a new transfer before the earlier one is reconciled).

## Why

"Paid" can mean three different things: the money was sent, the network confirmed it, or it is somewhere the payee can
use. Vestiarion already keeps each of these apart in its own place:

- the invoice's status: `matched` while a transfer is in flight, `paid` once Circle confirmed it;
- the payment intent (`payment_intents`): Vestiarion's own state, Circle's `provider_state`, the attempt, when it was
  sent (`submitted_at`, 0080), when it was confirmed, and the attempts Circle ended before (`previous_attempts`, 0036);
- the signed ledger: the agent's decision, a person's approval, the cycle's reconcile, the transfer watch's
  `payment_stuck`;
- the receipt: three checks, one of them read from the chain by the page itself.

Each is right about its own source; nothing puts them on one line. Finance cannot say, for one payment, whether it was
sent, whether Arc confirmed it, whether it is in the payee's wallet, and whether the books agree; nor list what is still
in flight and for how long. One step of the decision trail even says "A person approved and paid it." when the
approval's transfer was only submitted, or failed.

## Decisions

Each decision names what it costs if it turns out wrong.

**L1. A read model that writes nothing.**
- `src/lib/settlement.ts` is pure: it derives a payment's stage from facts already recorded. No migration, no new
  write, no new ledger action, no new permission.
- Nothing that moves money reads it: the cycle, `executePayment`, approvals, guardrails, the spending limit, the
  transfer watch and the commands keep their own rules. `tests/settlement.test.ts` pins that no module under
  `src/lib/agent`, `src/lib/commands`, `src/app/actions`, nor `src/lib/payments.ts`, imports it.
- Cost if wrong: if a display rule ever fed a payment decision, a reading mistake could send money. The pin fails
  first.

**L2. Seven stages, each from its own source.**
1. **Proposed**: the agent decided to pay or schedule it (`ap_pay` or `ap_schedule` that code did not refuse,
   `milestone_release`), or, when the agent did not, a person's approval (`approval_paid`, `milestone_approval_paid`).
   Source: that signed entry.
2. **Authorized**: what let it be sent. Code's checks, for an `ap_pay` or `milestone_release` whose transfer went out
   (`execution.resultingStatus` paid or matched, verified for a milestone); a person, for `approval_paid`; two people,
   for one with `approvals`. The latest one counts, so a person's approval of a second attempt is the one shown.
3. **Submitted**: Vestiarion sent the current attempt to Circle: `submitted_at`, else `executed_at`, else
   `created_at`. Never for an intent still `created` (a new attempt not yet sent keeps the last one's `submitted_at`).
4. **Pending**: Circle took it (a provider id) and has not confirmed it, with Circle's own state word (`INITIATED`,
   `QUEUED`, `SENT`, `STUCK` …), and the transfer watch's `payment_stuck` entries (D5 of the stuck-transfer alert).
5. **Confirmed**: Circle reported `CONFIRMED` or `COMPLETE` (intent `confirmed`, `confirmed_at`), with the transaction.
6. **In the payee's wallet**: what "available" means on this rail (L4).
7. **Reconciled**: the books agree with the confirmed transfer (L5).

Each source keeps its own word: Circle's `STUCK` is shown as Circle's, the invoice's status is untouched, and the stage
is only the read model's. Cost if wrong: a stage that merged two sources would hide which one is behind; each step
names its source, so a person can check it there.

**L3. Ends that are not stages, kept apart.**
- **Failed**: Circle ended the attempt `FAILED` or `DENIED` (Gateway's expired attestation is recorded `FAILED`).
- **Cancelled**: Circle ended it `CANCELLED`.
- **Not sent**: the send never reached Circle: an error of Vestiarion's before Circle answered (a refusal, a check
  that stopped it, a connection never made), or Circle listing nothing 15 minutes after a send it never answered
  (`NO_EARLIER_SEND`).
- **Outcome unknown**: Circle never answered the send (payment safety R1, R10: `unknownSend`, a send left
  `submitting` past its claim, a batch whose answer was lost). It is in flight, never failed.
- A read of Vestiarion's that failed on a transfer Circle took (`failed` with a provider id and a state Circle has not
  ended) is not a failure: it stays Pending, with "Circle could not be read just now". So is Gateway's `GATEWAY_FAILED`,
  whose attestation may still be minted.
- Copy for Failed and Cancelled says the payee was not paid; it never says "no money moved", since a transaction that
  failed on chain still spent its gas.
- Cost if wrong: a failure shown for a transfer that may still move invites paying it again by hand; these rules follow
  `paymentWasSent` and `lastAttemptOf`, which Approvals already applies.

**L4. "Available" said honestly; no stage the rail does not have.**
- A USDC transfer on Arc is final once confirmed: Arc has no reorganisation to wait for. A confirmed direct payment's
  sixth stage, "In the payee's wallet", is reached with the confirmation and says the USDC is in the payee's wallet on
  the workspace's network.
- A payout to another chain (CCTP, Gateway) reaches it once its mint on the payee's chain is recorded
  (`mint_tx_hash`), named "Minted on" that chain. The live provider records such a payout `confirmed` only with its
  mint.
- A simulated payment reaches no wallet, and says so.
- Nothing says the money is in a bank. Moving USDC to a bank is the payee's own step, which Vestiarion does not see,
  and the step says that.
- Refunds, reversals, chargebacks and disputes do not exist for a USDC transfer: there is no stage for them. The track
  says a refund would be a new transfer back, a separate event, and the guide says the same.
- The business paying a bill itself, outside Vestiarion (`payment_actuals`, the report's "Agent vs what really
  happened"), is a separate event too, never a stage of the payment on Arc.
- Cost if wrong: a stage claiming money is usable where it is not is the mistake this feature exists to stop.

**L5. Reconciled means the books agree.**
- The bill (invoice or milestone) is `paid`, its `tx_ref` is one of the transfer's references (its hash, its mint, or
  Circle's id), and a signed recording entry (`ap_pay`, `approval_paid`, `ap_reconcile`, `milestone_release`,
  `milestone_approval_paid`) names that reference. References compare without regard to case.
- Amounts are not compared with the intent's: the intent keeps its first attempt's amount, and a resend after a
  discount's deadline sends the full one (workspace report R3).
- When the confirmed transfer and the books disagree, the payment carries one **mismatch**: confirmed but not yet
  marked paid (the agent's next cycle marks it); marked paid but not confirmed; marked paid with another transaction;
  marked paid with no signed entry naming the transaction.
- Cost if wrong: a false mismatch makes someone look at a payment that is fine; a missed one hides money the books do
  not show. The mismatch count is a figure finance watches (outstanding mismatch).

**L6. Replay rules: order, duplicates and late facts.**
- Facts are sorted by time, then by stage, then by ledger sequence, so the result is the same in whatever order they
  arrive, and a fact seen twice changes nothing.
- Per attempt:
  - Confirmed is never undone. A failure, a pending read or a "not sent" after it is ignored; a failure is listed as
    a conflict.
  - Circle's terminal end (Failed, Cancelled) is never undone by a pending read. A confirmation of the same attempt
    after it is taken, since money moved, and listed as a conflict.
  - Not sent is the only end that reopens: a later send under the same key (a claim taken again), or any answer from
    Circle about the attempt, replaces it, because "not sent" is Vestiarion's conclusion and Circle's answer corrects
    it.
  - Outcome unknown ends when Circle answers (pending, confirmed, failed) or when the lookup records that Circle never
    took it.
- A new attempt, opened by `begin_payment_retry` only after Circle ended the last one (0036), is the one proven
  correction: the current attempt is the highest, earlier ones are listed with how they ended, and a late fact about an
  earlier attempt changes only that attempt.
- Cost if wrong: a stale fact could show a confirmed payment as in flight, and finance might pay it again by hand, or the
  reverse. Each rule has a test that replays the facts shuffled and repeated.

**L7. Where it shows.**
- **Bills & receivables**: each payable with a payment record shows **Where the payment is** in its card, under "How the
  agent decided", folded like the trail. Its summary says where the payment is now ("Reconciled", "Pending", "Outcome
  unknown" …), with how long a payment in flight has been sent; opened, the seven stages each say when (UTC), from
  which source, and link their entry or transaction. `#settlement-<id>` opens it.
- **Treasury**: **Payments in flight**: every payment sent and not confirmed, oldest first, with how long ago it was
  sent and where it is, and every payment whose books do not match. Its line gives how many, the sum per currency, the
  oldest's age and how many are past the network's `stuckAfterMinutes` (the transfer watch's threshold). A payment past
  it says so in words, not by colour alone. Hidden when there is nothing to show.
- **The receipt (I17)**: a **Status** row says plainly whether the payment is Reconciled (confirmed by Circle, found on
  the chain by this page, and named by the workspace's signed entry) or only Confirmed by Circle, and why it is not
  reconciled just now. The date under the amount says it is when Circle confirmed it.
- Not now: Contractors, the report, the API and webhooks.
- Cost if wrong: one more fold in a card and one more section on Treasury; both are hidden when there is nothing to say.

**L8. The reads.**
- Bills & receivables reads the workspace's invoice payment intents, a page at a time (as the report reads them),
  inside the organization scope, best effort: a read that fails is logged and the cards show no track; the page renders.
- Treasury reads every intent not yet confirmed, and the confirmed intents of the bills its own rows show in flight
  (`matched` invoices, `verified` milestones with a transaction), best effort as well.
- Named columns only, all of them present since 0080 (and 0057 for batches).
- Cost if wrong: one more query on each page; a read that fails hides only the new parts.

**L9. Wording that said paid before it was (I17).**
- The decision trail's `approval_paid` step said "A person approved and paid it." whatever its transfer did. It now
  follows the entry's `status`: `paid` keeps "A person approved and paid it."; `matched` says the payment was sent and
  the network is confirming it; `held` says the transfer failed; an entry without a status says "A person approved
  paying it." The sole approver's wording follows the same rule.
- The reasoning note `[approved and paid by a person]`, which "The transfer failed" or "waiting for Circle to confirm
  it" follows when the transfer did not confirm, now reads "A person approved paying it."
- Checked and kept, each saying sent or confirming until Circle confirms: the console's and chats' answer to Approve and
  pay (`paidMessage`, Slack's `outcomeLine`, Telegram's reply), the agent's activity and its toasts (`ap_pay` matched,
  `milestone_release` verified), the latest-decision line (0088 reads only confirmed payments), payee notices and
  GitHub comments (confirmed live payments only), the outcome badge ("Payment in flight" until `paid`), Treasury's
  "Paid out to date" (paid rows only), the report (confirmed intents only), and the receipt (built only from a
  confirmed intent of a paid invoice).

**L10. No retry before the earlier transfer is reconciled (I18): verified, not changed.**
- `executePayment` (`src/lib/payments.ts`): a confirmed intent is returned as is; one with a provider id is only
  reconciled; a new attempt opens only when `retryTerminalFailure` is passed and Circle, read right then, reports a
  terminal failure, through `begin_payment_retry`, which checks the expected key, `failed`, a provider id and the
  terminal state on the row itself. A send Circle never answered is looked for first (`lookForUnknownSend`) and sent
  again only once Circle lists nothing 15 minutes after it; a lost batch is looked for by its refId.
- Only a person passes `retryTerminalFailure`: Approve and pay (`approveAndPay`, only when no transfer may exist) and
  Pay now on a held milestone (`releaseHeldMilestone`). The cycle's reconcile and the transfer watch never do.
- Tests that hold it: `tests/payments.test.ts` ("reconciles a pending provider transaction without creating a second
  transfer", the terminal-failure retry block, "executePayment after a send Circle never answered"),
  `tests/payment-batch.test.ts`, `tests/approvals.test.ts`.
- The user-facing side: Approvals already says Circle did not answer and that Approve and pay looks for the transfer
  first. The new track says the same wherever the payment is shown: "Circle did not answer when this payment was sent,
  so it may have taken the transfer. Vestiarion looks for it on Circle before anything else is sent, and sends a new
  transfer only once Circle shows none."

## Not now

- The stage on Contractors' milestone cards, in the report, and through `/api/v1` or webhooks (which would need a
  changelog entry).
- A stored history of stages: it would need a table, and every fact the stages come from is already kept.
- Bank availability: Vestiarion does not see the payee's bank.
- A payable `processing` (a person's approval under way) is listed under "Paid and closed" on Bills & receivables; its
  badge says "Being decided by a person". Noted for the page's own grouping, not changed here.

## Testing

- `tests/settlement.test.ts`: the reducer over hand-made facts: every stage and end, failed and cancelled apart,
  not sent reopened by a later send and by Circle's answer, outcome unknown and its ends, a new attempt after a terminal
  failure, late facts about an earlier attempt, confirmed never undone, every permutation of a fact list giving the same
  result, duplicates, the books' mismatches, in-flight totals per currency and pending age past the threshold. The
  facts built from intent rows and ledger entries. The pin of L1.
- `tests/settlement-read.test.ts`: the reads, with a fake Supabase: named columns, paging, the Treasury filter.
- `tests/settlement-track.test.tsx` and `tests/payments-in-flight.test.tsx`: what the track and the Treasury section
  say, with words for every state (never colour alone), and the pages' wiring as source pins.
- `tests/receipts-status.test.ts`: the receipt's Status row for each combination of checks.
- `tests/decision-trail.test.tsx` and `tests/reasoning-copy.test.ts`: the approval step and the note by status.
- `tests/docs-guides.test.ts`: the guide quotes the screens as they are.
