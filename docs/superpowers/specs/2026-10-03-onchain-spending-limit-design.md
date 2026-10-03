# The spending limit, enforced on Arc

Date: 2026-10-03. Status: shipped (PR #149) and proven in production; see §6 (roadmap A6b, the second half of
`2026-10-02-outflow-budget-design.md`).
Decided under the standing autonomy grant; each ruling carries its cost if wrong. Rulings R1–R15.

## 1. Why

A6 gave the agent a spending limit: a daily figure, a 7-day figure, or both, checked in code before
every payment the agent makes on its own. That check is Vestiarion's own code. A bug in it, a race
between two cycles, or a model whose proposal slips past a check that was wrong would all pay past
the limit, and nothing outside the code would notice.

This makes the limit a property of the money's path instead: the agent's own payments leave through
a contract on Arc testnet, and the contract refuses a payment past the limit whatever the agent's
code decided. The check in code stays, in front of it. A payment needs both to agree.

## 2. What it is

- **The contract, `VestiarionSpendingLimit`**, one per workspace, deployed on Arc testnet through
  Circle's Smart Contract Platform. It knows four addresses and two figures:
  - `token`: USDC's ERC-20 interface on Arc testnet;
  - `treasury`: the workspace's operating wallet. The money stays there;
  - `owner`: the operating wallet too. Only it changes the figures;
  - `agent`: the agent's own wallet. Only it pays;
  - `dailyLimit` and `weeklyLimit`, in USDC units (6 decimals). 0 means that figure is not set; at
    least one is always set.
- **`pay(to, amount, ref)`**, the agent's only power. It pulls `amount` from the treasury to `to`
  with `transferFrom`, after three checks:
  - what it paid today (UTC), plus `amount`, is within `dailyLimit`;
  - what it paid today and in the six UTC days before, plus `amount`, is within `weeklyLimit`;
  - `ref` was never paid before. `ref` names the payment (an invoice or a milestone), not an
    attempt, so one payment cannot leave twice through the contract, whatever keys were used.
  It refuses with a named error (`OverDailyLimit`, `OverWeeklyLimit`, `AlreadyPaid`) and emits
  `Paid(ref, to, amount, day)` when it pays.
- **`setLimits(daily, weekly)`**, the owner's: the 7-day figure, when both are set, is at least the
  daily one, as in A6.
- **The agent's wallet** is a new Circle smart contract account in the workspace's wallet set. It
  holds no USDC: on Arc testnet Circle's Gas Station pays its gas. So it cannot send money anywhere
  by itself; its only use is `pay` on this contract.
- **The allowance:** the operating wallet approves the contract to draw from it. The contract only
  draws through `pay`, within the figures, for the agent.

## 3. Rulings

- **R1 — opt-in, per workspace.** An owner or admin (`agent.budget`) turns it on: "Enforce on Arc"
  under the agent's spending limit. It needs a live workspace with Circle credentials, an operating
  wallet holding at least 0.1 USDC (the deployer's gas, as for escrow), and a daily or 7-day figure.
  A sandbox cannot: its payments are simulated.
- **R2 — setup steps, resumable.** Each step runs under its own key and is recorded on the
  workspace's `spending_limit_contracts` row as it completes (the escrow pattern, 0047):
  1. a deployer EOA, given 0.1 USDC of gas by the operating wallet;
  2. the agent's wallet;
  3. the deployment, with the current figures;
  4. the operating wallet's approval;
  5. the row is marked `enforced`, and the ledger records `spending_limit_enforced`.
  A setup interrupted at any step resumes there. One Circle failed starts over with new keys.
- **R3 — what goes through the contract.** While it is enforced, every payment the agent decides on
  its own that moves USDC on Arc testnet is sent as `pay` from the agent's wallet: an AP `pay`, and a
  milestone release that is not from escrow. A batch is not used: each payment goes alone.
- **R4 — what does not, and is held instead.** A payment in EURC, or to a payee on another chain,
  cannot go through the contract. While it is enforced, the agent does not send these itself: they
  are held for a person with the rule `workspace.onchain_limit_route`. So everything the agent pays
  by itself passes the contract. Cost if wrong: in such a workspace the agent stops paying EURC and
  cross-chain payables on its own; a person approves them.
- **R5 — escrow releases stay as they are.** A milestone locked in escrow left the treasury when a
  person locked it. Its release comes from the escrow contract, not the treasury, so it does not go
  through the spending limit contract. The check in code still counts it (A6 R1).
- **R6 — people's payments are unchanged.** Approve and pay, and Pay now on a held milestone, are a
  person's decisions: plain transfers from the operating wallet, outside the agent's limit (A6 R1).
  A person's retry of a payment the agent first sent through the contract is also a plain transfer.
  That is safe: a retry only follows a transfer Circle ended in a terminal failure, which moved nothing.
- **R7 — the contract's verdict before sending.** Before a payment goes through the contract, the app
  asks the contract with an `eth_call` of the same `pay` from the agent's address: no transaction, no
  gas. If the contract would refuse, nothing is sent. The payment is held with the rule
  `workspace.onchain_limit`, and the decision records the contract's error and figures. This is the
  case the code check exists to prevent, so seeing it means the two disagreed. A verdict that cannot be
  read (the node did not answer) does not stop the payment: the contract still refuses at send time (R9).
- **R8 — the check in code stays first.** A6's check runs first and unchanged. When it holds a payment
  for the limit while the contract is enforced, the decision also records the contract's own verdict
  for the same payment. A refusal then shows both: the code's figures and the contract's.
- **R9 — a refusal at send time.** If the limit fills between the verdict and the send (another
  payment, another cycle), Circle cannot estimate the call and fails it. Nothing moves: the payment is
  held with Circle's reason, like any failed transfer, and a person may pay it.
- **R10 — changing the figures while enforced.** The contract is changed first (`setLimits` from the
  operating wallet). Only once Circle confirms it are the figures saved and `agent_budget_changed`
  appended, with the transaction. If Circle fails it, nothing changes, and the form says so. Removing
  both figures while enforced is refused: turn the enforcement off first. A6's refusal while a cycle
  is running applies before anything is sent.
- **R11 — turning it off.** The operating wallet's approval is set to 0, so the contract can draw
  nothing; the row is marked not enforced; the ledger records `spending_limit_unenforced`. The
  contract stays deployed. Turning it on again sets its figures to the current ones, approves again,
  and records `spending_limit_enforced`.
- **R12 — the record of a payment.** While the limit is enforced, every agent decision to pay records
  `onChainLimit: { contract, agent, ref, covered, uncoveredBecause?, verdict }` in its detail, held or
  paid. A payment sent through the contract has the `pay` call as its transaction, whose receipt holds
  the USDC transfer from the treasury to the payee, so the receipt page's on-chain check reads it as any
  other payment.
- **R15 — before migration 0062.** Reading the contract row treats a missing table as "never set up":
  without the table no workspace can enforce anything, so the agent and the limit's form work as before.
  Any other failure to read it stops the stage, as an unreadable limit does (A6 R8).
- **R13 — who holds the keys.** The operating wallet, the agent's wallet and the deployer are
  developer-controlled wallets: Circle signs for each with the workspace's entity secret, which
  Vestiarion's server holds. So the contract binds the agent and the code path that pays for it, not
  a server that is fully compromised: such a server could also sign as the operating wallet. Moving
  `owner` to a key no server holds (a person's own wallet) is the step that would close that, and it
  is not in this change. The guide says so plainly. This corrects A6's spec §5, which said A6b would
  bind a compromised server.
- **R14 — reading it.** The console reads the contract's figures and what it has paid today and in the
  7-day window, through the deployment's Arc RPC. A read that fails says so; it never shows the
  code's figures as the contract's.

## 4. What a person sees

- **Console, "Agent spending limit".** Under the figures, an "On Arc" line:
  - not set up: "Enforce on Arc" for owners and admins, with one sentence on what it does, or the
    reason it cannot run yet (a sandbox, no figure, no Circle credentials);
  - enforced: the contract's address and the agent's wallet, both linked to the Arc testnet explorer;
    what the contract counts as paid today and in 7 days against its own figures; "Turn off";
  - set up and turned off: "Enforce on Arc" again.
- **A held payable's card** names the new rules in its guardrail band, and the contract's verdict
  when there is one.

## 5. Records

- Migration 0062: `spending_limit_contracts` — one row per workspace: address, Circle contract id,
  deployer wallet and address, its gas transaction, deployment transaction hash, agent wallet and
  address, approval transaction, `enforced`, who set it up and when. Tenant isolation as 0047.
- Ledger: `spending_limit_enforced` and `spending_limit_unenforced` (actor `human`, domain `system`,
  ids and addresses only); `agent_budget_changed` gains `onChain: { contract, txHash }`.
- The contract's source is `contracts/VestiarionSpendingLimit.sol`, compiled with the pinned settings
  into `src/lib/spending-limit/artifact.json` (`npm run spending-limit:compile`), tested in the
  in-process EVM like the escrow.

## 6. Rollout

1. Merge; apply 0062 (nothing reads the table until a workspace turns this on).
2. In a live workspace with a limit set: Enforce on Arc. Check the deployment, the agent wallet with
   no USDC, the approval, and `spending_limit_enforced`.
3. A payable within the limit: paid through the contract (`Paid` on the explorer, the treasury's USDC
   moved to the payee, `onChainLimit` on the decision).
4. A payable past the limit: held by the code check, with the contract's verdict recorded beside it.
5. Record the transactions here.

### Rollout record (2026-10-03, UTC)

- PR #149 merged as `190fedc` at 00:06:48. 0062 was applied by the partner; a read-only probe found the table with
  RLS on, its two policies (permissive and restrictive), no access for `anon` or `authenticated`, CRUD for the
  tenant role, and its four constraints. 0061's `claim_invoice_decision` was intact after the replay.
- In `testnet-2` (live, hosted), with a 2 USDC daily figure and no 7-day figure:
  - #937, 00:10:31, `spending_limit_enforced`: contract `0x9da3c47f73ea9399ac566806a189b0bf47b7d4ba`, agent wallet
    `0xa79bd77b00143ced32a81d1fb8215d7dca21526a`, treasury and owner the operating wallet
    `0x97f85033bbd83870a841cf7153f35b387746b6b6`. Deployment tx `0xf48ee082d2120142e4a6fa3727b64690f255cbc8d91d801403486b3b79b5e4ff`,
    approval tx `0xbc838a0cc3775d12c68740bf25acc6a72d944ba136cc494a9ade20ff41e032ea`. Read from the chain: daily
    limit 2, weekly 0, nothing paid, the approval at its maximum, and the agent's wallet holding 0 USDC, not yet deployed.
  - A cycle run by a person (#943) then decided two payables:
    - #940, 00:15:00: Centronex's scheduled invoice paid at 1.94 USDC (the 3% early-payment discount), through the
      contract, `onChainLimit.verdict` `allowed`. Tx `0xa79cb982c488d5c8d40cfc6b6141bf30d95f5615e580d3c3d6b55b779fe6e71e`,
      block 65198976: a user operation from the agent's wallet (nonce 0, which deployed it), gas paid by Circle's
      paymaster `0x03dF76C8c30A88f424CF3CBBC36A1Ca02763103b`; the USDC transfer of 1.94 from the operating wallet to
      Centronex; and the contract's `Paid` event with ref `0xc2a1ac91f58d5aaada874f162cf148ef0130aeaa95547fdbd74ef9bd57f53cec`.
    - #941, 00:15:02: the day's 0.3 USDC Jiren retainer, held by the code check (`workspace.outflow_budget`: 1.94
      paid, 0.06 left), with the contract's own verdict recorded beside it: `refused`, `OverDailyLimit`, spent 1.94,
      amount 0.3, limit 2. Code and contract agreed, so the `workspace.onchain_limit` path did not occur.
  - #944, 00:16:46: the partner raised the daily figure to 3. The contract was changed first: `setLimits` tx
    `0x50f2cb77c85b76f6795f752fd012f0e1cd893911135a130cde3a255df1d25c7d` (`LimitsSet(3, 0)`), recorded as
    `onChain.txHash`.
  - #947, 00:17:03: the held retainer reopened; #948, 00:17:14: paid through the contract, tx
    `0x450177c644314b8abca2dee50683a54d139c280b1b803428b3891eb2a1a50e8e`, block 65199239, `Paid` event, the agent's
    nonce 1.
  - #951, 00:17:51, `spending_limit_unenforced`: approval set to 0, tx
    `0x33d0f2724ec6a1df6b477ab6d91e80132a8eee52301d6c8b4e4a109823b6665d` (`Approval` to 0).
  - #952, 00:18:05, `spending_limit_enforced` again on the same contract: `setLimits` tx
    `0x6a72b4f936034140c67112b55b31b94b72eab25f8909e33f96678a67b3a36590`, approval tx
    `0x3444d38f0bfa9bca7e30f0ed7670043f8f15da33201a58334fdc556f46f6f49f`, no new deployment.
  - Read from the chain afterwards: daily limit 3, 2.24 USDC paid through the contract today, the approval at its
    maximum, the agent's wallet deployed and holding 0 USDC.
