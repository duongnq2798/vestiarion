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
- **K1. A live workspace screens for real.**
  - Where the deployment has no `OPENSANCTIONS_API_URL`, a live workspace's counterparties are not screened "clear" by
    the demo list. They stay `unscreened`, and the agent pays them nothing (the unscreened hold).
  - Sandboxes keep the demo list.

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
