# Payment safety before real money: a stop switch, valid addresses, no reject over an unknown transfer, screening that fails closed

Date: 2026-10-05. Status: designed under the standing autonomy grant (partner, 2026-10-05: "Nếu thấy architecture/flow
hiện tại có điểm chưa đủ an toàn cho mainnet, chủ động đề xuất và sửa từ bây giờ"). Rulings carry their cost if wrong.
Source: the mainnet readiness review (artifact "Vestiarion Mainnet Plan", version 2), which mapped the money flow step by
step.

## 1. Why

The review found four places where real money would be unsafe today, each small enough to fix on Arc testnet now, so the
fixes have run for days before any mainnet workspace exists:

- **S. No stop switch for the platform.**
  - A workspace can pause its agent, but that does not stop a person's payment. Nothing stops every payment at once
    when a bug is found.
- **A. An address typed into the console is not checked.**
  - The form keeps any 200 characters (`optionalText(200)`), and the API checks only `0x` plus 40 hex characters.
  - A mistyped character is money sent to no one.
- **R. A person can reject a payable whose transfer Circle may have accepted.**
  - When `createTransaction` times out, the intent fails with no provider id, though Circle may have taken the transfer
    under its idempotency key. Reject is allowed then, and closes a bill whose money may be leaving.
- **K. A live workspace can screen against the two-name demo list.**
  - Without `OPENSANCTIONS_API_URL`, every name but two comes back "clear", in a live workspace too.

## 2. Rulings

- **S1. `PAYMENTS_DISABLED`.**
  - When the deployment's environment sets it (`1`, `true` or `yes`), nothing moves money on any chain: no payment to a
    payee by any route, swap, USYC sweep or redemption, Gateway deposit, escrow lock, release or refund, or spending-limit
    contract write.
  - Reads keep working: balances, the status of a transfer already sent, every page.
- **S2. Where it is checked.**
  - At the live chain provider's money methods (`transfer`, `batchTransfer`, `depositToEarn`, `withdrawFromEarn`,
    `swapForEurc`), and at the start of every direct Circle write (escrow holds and setup, Gateway funding,
    spending-limit setup).
  - This is the backstop: no path can move money around it.
- **S3. The agent does not start.**
  - `runAgentCycle` refuses while payments are off, so no decision is made and nothing is held that would need undoing.
  - The schedule reports each workspace as skipped, event cycles drop quietly, and a person's Run cycle says why.
- **S4. A person is told before anything is claimed.**
  - Approve and pay, Pay now on a milestone, Bring cash back and Fund Gateway refuse at once with "Payments are switched
    off for every workspace right now".
- **S5. Seen.** The console says that payments are switched off for every workspace, so no one mistakes it for a stuck
  agent.
- **S6. Rulings made while building it.**
  - The switch is a config value (`paymentsDisabled`, read once by `configFromEnv`), as every setting is.
    `getChainProvider` hands it to the live provider. Only a plain `1`, `true` or `yes` turns it on; anything else
    leaves payments on, as unset does.
  - Turning the spending limit off stays allowed while payments are off. It only takes the agent's power to pay away,
    which is what someone stopping payments wants. Cost if wrong: a little USDC is spent as gas for the revoke.
  - A batch refused by the switch is a batch that never left (`BatchNotSentError`). Each payment then goes alone, and
    `transfer` refuses in turn, so no member is left waiting to be looked for on Circle.
  - The schedule and the FX watcher skip every workspace outright (`payments_off`), without entering any of them.
  - A budget change on a workspace that enforces its limit on Arc is refused, as when Circle refuses the change. Its
    figures are saved only once the contract holds them.
- **A1. Addresses are checked where they enter.**
  - On the console form and the API, an Arc address must be `0x` followed by 40 hex characters.
  - When it mixes upper- and lower-case letters, it must be a valid EIP-55 checksum.
  - All lower-case or all upper-case is accepted as written: no checksum to check.
  - Applies to the add form and to every address edit.
- **A2. Not here.** Payee links and GitHub `/payto` already validate. Addresses already stored are left as they are.
- **R1. A transfer that may exist is never closed over.**
  - Reject and Return are refused while the invoice's intent failed with no provider id and no recorded answer from
    Circle, which is what a timeout leaves. The card says that Circle may have taken the transfer, and that approving
    checks it, sending nothing twice.
  - A failure Circle answered (a refusal with a reason) still allows Reject.
- **R2. What counts as no answer.** Circle never said what became of the send:
  - the 20-second deadline ran out;
  - the connection dropped after the request left (any network error but a connection never made: refused, DNS,
    unreachable);
  - Circle answered 5xx;
  - or it answered with no transaction id.
  - Gateway's transfer is the same: no answer, a 5xx, or no transfer id.
  - The provider writes "may or may not have been accepted" into the error, and that phrase is what the rule reads, so
    no migration is needed.
- **R3. What a person sees and can do.**
  - Reject, Return and Add details refuse with `payment_unknown`, saying why.
  - The card says Circle may have taken the transfer, and that approving asks Circle again under the same key.
  - Approving skips only the balance check, which the transfer Circle may hold could already have lowered. Circle's
    idempotency returns the original transfer when it holds one, and sends it when it does not. So every other check
    still applies, as to a new payment: risk, limit, an unconfirmed address, the new payee check, who may approve.
  - A held milestone cannot be closed, and its card says the same.
  - Cost if wrong: a person who changed their mind after approving cannot reject until Circle answers. Approving then
    completes the payment they approved.
- **K1. A live workspace screens for real.**
  - Where the deployment has no `OPENSANCTIONS_API_URL`, a live workspace's counterparties are not screened "clear" by
    the demo list. They stay `unscreened`, and the agent pays them nothing (the unscreened hold).
  - Sandboxes keep the demo list.
- **K2. Rulings made while building it.**
  - `orgConfig` marks a live workspace on a deployment with no service (`compliance.serviceRequired`). Its screening
    then fails, and the failure is recorded as any outage is: a counterparty with no verdict stays `unscreened`, and the
    sweep says it is incomplete.
  - No demo-list verdict can reach a live workspace from before. Going live deletes the sandbox's counterparties
    (migration 0029), and with the service on, a verdict from another source is screened again at once.
  - Production changes nothing today. A read-only probe on 2026-10-05 found every live workspace's cycles of the last
    three days screened with the service. The rule guards a deployment that forgets `OPENSANCTIONS_API_URL`.
  - The workspace header names the source: OpenSanctions, the bundled list, or "no service".

## 3. Testing

- **S:**
  - the provider's money methods refuse, and its reads still answer;
  - each direct writer refuses;
  - `runAgentCycle` refuses, and the schedule reports skipped;
  - approval, Pay now, Bring cash back and Fund Gateway refuse before any claim;
  - the console says so.
- **A:** the form and the API refuse a bad checksum and a short or long address; they accept a valid checksum and one
  case alone.
- **R:**
  - Reject and Return are refused over a timeout's intent;
  - they are allowed over a refused one;
  - the card says why.
- **K:** a live workspace with no screening service leaves counterparties unscreened; a sandbox still uses the list.

## 4. Rollout

- No migration.
- Turning the switch on is a Vercel environment change and a redeploy; turning it off, the same.
- Proof on testnet: set `PAYMENTS_DISABLED` on a preview deployment and see the cycle skip and Approve and pay refuse;
  type a mis-cased address on Counterparties and see it refused.

## 5. After review (2026-10-05, follow-up to PR #205)

A fresh review of the merged branch found that a send Circle never answered was still sent again blind, and that the
switch, read once per deployment, did not reach a console tab that Vercel's skew protection keeps on an older
deployment. These rulings replace the parts of R1–R3 and S1 they name.

- **R4. Look, never send again blind.**
  - A payment whose send Circle never answered is looked for on Circle before anything is sent again. That is either a
    failed intent with no provider id and the marker, or one left `submitting` for more than 2 minutes.
  - It is looked for by its reference in the wallet it was sent from, around the time it was sent, and nothing is sent
    while it is looked for.
  - **Found:** recorded and reconciled.
  - **Not listed 15 minutes after the send:** Circle never took it. The intent records that Circle has no transfer for
    it, and the next send goes as a new payment.
  - **Still inside those 15 minutes, or the lookup did not complete:** nothing is sent, and the intent stays unknown.
  - **Routes Circle cannot look up this way keep their own safety.**
    - Gateway's transfer is the same spec, spent once.
    - CCTP's steps are the same keys on the same wallet.
    - A batch is looked for by its own key, as before.
- **R5. The reference and the wallet.**
  - The reference is the payment's memo (`Invoice <id>`, `Milestone <id>`), unique to its source. The transactions of
    earlier attempts are left out.
  - The wallet is the operating wallet, or the agent's own for a payment through the spending limit contract. The intent
    records which when the send starts (`payment_intents.sent_wallet_id`, migration 0074).
- **R6. Reject, Return, Add details and Close look too.**
  - Circle has none: allowed.
  - Found: refused as sent, unless Circle ended it in a terminal failure.
  - Still being listed: refused, saying when to try again.
  - So no unknown send is a dead end. That includes one to a counterparty since screened high risk.
- **R7. An unknown send stays unknown until Circle answers about it.** A send of a Gateway or CCTP payment again that
  fails without that answer keeps the marker.
- **R8. Nothing is marked where nothing could have left.** CCTP's approve step moves no money, and a Gateway connection
  never made sent nothing.
- **R9. A transfer Circle took but we failed to record keeps the marker,** so it is looked for and found, never
  rejected over.
- **S7. The switch is in the database too.**
  - `platform_controls.payments_disabled_at` (migration 0074) is set and cleared with `npm run payments -- off
    "<reason>"` and `npm run payments -- on`.
  - Every check reads it, cached for 10 seconds, so every running deployment stops at once, with no redeploy. That
    includes one a tab is pinned to.
  - `PAYMENTS_DISABLED` still works; either one stops payments.
  - A read that fails stops money, never a page.
- **S8. Records keep working while payments are off.** Approve and pay, and Pay now, go through when the transfer
  already exists, because they only read Circle; the provider still refuses any send.
- **S9. The agent's purchases from its service budget (x402) check the switch too.**
- **A3. A checksum failure says so** on the address edit, the payee link and `/payto`, instead of a message about the
  address's length.
