# Treasury wallet controls: change the figures, stop and resume, from the treasury's own wallet

Wallet treasury part 2a. Follows `2026-10-07-wallet-treasury-design.md` (W14) and `2026-10-07-passkey-treasury-design.md`.

## 1. Why

On 2026-10-07 the first passkey treasury went live on Arc mainnet (`mainnet-wp`) and paid its first payable through its
spending limit contract. Two gaps remain for a workspace that pays from its owner's own wallet:

- **Its figures cannot change.** The contract holds them, and only its owner, the treasury wallet, may call `setLimits`.
  `changeAgentBudget` refuses (`wallet_contract`, "only that wallet can change them"), and nothing lets the wallet do it.
  A payable above the daily figure stays held for good.
- **Its agent can only be stopped off-chain.** Pausing the agent stops Vestiarion's cycles, but the contract's approval
  stands. A browser wallet can revoke it elsewhere (revoke.cash); a passkey wallet has no such tool.

## 2. Decisions

- **C1. Where.** Settings → Go live, once the workspace is live (and at its ready step), shows what the contract holds
  and, for an owner or admin, its controls:
  - its figures, today's and the last 7 days' payments through it, and its approval: unlimited, up to a figure, or
    stopped;
  - **Change figures**: the daily and 7-day figures, prefilled from the contract;
  - **Stop the agent's payments** while it is approved, behind a confirmation; **Resume payments** while it is stopped,
    with an optional cap.
  The console's spending limit panel, for such a workspace, says where its figures change instead of refusing a save.
- **C2. The calls.** Built in the browser from what the panel shows, never from a server's reply, so what the wallet
  signs is what the owner typed (as passkey treasury Review Focus 1):
  - figures: `setLimits(daily, weekly)` on the contract, in units; refused before signing where the contract would
    refuse (both empty or zero; 7-day below daily) and, on Arc mainnet, with no figure;
  - stop: `approve(contract, 0)` on USDC;
  - resume: `approve(contract, cap)` on USDC, the cap in units or unlimited.
- **C3. Signing.** The treasury's own signer: a passkey treasury sends one user operation the wallet pays for (priced as
  Circle's bundler asks); a browser wallet sends one transaction with `sendPrepared`. Either asks the wallet once.
- **C4. Recording, from the chain only.** One server action records a control by its transaction:
  - the receipt succeeded; for a passkey, EntryPoint's `UserOperationEvent` for this wallet with `success`; for a
    browser wallet, the transaction is from this wallet;
  - figures: the contract's `dailyLimit` and `weeklyLimit` are read and become the workspace's agent spending limit
    (`agent_budgets`); `agent_budget_changed` records them with `onChain: { contract, txHash, signer }`; a loosened
    figure starts a cycle (`budget_raised`), so a payable held under the old figure is decided again;
  - stop: the allowance reads 0; `spending_limit_stopped` is recorded and the agent is paused with the reason "The
    owner stopped the agent's payments on Arc", so it tries nothing the contract would refuse;
  - resume: the allowance reads above 0; `spending_limit_resumed` is recorded, a pause this control set is lifted, and a
    cycle starts (`agent_resumed`);
  - a transaction recorded once is answered as recorded again; one the chain cannot read yet is answered as pending,
    and the browser asks again, as the setup does (`pollRecord`).
- **C5. Who.** Owners and admins (`org.administer`), as every other treasury step. The wallet's signature is the real
  control: the action records only what the chain shows.
- **C6. Copy.** Plain, as the rest of Go live: what the wallet will be asked, and what changes.

## 3. Not in scope

- Money in to the treasury (receivables), agent gas after going live, an in-app recovery page, workspace deletion: the
  rest of part 2.
- Changing who the agent is, or replacing the contract.

## 4. Tests

- The call builders: units, the contract's own refusals, mainnet's figure, stop and resume encodings.
- Recording: each kind from a successful receipt; a reverted one, another sender's, another wallet's user operation,
  figures or an allowance that do not read as the kind says; idempotence; an unreadable chain as pending; the budget
  row and ledger entries written; the pause set and lifted; the cycle events.
- The panel: the controls for an owner on a live workspace paying from its own wallet, none for a viewer or another host;
  the console's spending limit panel pointing to Settings.
