# Receivables paid on Arc: a pay link, and money received matched to what was owed

Date: 2026-10-01. Status: in progress (design decided under the standing autonomy grant; rulings
below carry their cost if wrong).

## 1. Why

Vestiarion pays: payables, milestones, cross-chain payouts. Receivables are only a number in the
forecast (`projected_inflow`).

- Nothing tells a client where to pay.
- Nothing notices when they do.
- An invoice is marked `received` only by hand.

So the agent cannot see cash arrive and act on it, which is half of "an agent that runs a
business's money". It also means one traction figure can never move: total USDC received.

## 2. What it does

- **A pay link per receivable.** An owner or admin chooses **Get paid on Arc** on a receivable and
  gets a public link to send to the client. The page `/pay/<token>` shows:
  - who is asking;
  - the amount and currency;
  - the due date and memo;
  - the workspace's operating address on Arc testnet, with a copy button;
  - one line on how to pay from any wallet.
- **Money in is read from Circle.** Each cycle reads the operating wallet's inbound, completed
  transfers since the last read (Developer-Controlled Wallets `listTransactions`, `txType INBOUND`,
  `state COMPLETE`). Each one is recorded once in `incoming_transfers`.
- **Matched to what was owed.** An inbound transfer settles the open receivable whose currency and
  amount it equals, preferring:
  1. one whose client's address on file is the sender;
  2. then the oldest due.

  The receivable becomes `received`, with the transaction hash, and the ledger records
  `ar_received`. A transfer that matches nothing is kept as unmatched and shown for a person to
  assign.
- **The agent acts on it at once.** The read runs at the start of the cycle, before the payables,
  so cash that just arrived is there for the decisions after it. **I have paid** on the pay page
  asks for a check: rate limited, with a cycle event `payment_received` when something matched.

## 3. Rulings

- **R1 — exact amount, after the receivable, from the client or through its link.** No memo travels
  with a USDC transfer on Arc, so a transfer settles an open receivable of the same currency and amount
  (to the 6th decimal) that existed when it arrived. From the client's address on file it is trusted
  outright (oldest due first); from any other address only when it is the one such receivable and its
  client was sent its pay link. Anything else stays unmatched for a person. Found against testnet-2's
  real inbound transfers: they are all faucet drips of 20 USDC or EURC, which a 20 USDC receivable with
  no address on file would otherwise have swallowed. Cost if wrong: a person settles a few by hand.
- **R2 — the pay link shows only what the client needs.** The link token is hashed, revocable,
  and does not expire while the invoice is open. The page never shows other invoices, names of
  people or the ledger.
- **R3 — recorded once.** `incoming_transfers.circle_tx_id` is unique, so a cycle and a check
  that run together cannot match the same transfer twice. The receivable update is a
  compare-and-set on its open status.
- **R4 — live workspaces only.** A sandbox has no real wallet; its receivables stay as they are.
- **R5 — "I have paid" never trusts the client.** It only asks Vestiarion to look sooner. A
  receivable is `received` only when Circle shows the transfer complete.

## 4. Pieces (draft)

- Migration `0050_receivables.sql`:
  - `receivable_links`;
  - `incoming_transfers`;
  - `pay_link_preview(p_token_hash)`, the public page's read (service role).
- `src/lib/circle/inbound.ts`: lists inbound completed transfers for a wallet.
- `src/lib/agent/receipts.ts`: record, match and settle; the `receipts` stage in the orchestrator.
- `src/app/pay/[token]/page.tsx` and its check action.
- A control on the receivable card.
- Docs: guide section; changelog for `ar_received`.

## 5. Rollout

1. Testnet-2 (live) adds a receivable of 1 USDC from a client.
2. The partner pays it from the arc-canteen wallet to the operating address.
3. **I have paid** → within a minute the receivable is `received`, `ar_received` is signed, and
   the tx is on arcscan.
