# Milestone escrow

Roadmap X2. A workspace can lock a contractor's milestone payment in an escrow contract on Arc testnet before the work is done. The contractor can see on the chain that the money is set aside for them. When the milestone is verified, the agent releases it from the contract. If it is not verified by a date both sides can read on chain, the workspace can take it back.

## 1. Why

Today a contractor learns they will be paid only when they are paid. For work paid by milestone, this is the gap that escrow closes:

- the money is committed before the work starts;
- the payer cannot quietly take it back;
- release follows the evidence: a merged pull request, or a person's verification.

Vestiarion already verifies milestones and pays them. This feature moves the commitment onto the chain, in a contract whose rules the agent cannot exceed.

## 2. Behaviour

### E1. The contract

`VestiarionEscrow` has one instance per workspace. It is deployed with:
- `token`: USDC on Arc testnet, at `0x3600…0000`;
- `payer`: the workspace's operating wallet.

| Function | Who may call it | When | What it does |
|---|---|---|---|
| `fund(id, payee, amount, refundAfter)` | the payer | `id` is unused, `payee` is not zero, `amount > 0` | Pulls `amount` from the payer (after an `approve`) and records the hold. |
| `release(id)` | the payer | the hold is funded | Sends the amount to the hold's `payee`. |
| `refund(id)` | the payer | the hold is funded and `block.timestamp >= refundAfter` | Sends the amount back to the payer. |

- A hold is released or refunded once, never both.
- Events: `Funded`, `Released`, `Refunded`.
- The payee is the only address a release can pay. Before `refundAfter`, the money can go nowhere else.
- No owner, no upgrade, no other functions.
- Compiled with `evmVersion: "paris"`; Arc testnet rejects `PUSH0`.

### E2. Setting it up

On **Contractors**, an owner or admin of a live workspace presses **Set up escrow**. All of the following are keyed, so a retry repeats nothing:
1. It creates the workspace's escrow deployer, a Circle EOA wallet.
2. It sends 0.1 USDC of gas from the operating wallet to the deployer.
3. It deploys the contract through Circle's Smart Contract Platform from the deployer.
4. It waits for the contract's address.
5. It stores the result in `escrow_contracts` and appends `escrow_deployed`.

### E3. Locking a milestone

On a pending milestone whose contractor has an Arc testnet address, an owner or admin presses **Lock in escrow** and chooses a refund date (default 30 days ahead).

- From the operating wallet, under the request's keys:
  1. `approve(escrow, amount)` on USDC;
  2. `fund(id, payee, amount, refundAfter)`.
- `id` is the milestone's id as `bytes32`, so a milestone has at most one hold.
- The milestone records the hold, and the ledger records `escrow_funded`.

### E4. Releasing it

When the agent pays a verified milestone that has a funded hold, it calls `release(id)` instead of transferring:
- under the payment intent's attempt key, as any payment;
- on the `escrow` route;
- reconciled like any Circle transaction.

The decision and the milestone record the release transaction. If the milestone's amount no longer equals the amount held, the agent holds the payment for a person and sends nothing.

### E5. Taking it back

After the refund date, if the milestone was not paid, an owner or admin can press **Refund from escrow**. It calls `refund(id)`, the milestone records it, and the ledger records `escrow_refunded`.

### E6. What people see

- On a locked milestone's card: "Locked in escrow until <date>", with the funding transaction and the contract linked to Arc's explorer.
- After release: "Released from escrow", with its transaction.
- After a refund: "Refunded from escrow".

## 3. Rulings

- **R1. One contract per workspace, with the operating wallet as its only caller.** No owner or admin key exists beyond the payer itself. A shared contract would need its own access rules; one per workspace needs none.
- **R2. Deployed from an EOA through the Smart Contract Platform.** This is the documented path. The deployer gets just enough USDC for gas.
- **R3. A contract this project wrote, tested in an in-process EVM.** No Circle template fits: the Refund Protocol lets a recipient withdraw at once. It runs on Arc testnet, it has not been audited, and the docs say so.
- **R4. Payee protection is a date, not an arbiter.** Before `refundAfter`, only a release is possible. That is what a contractor can rely on.

## 4. Data

Migration `0047_milestone_escrow.sql`:

- **`escrow_contracts`**, one row per workspace:

  | Column | Type and constraint |
  |---|---|
  | `id` | uuid pk |
  | `org_id` | unique, → orgs, on delete cascade |
  | `address` | text, checked as an address |
  | `circle_contract_id` | text |
  | `deployer_wallet_id` | text |
  | `deploy_tx_hash` | text |
  | `created_by` | → auth.users |
  | `created_at` | timestamptz |

  Tenant RLS, as in 0045.
- **`milestones`** gains:
  - `escrow_state`: `funded`, `released` or `refunded`;
  - `escrow_amount`;
  - `escrow_refund_after`;
  - `escrow_fund_tx_hash`;
  - `escrow_release_tx_hash`;
  - `escrow_refund_tx_hash`.
- **`payment_intents.payout_route`** accepts `escrow`.

## 5. Tests

- **The contract**, in an in-process EVM:
  - fund, release and refund;
  - only the payer may call;
  - refund before the date reverts;
  - a hold cannot be funded twice, or released after a refund.
- **Setup:** keyed and resumable.
- **Locking:** keys and checks.
- **The agent's release path:** escrow route, amount mismatch.
- **Display.**
- **Migration and inventories.**

## 6. Rollout

1. The partner runs `npm run db:migrate` for 0047.
2. In testnet-2, the partner presses **Set up escrow**.
3. The partner locks a 1 USDC milestone for a contractor with an Arc address, then verifies it. The agent releases it.
4. Record the deployment, the funding and the release here.

### Done, 2026-10-01 (PR #105, merged as c23ad10)

**Migration.** 0047 was applied by the partner before the merge. A read-only check confirmed:
- `escrow_contracts` exists, with RLS and both policies;
- milestones have the seven escrow columns;
- the state check includes `funding`;
- `payout_route` accepts `escrow`.

**Setup, testnet-2.**
- Ledger entry #591, `escrow_deployed`.
- The contract is `0x74af203fec3f121ff1cd3a763092d1211487702b`, deployed through Circle's Smart Contract Platform (contract `01a0f75c-dc8f-7d6d-acef-f6b5e22b1d98`). Deployer `0x2590…1a6c`, deploy tx `0x550727a6a205d4d17f6998c06d5ed5ae84a21296466b2e3c348945884b971860`.
- On chain, the contract has 2,279 bytes of code; `payer()` is the operating wallet `0x97f8…b6b6`, and `token()` is USDC `0x3600…0000`.

**The milestone.** "Escrow test – logo files", 1 USDC for the contractor Puka Hotel. Each step, with its ledger entry:

| Time (UTC) | Entry | Step |
|---|---|---|
| 12:10:08 | #592 `create_milestone` | Added. |
| 12:11:06 | #593 `escrow_funded` | Locked until 2026-10-31. Hold id `0x96a6e67c…` is the milestone's id. Fund tx `0x865c3ecc3b4d1f4da44cf4ada127420b3c82a8f83a8f155f0188dad1e5e213ae`, block 64944221. |
| 12:12:14 | #594 `verify_milestone_manual` | Verified by hand. |
| 12:12:39 | #598 `milestone_release` | DeepSeek decided to release, 25 seconds after the verification. Release tx `0x4e196f4c0e75fc0bb7fe7643c605fe3fb059e97f29eb8fe965dd632698b44f87`, block 64944402. |

- **The fund transaction** logs 1 USDC moving from the operating wallet to the escrow, and the contract's `Funded` event.
- **The release transaction** logs 1 USDC moving from the escrow to the contractor `0xba3f…4bfa`, and the contract's `Released` event.
- **The payment intent** is on the `escrow` route, `confirmed` on its first attempt, and its `tx_hash` is the release.
- **The milestone** is `paid`, with `escrow_state = released` and both transactions recorded.
- **The contract's own record:** `holds(id)` answers state 2 (released), the same payee, refund date 2026-10-31 and amount 1.
- **The operating wallet** went from 20.140575 to 19.040575 USDC: 0.1 USDC of gas for the deployer, and the 1 USDC locked.

