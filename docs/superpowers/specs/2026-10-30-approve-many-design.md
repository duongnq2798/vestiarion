# Approve several bills in one confirmation, paid in one Arc transaction

Date: 2026-10-30. Status: built, branch `feat/approve-many`. No migration: batches use the columns of 0057.

## Why

Approvals pays one bill per confirmation. A person back from a week away, with eight bills the agent held for them,
opens eight dialogs and signs eight transactions, and each transfer pays its own network fee. The operating wallet can
already pay several transfers in one transaction: the contractor stage sends verified milestones together through the
wallet's own `executeBatch` (`docs/superpowers/specs/2026-10-02-batch-payouts-design.md`, R1-R7).

This lets a person select several bills on Approvals and approve them in one confirmation. Each bill is still approved
exactly as **Approve and pay** approves it alone: every check, its own claim, its own signed ledger entry, its own
receipt. Only the confirmation is shared, and, where the bills can share it, the transaction that pays them.

Code comments and test names cite the ids, for example "(approve many AM4)".

## Words used here

- **Selection**: the bills a person ticked on Approvals, sent with one confirmation.
- **Approve alone**: today's **Approve and pay** on one card, `approveAndPay` (`src/lib/agent/approvals.ts`).
- **Prepared**: a bill that passed every check of Approve alone and was claimed (`claim_invoice_decision`), with its
  approvals marked used and its address confirmed, and nothing sent yet.

## The rules

- **AM1. What it does.** A person who may decide payments (`approval.decide`: owners, admins, approvers) selects 2 to
  20 bills on Approvals and approves them with one confirmation. Each is decided as Approve alone decides it. The ones
  that pay now and may share a transaction go out together, through `executePaymentBatch`
  (`src/lib/payments.ts`), so one Arc transaction pays them all. The rest go out one by one, as they would alone.

- **AM2. Which bills can be selected.** The card offers a checkbox, and the server takes the bill in a selection, only
  when all of these hold:
  - the card shows Approve or Approve and pay to this person:
    - the person may decide;
    - it is not being decided by someone else (`processing`);
    - it is not held for an open shadow verdict, which a verdict decides;
  - `payBlockedReason` is null for this person: not their own entry or address unless they decide alone, not screened
    high risk, not their own first of two approvals;
  - it is in USDC;
  - it is paid to an address: no bank payout, and the payee's chain is the workspace's own (not paid across chains);
  - no payment was ever tried for it: no payment intent, which the card reads as `paymentTried` (beyond `lastAttempt`
    and `paymentSent`, it covers a send Circle refused before giving it an id).

  Anything else is approved alone. The server checks the same facts again. A bill in a selection that fails them is
  refused by name ("Approve it on its own: …") and never claimed, and the others are decided.

- **AM3. Size.** From 2 to 20 bills (`MAX_BATCH_SIZE`, one batch), each once. A selection outside that is refused
  whole, before anything is read.

- **AM4. Funds, before anything is claimed.**
  - The full amounts of the selected bills that pass AM2 are added up. Approve alone checks the full amount too; the
    discount comes off only at the transfer.
  - That total is set against the operating wallet's USDC, read as Approve alone reads it: synced on a live provider,
    stored otherwise.
  - Short: nothing is approved, and the person reads "These N bills come to X USDC; the operating wallet holds Y USDC.
    Select fewer, or approve them one at a time, which can bring cash back from the reserve."
  - A selection never brings cash back from the reserve. With the total covered, no single bill is short either.
  - A bill that turns out to need a second approval counts too. That only refuses more often, never pays more.

- **AM5. One after another, each on its own.** The bills are decided in the order the page shows them (due date
  first). Each goes through Approve alone's checks, up to and including its claim. A refusal (`ApprovalError`), or any
  other error while one bill is decided, is reported for that bill and the next one is decided: a bill prepared before
  it is still paid. Above the figure for two approvals, a first approval is recorded and sends nothing (two approvals
  T4), as alone.

- **AM6. Sending.** Once every bill is decided, the prepared ones are paid:
  - Prepared bills paying a new transfer to an address, not through the spending limit contract, go to `payInvoices`
    together, with exactly the request `payInvoice` builds for each: amount after the discount, the payout address, the
    memo.
    - With 2 or more on a network whose wallets are smart accounts, and a provider that batches, they go through
      `executePaymentBatch` and share one `executeBatch` transaction (batch payouts R1-R4). Should it throw, a bill whose
      transfer already has Circle's id, or is confirmed, is read and recorded as sent, never held.
    - Otherwise each goes alone under its own key, as R1 already says, through `executePayment` with its own catch, so
      one bill's error never hides a transfer another one made.
  - A prepared bill paid through the owner's wallet contract (wallet treasury W11) goes alone through `payInvoice`, as
    alone, as soon as it is decided, before the next bill's checks: the contract counts what it paid, so the next bill
    is checked against its daily and 7-day limits with it counted, and refused by name before its claim, as when they
    are approved one after another.
  - If sending throws, every prepared bill that has no result is given back as Approve alone gives one back
    (`giveBackAfterClaim`). The error is reported for each.

- **AM7. Recording.** Each bill's invoice row and its `approval_paid` entry are written exactly as Approve alone writes
  them, with two more fields:
  - `batch: { key, size }` when its transfer shared a transaction (the execution's `batch`);
  - `approvedTogether: N`, how many bills the person chose in this one confirmation.

  A bill paid in a batch has " [paid in one Arc transaction with N other bills]" added to its reasoning, as a milestone
  in a batch does.

- **AM8. Failure.**
  - A batch Circle ended in a terminal failure fails every member. Each bill is held with Circle's reason, as a failed
    approval leaves it, and its next approval is a transfer of its own (batch payouts R7).
  - A batch whose answer was lost leaves each member submitted (`matched`). Each is looked for on Circle by the batch's
    refId and never sent again (R5), as for milestones.

- **AM9. The reason.** When any selected bill goes against the agent's hold (`overridesHold`), the confirmation asks
  one optional "Why pay them anyway?". The answer is kept for each such bill whose approval decided a new payment
  (capability and reasons R10), as Approve alone keeps it.

- **AM10. After.** Payees hear of confirmed payments once, through one `sendNoticesSoon`, and the console's pages are
  revalidated once.

- **AM11. What the person reads.** One line per bill:
  - **Paid**, with its amount;
  - **Submitted**, awaiting confirmation;
  - **Approved**, one more approval pays it;
  - **Not paid**, with the reason.

  When bills shared a transaction, the result also says "Paid N bills in one Arc transaction" with **View transaction**.
  The selection then clears.

- **AM12. Keys.** On Approvals:
  - `j` and `k` move focus to the next and previous card;
  - `x` selects or deselects the focused card when it can be selected;
  - `a` opens the confirmation for the selection;
  - `Escape` clears the selection.

  No key does anything while typing in a field, with Ctrl, Meta or Alt held, or while a dialog is open. No key pays:
  the confirmation's button does. A short line beside the selection names the keys.

- **AM13. Where.** The console's Approvals page only. Slack approves one bill at a time, as before, where an owner lets
  bills be decided there; Telegram, Discord and the API approve none. An accountant's co-sign is never part of a
  selection.

## Where it is

- `src/lib/agent/approvals.ts`:
  - `approveAndPay` is split, with no change to what it does: `prepareApproval` (every check through the claim, the
    reserve cash, approvals used, address confirmed, frozen re-check) returns either a finished result or a prepared
    bill;
  - `recordApproval` writes the invoice row and the `approval_paid` entry from a prepared bill and its transfer result;
  - `approveAndPayMany` runs AM2-AM8 over a selection.
- `src/lib/agent/pay.ts`: `payInvoices`, the same request and the same result as `payInvoice`, for several bills
  through `executePaymentBatch` where they can share a transaction, else each alone, with one balance sync.
- `src/lib/commands/payables.ts`: `approvePayables`, the command, as `approvePayable` does for one (gate, reasons,
  notices).
- `src/app/actions/approvals.ts`: `approveManyAction`.
- `src/components/approvals/`: the selection, used by `ApprovalCard` and the page:
  - `selection-context.ts`: the context a card offers its bill to, and `useSelectableBill`;
  - `ApprovalSelection.tsx`: the selection around the list of cards, its bar and its keys;
  - `ApproveSelectionDialog.tsx`: the one confirmation, then the result;
  - `SelectBill.tsx`: the card's checkbox;
  - `keys.ts`: which key does what, and when none does (AM12).
- `src/components/ApprovalCard.tsx`: `selectableInSelection`, AM2 from the card's own facts.

## What it does not do

- No selection of shadow verdicts. Agreeing with several decisions at once is another feature.
- No cash back from the reserve for a selection (AM4).
- No bank payouts, payouts to other chains, EURC, or retries in a selection (AM2): each of those is its own transfer
  anyway.
- No new API or webhook. The new ledger fields (`batch`, `approvedTogether`) show wherever ledger entries do.
