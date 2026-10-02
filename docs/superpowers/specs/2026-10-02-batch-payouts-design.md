# Batch payouts: several milestones in one Arc transaction

Date: 2026-10-02. Status: shipped with this PR (design decided under the standing autonomy grant;
rulings below carry their cost if wrong). Roadmap T10.

## 1. Why

A cycle that releases three milestones sends three transfers: three Circle transactions, three
settlements, three fees. The operating wallet is a Circle smart account, and a smart account can
make several calls in one transaction: Circle documents a contract execution whose contract is the
wallet itself, calling its `executeBatch((address,uint256,bytes)[])` ("Batch operations"). The
wallet then calls each target as itself, so a USDC `transfer` inside the batch is a transfer from
the operating wallet, exactly as if it had sent it alone.

The first version used Arc's **Multicall3From** instead; see §6 for why it could not work.

The decision stays per payment. Each milestone is still decided by the model, checked by code
(high risk, payment limit, spending limit), and signed on its own. Only the sending is shared.

## 2. What it does

- In the contractor stage, the agent first decides every verified milestone, as before. Releases
  that pass every check are collected instead of sent one by one.
- If two or more of them are plain USDC transfers on Arc, they go out together. That is one Circle
  contract execution of the operating wallet's own `executeBatch`, with one
  `[USDC, 0, transfer(payee, amount)]` call per milestone. Either every transfer in the batch
  happens, or none does: the wallet reverts them all if one fails.
- Each milestone keeps its own payment intent, status, ledger entry and receipt. They share one
  transaction hash. The ledger entry's `execution.batch` says how many were sent together and
  under which batch key.
- One release alone, or a release from escrow, is sent as it always was.

## 3. Rulings

- **R1 — what may be batched.** All of the following:
  - a release that passed every guardrail in this cycle, while the agent is not paused;
  - USDC on Arc testnet (contractors are always paid on Arc);
  - not locked in escrow (a release from escrow is its own contract call);
  - its payment intent is new, so no transfer was ever sent for it.

  Anything else is paid alone, as before. At most 20 transfers go in one batch; more are split
  into batches of 20.
- **R2 — all or nothing, so only when the money is there.** A batch reverts as a whole if any
  transfer in it fails. So a batch is sent only when the operating balance covers its total.
  Otherwise each release is paid alone, as before, and as many as the balance allows go through.
- **R3 — keys.** Each payment keeps its own idempotency key (attempt 1, from its source). The
  batch's Circle key is derived from its members' keys, sorted
  (`vestiarion/payment-batch/v1/<keys>`). The same set of payments always has the same batch key.
  The batch key is also the transaction's `refId`, so the batch can be found on Circle by it.
- **R4 — the batch is recorded before it is sent.** Every member is claimed. Then one `UPDATE`
  writes the batch key, its size and when it was sent on all members at once. Only then is Circle
  called. If the write did not reach every member, it is undone and nothing is sent.
- **R5 — a batch whose answer was lost is found, never sent again.** If Circle's answer never
  came (a timeout, or the process stopped), a member has a batch key but no Circle id. Sending it
  again alone, under its own key, could pay twice if Circle had accepted the batch. So the next
  time the payment is reconciled, the agent looks the batch up instead. It lists the operating
  wallet's transactions around the time the batch was sent and looks for its `refId`.
  - Found: the batch's Circle id and hash are recorded on every member, and it is reconciled like
    any transfer.
  - Not found yet, less than 15 minutes after it was sent: the milestone stays verified and is
    looked for again next cycle.
  - Not found after 15 minutes: Circle never accepted it. The batch is released on every member
    still without a Circle id. Each is then an ordinary payment that was never sent, and the next
    attempt sends it alone, under its own key, with the usual checks (a contractor now screened
    high risk is not paid).
- **R6 — fees are shared.** The batch's fee is split equally between its members, so totals and
  medians stay per payment.
- **R7 — retries.** If Circle ends a batch in a terminal failure, every member is failed with it.
  A later attempt of any member (only a person opens one) is a single transfer under that
  attempt's own key. A batch is only ever made of first attempts.

## 4. Data

Migration `0057_payment_batches.sql` adds three nullable columns to `payment_intents`:
`batch_key`, `batch_size` and `batch_sent_at`, with an index on the batch key. Before it is
applied, the agent never batches: a write of the batch columns fails, and the batch falls back to
single payments.

## 5. API and webhooks

- `milestone_release` ledger entries for a batched payment carry `execution.batch`:
  `{ key, size }`. `execution.txRef` is the batch's transaction, shared with the other members.
- A transaction hash is no longer unique to one payment. Integrators who key on it should key on
  the milestone or invoice id.

## 6. What happened first

The first version (PR #128) sent the batch as `aggregate3` on Multicall3From
(`0x522fAf9A91c41c443c66765030741e4AaCe147D0`). Its first live batch, three milestones in testnet-2,
was refused by Circle at estimation: `ESTIMATION_ERROR`, "sender spoofing requires tx.origin as
sender". Arc's CallFrom precompile keeps the sender only when the sender is `tx.origin`, and a smart
account's transaction is sent by Circle's bundler, so `tx.origin` is never the wallet. No money
moved; the three milestones were held, as a terminally failed transfer is.

The `eth_call` that cleared it before merging called Multicall3From with the wallet as the sender,
which makes the wallet `tx.origin` too, so it could not see this. The check for this version
simulates `executeBatch` from EntryPoint v0.7, the path a user operation takes: three transfers
succeed from the testnet-2 and founding wallets (gas 123,678), an overdraft in any of them reverts
the whole batch, and a call from any other address reverts.

PR #129 turned batches off for live workspaces until this version.

## 7. Proof

Done when a batch of three or more milestones is paid in one Arc testnet transaction in
production, each with its own signed `milestone_release` entry naming the same transaction.
