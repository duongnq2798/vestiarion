# A key ends with its creator's membership: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a workspace API key works only while the person who created it is a member of the workspace. Leaving, being
removed or deleting the account revokes that person's active keys there, in the same transaction, and the ledger gets
one signed `api_key_revoked` entry per key.

**Architecture:**
- Migration 0069 adds three triggers and one function.
  - The triggers hold the rule whatever ends a membership: a deleted membership, an account deleted, or a key created
    for someone who is not a member.
  - `remove_member_revoking_keys` wraps `remove_member` and returns the ids it revoked.
- `removeMember` and `deleteAccount` write the entries.
- The Members page names the keys that will stop working.

**Tech stack:** Postgres (PL/pgSQL triggers), Next 16 server components and actions, supabase-js, vitest with PGlite
and `fakeSupabase`.

**Spec:** `docs/superpowers/specs/2026-10-03-member-api-keys-design.md`

## Global constraints

- No new runtime dependency. No change to any existing migration file: 0069 redefines nothing.
- Every new function is `set search_path = ''`. Those that read or lock platform rows are `security definer`, as 0020's
  `keep_an_owner` is. `remove_member_revoking_keys` is executable by `service_role` only.
- Ledger entries record ids only, never a key's name or prefix (API keys design K8).
- `api_key_revoked.detail` is `{ by, keyId, reason }`, plus `member` for `member_removed` only. `reason` is one of
  `person`, `member_left`, `member_removed`, `account_deleted`.
- The UI says "API key" and quotes key names with straight double quotes, as Settings' messages do.
- Commit messages are neutral, imperative, and end with the co-author line.
- Every doc the change makes stale is fixed in the same PR, and the changelog gets a dated entry (ARCHITECTURE,
  "Developer docs").

## Review focus

1. **A refusal must not revoke.** A viewer trying to remove an admin, or the last owner trying to leave, must leave
   every key working: the revocation happens before `remove_member`'s checks and must roll back with them. Tested in
   Task 1.
2. **Deleting a workspace or an account must still go through.** The new triggers must not make `delete_org`, a
   cascade from `orgs`, or deleting an `auth.users` row fail. Tested in Task 1. The existing delete-org and
   delete-account migration suites must stay green.
3. **Someone else's keys stay.** Removing one member must not touch keys that other members created, nor the
   removed member's keys in another workspace, nor the `revoked_at` of a key revoked earlier. Tested in Task 1.
4. **The account deletion read happens before anything is deleted.** If reading the keys fails, no workspace and no
   account may be deleted. Tested in Task 4.
5. **The Members page leaks no names to rows the viewer cannot act on.** A viewer must receive only their own keys'
   names. Tested in Task 5, through `keyNamesForViewer`.

---

### Task 1: migration 0069

**Files:**
- Create: `supabase/migrations/0069_member_api_keys.sql`
- Create: `tests/member-api-keys-migration.test.ts`
- Modify: `tests/api-keys-migration.test.ts`. Its `create` helper and its account-deletion test create keys for
  someone who is not a member, which R3 now refuses.

**Interfaces:**
- Produces: `public.remove_member_revoking_keys(p_org_id uuid, p_actor uuid, p_user_id uuid) returns table
  (removed_role text, revoked_key_ids uuid[])`, and the error prefix `api_key_creator_not_a_member:`.

- [ ] **Step 1: Write the failing PGlite tests** in `tests/member-api-keys-migration.test.ts`:
  - **Leaving or being removed (R1, R4):**
    - Leaving revokes the leaver's active keys in that workspace, and returns them oldest first. Their key in a second
      workspace stays active, another member's key stays active, and a key revoked earlier keeps its `revoked_at`.
    - An owner removing an admin returns `removed_role: "admin"` and the admin's key ids.
    - A member who created no key gets `revoked_key_ids: []`.
  - **Refusals roll back (Review focus 1):**
    - `role_not_assignable` (a viewer removes an admin) and `not_a_member` (an outsider acts) both leave the target's
      keys active and the membership in place.
    - `member_not_found` (the target is not a member) raises.
    - The last owner leaving raises `/last owner/` and keeps their key active (R7).
  - **Other ends of a membership (R1):**
    - A plain `remove_member` call revokes.
    - `delete from public.memberships` revokes.
    - `delete from public.orgs` still deletes the org's keys and memberships without error.
  - **Deleting the account (R2):**
    - Deleting the `auth.users` row of a member of two workspaces revokes their keys in both and clears `created_by`.
      A key revoked earlier keeps its `revoked_at`.
    - An update of a key's name does not revoke it.
  - **Creating a key (R3):**
    - `create_api_key` for an outsider, or for a member of another workspace only, raises
      `/api_key_creator_not_a_member/` and inserts nothing.
    - A key inserted with no `created_by` is accepted.
  - **Who may call it:**
    - `anon`, `authenticated` and the tenant get `permission denied` on `remove_member_revoking_keys`.
    - `pg_proc` shows it `security definer` with `search_path=""`.
  - **Replay:**
    - Executing 0069 again changes nothing.
    - The three triggers still exist once each.

- [ ] **Step 2: Run the tests and watch them fail.**
  Run: `npx vitest run tests/member-api-keys-migration.test.ts`. They fail because `remove_member_revoking_keys` does
  not exist and no trigger revokes anything yet.

- [ ] **Step 3: Write the migration**, exactly as follows:

```sql
-- A workspace API key works only while the person who created it is a member of the workspace
-- (docs/superpowers/specs/2026-10-03-member-api-keys-design.md). Before this, a key outlived its creator's membership
-- (API keys design K4). Re-runnable, as every migration here: db:migrate applies them all in order. It redefines no
-- existing function, so a run from a checkout without this file neither fails nor undoes it.
--
-- The functions that read or lock platform rows are security definer with an empty search_path, as 0020's
-- keep_an_owner is: memberships and api_keys are platform tables that only the service role may touch.

-- 1. Whatever ends a membership revokes the keys its person created in that workspace, in the same transaction (R1):
--    leaving or being removed (remove_member, and remove_member_revoking_keys below), the cascade from deleting an
--    account, an operator's delete, or code deployed before this file that still calls remove_member.
create or replace function public.revoke_departed_member_api_keys() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- The organization row is gone: this membership goes with it, and so do its keys (0027's cascade).
  perform 1 from public.orgs where id = old.org_id;
  if not found then
    return old;
  end if;

  update public.api_keys set revoked_at = now()
   where org_id = old.org_id and created_by = old.user_id and revoked_at is null;
  return old;
end;
$$;

revoke execute on function public.revoke_departed_member_api_keys() from public, anon, authenticated;

drop trigger if exists memberships_revoke_api_keys on public.memberships;
create trigger memberships_revoke_api_keys
  after delete on public.memberships
  for each row execute function public.revoke_departed_member_api_keys();

-- 2. Deleting an account clears created_by on its keys (0027's on delete set null). Such a key acts for nobody, so the
--    same update revokes it (R2): deleting an account revokes its keys whichever of its cascades runs first.
create or replace function public.revoke_api_key_without_creator() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.created_by is not null and new.created_by is null and new.revoked_at is null then
    new.revoked_at := now();
  end if;
  return new;
end;
$$;

revoke execute on function public.revoke_api_key_without_creator() from public, anon, authenticated;

drop trigger if exists api_keys_revoke_without_creator on public.api_keys;
create trigger api_keys_revoke_without_creator
  before update of created_by on public.api_keys
  for each row execute function public.revoke_api_key_without_creator();

-- 3. Only a member creates a key (R3). The key-share lock holds the creator's membership row until the key is
--    committed: a removal waits for it and then revokes the new key with the others, and a removal that committed
--    first leaves no row to find. A key with no creator, which only the operator can insert, is no one's to end.
create or replace function public.api_key_creator_is_member() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.created_by is not null then
    perform 1 from public.memberships m
     where m.org_id = new.org_id and m.user_id = new.created_by
       for key share;
    if not found then
      raise exception 'api_key_creator_not_a_member: the person creating this key is not a member of this organization';
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.api_key_creator_is_member() from public, anon, authenticated;

drop trigger if exists api_keys_creator_is_member on public.api_keys;
create trigger api_keys_creator_is_member
  before insert on public.api_keys
  for each row execute function public.api_key_creator_is_member();

-- 4. What the app calls to end a membership (R4): remove_member (0021), unchanged, and the ids of the keys it revoked,
--    oldest first, so each gets its own signed ledger entry.
create or replace function public.remove_member_revoking_keys(p_org_id uuid, p_actor uuid, p_user_id uuid)
returns table (removed_role text, revoked_key_ids uuid[])
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_keys uuid[];
  v_role text;
begin
  -- Lock the membership first. A key being created for this person holds a key-share lock on this row (3), so it is
  -- committed before the keys are read below, and none can be created after.
  perform 1 from public.memberships m where m.org_id = p_org_id and m.user_id = p_user_id for update;

  -- Revoked before remove_member checks the actor: a refusal raises, and the whole call rolls back, these updates
  -- included. remove_member's delete then fires (1), which finds nothing left to revoke.
  with revoked as (
    update public.api_keys k set revoked_at = now()
     where k.org_id = p_org_id and k.created_by = p_user_id and k.revoked_at is null
    returning k.id, k.created_at
  )
  select coalesce(array_agg(r.id order by r.created_at, r.id), '{}') into v_keys from revoked r;

  v_role := public.remove_member(p_org_id, p_actor, p_user_id);
  return query select v_role, v_keys;
end;
$$;

revoke execute on function public.remove_member_revoking_keys(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.remove_member_revoking_keys(uuid, uuid, uuid) to service_role;

-- Rollback:
-- drop function if exists public.remove_member_revoking_keys(uuid, uuid, uuid);
-- drop trigger if exists api_keys_creator_is_member on public.api_keys;
-- drop trigger if exists api_keys_revoke_without_creator on public.api_keys;
-- drop trigger if exists memberships_revoke_api_keys on public.memberships;
-- drop function if exists public.api_key_creator_is_member(), public.revoke_api_key_without_creator(),
--   public.revoke_departed_member_api_keys();
```

- [ ] **Step 4: Fix the two 0027 tests that R3 now refuses.**
  - `create` adds the owner as an owner of the organization first, with `on conflict (org_id, user_id) do nothing`.
  - "keeps the key when its creator's account is deleted" first makes the creator an admin of `creator-co`.

- [ ] **Step 5: Run the new suite, the 0027 suite, and the suites that delete orgs, accounts or memberships.**
  Run: `npx vitest run tests/member-api-keys-migration.test.ts tests/api-keys-migration.test.ts
  tests/delete-org-migration.test.ts tests/delete-account-migration.test.ts tests/members-migration.test.ts
  tests/telegram-migration.test.ts tests/sole-approver-migration.test.ts`. Expected: all pass.

- [ ] **Step 6: Commit.** Message: "End a member's API keys with their membership, in the database".

### Task 2: the `api_key_revoked` entry, with a reason, and key names by creator

**Files:**
- Modify: `src/lib/platform/api-keys.ts`
- Test: `tests/api-keys.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ApiKeyRevokedReason = "person" | "member_left" | "member_removed" | "account_deleted";
  export type ApiKeyRevocation =
    | { reason: "person" | "member_left" | "account_deleted"; by: string; keyId: string }
    | { reason: "member_removed"; by: string; keyId: string; member: string };
  export function apiKeyRevokedEntry(revocation: ApiKeyRevocation): LedgerEntryInput;
  export async function activeKeyNamesByCreator(orgId: string): Promise<Record<string, string[]>>;
  ```
- `revokeApiKey` appends `apiKeyRevokedEntry({ reason: "person", by: actorId, keyId })`.

- [ ] **Step 1: Write the failing tests:**
  - `apiKeyRevokedEntry` gives actor `human`, domain `system`, action `api_key_revoked`, and these summaries:

    | `reason` | `summary` |
    |---|---|
    | `person` | "An API key was revoked" |
    | `member_left` | "An API key was revoked when the member who created it left" |
    | `member_removed` | "An API key was revoked when the member who created it was removed" |
    | `account_deleted` | "An API key was revoked when the member who created it deleted their account" |

    `detail` is exactly `{ by, keyId, reason }`, plus `member` for `member_removed`.
  - `revokeApiKey`'s entry `detail` is `{ by: ACTOR, keyId: KEY_ID, reason: "person" }`.
  - `activeKeyNamesByCreator`:
    - it sends `org_id=eq.<org>`, `revoked_at=is.null` and `select=name,created_by`, ordered by `created_at`;
    - it groups names by creator, keeping their order;
    - it skips a key whose `created_by` is null.
- [ ] **Step 2: Run them and watch them fail.** Run: `npx vitest run tests/api-keys.test.ts`.
- [ ] **Step 3: Implement**, beside `revokeApiKey`:

```ts
/** Why a key was revoked (member API keys design R5, R6): by a person in Settings, or because its creator's membership ended. */
export type ApiKeyRevokedReason = "person" | "member_left" | "member_removed" | "account_deleted";

/** `member` names the person removed, as `member_removed` does; for every other reason `by` says it all. */
export type ApiKeyRevocation =
  | { reason: "person" | "member_left" | "account_deleted"; by: string; keyId: string }
  | { reason: "member_removed"; by: string; keyId: string; member: string };

const REVOKED_SUMMARIES: Record<ApiKeyRevokedReason, string> = {
  person: "An API key was revoked",
  member_left: "An API key was revoked when the member who created it left",
  member_removed: "An API key was revoked when the member who created it was removed",
  account_deleted: "An API key was revoked when the member who created it deleted their account",
};

/** The `api_key_revoked` entry: ids only (K8), never the key's name or prefix. */
export function apiKeyRevokedEntry(revocation: ApiKeyRevocation): LedgerEntryInput {
  const detail: Record<string, unknown> = { by: revocation.by, keyId: revocation.keyId, reason: revocation.reason };
  if (revocation.reason === "member_removed") detail.member = revocation.member;
  return { actor: "human", domain: "system", action: "api_key_revoked", summary: REVOKED_SUMMARIES[revocation.reason], detail };
}

/**
 * The names of the workspace's active keys, by the member who created each, oldest first: the Members page names the
 * keys that stop working when a membership ends (migration 0069). A key whose creator's account is gone has no entry.
 */
export async function activeKeyNamesByCreator(orgId: string): Promise<Record<string, string[]>> {
  const rows = unwrap(
    await platformDb()
      .from("api_keys")
      .select("name, created_by")
      .eq("org_id", orgId)
      .is("revoked_at", null)
      .order("created_at")
  ) as Array<{ name: string; created_by: string | null }>;
  const byCreator: Record<string, string[]> = {};
  for (const row of rows) {
    if (row.created_by) (byCreator[row.created_by] ??= []).push(row.name);
  }
  return byCreator;
}
```

  Then `revokeApiKey` appends
  `apiKeyRevokedEntry({ reason: "person", by: input.actorId, keyId: input.keyId })` in place of its inline entry.
- [ ] **Step 4: Run the tests and watch them pass.** Run: `npx vitest run tests/api-keys.test.ts`.
- [ ] **Step 5: Commit.** Message: "Say why an API key was revoked in its ledger entry".

### Task 3: `removeMember` ends the keys and records each

**Files:**
- Modify: `src/lib/platform/members.ts`, `src/lib/dal/index.ts` (`PLATFORM_RPCS`: `remove_member` becomes
  `remove_member_revoking_keys`), `src/app/actions/members.ts`
- Test: `tests/members.test.ts`, `tests/members-actions.test.ts`

**Interfaces:**
- Consumes: `remove_member_revoking_keys` (Task 1), `apiKeyRevokedEntry` (Task 2).
- Produces: `removeMember(input: { actorId: string; userId: string }): Promise<{ revokedKeys: number }>`.

- [ ] **Step 1: Write the failing tests:**
  - **`tests/members.test.ts`.** The fake answers `/rest/v1/rpc/remove_member_revoking_keys` with
    `{ removed_role, revoked_key_ids: options.revokedKeyIds ?? [] }`.
    - The request body is exactly `{ p_org_id: ORG, p_actor, p_user_id }`.
    - Leaving with two keys appends `member_left`, then `api_key_revoked` for each key, in order. Each `detail` is
      exactly `{ by: ACTOR, keyId, reason: "member_left" }`. It returns `{ revokedKeys: 2 }`.
    - Removing someone with one key appends `member_removed`, then `api_key_revoked` with `detail` exactly
      `{ by: ACTOR, keyId, reason: "member_removed", member: TARGET }`.
    - No key means one entry and `{ revokedKeys: 0 }`.
    - The last-owner refusal throws `MemberError` `last_owner` and appends nothing.
    - With the ledger down, `removeMember` still resolves with the count, and logs `api_key_revoked` once per key.
      The existing "best effort" table no longer expects `undefined` from `removeMember`.
  - **`tests/members-actions.test.ts`.** Removing someone answers:

    | Keys revoked | Message |
    |---|---|
    | 0 | "Member removed." |
    | 1 | "Member removed. The API key they created was revoked." |
    | 2 | "Member removed. The 2 API keys they created were revoked." |

    Leaving still answers "You left the workspace." The mocks resolve `{ revokedKeys: n }`.
- [ ] **Step 2: Run them and watch them fail.** Run: `npx vitest run tests/members.test.ts tests/members-actions.test.ts`.
- [ ] **Step 3: Implement `removeMember`:**

```ts
/** The row `remove_member_revoking_keys` returns (migration 0069). */
interface RemovedMemberRow {
  removed_role: OrgRole;
  revoked_key_ids: string[];
}

/**
 * Runs in scope: `p_org_id` comes from `currentOrgId()`. Ending a membership also revokes the active API keys the
 * person created in this workspace, in the same transaction (migration 0069). The member's entry comes first, then one
 * `api_key_revoked` per key, each best effort.
 */
export async function removeMember(input: { actorId: string; userId: string }): Promise<{ revokedKeys: number }> {
  const orgId = currentOrgId();
  const result = await platformDb()
    .rpc("remove_member_revoking_keys", { p_org_id: orgId, p_actor: input.actorId, p_user_id: input.userId })
    .single<RemovedMemberRow>();
  if (result.error) raise(result.error);
  const { removed_role: role, revoked_key_ids: keyIds } = result.data as RemovedMemberRow;
  const left = input.actorId === input.userId;

  // ...the existing member_left / member_removed entry, unchanged...

  for (const keyId of keyIds) {
    await appendLedgerEntryBestEffort(
      orgId,
      left
        ? apiKeyRevokedEntry({ reason: "member_left", by: input.actorId, keyId })
        : apiKeyRevokedEntry({ reason: "member_removed", by: input.actorId, keyId, member: input.userId })
    );
  }
  return { revokedKeys: keyIds.length };
}
```

  In `removeMemberAction`, `const { revokedKeys } = await removeMember(...)`. For someone else, the message is
  `removedMessage(revokedKeys)`, which gives the three strings above.
- [ ] **Step 4: Run them and watch them pass.** Also run `npx vitest run tests/dal.test.ts`, for the RPC allowlist.
- [ ] **Step 5: Commit.** Message: "Record each API key a departing member's membership takes with it".

### Task 4: deleting an account records its revocations

**Files:**
- Modify: `src/lib/platform/delete-account.ts`, `src/components/DeleteAccountDialog.tsx`, and
  `src/app/privacy/page.tsx` if its account deletion paragraph lists what goes.
- Test: `tests/delete-account-lib.test.ts`, `tests/delete-account-ui.test.tsx`

**Interfaces:**
- Consumes: `apiKeyRevokedEntry` (Task 2), `appendLedgerEntryBestEffort` (`src/lib/ledger-best-effort.ts`).

- [ ] **Step 1: Write the failing tests.** `tests/delete-account-lib.test.ts` mocks `@/lib/ledger-best-effort`. The
  fake's `World` gains `apiKeys` and `keysFail`, and the fake answers `GET /rest/v1/api_keys`, filtered by
  `created_by=eq.` and `revoked_at=is.null`.
  - With two active keys in a shared workspace, and one in a sole workspace, it appends exactly two entries:
    `(sharedId, apiKeyRevokedEntry({ reason: "account_deleted", by: ME, keyId }), { enterScope: { userId: ME } })`.
    Both are appended after the auth user is deleted.
  - It appends nothing when the auth admin API refuses.
  - When the keys cannot be read, it throws, and no `delete_org` and no auth delete was sent.
  - `tests/delete-account-ui.test.tsx`: the dialog body contains "API keys you created in them stop working."
- [ ] **Step 2: Run them and watch them fail.**
  Run: `npx vitest run tests/delete-account-lib.test.ts tests/delete-account-ui.test.tsx`.
- [ ] **Step 3: Implement:**

```ts
/**
 * The person's active API keys in the workspaces that stay (member API keys design R6). Deleting the account revokes
 * them in the database (migration 0069); each gets its `api_key_revoked` entry once the account is gone.
 */
async function keysLeftBehind(userId: string, deletedWithAccount: ReadonlySet<string>): Promise<Array<{ id: string; orgId: string }>> {
  const rows = unwrap(
    await platformDb().from("api_keys").select("id, org_id").eq("created_by", userId).is("revoked_at", null).order("created_at")
  ) as Array<{ id: string; org_id: string }>;
  return rows.filter((row) => !deletedWithAccount.has(row.org_id)).map((row) => ({ id: row.id, orgId: row.org_id }));
}
```

  In `deleteAccount`, after the running-agent refusal and before the `delete_org` loop:
  `const keys = await keysLeftBehind(input.userId, new Set(soleIds.values()));`.

  After `deleteUser` succeeds, for each key:
  `appendLedgerEntryBestEffort(key.orgId, apiKeyRevokedEntry({ reason: "account_deleted", by: input.userId, keyId: key.id }), { enterScope: { userId: input.userId } })`.

  The dialog's `remains` paragraph gains "API keys you created in them stop working." after "Your memberships and the
  invitations you sent are removed."
- [ ] **Step 4: Run them and watch them pass.** Run the two files again, plus `tests/delete-account-action.test.ts`.
- [ ] **Step 5: Commit.** Message: "Record the API keys an account takes with it when it is deleted".

### Task 5: the Members confirmations name the keys

**Files:**
- Create: `src/lib/member-keys.ts`
- Modify: `src/components/MembersPanel.tsx`, `src/app/o/[slug]/members/page.tsx`
- Test: `tests/member-keys.test.ts`

**Interfaces:**
- Consumes: `activeKeyNamesByCreator` (Task 2), `canAssignRole` and `OrgRole` (`src/lib/auth/roles.ts`).
- Produces:
  ```ts
  export function removeMemberDescription(keyNames: readonly string[]): string;
  export function leaveWorkspaceDescription(keyNames: readonly string[]): string;
  export function keyNamesForViewer(input: {
    members: ReadonlyArray<{ userId: string; role: OrgRole }>;
    viewerId: string;
    viewerRole: OrgRole;
    byCreator: Readonly<Record<string, string[]>>;
  }): Record<string, string[]>;
  ```
  `MembersPanel` takes `keyNames?: Record<string, string[]>`, keyed by user id.

- [ ] **Step 1: Write the failing tests** (`tests/member-keys.test.ts`):
  - `removeMemberDescription([])` is the current text, word for word: "They lose access to this workspace at once.
    The removal is recorded in the audit log, and you can invite them again later."
  - `removeMemberDescription(["CI deploy"])` is: `They lose access to this workspace at once, and the API key they
    created stops working: "CI deploy". The removal is recorded in the audit log, and you can invite them again later.`
  - Two names read `"CI deploy" and "Reporting"`, and three read `"a", "b" and "c"`, under "the API keys they created
    stop working".
  - `leaveWorkspaceDescription([])` is "You lose access at once. An owner or admin can invite you back."
    `leaveWorkspaceDescription(["CI deploy"])` is `You lose access at once, and the API key you created stops working:
    "CI deploy". An owner or admin can invite you back.`
  - `keyNamesForViewer`:
    - a viewer gets only their own entry;
    - an owner gets everyone else's and their own;
    - an admin gets their own and the approvers' and viewers', but not the other admins' or the owners';
    - a member with no keys gets `[]`.
- [ ] **Step 2: Run them and watch them fail.** Run: `npx vitest run tests/member-keys.test.ts`.
- [ ] **Step 3: Implement:**

```ts
import { canAssignRole, type OrgRole } from "./auth/roles";

/**
 * What the Members page says about the API keys a membership takes with it (member API keys design R9). A key works
 * only while its creator is a member (migration 0069), so leaving, or being removed, revokes the keys the person
 * created in this workspace; the confirmation names them first.
 */

/** "a"; "a" and "b"; "a", "b" and "c". Each name is quoted, as Settings quotes a key's name. */
function quotedList(names: readonly string[]): string {
  const quoted = names.map((name) => `"${name}"`);
  return quoted.length < 2 ? quoted.join("") : `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

function keysClause(names: readonly string[], who: "they" | "you"): string {
  if (names.length === 0) return "";
  const subject = names.length === 1 ? `the API key ${who} created stops working` : `the API keys ${who} created stop working`;
  return `, and ${subject}: ${quotedList(names)}`;
}

export function removeMemberDescription(keyNames: readonly string[]): string {
  return `They lose access to this workspace at once${keysClause(keyNames, "they")}. The removal is recorded in the audit log, and you can invite them again later.`;
}

export function leaveWorkspaceDescription(keyNames: readonly string[]): string {
  return `You lose access at once${keysClause(keyNames, "you")}. An owner or admin can invite you back.`;
}

/**
 * The key names the Members page hands the browser: the viewer's own, for Leave, and those of each member the viewer
 * may remove. A viewer, who removes no one, gets their own only.
 */
export function keyNamesForViewer(input: {
  members: ReadonlyArray<{ userId: string; role: OrgRole }>;
  viewerId: string;
  viewerRole: OrgRole;
  byCreator: Readonly<Record<string, string[]>>;
}): Record<string, string[]> {
  const names: Record<string, string[]> = {};
  for (const member of input.members) {
    if (member.userId === input.viewerId || canAssignRole(input.viewerRole, member.role)) {
      names[member.userId] = input.byCreator[member.userId] ?? [];
    }
  }
  return names;
}
```

  `members/page.tsx` adds `activeKeyNamesByCreator(membership.orgId)` to its `Promise.all`, and passes
  `keyNames={keyNamesForViewer({ members, viewerId: user.id, viewerRole: membership.role, byCreator })}`.

  `MembersPanel` passes `keyNames[member.userId] ?? []` to `RemoveMember` and to `LeaveWorkspace`. Their
  `ConfirmDialog` descriptions become `removeMemberDescription(keyNames)` and `leaveWorkspaceDescription(keyNames)`.
- [ ] **Step 4: Run them and watch them pass.** Then run `npm run typecheck`.
- [ ] **Step 5: Commit.** Message: "Name the API keys that stop working in the Members confirmations".

### Task 6: docs

**Files:**
- `content/docs/get-started/authentication.mdx`:
  - "Creating a key" says a key works while its creator is a member;
  - "Revoking a key" says who revokes a key without choosing to, and lists `reason`'s values;
  - "Keeping a key safe" gains the long-lived integration bullet.
- `content/docs/get-started/quickstart.mdx`: one sentence after the 20-keys limit.
- `content/docs/changelog.mdx`: a new top entry, "2026-10-03: A member's API keys end with their membership".
- `ARCHITECTURE.md`:
  - the members paragraph: `remove_member_revoking_keys`, and the three triggers;
  - the `/api/v1` paragraph: a key works while its creator is a member.
- `README.md`: the API keys paragraph gets one sentence.
- `docs/superpowers/specs/2026-09-29-api-keys-design.md`: K4's first two bullets point to the new spec.
- `docs/superpowers/specs/2026-09-30-workspace-delete-footer-screenshots-design.md`: A3 gains the 0069 note.
- `docs/superpowers/specs/2026-10-03-member-api-keys-design.md`: the status line.

- [ ] **Step 1:** Write the changes above. Then grep `content/`, `README.md`, `ARCHITECTURE.md` and
  `docs/superpowers/specs/` for "survives", "outlive", "created_by becomes null", "api_key_revoked" and "leaves the
  workspace", and fix any statement still claiming a key outlives its creator.
- [ ] **Step 2:** Run `npx vitest run tests/docs-*.test.ts tests/docs-*.test.tsx`. Expected: pass, which proves the
  links, anchors and nav still resolve.
- [ ] **Step 3: Commit.** Message: "Document that a key ends with its creator's membership".

### Task 7: verify and open the PR

- [ ] **Step 1:** Run `npm run verify`, and `npm run build`. Expected: both green.
- [ ] **Step 2:** Merge `origin/main` into the branch, if it moved, and rerun `npm run verify`.
- [ ] **Step 3:** Push to `origin` as `fix/member-api-keys` and open the PR. The body states:
  - the rule;
  - the migration;
  - the rollout order: the partner runs `db:migrate` for 0069 from this branch before the merge;
  - the probe;
  - the testnet-2 steps from spec §7.
- [ ] **Step 4:** Update the roadmap row API1b with the PR number.
