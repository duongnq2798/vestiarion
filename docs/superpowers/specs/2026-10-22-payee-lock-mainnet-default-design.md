# The payee lock starts on for a new Arc mainnet workspace

Date: 2026-10-22. Status: accepted.

## Why

The payee lock (`2026-10-20-payee-lock-design.md`) makes confirming a changed payout address a recorded check by a
second person. It is off until an owner turns it on, so most workspaces never do. On Arc mainnet a payment redirected to
the wrong address is real money that does not come back. A safe default there costs a business one extra step, and a
mistaken default costs it the payment.

## What

**LD1. On from the start, on Arc mainnet.**
- `createWorkspace` writes the workspace's first `approval_policies` row with the payee lock on and no wait
  (`MAINNET_STARTING_PAYEE_LOCK`), beside the two-approval figure it already writes there.
- No wait, because a payee's first address through its link is a change too, and a day's hold on every new contractor
  would be friction the check does not need. An owner adds a wait, or turns the lock off, in Settings.
- `org_created` records it among the starting limits.
- On a deployment before migration 0135, the figure alone is written, as before, and the entry does not name the lock.
- Arc testnet is unchanged: the lock starts off. Workspaces already on Arc mainnet keep their setting.

**LD2. One step on the owner's checklist.**
- On Arc mainnet, **Check payees with the payee lock** follows **Add a payee with an Arc address**.
- It says what the lock does, links to the payee lock in Settings, and needs no role to read.
- It is done once a person has used the lock (`readPayeeLockUsed`), read from records that already exist:
  - an address confirmed under it (a `counterparty_address_confirmed` entry carrying `payeeLock`);
  - or the lock changed (`payee_lock_changed`).
- Nothing new is stored, so no migration.
- If either fact cannot be read, the step is left out.

## Tests

- `tests/workspace.test.ts`: the mainnet row with the lock on, the starting limits naming it, and the figure alone before
  0135.
- `tests/getting-started.test.ts`: the step's place, words and tick, and no step without the facts.
- `tests/onboarding-read.test.ts`: `readPayeeLockUsed` for a change, a confirmation under the lock, one without it, and
  a failed read.
