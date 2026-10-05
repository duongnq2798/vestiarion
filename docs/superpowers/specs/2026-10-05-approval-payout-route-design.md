# A person's payout to another chain takes the agent's route

Date: 2026-10-05. Status: designed under the standing autonomy grant. The partner had postponed this on 2026-10-01
("tạm thời không làm, sẽ làm sau") and asked for it on 2026-10-05 ("ok tiếp tục"), after a two-approvals proof
failed on it. Amends ruling R7 of `2026-10-01-gateway-payouts-design.md`. Rulings carry their cost if wrong.

## 1. Why

In testnet-2 on 2026-10-05, a 2 USDC payable to a payee on Arbitrum Sepolia was held for two approvals. The agent had
chosen Gateway: a 0.163 USDC fee, paid from a 7.89 USDC Gateway balance. The second approval paid it through CCTP,
because R7 sends a person's first attempt through CCTP. That route has a 0.227 USDC fee, paid from the operating wallet.
The wallet held 2.10 USDC, the approval's funds check compared it with the invoice's 2 USDC alone, and Circle refused the
transfer (`INSUFFICIENT_TOKEN`). Nothing moved, but a payment a person approved failed at Circle instead of being
stopped, or sent the cheaper way, before it left.

## 2. Rulings

- **P1. One rule for the route.**
  - A new payout to another chain goes through Gateway when the workspace's Gateway balance covers the amount and
    Gateway's fee, and Gateway's fee is no higher than CCTP's (or CCTP gave none). Otherwise it goes through CCTP.
  - A route an earlier attempt took is kept (G2, R5).
  - The agent and a person's Approve and pay use the same function (`choosePayoutRoute`, `src/lib/payout-route.ts`).
  - This replaces R7's "CCTP for a first one".
  - Cost if wrong: none known. A person's payout costs what the agent's would.
- **P2. The funds check counts what leaves, from where it leaves.**
  - **CCTP:** the operating wallet must hold the amount plus CCTP's fee, when Circle gave one.
  - **Gateway:** the operating wallet is not touched. The Gateway balance must hold the amount plus Gateway's fee. A
    route pinned to Gateway that the balance no longer covers is refused: "The Gateway balance, X USDC, does not cover
    this payout and its Y USDC fee. Fund Gateway on Treasury first."
  - Both checks are made before any claim.
  - Cost if wrong: a payout refused before sending that Circle would have refused anyway.
- **P3. The fee ceiling is unchanged.** A person's payout's fee may be at most the invoice itself, on either route
  (CCTP payouts review I2, I4).
- **P4. The card says the route.** The Approvals listing reads Gateway's quote as well as CCTP's for a payable to another
  chain, chooses the route by P1, and the confirmation names it:
  - "The Gateway fee, about X USDC, comes on top, from the Gateway balance."
  - "The CCTP fee, about X USDC, comes on top."
- **P5. The ledger.** `approval_paid.payout.route` can be `gateway` for a person's first attempt. This is a changelog
  entry, because webhooks carry it.

## 3. Testing

- `choosePayoutRoute`: Gateway when covered and no dearer; CCTP when Gateway is short, dearer, or has no quote; a pinned
  route is kept.
- Approve and pay:
  - Gateway chosen and passed to the payment step, with the operating wallet not checked;
  - CCTP when Gateway is dearer, with the fee counted in the funds check;
  - a pinned Gateway route the balance does not cover is refused before any claim.
- The AP stage chooses as before (its tests stand).
- The listing's route and fee, and the card's words.

## 4. Rollout

- No migration.
- Proof in testnet-2: approve a small payable to the Arbitrum Sepolia payee. It goes through Gateway, and
  `approval_paid.payout.route` is `gateway`.
