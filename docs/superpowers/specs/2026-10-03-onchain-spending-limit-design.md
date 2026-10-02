# The spending limit, enforced on Arc

Date: 2026-10-03. Status: design (roadmap A6b, the second half of `2026-10-02-outflow-budget-design.md`).
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
