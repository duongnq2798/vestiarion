# Test USDC for shadow mode

Date: 2026-10-08. Status: decided (autonomy grant 2026-10-05). Roadmap: SM6 (tameion-roadmap).

## Why

In shadow mode every payment a person agrees to is made in USDC on Arc testnet at the bill's real amount. The operating
wallet has to hold that USDC first. Circle's faucet gives 20 testnet USDC every two hours, so a single real bill of
500 USDC takes more than two days of faucet drips, and a month of a small business's bills cannot be mirrored at all.
That stops shadow mode exactly where it is meant to start: on a business's real bills.

Testnet USDC can be bought in bulk. TestMint (testmint.myproceeds.xyz) delivers 1,000, 5,000 or 10,000 testnet USDC
on Arc testnet for 1, 5 or 10 real USDC paid on Base through x402. Vestiarion buys it once, into a wallet of its own,
and each shadow workspace takes what its open bills need from there.

## Decisions

**T1. One float wallet, in the platform's hosted Circle account.**
- The float is one developer-controlled wallet on ARC-TESTNET in the hosted Circle entity
  (`HOSTED_CIRCLE_API_KEY`, `HOSTED_CIRCLE_ENTITY_SECRET`), in a wallet set named `vestiarion-shadow-float`.
- Its Circle wallet id is set as `SHADOW_FLOAT_WALLET_ID`. Unset, or without the hosted pair, the feature is off and
  the console offers nothing.
- `npm run shadow-float -- setup` makes the wallet, idempotently, and prints its id and address.
  `npm run shadow-float -- status` prints its USDC balance and what each workspace took in the last 7 days and in all.
- The float is filled from outside the code: TestMint (Arc Testnet, recipient the float's address) or Circle's faucet.
  The code never spends real USDC and never calls TestMint.
- Cost if wrong: one more wallet in the hosted entity; nothing a workspace holds is touched.

**T2. Who may add it, and where.**
- An owner or admin (`records.write`, as for a mirror address).
- The workspace is on Arc testnet, live, in shadow mode, and has an operating wallet with an address. Never on Arc
  mainnet, never in a sandbox, never outside shadow mode.
- The platform's stop switch (`PAYMENTS_DISABLED`) stops it too: it moves money on chain like any payment.

**T3. How much: what the open bills need, no more.**
- The amount is the shortfall the console already shows: minus **Safe to spend today**, from the same
  `cashOutlook`, when that figure is below zero. It counts open USDC payables within 30 days, open milestones and the
  treasury's cushion, against the operating wallet's USDC and the USYC reserve.
- At the moment of adding, the server works it out again, with the operating wallet's USDC read from the chain, not
  from the page. The page's figure is only what the button says.
- It is rounded up to the cent and is at least 1 USDC.
- It is capped by what the workspace may still take this week: `SHADOW_FLOAT_WEEKLY_LIMIT` USDC (default 5,000) in
  any 7 days, counted from the workspace's own `test_usdc_added` entries.
- It is capped by the float's own USDC, read from the chain. A float with less than 1 USDC adds nothing.
- Nothing short: "Nothing to add: the operating wallet covers your open bills."
- Cost if wrong: a workspace receives up to its weekly limit of test USDC, which has no value.

**T4. The transfer.**
- Circle `createTransaction` from the float wallet to the operating wallet's address, USDC resolved from the float's
  own token balances by contract (`stablecoinEntry`), fee level MEDIUM, under the same deadline and "may have been
  accepted" handling as a payment (`sendToCircle`).
- Its idempotency key is derived from the workspace and the number of `test_usdc_added` entries it already has: two
  clicks at the same moment compute the same key, and Circle makes one transfer.
- It waits for settlement as a payment does (`awaitSettlement`) and reports confirmed, or still processing.

**T5. The ledger entry.**
- Once Circle accepted the transfer, the workspace's ledger records it:
  - actor `human`, domain `treasury`, action `test_usdc_added`;
  - summary "Added N test USDC on Arc testnet to the operating wallet, from Vestiarion's test USDC float, for shadow
    mode";
  - detail `{ by, amount, from, to, transferId, txHash, status, shortfall, weeklyLimit }`, `txHash` null while Arc
    testnet still confirms it.
- It is written even while the transfer is still processing, so the weekly limit counts it.
- It is money in, not a payment: the payments /open counts, the traction digest and the agreement rate never count
  it. The operating wallets' USDC that /open shows does include it, as it includes faucet drips.
- It reaches webhook endpoints as `ledger.appended`, like every entry.

**T6. Money in is not a client paying.**
- The receipts stage records every inbound transfer, as now. One sent from an address a `test_usdc_added` entry names
  as its `from` is never matched to a receivable, whatever its amount.

**T7. The agent decides again.**
- After the entry, an event cycle starts (`test_usdc_added`), so payables held for cash are decided again within
  seconds, as when cash comes back from the reserve.

**T8. In the console.**
- The **Shadow mode** section gains one line when Safe to spend today is below zero:
  "Your open bills need N USDC more than the operating wallet holds."
- For an owner or admin, with the float configured, a button **Add N test USDC** and beneath it
  "From Vestiarion's test USDC float, on Arc testnet." Others see the line only.
- After adding: "Added N test USDC to the operating wallet." with **View transaction**, or "Arc testnet is still
  confirming it." while it settles.
- When the week's limit is used: "This workspace took its N test USDC for this week. For more, buy testnet USDC from
  TestMint and send it to the operating wallet: ADDRESS." with a link to TestMint.
- When the float has too little: "Vestiarion's test USDC float is empty just now. Use Circle's faucet, or buy testnet
  USDC from TestMint and send it to the operating wallet."

**T9. Documentation in the same change.**
- Shadow mode guide: "Before you start" names the float; a section "Fund it for your real amounts"; the error table's
  rows; `test_usdc_added` in "What the ledger records".
- Changelog: a new ledger action delivered to webhooks.
- `.env.example`: `SHADOW_FLOAT_WALLET_ID`, `SHADOW_FLOAT_WEEKLY_LIMIT`.
- ARCHITECTURE: where the float lives and why it is the only use of the hosted pair outside a hosted workspace.

## Errors

| Code | Message |
| --- | --- |
| `not_in_shadow` | Test USDC is for shadow mode. An owner turns it on in Settings. |
| `mainnet` | Test USDC is for Arc testnet. On Arc mainnet the agent pays your real bills. |
| `not_live` | Go live on Arc testnet first: test USDC goes to the operating wallet. |
| `unavailable` | Vestiarion's test USDC float is not set up on this deployment. |
| `in_flight` | Arc testnet is still confirming the last test USDC. Try again in a minute. (review fix A) |
| `nothing_needed` | Nothing to add: the operating wallet covers your open bills. |
| `limit_reached` | This workspace took its N test USDC for this week. |
| `float_empty` | Vestiarion's test USDC float is empty just now. |
| `payments_off` | The platform's stop switch's own message. |

## Out of scope

- Buying from TestMint in code. It spends real USDC on Base; a person buys.
- Sending mirror wallets' USDC back to the operating wallet. The float is cheap, and money going round in a circle
  reads as less than it is.
- A float on Arc mainnet. There, USDC is real.
- Showing the float's balance publicly.

## Testing

- Pure: the amount (shortfall, rounding, minimum, weekly cap, float cap), the weekly total from entries, the
  idempotency key, the receipts exclusion.
- The library with a fake Circle client and a scoped test database: each refusal, a confirmed grant, a grant still
  processing, the key reused by a second call that counted the same entries.
- The console line and button render for an owner and not for a viewer (component test).
- The docs tests that hold the guide and changelog to the code.

## Review fixes

Decided 2026-10-08 after review, before rollout.

- **A. Circle is the record of what the float sent.** Before deciding, the float's transfers to the operating wallet
  are listed from Circle (`listTransactions`: the float's wallet, the operating address, outbound, Arc testnet), every
  page. One not settled yet (not COMPLETE, CONFIRMED, FAILED, CANCELLED or DENIED) refuses with `in_flight`: "Arc
  testnet is still confirming the last test USDC. Try again in a minute." One that arrived (CONFIRMED or COMPLETE) but
  that no entry names as its `transferId` is recorded first, from Circle's figures: `by: null`, `recovered: true`,
  `shortfall: null`, summary "Recorded N test USDC that Vestiarion's float sent earlier to the operating wallet, on Arc
  testnet". The idempotency key's ordinal is the number of transfers Circle listed, in any state, plus one; the week's
  total is what Circle lists sent in the last 7 days, failed, cancelled and denied transfers aside.
- **B. One entry per transfer.** When Circle answers with a transfer it listed already, or the ledger names it when
  checked right before writing, no second entry is written: a press at the same moment sent it. The entry records the
  amount Circle's transaction reports when it does, and a transaction naming another destination than the operating
  wallet is refused before anything is recorded.
- **C. Nothing is sent that could not be signed for.** The ledger's signing key is resolved as `appendLedgerEntry`
  resolves it (`assertLedgerCanSign`) after the stop switch and before Circle is asked anything.
- **D. Only the float leaves the platform's configuration.** `currentShadowFloat()` gives the float's wallet id and the
  hosted pair, from the configuration the workspace's scope was built from, in place of the whole of it.
- **E. The float's own address is never a client's.** The receipts stage also leaves unmatched a transfer from the
  float's address, read with the hosted pair once per process (`floatAddress`, null when it cannot be read), for a
  transfer whose entry is not written yet. The addresses entries name still count too.
- **F. The console counts each transfer once.** Its week's total counts a `transferId` once and leaves out failed
  transfers, and "Last added" names the newest grant that did not fail.

Not done: a limit across every workspace, or per person. The weekly limit is per workspace.

## Rollout

1. `npm run shadow-float -- setup` prints the float's id and address.
2. The partner buys testnet USDC on TestMint: destination Arc Testnet, recipient the float's address.
3. The partner sets `SHADOW_FLOAT_WALLET_ID` on Vercel and redeploys.
4. In a shadow workspace with a bill larger than its wallet: **Add N test USDC**, then the agent pays it once a person
   agrees.
