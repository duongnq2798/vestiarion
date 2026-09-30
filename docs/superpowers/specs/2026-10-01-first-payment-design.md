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

The steps, in order. Each is computed from rows (G1 still holds).

| # | Step | Done when | Notes |
|---|---|---|---|
| 1 | Add a wallet | the operating account has a Circle wallet (or the workspace is live) | owner; a hosted wallet in one click |
| 2 | Fund it with USDC | the stored operating balance is above 0 (or live) | shows the operating wallet's address with **Copy** and a link to Circle's faucet; while this is the next step, the console reads the balance from the chain every 30 s, for up to 15 minutes, and ticks the step on its own |
| 3 | Go live | the workspace is live | owner |
| 4 | Add a payee with a confirmed Arc address | a non-sample vendor or contractor with an address that is not waiting for confirmation | mentions **Ask for address** (payee links) and confirming an address that arrived through one |
| 5 | Add a payable | the workspace has a non-sample payable invoice | "the agent decides on it within a minute" |
| 6 | First payment on Arc testnet | a confirmed live payment exists | done: links to it on arcscan |

The checklist shows until step 6 is done, not merely until the workspace is live. A live workspace
that has never paid anyone still needs the guide.

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

- **R1: G2 changes for the funding step only.** While "Fund it" is the next step and the operating
  account has a wallet, the console calls the existing balance refresh (`refreshOnChainBalanceAction`)
  every 30 s, for at most 15 minutes. The refresh already holds a 30 s cooldown and a claim, and
  refuses while a cycle runs, so this adds at most two Circle reads a minute for one waiting
  workspace. Every other console view still makes no Circle call. Cost if wrong: a few extra balance
  reads while someone funds a wallet.
- **R2: "Go live" comes before the payee and the payable.** On the old order, a new user's first
  payable was paid in a sandbox with simulated money, and did not count as a first payment. Cost if
  wrong: a user who wants to try things out first still has sample data and the sandbox; the order
  is a suggestion, and every step can be done in any order.
- **R3: time to first payment starts when the workspace is created.** Sign-up time would also count
  people who create a second workspace. Cost if wrong: the figure understates for people who first
  explored a sandbox.
- **R4: the payee step needs a confirmed address.** An address that is waiting for confirmation
  cannot be paid, so ticking the step for it would send the user to a payable the agent must hold.

## 5. Pieces

- `src/lib/getting-started.ts`:
  - the new steps;
  - the input gains `operatingAddress`, the counterparties' role and address timestamps,
    `payableCount` and `firstPayment`;
  - `show` is "first payment not yet".
- `src/components/vx/GettingStarted.tsx`: the address row with `CopyButton`, the faucet link, and
  the first payment's arcscan link.
- `src/components/FundingWatcher.tsx`: a client component that calls the refresh every 30 s for at
  most 15 minutes, and calls `router.refresh()` once the balance is above 0.
- The console page:
  - reads the first confirmed live payment (one `payment_intents` query);
  - passes the operating address;
  - renders the watcher while step 2 is next.
- `supabase/migrations/0042_first_payments.sql`: the `open_first_payments` function.
- `src/lib/platform/open-numbers.ts`, which reads and merges `open_first_payments`; `OPEN_ROWS`,
  which gains two rows and a `duration` format; and the page.
- `npm run numbers`, which prints them.
- Docs: the first-payment guide lists the path in the new order.

## 6. Tests

- **Checklist:** every step's done rule, including an unconfirmed address, a client, sample rows and
  receivables; the order; `show` until the first payment; the address on the fund step; the arcscan
  link.
- **Watcher:** it refreshes on the interval, stops at the cap, stops once funded, and never runs
  without a wallet. Both the timer and the action are faked.
- **PGlite:**
  - the first payment per workspace, and a later payment that does not count;
  - the median;
  - the period, by the first payment's time;
  - the customer/ours split;
  - the grants.
- **Open numbers:** the merge, the duration format, and the rows rendered.

## 7. Rollout

1. The partner runs `npm run db:migrate` (0042).
2. Merge, then check `/open`: our two workspaces show their first payments and the median.
3. Walk the checklist in a fresh workspace, from wallet to a first payment, and time it.
4. Record the result here.

## 8. Rollout record

(pending)
