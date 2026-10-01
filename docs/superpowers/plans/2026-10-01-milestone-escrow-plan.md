# Milestone escrow: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a workspace locks a milestone's USDC in its own escrow contract on Arc testnet. The agent releases the hold to the contractor when the milestone is verified, and after the refund date the workspace can take it back.

**Architecture:**
- The contract is `contracts/VestiarionEscrow.sol`, compiled with solc 0.8.37 (paris) into `src/lib/escrow/artifact.json`.
- It is deployed per workspace through Circle's Smart Contract Platform from an EOA deployer that the operating wallet funds with gas.
- The workspace stores the contract in `escrow_contracts`, and each hold on its milestone.
- Fund, release and refund are contract executions from the operating wallet, each under an idempotency key.
- The agent releases a hold on the `escrow` payout route of `executePayment`.

**Tech stack:**
- Next.js 16: server actions.
- Supabase Postgres with RLS.
- Circle Developer-Controlled Wallets and the Smart Contract Platform SDK.
- Tests: solc and `@ethereumjs/evm`, dev only.

**Spec:** `docs/superpowers/specs/2026-10-01-milestone-escrow-design.md`

## Global constraints

- **Live workspaces only.** Owners and admins, under the `treasury.manage` permission.
- **Copy:** say "Arc testnet" plainly, and say the contract is not audited where it is described.
- **Idempotency:** every Circle write runs under an idempotency key, so a retry repeats nothing.
- **Changelog:** a dated entry for the new ledger actions and fields.

## Review focus

1. Escrow release paying twice, or paying both by release and by transfer.
2. A milestone whose amount changed after it was locked.
3. A lock whose approve completes but whose fund fails: a retry must not fund twice. Contract `HoldExists` and the keys cover this.
4. A deploy that times out after Circle accepted it: the retry must resume, not deploy twice.
5. A refund before the date: refuse it in the app, before the contract does.

---

### Task 1: the contract (done)

The contract, the compile script and the artifact. The tests run in an in-process EVM and were mutation-checked: six deliberate bugs, each caught by its test.

### Task 2: migration 0047 and inventories

The `escrow_contracts` table and the milestone escrow columns. `payout_route` gains `escrow`. Includes the migration test and the inventories.

### Task 3: setting up escrow

- `src/lib/circle/escrow-setup.ts` has `setUpEscrow({ actorId })`, which resumes.
- A server action, and the **Escrow** panel on Contractors.

### Task 4: locking a milestone

- `lockMilestone({ actorId, milestoneId, refundAfter })` runs approve then fund.
- An action, and the **Lock in escrow** control on a milestone card.

### Task 5: the agent's release

- `releaseMilestone` uses the `escrow` route when a hold is funded.
- `LiveProvider` calls `release(bytes32)`.
- An amount mismatch holds the payment.

### Task 6: refunding

- `refundMilestone` refuses before the date.
- An action and its control.

### Task 7: display and docs

- The milestone card shows the escrow's state and links.
- The guide, the changelog and the privacy page are updated.
