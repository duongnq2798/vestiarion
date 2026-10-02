# A real USYC reserve on Arc testnet

Date: 2026-10-02. Status: shipped with this PR (design decided under the standing autonomy grant;
rulings below carry their cost if wrong). Roadmap C1.

## 1. Why

The treasury agent has always decided when to sweep idle USDC into a USYC reserve and when to redeem
it before obligations fall due. The reserve itself was simulated: a number in the database, labelled
"simulated" everywhere. USYC on Arc testnet is permissioned. On 2026-10-02 Circle Support
allowlisted the operating and reserve wallets of both live workspaces. On chain, the Entitlements
contract's `canCall` is true for `Teller.deposit`, `Teller.redeem` and USYC transfers.

## 2. What was learned on chain (read-only, 2026-10-02)

- **Teller** (`0x9fdF…105A`, proxy to `Teller`) is ERC-4626-like:
  - `deposit(assets, receiver)` pulls USDC from the caller and mints USYC to `receiver`.
  - `redeem(shares, receiver, account)` burns `account`'s USYC and sends USDC to `receiver`.
- **Prices.**
  - The oracle (18 decimals) updates once per business day, at about 12:31 UTC.
  - `mintPrice()` is the latest price only between that update and 14:00 New York time. Outside it
    is `oracle.nextPrice()`, which is 0.
  - So a deposit outside that window reverts (division by zero).
  - Redeem always uses the latest price.
- **Fees** are zero for these wallets. The FeeManager's free tier is 1,000,000 USDC.
- **Yield.** The price moved from 1.138581 (Sep 28) to 1.138898 (Oct 1), about 3.4% a year.
- **Gas.** The wallets are Circle SCA wallets, whose gas Circle's Gas Station sponsors on Arc testnet.
  An operating wallet's USDC fell by exactly what it paid, so the reserve wallet can call redeem
  holding no USDC.

## 3. Rulings

- **R1 — per workspace, by an owner or admin.** Settings → **USYC reserve** → **Turn on**.
  - It first checks, on chain, that the Entitlements contract lets the operating wallet call
    `deposit` and the reserve wallet call `redeem`. If not, it says which wallet Circle has to
    allowlist, with its address.
  - It is refused while the simulated reserve holds anything, so no simulated balance is ever
    counted as real USYC.
  - `orgs.usyc_live_at` records it (migration 0054). The change is signed as `usyc_reserve_enabled`.
  - Cost if wrong: an allowlisted workspace stays simulated until someone turns it on.
- **R2 — where the money sits.** USYC is held by the reserve wallet; USDC by the operating wallet.
  - A sweep: the operating wallet approves the Teller for the USDC, then deposits with the reserve
    wallet as receiver.
  - A redemption: the reserve wallet redeems, with the operating wallet as receiver.
- **R3 — the reserve's balance is read from the chain**, every reconcile: its USYC × the oracle's
  latest price, in USDC. The stored figure is a cache of it. The notional carve-out from the
  operating balance applies only while the reserve is simulated.
- **R4 — outside the subscription window, no sweep.** The model is told whether USYC can be bought
  now. A sweep it decides while the window is closed is not attempted, and the ledger says why.
  Redemptions are never blocked by the window.
- **R5 — a redemption redeems whole shares** enough to cover the USDC asked, rounded up, and never
  more than the reserve holds.
- **R6 — each move is idempotent per cycle and action.** The Circle idempotency keys are derived
  from the cycle and the step, so a retried cycle never deposits or redeems twice.
- **R7 — what the ledger keeps.** A live move's treasury entry gains `execution`:
  `{ approveTxHash, depositTxHash | redeemTxHash, shares, price }`. Its `earnMode` is `live`.

## 4. What a person sees

- **Settings → USYC reserve.**
  - Off: what it does, the two addresses Circle must allowlist, and **Turn on**.
  - On: when it was turned on, the reserve's USYC and its value.
- **Console.**
  - The reserve account shows real USYC, no "simulated" mark.
  - The provenance strip reads "Yield · USYC reserve · live".
  - A treasury decision links its transaction.
- **The guide** (Go live on Arc testnet) gains "Earn on idle cash with USYC".

## 5. Not in this PR

- A yield rate read from the oracle's history. The reserve's configured APY still prices a sweep.
- Turning USYC off again. It can be added once a reserve can be emptied on request.
