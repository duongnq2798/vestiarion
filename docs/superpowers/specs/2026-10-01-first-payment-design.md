# First payment in minutes

Date: 2026-10-01. Status: approved for implementation (decided under the standing autonomy grant;
rulings carry their cost if wrong).

## 1. Why

A workspace is only useful once the agent has paid someone on Arc testnet. Today the console's
Get started checklist stops short of that. It ends at "Go live" and disappears there, so the step
that matters, the first payment, has no guide at all. The checklist is also ordered for a sandbox:
it asks for an invoice before going live, so that invoice is paid with simulated money.

Two steps cost the most time for a new user, and both are manual:

- funding the wallet: find the address in Settings, open the faucet, come back, and press refresh;
- collecting a payee's address.

Both now have tools: payee links (T2), and the agent acting within a minute (event-driven cycles).
This change points the checklist at them. It also measures how long the path takes, so the claim
"first payment in minutes" is a number on `/open`, not a slogan.

## 2. The checklist

The steps, in order. Each is computed from rows the console already reads (G1 and G2 still hold:
no stored state, no extra query, no Circle call on the console).

| # | Step | Done when | Next-step guidance |
|---|---|---|---|
| 1 | Add a wallet | the operating account has a Circle wallet (or the workspace is live) | owner; Settings |
| 2 | Fund it with USDC | the stored operating balance is above 0, live or not (R6) | Settings shows the address and the faucet, and now reads the balance again by itself (R1) |
| 3 | Go live | the workspace is live | owner; Settings |
| 4 | Add a payee with an Arc address | a vendor or contractor a person added, with an address that is not waiting for confirmation | points at **Ask for address**; when the only payee's address is unconfirmed, says to confirm it |
| 5 | Add a payable | an open payable (not paid, not rejected) of a counterparty a person added | within the payee's limit, with a PO reference and goods received, or the agent asks for information |
| 6 | First payment on Arc testnet | the workspace has a paid invoice or milestone with an on-chain transaction (`stats().onchainTransfers`) | links to **Approvals** while the agent holds something for a person, otherwise to AP / AR |

The checklist shows until the workspace is live and step 6 is done (R7), not merely until it is
live. A live workspace that has never paid anyone still needs the guide. **Read the guide** opens the Go live guide while a
Settings step is left, and the first-payment guide after that.

## 3. On `/open`

Two new rows, per side (customers, ours, total), for workspaces whose **first confirmed payment on
Arc testnet** falls in the period:

- **First payments on Arc testnet**: how many workspaces made their first one.
- **Median time to first payment**: from the workspace's creation to that payment, for those
  workspaces. It is shown as minutes, hours or days.

They come from a new function, `open_first_payments(p_since)`, in migration 0042. It is a
`security definer` function with an empty `search_path`, executable by the service role only, and
it uses the same side rule as `open_numbers` (R3 of the open numbers spec). It is separate from
`open_numbers`, which the EURC branch's 0040 redefines, so the two branches cannot overwrite each
other's definition.

## 4. Rulings

- **R1: the balance is read again where the funding happens, not on the console.** In Settings, the
  Go live panel's balance line already reads the operating balance from Circle once when it opens.
  While that balance is 0 or unread, it now reads it again when the tab becomes visible (coming back
  from the faucet), and every 30 s while the tab is visible, for up to 15 minutes after the panel
  opened. It stops once the balance is above 0, and never runs for a sample balance. G2 is
  unchanged: the console makes no Circle call. Cost if wrong: at most 30 balance reads for one owner
  who leaves Settings open on an unfunded wallet.
- **R2: "Go live" comes before the payee and the payable.** On the old order, a new user's first
  payable was paid in a sandbox with simulated money, and did not count as a first payment. Cost if
  wrong: a user who wants to try things out first still has sample data and the sandbox; the order
  is a suggestion, and every step can be done in any order.
- **R3: time to first payment starts when the workspace is created.** Sign-up time would also count
  people who create a second workspace. Cost if wrong: the figure understates for people who first
  explored a sandbox.
- **R4: the payee step needs a confirmed address.** An address that is waiting for confirmation
  cannot be paid, so ticking the step for it would send the user to a payable the agent must hold.
- **R6 (review I2): funding stays undone while the operating wallet holds no USDC, even when live.**
  Going live does not check the balance, and the checklist now outlives going live, so ticking
  funding for any live workspace would lead to payables the agent cannot pay. The stored balance is
  current on the console (its balance tile reads the chain and stores it). Cost if wrong: a live
  workspace briefly sees "Fund it" undone before the tile's first read lands.
- **R7 (review minor 1, re-graded): the checklist hides only when the workspace is live and has
  paid.** A sandbox with Circle connected can already pay on chain; hiding then would drop the guide
  to going live, and a sandbox is deleted when inactive. Cost if wrong: none found.
- **R8 (review I3): the first-payment figures fail on their own.** When `open_first_payments` cannot
  be read, the two rows show a dash and every other figure still shows, so a deploy that lands
  before migration 0042 cannot blank `/open`. Cost if wrong: two dashes until the migration runs.
- **R5: "first payment" is an on-chain transfer the console already counts.** `stats()` counts paid
  invoices and milestones whose transaction is not a simulated one. Reusing it keeps G1's "no extra
  query". Cost if wrong: none found; a simulated payment never has an on-chain transaction.

## 5. Pieces

- `src/lib/getting-started.ts`: the six steps; the input gains the counterparties' name, role and
  address timestamps, `payableCount` (was `invoiceCount`), `onchainPayments` and `waitingCount`;
  `show` is "no on-chain payment yet"; `ownPayableCount` replaces `ownInvoiceCount`.
- `src/components/vx/GettingStarted.tsx`: the guide link by stage.
- The console page passes `dashboardStats.onchainTransfers` and `needsReview`.
- `src/lib/funding-watch.ts`: when the balance line should read again (pure, tested); the Go live
  panel's `BalanceLine` wires it to an interval and `visibilitychange`.
- `supabase/migrations/0042_first_payments.sql`: the `open_first_payments` function.
- `src/lib/platform/open-numbers.ts` reads both functions and merges the figures into each side;
  `OPEN_ROWS` gains two rows and a `duration` format; `npm run numbers` prints them.
- Docs: the go-live guide's checklist paragraph and its screenshot (`go-live-checklist`), the
  balance line's new behaviour, and the first-payment guide's opening.

## 6. Tests

- **Checklist:** every step's done rule, including an unconfirmed address, a client, sample rows and
  receivables; the order; `show` until an on-chain payment; step 6's link while something waits;
  the guide link by stage; the console wiring pin.
- **Funding watch:** reads again when visible, unfunded, within 15 minutes and not already reading;
  never for a sample balance, a funded wallet, a hidden tab, or after the cap.
- **PGlite:** the first payment per workspace, and a later payment that does not count; a simulated
  or failed payment that does not count; the median; the period, by the first payment's time; the
  customer/ours split; the grants.
- **Open numbers:** the merge, a missing median, the duration format, and the rows rendered.

## 7. Rollout

1. The partner runs `npm run db:migrate` (0042).
2. Merge, then check `/open`: our two workspaces show their first payments and the median.
3. Walk the checklist in a fresh workspace, from wallet to a first payment, and time it.
4. Record the result here.

## 8. Rollout record

(pending)
