# Spending limit contract v2: pay another chain from the owner's own wallet

Date: 2026-10-19. Status: built. Follows `2026-10-19-mainnet-base-payouts-design.md` (B3), which left this as the
follow-up. Migration: `0132_spending_limit_v2.sql` (new columns only, safe to run before or after the deploy).

## Why

A workspace that pays from the owner's own wallet (`wallet_host = 'external'`, "path C") moves USDC only through its
`VestiarionSpendingLimit` contract, from the agent's wallet. The agent's wallet holds gas and nothing else (wallet
treasury W4). Version 1 of the contract does one thing: `transferFrom(treasury, to, amount)`. USDC sent that way to
TokenMessengerV2 is not burned; it is lost. So since #453 a vendor on Base can be paid from Arc mainnet only by a
workspace on its own Circle account. Path C is the default for new mainnet customers, and the only live mainnet
workspace is on it. Its Base vendors are held (`workspace.onchain_limit_route`), refused for a person, and refused by
the wallet provider (`WALLET_CONTRACT_ONLY`).

## The contract (V1–V6)

`contracts/VestiarionSpendingLimitV2.sol`. Version 1 stays byte for byte, because deployed contracts are checked
against its code.

- **V1. Everything version 1 does, unchanged.** Same `pay`, `setLimits`, figures, `spentOn`, `paid`, events and
  errors. `VERSION()` returns 2. Version 1 has no `VERSION`, so a call to it reverts.
- **V2. `payAcrossChains(amount, maxFee, domain, recipient, ref)`, for the agent only.** In this order:
  1. It counts `amount + maxFee` against the daily and the 7-day figure, and marks `ref` paid. The `paid` mapping is
     the one `pay` uses, so a ref leaves once by either function.
  2. It does `transferFrom(treasury, this, amount + maxFee)`.
  3. It approves TokenMessengerV2 for that total.
  4. It calls `depositForBurnWithHook(total, domain, recipient, USDC, bytes32(0), maxFee, 1000, "cctp-forward")`.
     This is the same burn the operating wallet's bridge sends (CCTP payouts X2). Circle's Forwarding Service submits
     the mint, so nothing is needed on the payee's chain.
  5. It emits `PaidAcrossChains(ref, domain, recipient, amount, maxFee, day)`.
- **V3. TokenMessengerV2 and the allowed domains are immutables.** They are set at deployment from the network profile:
  - Arc mainnet: `0x28b5a0e9…cf5d`, domain bitmask `1 << 6` (Base).
  - Arc testnet: `0x8FE6B999…2DAA`, the bitmask of its CCTP payee chains.

  `payAcrossChains` refuses any other domain (`DomainNotAllowed`). These are part of the code the server checks at
  deployment (wallet treasury W8). A contract wired to another messenger or other domains is not Vestiarion's.
  Adding a chain later means a new deployment.
- **V4. The fee is capped on chain.** `maxFee` must be at most 10% of `amount` (`MAX_FEE_BPS = 1000`, the same 10% as
  `bridge.fee_above_cap`) and at most 2 USDC (`MAX_FEE_UNITS`). Otherwise the call is refused with
  `FeeTooHigh(maxFee, cap)`. The agent cannot send value into fees beyond that. Arc to Base costs about 0.054 USDC
  today. The app reads the same caps, and holds a payout whose fee is past either cap before anything is sent.
- **V5. The contract holds nothing after a call.** Its USDC balance after the burn must equal its balance before. Its
  allowance to TokenMessengerV2 must be 0. Otherwise the whole call reverts (`BalanceLeft`).
- **V6. Unaudited and minimal.** No upgrade path, no owner functions beyond `setLimits`, no recovery of stray tokens.
  `token` and `tokenMessenger` are trusted immutables, and every state change comes before the external calls. Written
  for Arc and not audited, as version 1 is. The repo's README and Security page say so.

## Versions in the app (V7–V10)

- **V7. `artifact.json` holds both versions** under `v1` and `v2`.
  - `npm run spending-limit:compile` writes both.
  - The contract test fails when either committed artifact is not what its source compiles to.
  - `deployment.ts` builds either version's creation code; v2 needs the messenger and the domains.
  - `spendingLimitTerms(network)` gives the terms a network deploys v2 with, or null for a network without CCTP.
- **V8. New setups deploy v2** where the network has CCTP, on both routes:
  - the browser wallet's deployment;
  - the passkey's one user operation, whose address follows from the v2 code.

  `verifyDeployedAt` accepts the code of either version for this USDC, wallet and agent, and says which. A passkey
  setup that was sent as v1 before this change and never recorded is still recorded as v1.
- **V9. `spending_limit_contracts.version` (1 or 2) records which one carries the payments.** Default 1, so every
  existing row is v1. The upgrade fields:
  - `next_address` and `next_deploy_tx_hash`: a v2 deployed but not approved yet;
  - `previous_address`: the v1 it replaced;
  - `previous_revoke_tx_hash`: the owner's revocation of that v1.

  The rows are read with `select('*')`, so code deployed before the migration runs still reads every row, as v1.
  Until the row carries `version`, nothing of v2 is written or offered: setups deploy v1 and the upgrade is not shown,
  so no step the owner pays gas for is refused when it is recorded (review finding 1).
- **V10. The Go live panel offers an owner the upgrade** while the contract is v1 and the network has CCTP. It shows
  for a live workspace too, beside the wallet controls. It is owner or admin only, and every result is read from the
  chain (W7):
  - **Browser wallet, three transactions:**
    1. Deploy v2. The deployment carries the figures v1 holds now. Recorded as `next_address`.
    2. Approve v2 on USDC, unlimited or capped. Recorded as the switch: `address` becomes v2, `previous_address` v1,
       `version` 2.
    3. Revoke v1, `approve(v1, 0)`. Recorded once USDC's own `Approval` shows 0 and the allowance reads 0.
  - **Passkey, one user operation.** In order: deploy v2 through the deterministic deployment proxy, `setLimits` to
    v1's figures, approve v2, and `approve(v1, 0)`. Recorded when the EntryPoint shows the operation succeeded, v2 is
    at its address with the right code, v2 is approved, and v1's allowance is 0. The browser builds the calls itself
    and refuses a server reply that differs (K6).
  - **The switch waits for payments in flight.** While any payment intent is `submitting` or `pending`, or recorded
    as `failed` with a send Circle may still hold (review finding 2), the switch is refused. A payment sent through v1 and sent again through v2 under its key would be two payments, since v2's
    `paid` starts empty.
  - **Ledger entries.** `spending_limit_upgraded` names both contracts, the version, the figures and the transactions.
    `spending_limit_revoked` names v1 and the revocation. The panel asks for the revocation until it is recorded, even
    where v1's allowance reads 0 already, so the entry is never skipped (review finding 3).
  - **The panel keeps its own result.** A recorded step re-renders the page with the new status, which can unmount
    the step that sent it. So the success line is held in state above the steps, not in the step (the revalidate
    unmount pattern).

## The payment path (V11–V13)

- **V11. The agent's payout goes through `payAcrossChains`.** `spendingLimitPay` in `liveProvider.ts` takes this
  path when the payee is on another chain and the payment's contract is v2. It works like the EOA bridge (B2):
  1. It reads the fee from Iris again just before the burn. A fee above the payment's ceiling or the contract's cap
     sends nothing (`BridgeFeeError`).
  2. The agent's wallet sends one contract execution under the attempt's key. There is no separate approve: the
     contract approves itself.
  3. The payment is recorded with the burn's id (`cctp:`), `payout_route = 'cctp'`, `destination_chain` and
     `bridge_fee`.
  4. It counts as paid on the mint, which `forwardedMint` reads from Iris. Reconciliation reads it the same way.

  A v1 contract, EURC, a Gateway route, an escrow release, or a chain with no domain still sends nothing.
- **V12. `onChainLimitGate` covers another chain for v2.** The decision records `covered: true`. With the fee read
  for the decision, the verdict is an `eth_call` of the same `payAcrossChains` from the agent. Over a figure, the
  bill is held under `workspace.onchain_limit` with the contract's figures, as any payment is. Without a fee there is
  no verdict, and the bridge guardrail holds it (`bridge.fee_unavailable`). A v1 contract keeps
  `workspace.onchain_limit_route`.
- **V13. A person's approval goes through v2 too.** These refuse only for v1 now:
  - the early refusal in `approvals.ts`;
  - `ContractRefusal` in `person-payment.ts`.

  With v2, the person's payout is asked of the contract with the fee just read. Its refusal reads in the contract's
  figures, and nothing is claimed. `WALLET_CONTRACT_ONLY` stays for anything that does not name the contract.

## What it does not do

- Pay EURC across chains, through Gateway, or to a chain outside the deployment's domains.
- Move a v1 contract's spent counts or paid refs into v2. On the day of the upgrade, v2's daily figure starts at
  0. The app's own spending limit (`agent_budgets`, the ledger's outflow) still counts the day's payments in code, so
  the agent pays no more than the limit that day. Only the on-chain bound restarts.
- Change the Circle-wallet route (`treasury_kind = 'circle'`, Settings → Enforce on Arc). It deploys v1 as before.
  Its cross-chain payouts go from the operating wallet, outside the contract (onchain spending limit R4).

## Proof

On Arc mainnet, from the live path C workspace:
1. The owner upgrades: deploy, approve, revoke, or one passkey confirmation.
2. A 1 USDC bill to a Base address the partner holds is paid. The proof is the agent's `payAcrossChains`
   transaction on Arc (one burn), the mint on Base, and the signed `ap_pay` with `payout.chain: "BASE"` and
   `onChainLimit.covered: true`.

Money is moved only by the partner.

## Cost if wrong

- **A bug in the contract.** It loses at most what the figures allow in a day and a week, and the agent's wallet
  still cannot move USDC outside the contract. The owner stops it from Go live (approval to 0).
- **An unaudited path.** The forwarding hook is a fixed constant, the fee is capped, the domains are fixed, and the
  balance check reverts any call that leaves USDC behind.
- **A fee that moves between the decision and the burn.** The verdict is asked with the fee the decision read, and
  the burn reads it again. A payout close to a figure can then be allowed by the verdict and refused on chain
  (`OverDailyLimit`): the agent's transaction fails, its gas is spent, and no USDC moves (review finding 4).
- **The upgrade stopped halfway.** Before the switch, v1 keeps paying. Between the switch and the revocation, both
  contracts are approved; only v2 is used, and the panel asks for the revocation until it reads 0.
