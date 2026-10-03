# A key ends with its creator's membership

Date: 2026-10-03. Status: implemented on `claude/unruffled-khorana-dfec27`; migration 0069 is not yet applied in
production. Decided under the standing autonomy grant;
each ruling says what it costs if it is wrong. This replaces the first bullet of the API keys design's K4
(`2026-09-29-api-keys-design.md`): a key no longer survives its creator leaving the workspace.

## 1. The problem

- A workspace API key belongs to its workspace and records who created it (`created_by`, migration 0027). K4 decided
  that a key survives its creator leaving, and that `created_by` becomes null when the creator's account is deleted.
- So a member who leaves, or is removed, keeps every key they created. The key still reads the whole workspace: its
  invoices, counterparties, treasury and ledger. Removing a person does not remove their access.
- The write API (`feat/write-api`, migration 0066) makes this worse. A read-and-write key also adds counterparties and
  invoices, recorded as created by the key's issuer (write API R4). A removed member's leftover key could keep adding
  records in their name. It cannot redirect money, because an address added through the API waits for a person to
  confirm it (write API R3).
- Deleting an account is the same exit by another door. The person's memberships go with the account (0015's
  cascade), and their keys stay, with no creator. Such a key acts for nobody, so a record it adds has no maker, and
  the rule that no one approves what they entered cannot apply to it.
- Production, read-only probe on 2026-10-03: 1 active key and 1 revoked. No active key's creator has left its
  workspace, and none has a deleted account. So nothing needs revoking retroactively.

## 2. The rule

A workspace API key works only while the person who created it is a member of that workspace.

When that membership ends, every active key the person created in that workspace is revoked, in the same transaction
that ends it. A membership ends when the person leaves, when an owner or admin removes them, or when they delete
their account. Their keys in other workspaces they still belong to stay. Keys that other members created stay. A
revoked key answers exactly like an unknown one, as before (K4).

## 3. Approaches considered

- **A. Revoke in `removeMember`, right after the RPC.** Rejected. It uses two transactions: if the second one fails,
  the member is gone and the keys still work, which is the gap this design closes. It also misses every other way a
  membership ends.
- **B. Redefine `remove_member` in a new migration so it also revokes.** Rejected, for two reasons:
  - Its return type, `text`, cannot change in place. If a new migration changed it, 0021's `create or replace` would
    fail on every later `db:migrate`, which re-runs every file. So the caller could not learn which keys went.
  - A `db:migrate` run from a checkout without the new file silently puts 0021's body back.
- **C. The database enforces the rule, and a new function reports what it revoked (chosen).**
  - Triggers revoke the keys whatever ends a membership.
  - A new function, `remove_member_revoking_keys`, wraps `remove_member` and returns the ids of the keys it revoked,
    so the app can sign one ledger entry per key.
  - Nothing redefines an existing function. A replay from an older checkout therefore neither fails nor reverts it.
- **D. Check the creator's membership on every API request.** Rejected as the mechanism. It adds a query to every
  request, and the keys would still show as active in Settings, with nothing in the ledger. Revoking is visible and
  recorded.

## 4. Rulings

- **R1. Whatever ends a membership revokes the person's keys in that workspace.**
  - The trigger `memberships_revoke_api_keys` runs after a membership row is deleted, in the same transaction.
  - It covers every way a membership is deleted:
    - `remove_member`, and the new function;
    - the cascade from deleting an account;
    - an operator's delete;
    - a deployment still running the old code after the migration is applied, as the rollout does.
  - When the organization row is already gone (`delete_org`, or any delete of an organization), the trigger does
    nothing. The keys go with the workspace through 0027's cascade.
  - Cost if wrong: an operator who deletes a membership row by hand also ends that person's keys. That is the rule.
- **R2. A key whose creator's account is deleted is revoked too.**
  - Deleting an account clears `created_by` on its keys (0027's `on delete set null`). The trigger
    `api_keys_revoke_without_creator` runs before that update and sets `revoked_at` in the same row update.
  - Deleting an account therefore revokes its keys whichever of the account's two cascades Postgres runs first, the
    memberships' or the keys' own.
  - The row stays, with `created_by` null and `revoked_at` set, as Settings has always kept a revoked key.
- **R3. Only a member creates a key.**
  - The trigger `api_keys_creator_is_member` runs before a key is inserted. It refuses a key whose `created_by` is
    not a member of the key's workspace, with `api_key_creator_not_a_member`.
  - It takes a key-share lock on that membership row, held until the key is committed. A key created while its
    creator is being removed is therefore either committed first, and revoked with the others, or finds no membership
    and is refused.
  - Without it, a create request that passed its permission check just before the removal committed could still
    leave a working key behind.
  - A key inserted with no creator is not checked. Only the operator can insert one, and no membership can end it.
    The app always names the creator.
  - Cost if wrong: a test or script that creates a key for someone who is not a member now fails. That is the rule.
- **R4. `remove_member_revoking_keys(p_org_id, p_actor, p_user_id)` returns `(removed_role, revoked_key_ids)`.**
  - Only the service role may execute it.
  - In one transaction, it:
    1. locks the membership row;
    2. revokes the person's active keys in that workspace, and keeps their ids, oldest first;
    3. calls `remove_member`.
  - `remove_member`'s checks and errors are unchanged: `not_a_member`, `member_not_found`, `role_not_assignable`, and
    the last-owner trigger. A refusal rolls the whole call back, the revocations included.
  - The lock makes the returned ids complete. A key being created for the person is committed before the keys are
    read, and none can be created after (R3).
  - `removeMember` calls it instead of `remove_member`. The app's list of platform functions it may call drops
    `remove_member`.
- **R5. Each revoked key gets its own signed entry.**
  - After the member's own entry (`member_left` or `member_removed`, unchanged), `removeMember` appends one
    `api_key_revoked` per revoked key. The actor is `human` and the domain `system`. Each entry is best effort, like
    every entry in this module.
  - Its `detail` is `{ by, keyId, reason }`:
    - `reason: "member_left"` when the person left. `by` is that person.
    - `reason: "member_removed"` when someone removed them. `by` is who removed them, and `detail.member` is the
      person removed, as in `member_removed`.
  - Revoking a key in Settings now also carries `reason: "person"`, so every `api_key_revoked` from now on has a
    reason.
  - The entries record ids only (K8), never a key's name or prefix.
- **R6. Deleting an account records its revocations.**
  - Before anything is deleted, `deleteAccount` reads the person's active keys in the workspaces that stay.
  - Once the account is deleted, it appends `api_key_revoked` in each key's workspace, with
    `reason: "account_deleted"` and `by` the person.
  - If the account's deletion fails, nothing is appended, because nothing was revoked.
  - A key created in the moment between the read and the deletion is still revoked (R1, R2), but without an entry.
    Cost if wrong: one missing entry, for a key the person created while deleting their own account.
- **R7. The last owner keeps their keys, because they cannot leave.**
  - 0020's trigger still refuses removing or demoting a workspace's last owner, and leaving is a removal.
  - The refusal raises inside `remove_member_revoking_keys`, so the revocations roll back with it. The last owner
    stays, and so do their keys.
  - A last owner goes in one of two ways only:
    - the workspace is deleted, and its keys go with it;
    - they delete their account as the workspace's only member, and the workspace is deleted with the account.
  - A last owner with other members cannot delete their account (account deletion A2).
  - So no workspace is left with working keys whose creator has gone, whoever the last owner is.
- **R8. What does not change.**
  - **A role change keeps the keys.** A demoted admin is still a member and still accountable. An owner or admin can
    revoke the key in Settings.
  - **Webhook endpoints** a departed member created keep delivering. That is a separate change, recorded as a
    follow-up.
  - **Records** a departed member's key already added keep their `created_by`.
  - **The 401** for a revoked key is the same answer as before.
- **R9. The screens say so.**
  - On Members, the Remove confirmation names the active keys the person created, for example:

    > They lose access to this workspace at once, and the API keys they created stop working: "CI deploy" and
    > "Reporting". The removal is recorded in the audit log, and you can invite them again later.

  - Leave names the viewer's own keys the same way. With no keys, both read as before.
  - After a removal, the message says how many keys were revoked.
  - The account deletion dialog says that API keys you created in workspaces you share stop working.
  - The Members page reads the names and creators of active keys with the service role. It passes the browser only
    the names for the rows the viewer can act on: their own, and those they may remove. Every member can already read
    every key's name in Settings.
- **R10. The docs say so.**
  - Authentication:
    - "Revoking a key" says when a key is revoked without anyone choosing to, and lists `reason`'s values;
    - "Keeping a key safe" says to create a long-lived integration's key as someone who will stay.
  - The Quickstart says, in one sentence, that a key works while its creator is a member.
  - The changelog gets a dated entry.
  - ARCHITECTURE describes the members flow and the triggers.
  - The API keys design's K4 and the account deletion design's A3 point here.

## 5. Migration 0069

`0069_member_api_keys.sql` adds:
- the three triggers and their functions (R1–R3);
- `remove_member_revoking_keys` (R4);
- the grants. The functions are `security definer` with an empty `search_path`, like 0020's `keep_an_owner`.

It is additive. It redefines no existing function, so a replay from an older checkout neither fails nor reverts it.

It is numbered 0069 because 0066 is the write API's, and the integrations design reserves 0067 and 0068 for Slack and
for email intake.

## 6. Testing

- **Migration, against Postgres (PGlite), in `tests/member-api-keys-migration.test.ts`:**
  - Leaving revokes the leaver's active keys in that workspace only. Their keys in another workspace stay, other
    members' keys stay, and a key revoked earlier keeps its `revoked_at`.
  - Removal by an owner returns the removed role and the revoked ids, oldest first.
  - Each refusal rolls back, and the keys stay active: `role_not_assignable`, `member_not_found`, `not_a_member`, and
    the last owner.
  - A plain `remove_member` call and a direct delete of the membership also revoke (R1).
  - Deleting the account revokes the keys and clears `created_by` (R2).
  - Deleting the workspace still deletes its keys (R1's guard).
  - A key for someone who is not a member is refused. A key for a member is created (R3).
  - Only the service role may execute the function; `anon`, `authenticated` and the tenant cannot.
  - Every migration replays twice without error.
- **Unit:**
  - `removeMember` (`tests/members.test.ts`):
    - it calls the new function with the same parameters;
    - it appends the member's entry, then one `api_key_revoked` per id, with `reason` and `member`;
    - it appends no key entry when no key was revoked;
    - each entry is best effort;
    - it returns the count.
  - `revokeApiKey`: its entry carries `reason: "person"`.
  - `deleteAccount`:
    - it appends `account_deleted` entries after the deletion;
    - it appends none when the auth API refuses;
    - it appends none for the keys of a workspace deleted with the account.
  - `removeMemberAction`: the message counts the revoked keys.
  - The Members copy: the sentence for none, one, two and three key names.
- **Existing tests** that created a key for someone who is not a member of its workspace now add that membership first
  (R3).

## 7. Rollout

1. Merge `main` into the branch, then the partner runs `npm run db:migrate` from it to apply 0069. A read-only probe
   then checks:
   - the three triggers exist;
   - `remove_member_revoking_keys` is `security definer` with `search_path=""`;
   - only `service_role` may execute it.
2. Merge. The code calls `remove_member_revoking_keys`, so 0069 comes first. Until the deploy, the old code's
   `remove_member` already revokes through R1, without ledger entries.
3. In testnet-2:
   1. As an owner, invite a second account as an admin.
   2. As that admin, create a key in Settings. `GET /api/v1/status` with it answers 200.
   3. As the owner, remove the admin. The confirmation names the key, and the message says one key was revoked.
   4. Settings shows the key as revoked, and `GET /api/v1/status` with it answers 401.
   5. The ledger shows `member_removed`, then `api_key_revoked` with `reason: "member_removed"`.
4. Record the result here.
