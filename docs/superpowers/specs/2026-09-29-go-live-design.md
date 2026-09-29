# Go live: a workspace connects its own Circle wallet and turns live

A new workspace starts as a sandbox. It has simulated accounts, simulated payments, cycles run by hand, and it is deleted after a period of inactivity. Today, only the operator can make a workspace move real money, by running scripts:
- `org:adopt-env` or a manual database write stores the Circle credentials;
- `bootstrap:circle` creates the wallets;
- setting `mode` to `live` by hand turns on the scheduled cycles.

This design makes that a guided, owner-only flow in Settings. It was decided on 2026-09-29 by the implementer under the partner's standing instruction. Each decision states its reason.

## 1. What exists

- **Payments.** A workspace pays for real when its row holds readable Circle credentials (`orgs.circle_api_key_enc`, `circle_entity_secret_enc`, each an envelope bound to the organization and column). `getChainProvider()` then uses `LiveProvider` for transfers and balances. If stored credentials cannot be decrypted, it refuses to fall back to simulation (R12).
- **Balances.** In live mode, each cycle's `reconcile` stage reads every non-reserve account's USDC balance from its Circle wallet (`accounts.circle_wallet_id`) and replaces the stored balance with it. A simulated balance therefore never funds a live payment.
- **Mode.** `orgs.mode` is `sandbox` or `live`. Only `live` workspaces run on the 6-hourly schedule (`runLiveOrganizations`). Only a `sandbox` can be deleted by the daily cleanup (`delete_sandbox_org` refuses anything else). The sandbox cycle cap (`begin_cycle_run`) applies only to sandboxes.
- **Wallets.** `scripts/bootstrap-circle.ts` finds or creates a wallet set named `vestiarion-treasury`, then an SCA wallet on each account's chain, and writes the wallet id and address back to the account.

## 2. What this builds

A **Go live** section at the top of Settings. Everyone sees the workspace's status. Only an owner (`org.administer`) can act, in three steps, each unlocked by the one before:

1. **Connect Circle.** The owner pastes the API key and entity secret from their Circle developer console.
   - The server checks the key with Circle: a read that needs a valid key.
   - It encrypts and stores both values, and records `circle_connected` with `{ by }`.
   - The values are never shown again, logged, or sent back to the browser.
2. **Create treasury wallets.** One click creates, in the owner's own Circle entity, the wallet set and one wallet for each account that has none.
   - This also proves the entity secret: creating a wallet needs it.
   - The accounts drop "(simulated)" from their names.
   - The step shows the operating wallet's address with a copy button, a link to Circle's testnet faucet, and the live on-chain USDC balance with a refresh button.
   - It records `treasury_wallets_created` with `{ by, accounts: n }`.
3. **Go live.** A confirmation dialog states what changes: real testnet USDC moves when the agent pays, the agent runs every 6 hours, and the workspace is no longer deleted when inactive.
   - Confirming sets `mode` to `live` and records `workspace_went_live` with `{ by }`.
   - The **Pause agent** control is the way to stop it. Going back to sandbox is out of scope.

A live workspace shows its status: connected, the wallet addresses, live since (from the ledger entry), and the scheduled cadence. The founding workspace is already live, so it shows this state and no steps.

## 3. Decisions

- **L1. Owner only.** It uses the existing `org.administer` permission (owner). Connecting a payment account and turning on autonomous payments is the highest-stakes change a workspace can make, above an admin's reach (roles: admins manage members, keys and webhooks).
- **L2. Credentials are handled like the platform's other secrets.**
  - They are stored with `encryptSecret` under `{ orgId, column: "circle_api_key_enc" }` and `{ orgId, column: "circle_entity_secret_enc" }` through `platformDb()`.
  - The server action reads them from form data, trims them, validates the format (non-empty, at most 512 characters), and never echoes them.
  - The form fields are `type="password"` with `autoComplete="off"` plus the password-manager ignore attributes used by "Try it".
  - A failed check answers one of two fixed messages:
    - "Circle did not accept this API key.";
    - "Could not reach Circle; try again."
  - After success the page shows "Connected", never a fragment of the key.
- **L3. Checking the key.** The key is checked with one Circle read that needs a valid key (`listWalletSets`), under a 10 s deadline (`withDeadline`). The entity secret cannot be checked without writing. It is checked in step 2, and a failure there says "Circle did not accept the entity secret; reconnect with the right one." In that case the stored credentials stay, and the owner can replace them.
- **L4. Replacing credentials.** An owner can replace the credentials at any time: the same form, the same check, and `circle_reconnected` recorded. Removing credentials is not offered: a live workspace without them would stop paying, and silently dropping to simulation is exactly what R12 forbids.
- **L5. Wallet provisioning moves into a library.** `createTreasuryWallets(orgId)` in `src/lib/circle/provision.ts` does what `bootstrap-circle` does for accounts.
  - It is idempotent: an account that already has a wallet is skipped.
  - It runs in the organization's scope with its own credentials, and each Circle call has a deadline.
  - `bootstrap-circle` calls it for accounts, and keeps minting counterparty wallets for the demo seed. Counterparties are out of the UI flow, because a real counterparty gives you its address.
- **L6. Going live is atomic and conditional.** It is one database update, `update orgs set mode = 'live' where id = $1 and mode = 'sandbox'`, done only when credentials are stored and the operating account has a wallet. Both conditions are checked in the same server action immediately before the update.
- **L7. A sandbox that has connected Circle is never auto-deleted.** Its wallets may hold funds.
  - Migration `0029` changes `delete_sandbox_org` to also refuse when `circle_api_key_enc` is not null.
  - `cleanup.ts` stops listing such sandboxes.
  - Without this, a connected but not-yet-live sandbox that goes quiet would be deleted, and with it the only record of which wallets are its own. The funds would stay in the owner's Circle entity but become orphaned from the product.
- **L8. The ledger records ids only:**
  - `circle_connected` / `circle_reconnected` with `{ by }`;
  - `treasury_wallets_created` with `{ by, accounts }`;
  - `workspace_went_live` with `{ by }`.

  No key, secret, wallet id or address is recorded. The addresses are on the accounts page for members.
- **L9. Counterparties are paid only to real addresses.** The step-2 panel says so, and links to the counterparties page, where the address is set. A counterparty without an address is held by the existing guardrails, which is unchanged; the panel only explains it.

## 4. Components

```
supabase/migrations/0029_go_live.sql       delete_sandbox_org also refuses a sandbox with stored Circle credentials
src/lib/circle/provision.ts                createTreasuryWallets(): wallet set + a wallet per account, idempotent, deadlines
src/lib/circle/check.ts                    checkCircleApiKey(apiKey): ok | rejected | unreachable (10 s)
src/lib/platform/go-live.ts                connectCircle, createWallets, goLive, goLiveStatus (the state the page shows)
src/app/actions/go-live.ts                 three actions, authorize(slug, "org.administer")
src/components/GoLivePanel.tsx             the section: status for everyone, steps for owners
src/app/o/[slug]/settings/page.tsx         renders it first
scripts/bootstrap-circle.ts                uses createTreasuryWallets for accounts
```

## 5. Error handling

| Situation | Result |
|---|---|
| The API key is rejected by Circle | "Circle did not accept this API key." Nothing stored |
| Circle is unreachable or times out | "Could not reach Circle; try again." Nothing stored |
| The entity secret is wrong (step 2) | "Circle did not accept the entity secret; reconnect with the right one." No wallet written |
| Some wallets are created, then a failure | The created ones are kept, since provisioning is idempotent; re-running finishes the rest |
| Going live without credentials or an operating wallet | Refused with the missing step named |
| The workspace is already live | The steps are hidden; the status is shown |
| A non-owner posts an action | 403, from `authorize` |
| Stored credentials become unreadable | The existing R12 behaviour: the page shows the warning, and payments refuse |

## 6. Testing

- **The migration, on PGlite:**
  - `delete_sandbox_org` refuses a sandbox with credentials;
  - it still deletes one without;
  - cleanup does not list the connected one;
  - replay is idempotent.
- **The library, with a fake Circle client:**
  - the key check returns ok, rejected (401/403) or unreachable (a timeout or a network error);
  - connect stores both envelopes bound to the org and column, and records the ledger entry with `{ by }` only;
  - no secret reaches a log, a return value or the ledger;
  - provisioning is idempotent, renames the simulated accounts, maps an entity-secret rejection, and keeps partial progress;
  - go-live refuses without credentials or wallets, and the update is conditional on `sandbox`.
- **The actions:** the permission literal `org.administer`, generic messages, and that the credentials are never in the returned state.
- **The panel:** a non-owner sees the status and no forms; an owner sees exactly the step they are on; a live workspace shows the status only; nothing secret is in the RSC props.
- **In the browser:** the steps at 360, 520 and 1440 px in headless Edge, against a sandbox with a fake Circle client (a dev flag in tests only, never in production).

## 7. Rollout

1. Apply `0029` before the merge. Probe that `delete_sandbox_org` refuses a sandbox with credentials.
2. Merge. The partner opens a new sandbox, or uses `note-one`, and follows the three steps:
   - connect with their Circle testnet credentials, typed into the form themselves;
   - create the wallets, then fund the operating wallet from the faucet (20 USDC);
   - go live.
3. Run one cycle there and check:
   - `reconcile` reads the on-chain balance;
   - the ledger has the three entries with ids only;
   - the next scheduled tick includes the workspace.
4. This is also the setting for the next item: approve-and-pay in production, with a held invoice in that workspace.
5. Record the outcome here.

## 8. Out of scope

- Switching back to sandbox, and deleting credentials.
- Minting counterparty wallets from the UI.
- A mainnet switch: Arc testnet only, as today.
- Circle credentials for EarnKit (`KIT_KEY`): yield stays simulated.
- Self-serve OpenSanctions configuration.
