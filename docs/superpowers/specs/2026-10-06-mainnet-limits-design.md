# Two people above a figure on Arc mainnet: phase 2b of the mainnet plan

Date: 2026-10-06. Status: designed under the standing autonomy grant, after phase 2a (#219, Arc mainnet behind a
switch). Rulings carry their cost if wrong.

## 1. Why

- **Phase 2a** lets a person on the allowlist create a workspace on Arc mainnet, connect its own Circle account, and
  create and fund its wallet.
  - Going live there stays closed: the profile's `goLiveOpen` is false.
  - The agent starts tight there: 50 USDC a day and 150 USDC in 7 days, with a figure always kept.
- **What a person may approve on Arc mainnet is not bounded.** One approver can pay any payable the wallet covers.
  - Approve and pay skips the agent's spending limit and the payee's limit, as on Arc testnet.
  - A figure read wrong from a document is caught only if that one person notices it.
  - Two approvals (#208) are optional, off by default, and turning them on needs two people who can approve.
- **2a's final review deferred eight minor issues.** Each matters once real money moves on Arc mainnet:
  - the status API calls an unconnected mainnet workspace simulated;
  - the Go live badge says "Live" beside "switched off";
  - the platform's testnet USDC token id reaches mainnet providers;
  - the starting limit has no ledger record;
  - the reconcile line does not name the gas reserve;
  - the balance rounds when the gas reserve is 0;
  - the banner works out the hold on its own;
  - 0075's comment on the network column is stale.
- **Mainnet receipts cannot read native USDC.** A receipt reads Arc's native USDC log as well as the ERC-20's, and
  Arc mainnet's payee chain names no native emitter.
  - Arc's docs give it: the system emitter `0xffff…fffE` (EIP-7708), which mainnet has used since genesis.
- **Done when:**
  - every mainnet workspace pays above 100 USDC only with two people;
  - the deferred minors are fixed;
  - a mainnet receipt can read a native USDC transfer;
  - Arc testnet is unchanged.

## 2. Rulings

- **L1. A mainnet workspace starts with two approvals above 100 USDC.**
  - `createWorkspace` writes the `approval_policies` row when it creates a workspace on Arc mainnet.
  - This is the platform's default, not an owner's tightening. So it does not need the two approvers that turning it
    on in Settings needs (#208 T1).
  - Everything else is #208's rule, unchanged:
    - the agent never pays above the figure: `workspace.two_approvals` holds it;
    - a person's payment above it needs a second person;
    - a workspace with one approver pays nothing above it, and the card says to raise the figure or add an approver.
  - *Cost if wrong:* a solo pilot cannot pay a single invoice above 100 USDC until it raises the figure or adds an
    approver. That is the point.
- **L2. On Arc mainnet the figure stays.**
  - Turning it off is refused: "A workspace on Arc mainnet keeps two approvals above a figure."
  - Raising it stays allowed, and is recorded as `approval_policy_changed`.
  - Lowering it still needs two approvers.
- **L3. No separate ceiling for one invoice.** Above the figure, two people check every payment a person makes, and
  the agent pays nothing above it. A misread amount meets two people.
  - *Cost if wrong:* a payable can be entered with any amount. It is paid only by two people.
- **L4. The starting limits are recorded.** `org_created` carries
  `startingLimits: { dailyUsdc, weeklyUsdc, twoApprovalsAbove }` on Arc mainnet.
- **L5. A mainnet receipt reads native USDC.** Arc mainnet's payee chain names the system emitter `0xffff…fffE`, as
  testnet's does.
- **L6. The platform's USDC token id is Arc testnet's.** `CIRCLE_USDC_TOKEN_ID` is configured for the platform's
  testnet account.
  - A provider on another network looks its token up by contract, as `ARC_RPC_URL` reaches Arc testnet only.
- **L7. The pages tell the truth about a held mainnet workspace.**
  - `/api/v1/status` answers payments `unavailable`, not `simulate`, for a mainnet workspace with no provider.
  - The Go live badge reads "Arc mainnet switched off" while the deployment has it off.
  - The banner reads `networkHold()`, as every gate does.
- **L8. The ledger and the books.**
  - The reconcile line names the gas reserve it kept aside.
  - `liveOperatingBalance` rounds only when there is a gas reserve, so Arc testnet's figures are byte-identical to
    before 2a.
  - Migration 0079 rewrites the network column's comment.
- **L9. Going live on Arc mainnet stays closed.** The copy that names Arc testnet (phase 2c) is still to move.
  - Emails and comments to payees must name Arc mainnet before a real payment.
  - So `goLiveOpen` turns on with 2c, not here.

## 3. Testing

- **`createWorkspace`:** on Arc mainnet it writes the policy row and records the starting limits; on Arc testnet it
  writes neither.
- **`changeTwoApprovals` on Arc mainnet:** turning it off is refused, raising it is accepted, and lowering it with one
  approver is refused, as before.
- **The receipt reader on Arc mainnet** counts a native USDC log from `0xffff…fffE`.
- **A provider on Arc mainnet** ignores `CIRCLE_USDC_TOKEN_ID`.
- **Pages:**
  - the status route on an unconnected mainnet workspace answers `unavailable`;
  - the badge reads "switched off" while it is;
  - the banner and the gates agree.
- **The reconcile line** names the gas reserve on Arc mainnet.
- **`liveOperatingBalance`** with a gas reserve of 0 equals the pre-2a function across random 18-decimal balances.
- **The migration (PGlite):** the comment.

## 4. Rollout

- **Migration 0079**, a comment only. The partner runs it before the merge.
- No mainnet workspace exists in production, so nothing changes there. Arc testnet is unchanged.
- Rollback: revert.
