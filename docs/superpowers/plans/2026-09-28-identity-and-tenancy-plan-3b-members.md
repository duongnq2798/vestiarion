# Identity and tenancy — Plan 3b: members, invitations and sandbox lifecycle

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An owner or admin can invite people by email, see and manage the workspace's members, and no one can grant a role above their own. Abandoned sandboxes are deleted daily. The sandbox cycle cap holds under concurrency.

**Architecture:**
- **Migration `0021`** adds service-role functions that take the acting person and check that person's role themselves: `invite_member`, `accept_invitation`, `change_member_role`, `remove_member`, `revoke_invitation`, and `org_members`, which reads names from `auth.users`. The rule that no one grants a role above their own lives here.
- **Migration `0022`** adds:
  - `touch_org_activity`;
  - `delete_sandbox_org`, which refuses a live organization and one active since the cutoff;
  - `begin_cycle_run`, a tenant function that takes a per-organization lock, counts today's runs and opens the run in one transaction.
- **`src/lib/platform/members.ts`** calls those functions, records every membership change in the organization's signed ledger (user ids only, never email addresses), and sends the invitation through `src/lib/email/send.ts` (Resend's HTTP API, optional).
- **Pages and routes:**
  - `/o/[slug]/members` is the members page;
  - `/invite/[token]` accepts an invitation, by POST;
  - `/api/platform/cleanup` is called by a daily GitHub Actions schedule.

**Tech Stack:** Next.js 16.3.6, supabase-js 2.117, Postgres (Supabase), PGlite, Vitest, Node `crypto`, Resend HTTP API via `fetch` (no SDK).

**Spec:** `docs/superpowers/specs/2026-09-27-identity-and-tenancy-design.md`:
- §5.1 `invitations`;
- §6 (abandoned sandboxes, email delivery);
- §7 (roles, invitations, the ledger records who);
- §8 (errors);
- §10 step 5b, with the decisions recorded under it on 2026-09-28.

## Global Constraints

- Read the relevant guide in `node_modules/next/dist/docs/` before writing Next code (`AGENTS.md`). In this Next version:
  - a layout is not a gate: every page calls `requireMembership` itself;
  - `params` is a Promise.
- No new dependencies. `npm run verify` is green at every commit.
- Migrations are idempotent. `scripts/migrate.ts` replays every file from `0001` each run, each in its own transaction.
- Roles, highest first: `owner`, `admin`, `approver`, `viewer`. An owner may grant or change any role. An admin may grant or change only `approver` and `viewer`. No one else may do either (`canAssignRole` in `src/lib/auth/roles.ts`).
- Invitations:
  - expire **7 days** after they are created;
  - an organization has at most **20** open invitations;
  - the token is 32 random bytes, base64url;
  - only `sha256` hex of the token is stored.
- An abandoned sandbox is a `sandbox` organization whose `last_active_at` is more than **60 days** old. `last_active_at` is refreshed at most once an hour. A `live` organization is never deleted automatically.
- Sandbox cap: at most **20** cycles per sandbox organization per UTC day (`SANDBOX_DAILY_CYCLES`).
- Email sender: `Vestiarion <no-reply@vestiarion.xyz>`, env `RESEND_API_KEY` (optional) and `EMAIL_FROM` (optional). Never use any other domain.
- Ledger entries record user ids (`detail.by`, `detail.member`), never an email address (§7).
- Data access:
  - tenant data goes through `db()` (the tenant role, RLS);
  - platform tables (`orgs`, `memberships`, `invitations`) and platform functions go through `platformDb()`;
  - ESLint forbids the raw client outside `src/lib/dal`.
- Never print secrets or tokens. Never run anything against the Supabase project in `.env.local` (production). SQL is tested on PGlite only (`tests/support/pglite.ts`).
- Commit messages are neutral descriptions of the change: subject, blank line, then the Co-Authored-By trailer your harness mandates, via `git commit -F <file>`.

## Review Focus

1. **A mail scanner or link preview opens the invitation link before the person does.** Expected: the invitation is still unused. Only the signed-in person's POST accepts it. Pinned by Task 5 (the page has no side effect; a test asserts `acceptInvitation` is reached only from the action).
2. **Someone signed in with a different address opens a forwarded invitation.** Expected: refused with a message saying the invitation was sent to a different address, without disclosing that address. The invitation stays open. Pinned by Tasks 1 and 5.
3. **An admin crafts a POST to make someone an owner or admin, or to change an owner's role.** Expected: the database refuses it, even though `members.manage` lets the admin reach the action. Pinned by Task 1 (SQL) and Task 4 (the action surfaces the message).
4. **A workspace name containing HTML, or an address with `<script>` in it.** Expected: the email and the page render it as text. Pinned by Task 3 (`invitationEmail` escapes) and Task 1 (`invalid_email`).
5. **The cleanup meets a sandbox that became active after it was listed, or a live organization.** Expected: neither is deleted. Pinned by Task 2 (`p_inactive_before`, `not_a_sandbox`).

## Rulings made while writing this plan

These are also recorded in the spec under §10 step 5b.
- **Membership changes go through service-role functions that take `p_actor`.** `memberships` and `invitations` are platform tables the tenant role cannot touch. So the database-side role check lives in these functions, and every one of them re-reads the actor's role inside the same transaction.
- **Accepting re-checks the inviter's role.** An invitation sent by an admin who has since been demoted to viewer no longer grants anything.
- **Accepting when already a member is refused** (`already_a_member`). Role changes are the members page's job.
- **Leaving is removing yourself.** Any member may leave. The last-owner trigger from `0020` still refuses the last owner.
- **The invitation link is shown once to its sender**, whether or not the email was sent. The token is not stored, so it cannot be shown again. A lost link means revoking the invitation and inviting again.
- **`sandboxCyclesUsedToday` is removed.** `begin_cycle_run` replaces it. A refused cycle advances nothing: in simulate mode the day is advanced only after the run is open.
- **Cleanup deletes the organization's ledger too.** The chain belongs to an organization that no longer exists, and a sandbox never held real money. `cycle_snapshots` is append-only by trigger. The trigger lets a delete through only when the transaction-local setting `vestiarion.purging_org` names the row's organization, and only `delete_sandbox_org` sets it.
- **The copy fixes from the 5a rollout ride along (Task 8).**
  - On a sandbox, the balance tile no longer says "on-chain".
  - The cycle report counts ledger entries rather than claiming a number of decisions that disagrees with the entry it summarises. Counts are pluralised.

---

### Task 1: Migration 0021 — membership functions

**Files:**
- Create: `supabase/migrations/0021_members.sql`
- Test: `tests/members-migration.test.ts`

**Interfaces:**
- Consumes: tables from `0015`; the `keep_an_owner` trigger from `0020`; `createUser`, `createDatabase`, `applyMigrations`, `asServiceRole`, `asRole`, `asTenant` from `tests/support/pglite.ts`.
- Produces SQL functions, all `security definer`, `search_path = ''`, executable by `service_role` only. Each raises `'<code>: <text>'`; Task 3 maps the code.

| Function | Returns |
|---|---|
| `invite_member(p_org_id uuid, p_actor uuid, p_email text, p_role text, p_token_hash text)` | `public.invitations` |
| `accept_invitation(p_token_hash text, p_user_id uuid)` | `table(org_id uuid, slug text, role text, invitation_id uuid)` |
| `change_member_role(p_org_id uuid, p_actor uuid, p_user_id uuid, p_role text)` | `text`, the previous role |
| `remove_member(p_org_id uuid, p_actor uuid, p_user_id uuid)` | `text`, the removed role |
| `revoke_invitation(p_org_id uuid, p_actor uuid, p_invitation_id uuid)` | `void` |
| `org_members(p_org_id uuid)` | `table(user_id uuid, email text, role text, joined_at timestamptz)` |

- Error codes: `not_a_member`, `member_not_found`, `role_not_assignable`, `invalid_email`, `already_a_member`, `invitation_limit_reached`, `invitation_not_found`, `invitation_used`, `invitation_expired`, `invitation_email_mismatch`, `invitation_no_longer_valid`.

- [ ] **Step 1: Write the failing tests**

`tests/members-migration.test.ts`:

```ts
import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createUser } from "./support/pglite";

/**
 * Migration 0021: every membership change goes through a service-role
 * function that is told who is acting and checks that person's role itself
 * (spec §7, §10 step 5b). No one grants a role above their own.
 */

let db: PGlite;
let owner: string, admin: string, approver: string, viewer: string, outsider: string;
let orgId: string;

const hash = () => crypto.randomBytes(32).toString("hex");

async function call<T = Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> {
  return asServiceRole(db, async (tx) => (await tx.query<T>(sql, params)).rows);
}
const invite = (actor: string, email: string, role: string, tokenHash = hash()) =>
  call<{ id: string; email: string; expires_at: Date }>(
    "select * from public.invite_member($1, $2, $3, $4, $5)", [orgId, actor, email, role, tokenHash]);
const accept = (tokenHash: string, userId: string) =>
  call<{ org_id: string; slug: string; role: string; invitation_id: string }>(
    "select * from public.accept_invitation($1, $2)", [tokenHash, userId]);
const changeRole = (actor: string, userId: string, role: string) =>
  call<{ previous: string }>("select public.change_member_role($1, $2, $3, $4) as previous", [orgId, actor, userId, role]);
const remove = (actor: string, userId: string) =>
  call<{ removed: string }>("select public.remove_member($1, $2, $3) as removed", [orgId, actor, userId]);
const roleOf = async (userId: string) =>
  (await db.query<{ role: string }>("select role from public.memberships where org_id = $1 and user_id = $2", [orgId, userId])).rows[0]?.role ?? null;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  owner = await createUser(db, "owner@example.com");
  admin = await createUser(db, "admin@example.com");
  approver = await createUser(db, "approver@example.com");
  viewer = await createUser(db, "viewer@example.com");
  outsider = await createUser(db, "Outsider@Example.com");
  orgId = (await db.query<{ id: string }>(
    "insert into public.orgs (slug, name, mode) values ('members-co', 'Members Co', 'sandbox') returning id")).rows[0].id;
  for (const [user, role] of [[owner, "owner"], [admin, "admin"], [approver, "approver"], [viewer, "viewer"]] as const) {
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, $3)", [orgId, user, role]);
  }
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("invite_member", () => {
  it("stores a lowercased address, the hash and a 7-day expiry", async () => {
    const [row] = await invite(owner, "  New.Person@Example.COM ", "admin");
    expect(row.email).toBe("new.person@example.com");
    const days = (new Date(row.expires_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThan(7.01);
  });

  it("lets an admin invite an approver or a viewer, but not an admin or an owner", async () => {
    await expect(invite(admin, "a1@example.com", "viewer")).resolves.toHaveLength(1);
    await expect(invite(admin, "a2@example.com", "approver")).resolves.toHaveLength(1);
    await expect(invite(admin, "a3@example.com", "admin")).rejects.toThrow(/role_not_assignable/);
    await expect(invite(admin, "a4@example.com", "owner")).rejects.toThrow(/role_not_assignable/);
  });

  it("refuses approvers, viewers and non-members", async () => {
    await expect(invite(approver, "b1@example.com", "viewer")).rejects.toThrow(/role_not_assignable/);
    await expect(invite(viewer, "b2@example.com", "viewer")).rejects.toThrow(/role_not_assignable/);
    await expect(invite(outsider, "b3@example.com", "viewer")).rejects.toThrow(/not_a_member/);
  });

  it("refuses something that is not an email address", async () => {
    await expect(invite(owner, "<script>@x", "viewer")).rejects.toThrow(/invalid_email/);
    await expect(invite(owner, "no-at-sign", "viewer")).rejects.toThrow(/invalid_email/);
  });

  it("refuses an address that already belongs to a member", async () => {
    await expect(invite(owner, "VIEWER@example.com", "admin")).rejects.toThrow(/already_a_member/);
  });

  it("replaces the open invitation for the same address", async () => {
    await invite(owner, "again@example.com", "viewer");
    await invite(owner, "again@example.com", "approver");
    const open = await db.query<{ role: string }>(
      "select role from public.invitations where org_id = $1 and email = 'again@example.com' and accepted_at is null", [orgId]);
    expect(open.rows.map((r) => r.role)).toEqual(["approver"]);
  });

  it("refuses a 21st open invitation", async () => {
    const other = (await db.query<{ id: string }>(
      "insert into public.orgs (slug, name) values ('busy-co', 'Busy') returning id")).rows[0].id;
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'owner')", [other, owner]);
    for (let i = 0; i < 20; i++) {
      await call("select public.invite_member($1, $2, $3, 'viewer', $4)", [other, owner, `p${i}@example.com`, hash()]);
    }
    await expect(call("select public.invite_member($1, $2, 'p20@example.com', 'viewer', $3)", [other, owner, hash()]))
      .rejects.toThrow(/invitation_limit_reached/);
  });
});

describe("accept_invitation", () => {
  it("makes the invited person a member with the invited role, once", async () => {
    const token = hash();
    await invite(owner, "outsider@example.com", "approver", token);
    const [joined] = await accept(token, outsider);
    expect(joined).toMatchObject({ org_id: orgId, slug: "members-co", role: "approver" });
    expect(await roleOf(outsider)).toBe("approver");
    await expect(accept(token, outsider)).rejects.toThrow(/invitation_used/);
    await remove(owner, outsider);
  });

  it("refuses someone signed in with a different address and leaves the invitation open", async () => {
    const token = hash();
    await invite(owner, "someone.else@example.com", "viewer", token);
    await expect(accept(token, outsider)).rejects.toThrow(/invitation_email_mismatch/);
    const open = await db.query("select 1 from public.invitations where token_hash = $1 and accepted_at is null", [token]);
    expect(open.rows).toHaveLength(1);
  });

  it("refuses an unknown or expired token", async () => {
    await expect(accept(hash(), outsider)).rejects.toThrow(/invitation_not_found/);
    const token = hash();
    await invite(owner, "outsider@example.com", "viewer", token);
    await db.query("update public.invitations set expires_at = now() - interval '1 minute' where token_hash = $1", [token]);
    await expect(accept(token, outsider)).rejects.toThrow(/invitation_expired/);
  });

  it("refuses when the inviter can no longer grant the role", async () => {
    const token = hash();
    const newcomer = await createUser(db, "newcomer@example.com");
    await invite(admin, "newcomer@example.com", "approver", token);
    await changeRole(owner, admin, "viewer");
    await expect(accept(token, newcomer)).rejects.toThrow(/invitation_no_longer_valid/);
    await changeRole(owner, admin, "admin");
  });
});

describe("change_member_role and remove_member", () => {
  it("lets an owner change any role and returns the previous one", async () => {
    const [{ previous }] = await changeRole(owner, viewer, "admin");
    expect(previous).toBe("viewer");
    await changeRole(owner, viewer, "viewer");
  });

  it("lets an admin move people between approver and viewer only", async () => {
    await expect(changeRole(admin, viewer, "approver")).resolves.toHaveLength(1);
    await expect(changeRole(admin, viewer, "admin")).rejects.toThrow(/role_not_assignable/);
    await expect(changeRole(admin, owner, "viewer")).rejects.toThrow(/role_not_assignable/);
    await changeRole(owner, viewer, "viewer");
  });

  it("refuses approvers and viewers, and names a target that is not a member", async () => {
    await expect(changeRole(approver, viewer, "approver")).rejects.toThrow(/role_not_assignable/);
    await expect(changeRole(owner, outsider, "viewer")).rejects.toThrow(/member_not_found/);
  });

  it("keeps the last owner", async () => {
    await expect(changeRole(owner, owner, "admin")).rejects.toThrow(/last owner/);
    await expect(remove(owner, owner)).rejects.toThrow(/last owner/);
  });

  it("lets anyone leave, and an admin remove only approvers and viewers", async () => {
    const leaver = await createUser(db, "leaver@example.com");
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'viewer')", [orgId, leaver]);
    const [{ removed }] = await remove(leaver, leaver);
    expect(removed).toBe("viewer");
    await expect(remove(admin, owner)).rejects.toThrow(/role_not_assignable/);
  });
});

describe("revoke_invitation and org_members", () => {
  it("revokes only an invitation the actor could have sent", async () => {
    const [ownerInvite] = await invite(owner, "boss@example.com", "admin");
    await expect(call("select public.revoke_invitation($1, $2, $3)", [orgId, admin, ownerInvite.id])).rejects.toThrow(/role_not_assignable/);
    await call("select public.revoke_invitation($1, $2, $3)", [orgId, owner, ownerInvite.id]);
    const left = await db.query("select 1 from public.invitations where id = $1", [ownerInvite.id]);
    expect(left.rows).toHaveLength(0);
  });

  it("lists members with their address and role", async () => {
    const rows = await call<{ email: string; role: string }>("select email, role from public.org_members($1) order by email", [orgId]);
    expect(rows).toContainEqual({ email: "owner@example.com", role: "owner" });
    expect(rows).toContainEqual({ email: "viewer@example.com", role: "viewer" });
  });
});

describe("who may call these functions", () => {
  it.each(["anon", "authenticated"] as const)("%s cannot execute them", async (role) => {
    await expect(asRole(db, role, (tx) => tx.query("select * from public.org_members($1)", [orgId]))).rejects.toThrow(/permission denied/);
  });

  it("the tenant role cannot execute them", async () => {
    await expect(asTenant(db, orgId, (tx) => tx.query("select * from public.org_members($1)", [orgId]))).rejects.toThrow(/permission denied/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/members-migration.test.ts`
Expected: FAIL. `function public.invite_member(...) does not exist`.

- [ ] **Step 3: Write the migration**

`supabase/migrations/0021_members.sql`:

```sql
-- Members and invitations (spec §7, §10 step 5b).
--
-- memberships and invitations are platform tables: the tenant role has no
-- privileges on them (0015), so every change goes through one of these
-- functions, which the server calls as the service role and tells who is
-- acting. Each re-reads that person's role inside its own transaction and
-- refuses what the role may not do. This is where "no one grants a role
-- above their own" is enforced:
--   owner  — may grant or change any role;
--   admin  — may grant or change approver and viewer only;
--   others — may do neither.
-- Leaving (removing yourself) is open to every member; the last-owner trigger
-- from 0020 still refuses the last owner.
--
-- security definer: org_members and the address checks read auth.users,
-- which the service role cannot read on Supabase. search_path stays ''.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

create index if not exists invitations_org_idx on public.invitations (org_id);
create unique index if not exists invitations_open_address_idx
  on public.invitations (org_id, email) where accepted_at is null;

create or replace function public.role_rank(p_role text) returns int
language sql immutable
set search_path = ''
as $$
  select case p_role when 'owner' then 4 when 'admin' then 3 when 'approver' then 2 when 'viewer' then 1 end
$$;

-- Mirrors canAssignRole in src/lib/auth/roles.ts.
create or replace function public.can_assign_role(p_actor_role text, p_target_role text) returns boolean
language sql immutable
set search_path = ''
as $$
  select case
    when p_actor_role = 'owner' then true
    when p_actor_role = 'admin' then public.role_rank(p_target_role) < public.role_rank('admin')
    else false
  end
$$;

create or replace function public.member_role(p_org_id uuid, p_user_id uuid) returns text
language sql stable
security definer
set search_path = ''
as $$
  select role from public.memberships where org_id = p_org_id and user_id = p_user_id
$$;

create or replace function public.invite_member(
  p_org_id      uuid,
  p_actor       uuid,
  p_email       text,
  p_role        text,
  p_token_hash  text
) returns public.invitations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role text := public.member_role(p_org_id, p_actor);
  v_email      text := lower(btrim(p_email));
  v_open       int;
  v_row        public.invitations;
begin
  if v_actor_role is null then
    raise exception 'not_a_member: the inviting person is not a member of this organization';
  end if;
  if not public.can_assign_role(v_actor_role, p_role) then
    raise exception 'role_not_assignable: a % cannot invite a %', v_actor_role, p_role;
  end if;
  if v_email !~ '^[^@\s<>"'']+@[^@\s<>"'']+\.[^@\s<>"'']+$' or length(v_email) > 254 then
    raise exception 'invalid_email: not an email address';
  end if;
  if exists (
    select 1 from public.memberships m join auth.users u on u.id = m.user_id
     where m.org_id = p_org_id and lower(u.email) = v_email
  ) then
    raise exception 'already_a_member: that address already belongs to a member';
  end if;

  -- Serialise invitations per organization so two requests cannot both pass
  -- the limit (the same reasoning as create_org in 0020).
  perform pg_advisory_xact_lock(hashtext('vestiarion_invite:' || p_org_id::text));
  delete from public.invitations where org_id = p_org_id and email = v_email and accepted_at is null;
  select count(*) into v_open from public.invitations
   where org_id = p_org_id and accepted_at is null and expires_at > now();
  if v_open >= 20 then
    raise exception 'invitation_limit_reached: at most 20 open invitations per organization';
  end if;

  insert into public.invitations (org_id, email, role, token_hash, invited_by, expires_at)
  values (p_org_id, v_email, p_role, p_token_hash, p_actor, now() + interval '7 days')
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.accept_invitation(p_token_hash text, p_user_id uuid)
returns table (org_id uuid, slug text, role text, invitation_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv   public.invitations;
  v_email text;
begin
  select * into v_inv from public.invitations i where i.token_hash = p_token_hash for update;
  if not found then
    raise exception 'invitation_not_found: no invitation matches this link';
  end if;
  if v_inv.accepted_at is not null then
    raise exception 'invitation_used: this invitation has already been accepted';
  end if;
  if v_inv.expires_at <= now() then
    raise exception 'invitation_expired: this invitation has expired';
  end if;
  select lower(u.email) into v_email from auth.users u where u.id = p_user_id;
  if v_email is distinct from v_inv.email then
    raise exception 'invitation_email_mismatch: this invitation was sent to a different address';
  end if;
  if not public.can_assign_role(public.member_role(v_inv.org_id, v_inv.invited_by), v_inv.role) then
    raise exception 'invitation_no_longer_valid: the inviter can no longer grant this role';
  end if;
  if public.member_role(v_inv.org_id, p_user_id) is not null then
    raise exception 'already_a_member: you are already a member of this organization';
  end if;

  insert into public.memberships (org_id, user_id, role, invited_by)
  values (v_inv.org_id, p_user_id, v_inv.role, v_inv.invited_by);
  update public.invitations set accepted_at = now() where id = v_inv.id;

  return query
    select o.id, o.slug, v_inv.role, v_inv.id from public.orgs o where o.id = v_inv.org_id;
end;
$$;

create or replace function public.change_member_role(
  p_org_id  uuid,
  p_actor   uuid,
  p_user_id uuid,
  p_role    text
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role  text := public.member_role(p_org_id, p_actor);
  v_target_role text := public.member_role(p_org_id, p_user_id);
begin
  if v_actor_role is null then
    raise exception 'not_a_member: the acting person is not a member of this organization';
  end if;
  if v_target_role is null then
    raise exception 'member_not_found: that person is not a member of this organization';
  end if;
  -- Both ends: an admin may not raise someone to admin, nor touch an admin or owner.
  if not (public.can_assign_role(v_actor_role, v_target_role) and public.can_assign_role(v_actor_role, p_role)) then
    raise exception 'role_not_assignable: a % cannot change a % to %', v_actor_role, v_target_role, p_role;
  end if;
  update public.memberships set role = p_role where org_id = p_org_id and user_id = p_user_id;
  return v_target_role;
end;
$$;

create or replace function public.remove_member(p_org_id uuid, p_actor uuid, p_user_id uuid) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role  text := public.member_role(p_org_id, p_actor);
  v_target_role text := public.member_role(p_org_id, p_user_id);
begin
  if v_actor_role is null then
    raise exception 'not_a_member: the acting person is not a member of this organization';
  end if;
  if v_target_role is null then
    raise exception 'member_not_found: that person is not a member of this organization';
  end if;
  if p_actor <> p_user_id and not public.can_assign_role(v_actor_role, v_target_role) then
    raise exception 'role_not_assignable: a % cannot remove a %', v_actor_role, v_target_role;
  end if;
  delete from public.memberships where org_id = p_org_id and user_id = p_user_id;
  return v_target_role;
end;
$$;

create or replace function public.revoke_invitation(p_org_id uuid, p_actor uuid, p_invitation_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role text := public.member_role(p_org_id, p_actor);
  v_role       text;
begin
  if v_actor_role is null then
    raise exception 'not_a_member: the acting person is not a member of this organization';
  end if;
  select i.role into v_role from public.invitations i
   where i.id = p_invitation_id and i.org_id = p_org_id and i.accepted_at is null;
  if not found then
    raise exception 'invitation_not_found: no open invitation with that id';
  end if;
  if not public.can_assign_role(v_actor_role, v_role) then
    raise exception 'role_not_assignable: a % cannot revoke an invitation for a %', v_actor_role, v_role;
  end if;
  delete from public.invitations where id = p_invitation_id;
end;
$$;

create or replace function public.org_members(p_org_id uuid)
returns table (user_id uuid, email text, role text, joined_at timestamptz)
language sql stable
security definer
set search_path = ''
as $$
  select m.user_id, u.email::text, m.role, m.created_at
    from public.memberships m join auth.users u on u.id = m.user_id
   where m.org_id = p_org_id
   order by public.role_rank(m.role) desc, u.email
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.role_rank(text)',
    'public.can_assign_role(text, text)',
    'public.member_role(uuid, uuid)',
    'public.invite_member(uuid, uuid, text, text, text)',
    'public.accept_invitation(text, uuid)',
    'public.change_member_role(uuid, uuid, uuid, text)',
    'public.remove_member(uuid, uuid, uuid)',
    'public.revoke_invitation(uuid, uuid, uuid)',
    'public.org_members(uuid)'
  ]
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- Rollback:
-- drop function if exists public.org_members(uuid), public.revoke_invitation(uuid, uuid, uuid),
--   public.remove_member(uuid, uuid, uuid), public.change_member_role(uuid, uuid, uuid, text),
--   public.accept_invitation(text, uuid), public.invite_member(uuid, uuid, text, text, text),
--   public.member_role(uuid, uuid), public.can_assign_role(text, text), public.role_rank(text);
-- drop index if exists public.invitations_open_address_idx, public.invitations_org_idx;
```

If PGlite reports that `vestiarion_tenant` still has EXECUTE on these functions (Postgres grants EXECUTE to PUBLIC by default, and `vestiarion_tenant` inherits from PUBLIC), the `revoke … from public` above removes it. If the "tenant role cannot execute them" test still passes EXECUTE through, check `tests/support/pglite.ts` for a default-privileges grant and report it rather than weakening the test.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/members-migration.test.ts`
Expected: PASS.

Then run `npm run verify`. Expected: exit 0. `tests/migrations-select.test.ts` and `tests/ledger-parity.test.ts` replay every migration, so they cover idempotency.

- [ ] **Step 5: Commit**

Subject: `feat(db): membership functions that check the acting person's role`

---

### Task 2: Migration 0022 — activity, sandbox deletion and the cycle cap

**Files:**
- Create: `supabase/migrations/0022_workspace_lifecycle.sql`
- Test: `tests/lifecycle-migration.test.ts`

**Interfaces:**
- Consumes: `seedOrgRows`, `asTenant`, `asServiceRole`, `createDatabase`, `applyMigrations`, `TENANT_TABLES` from `tests/support/pglite.ts`.
- Produces:
  - `touch_org_activity(p_org_id uuid) returns void`. Service role only. Updates `last_active_at` only when it is more than an hour old.
  - `delete_sandbox_org(p_org_id uuid, p_inactive_before timestamptz) returns boolean`. Service role only.
    - `true` means deleted.
    - `false` means the organization was not found, or was active at or after `p_inactive_before`.
    - It raises `not_a_sandbox: …` for a live organization.
  - `begin_cycle_run(p_org_id uuid, p_daily_cap int, p_started_at timestamptz, p_clock_mode text, p_chain_mode text, p_screening_mode text) returns uuid`.
    - `security invoker`, executable by `vestiarion_tenant` and `service_role`.
    - It raises `sandbox_cap_reached: …` when `p_daily_cap` is not null and the organization already has that many runs since the start of the UTC day.
    - Otherwise it inserts a `running` row with a null `sim_day` and returns its id.
  - `reject_cycle_snapshot_mutation()` now lets a DELETE through when `current_setting('vestiarion.purging_org', true) = old.org_id::text`.

- [ ] **Step 1: Write the failing tests**

`tests/lifecycle-migration.test.ts`:

```ts
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg, seedOrgRows, TENANT_TABLES,
} from "./support/pglite";

/**
 * Migration 0022 (spec §6 "Abandoned sandboxes", §10 step 5b): activity is
 * refreshed at most hourly, an abandoned sandbox is deleted whole, a live
 * organization never is, and the sandbox cycle cap is checked and the run
 * opened in one transaction.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
}, 60_000);

afterAll(async () => {
  await db.close();
});

const lastActive = async (orgId: string) =>
  (await db.query<{ t: Date }>("select last_active_at as t from public.orgs where id = $1", [orgId])).rows[0].t;

describe("touch_org_activity", () => {
  it("refreshes last_active_at only when it is more than an hour old", async () => {
    const orgId = await createOrg(db, "touch-co");
    await db.query("update public.orgs set last_active_at = now() - interval '30 minutes' where id = $1", [orgId]);
    const before = await lastActive(orgId);
    await asServiceRole(db, (tx) => tx.query("select public.touch_org_activity($1)", [orgId]));
    expect(await lastActive(orgId)).toEqual(before);

    await db.query("update public.orgs set last_active_at = now() - interval '2 hours' where id = $1", [orgId]);
    await asServiceRole(db, (tx) => tx.query("select public.touch_org_activity($1)", [orgId]));
    expect(Date.now() - (await lastActive(orgId)).getTime()).toBeLessThan(60_000);
  });
});

describe("delete_sandbox_org", () => {
  const purge = (orgId: string, cutoff: string) =>
    asServiceRole(db, async (tx) =>
      (await tx.query<{ deleted: boolean }>("select public.delete_sandbox_org($1, $2::timestamptz) as deleted", [orgId, cutoff])).rows[0].deleted);

  it("deletes an inactive sandbox and every row it owns, ledger included, and nothing of anyone else's", async () => {
    const doomed = await createOrg(db, "doomed-co");
    const kept = await createOrg(db, "kept-co");
    await seedOrgRows(db, doomed, "doomed");
    await seedOrgRows(db, kept, "kept");
    await db.query("update public.orgs set last_active_at = now() - interval '61 days' where id = $1", [doomed]);

    expect(await purge(doomed, new Date(Date.now() - 60 * 86_400_000).toISOString())).toBe(true);

    expect((await db.query("select 1 from public.orgs where id = $1", [doomed])).rows).toHaveLength(0);
    for (const table of TENANT_TABLES) {
      const doomedRows = await db.query(`select 1 from public.${table} where org_id = $1`, [doomed]);
      const keptRows = await db.query(`select 1 from public.${table} where org_id = $1`, [kept]);
      expect(doomedRows.rows, table).toHaveLength(0);
      expect(keptRows.rows.length, table).toBeGreaterThan(0);
    }
  });

  it("leaves a sandbox that was active after the cutoff", async () => {
    const recent = await createOrg(db, "recent-co");
    expect(await purge(recent, new Date(Date.now() - 60 * 86_400_000).toISOString())).toBe(false);
    expect((await db.query("select 1 from public.orgs where id = $1", [recent])).rows).toHaveLength(1);
  });

  it("refuses a live organization, however old", async () => {
    const live = await createOrg(db, "live-co");
    await db.query("update public.orgs set mode = 'live', last_active_at = now() - interval '400 days' where id = $1", [live]);
    await expect(purge(live, new Date().toISOString())).rejects.toThrow(/not_a_sandbox/);
  });

  it("keeps cycle_snapshots append-only everywhere else", async () => {
    const other = await createOrg(db, "snap-co");
    await seedOrgRows(db, other, "snap");
    await expect(db.query("delete from public.cycle_snapshots where org_id = $1", [other])).rejects.toThrow(/append-only/);
  });

  it("is not executable by the tenant or browser roles", async () => {
    const orgId = await createOrg(db, "guarded-co");
    await expect(asTenant(db, orgId, (tx) => tx.query("select public.delete_sandbox_org($1, now())", [orgId]))).rejects.toThrow(/permission denied/);
    await expect(asRole(db, "authenticated", (tx) => tx.query("select public.touch_org_activity($1)", [orgId]))).rejects.toThrow(/permission denied/);
  });
});

describe("begin_cycle_run", () => {
  const begin = (orgId: string, cap: number | null) =>
    asTenant(db, orgId, async (tx) =>
      (await tx.query<{ id: string }>(
        "select public.begin_cycle_run($1, $2, now(), 'real', 'simulate', 'simulate') as id", [orgId, cap])).rows[0].id);

  it("opens a running run and returns its id", async () => {
    const orgId = await createOrg(db, "runs-co");
    const id = await begin(orgId, 20);
    const row = await db.query<{ status: string; org_id: string; sim_day: number | null }>(
      "select status, org_id, sim_day from public.cycle_runs where id = $1", [id]);
    expect(row.rows[0]).toEqual({ status: "running", org_id: orgId, sim_day: null });
  });

  it("refuses once today's runs reach the cap, and counts only today's", async () => {
    const orgId = await createOrg(db, "capped-co");
    await db.query(
      "insert into public.cycle_runs (org_id, started_at, clock_mode, chain_mode, screening_mode) values ($1, now() - interval '2 days', 'real', 'simulate', 'simulate')",
      [orgId]);
    await begin(orgId, 2);
    await begin(orgId, 2);
    await expect(begin(orgId, 2)).rejects.toThrow(/sandbox_cap_reached/);
  });

  it("has no cap when p_daily_cap is null", async () => {
    const orgId = await createOrg(db, "uncapped-co");
    for (let i = 0; i < 3; i++) await begin(orgId, null);
    await expect(begin(orgId, null)).resolves.toBeTruthy();
  });

  it("cannot open a run in another organization", async () => {
    const mine = await createOrg(db, "mine-co");
    const theirs = await createOrg(db, "theirs-co");
    await expect(asTenant(db, mine, (tx) =>
      tx.query("select public.begin_cycle_run($1, null, now(), 'real', 'simulate', 'simulate')", [theirs]))).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lifecycle-migration.test.ts`
Expected: FAIL. `function public.touch_org_activity(...) does not exist`.

- [ ] **Step 3: Write the migration**

`supabase/migrations/0022_workspace_lifecycle.sql`:

```sql
-- Workspace lifecycle (spec §6 "Abandoned sandboxes", §10 step 5b).
--
-- touch_org_activity: last_active_at is refreshed at most hourly, so a page
-- view costs at most one real write per organization per hour.
--
-- delete_sandbox_org: the daily cleanup's only way to delete an organization.
-- It refuses a live organization outright, and returns false for one that
-- became active at or after the cutoff the caller listed it under, so a
-- sandbox someone opened between the listing and the delete survives. It
-- removes the organization's rows table by table — every tenant table's
-- org_id restricts the organization's delete (0015) — ledger included: the
-- chain belongs to an organization that no longer exists, and a sandbox never
-- held real money.
--
-- begin_cycle_run: the sandbox cycle cap from step 5a, moved into the
-- database. The per-organization lock serialises concurrent starts; the count
-- then runs under a fresh READ COMMITTED snapshot and sees every run the
-- previous holder committed. Invoker rights: the tenant role runs it, and RLS
-- confines both the count and the insert to the organization in its token.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

create or replace function public.touch_org_activity(p_org_id uuid) returns void
language sql
set search_path = ''
as $$
  update public.orgs set last_active_at = now()
   where id = p_org_id and last_active_at < now() - interval '1 hour'
$$;

-- cycle_snapshots stays append-only (0008), except while delete_sandbox_org
-- removes an organization whole: it sets vestiarion.purging_org for its own
-- transaction only, and only rows of that organization pass.
create or replace function public.reject_cycle_snapshot_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and current_setting('vestiarion.purging_org', true) = old.org_id::text then
    return old;
  end if;
  raise exception 'cycle_snapshots are append-only';
end;
$$;

create or replace function public.delete_sandbox_org(p_org_id uuid, p_inactive_before timestamptz) returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_org public.orgs;
begin
  select * into v_org from public.orgs where id = p_org_id for update;
  if not found then
    return false;
  end if;
  if v_org.mode <> 'sandbox' then
    raise exception 'not_a_sandbox: % is %, and only a sandbox is deleted automatically', v_org.slug, v_org.mode;
  end if;
  if v_org.last_active_at >= p_inactive_before then
    return false;
  end if;

  perform set_config('vestiarion.purging_org', p_org_id::text, true);
  -- Children before parents: snapshots restrict their run's delete (0019),
  -- and every table restricts the organization's.
  delete from public.cycle_snapshots   where org_id = p_org_id;
  delete from public.cycle_runs        where org_id = p_org_id;
  delete from public.payment_intents   where org_id = p_org_id;
  delete from public.milestones        where org_id = p_org_id;
  delete from public.compliance_checks where org_id = p_org_id;
  delete from public.invoices          where org_id = p_org_id;
  delete from public.treasury_actions  where org_id = p_org_id;
  delete from public.counterparties    where org_id = p_org_id;
  delete from public.accounts          where org_id = p_org_id;
  delete from public.forecasts         where org_id = p_org_id;
  delete from public.ledger_entries    where org_id = p_org_id;
  delete from public.sim_clock         where org_id = p_org_id;
  perform set_config('vestiarion.purging_org', '', true);
  -- memberships and invitations cascade with the organization.
  delete from public.orgs where id = p_org_id;
  return true;
end;
$$;

create or replace function public.begin_cycle_run(
  p_org_id          uuid,
  p_daily_cap       int,
  p_started_at      timestamptz,
  p_clock_mode      text,
  p_chain_mode      text,
  p_screening_mode  text
) returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_today int;
  v_id    uuid;
begin
  perform pg_advisory_xact_lock(hashtext('vestiarion_cycle_run:' || p_org_id::text));
  if p_daily_cap is not null then
    select count(*) into v_today from public.cycle_runs
     where org_id = p_org_id
       and started_at >= (date_trunc('day', now() at time zone 'utc') at time zone 'utc');
    if v_today >= p_daily_cap then
      raise exception 'sandbox_cap_reached: % cycles already started today (UTC)', v_today;
    end if;
  end if;
  insert into public.cycle_runs (org_id, started_at, status, clock_mode, chain_mode, screening_mode)
  values (p_org_id, p_started_at, 'running', p_clock_mode, p_chain_mode, p_screening_mode)
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.touch_org_activity(uuid) from public, anon, authenticated;
grant execute on function public.touch_org_activity(uuid) to service_role;
revoke execute on function public.delete_sandbox_org(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.delete_sandbox_org(uuid, timestamptz) to service_role;
revoke execute on function public.begin_cycle_run(uuid, int, timestamptz, text, text, text) from public, anon, authenticated;
grant execute on function public.begin_cycle_run(uuid, int, timestamptz, text, text, text) to vestiarion_tenant, service_role;

-- Rollback:
-- drop function if exists public.begin_cycle_run(uuid, int, timestamptz, text, text, text);
-- drop function if exists public.delete_sandbox_org(uuid, timestamptz);
-- drop function if exists public.touch_org_activity(uuid);
-- then re-run 0008's reject_cycle_snapshot_mutation() body (always raises).
```

Check two things against the real schema before running.
- **Column names.** The `cycle_runs` insert names `status`, `clock_mode`, `chain_mode` and `screening_mode`. Compare them with `src/lib/agent/orchestrator.ts` (`runAgentCycle`), which inserts the same row today.
- **Delete order.** If a delete fails on a foreign key the list above does not order, move that table earlier and say so in your report. Do not drop a foreign key.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/lifecycle-migration.test.ts`
Expected: PASS. Then `npm run verify`, expecting exit 0.

- [ ] **Step 5: Commit**

Subject: `feat(db): activity refresh, abandoned-sandbox deletion and an atomic cycle cap`

---

### Task 3: The members library and invitation email

**Files:**
- Create: `src/lib/email/send.ts`, `src/lib/email/invitation.ts`, `src/lib/platform/members.ts`
- Modify: `src/lib/dal/index.ts` (`PLATFORM_RPCS`)
- Test: `tests/email.test.ts`, `tests/members.test.ts`

**Interfaces:**
- Consumes:
  - the SQL functions and error codes from Task 1;
  - `platformDb()`, `db()`, `unwrap` from `@/lib/dal`;
  - `withOrg` and `currentOrgId` from `@/lib/dal/scope`;
  - `appendLedgerEntry` from `@/lib/ledger`;
  - `siteOrigin()` from `@/lib/auth/env`;
  - `type OrgRole` and `canAssignRole` from `@/lib/auth/roles`.
- Produces, from `@/lib/email/send`:
  - `interface EmailMessage { to: string; subject: string; html: string; text: string }`;
  - `type SendResult = { sent: true; id: string } | { sent: false; reason: string }`;
  - `emailSettingsFromEnv(env?: NodeJS.ProcessEnv): { apiKey: string; from: string } | null`;
  - `sendEmail(message: EmailMessage, settings?: { apiKey: string; from: string } | null, fetchImpl?: typeof fetch): Promise<SendResult>`.
- Produces, from `@/lib/email/invitation`: `invitationEmail(input: { orgName: string; role: OrgRole; link: string; expiresAt: Date; origin: string }): { subject: string; html: string; text: string }`.
- Produces, from `@/lib/platform/members`:
  - `type MemberErrorCode` (Task 1's codes plus `"last_owner"`);
  - `class MemberError extends Error { readonly code: MemberErrorCode }`, whose `message` is the user-facing text;
  - `memberErrorFrom(error: { message: string }): MemberError | null`;
  - `hashInvitationToken(token: string): string`;
  - `inviteMember(input: { actorId: string; orgName: string; email: string; role: OrgRole; token?: string }): Promise<{ invitationId: string; link: string; emailed: boolean }>`. Runs inside an organization scope.
  - `acceptInvitation(input: { token: string; userId: string }): Promise<{ orgId: string; slug: string; role: OrgRole }>`. Runs outside any scope.
  - `invitationPreview(token: string): Promise<{ orgName: string; role: OrgRole; state: "open" | "used" | "expired" } | null>`;
  - `changeMemberRole(input: { actorId: string; userId: string; role: OrgRole }): Promise<void>`. Runs in scope.
  - `removeMember(input: { actorId: string; userId: string }): Promise<void>`. Runs in scope.
  - `revokeInvitation(input: { actorId: string; invitationId: string }): Promise<void>`. Runs in scope.
  - `listMembers(orgId: string): Promise<Member[]>`, where `Member = { userId: string; email: string; role: OrgRole; joinedAt: string }`;
  - `listOpenInvitations(orgId: string): Promise<OpenInvitation[]>`, where `OpenInvitation = { id: string; email: string; role: OrgRole; expiresAt: string }`.

User-facing messages, exact text:

| code | message |
|---|---|
| `not_a_member` | You are not a member of this workspace. |
| `member_not_found` | That person is not a member of this workspace. |
| `role_not_assignable` | Your role cannot grant or change that role. |
| `invalid_email` | That does not look like an email address. |
| `already_a_member` | That person is already a member of this workspace. |
| `invitation_limit_reached` | This workspace already has 20 open invitations. Revoke one first. |
| `invitation_not_found` | This invitation link is not valid. |
| `invitation_used` | This invitation has already been accepted. |
| `invitation_expired` | This invitation has expired. Ask for a new one. |
| `invitation_email_mismatch` | This invitation was sent to a different email address. Sign in with that address to accept it. |
| `invitation_no_longer_valid` | The person who sent this invitation can no longer grant that role. Ask for a new one. |
| `last_owner` | A workspace must keep at least one owner. |

`memberErrorFrom` reads the leading `code:` of the Postgres message. It maps the `0020` trigger's text, which contains `last owner`, to `last_owner`. It returns `null` for anything else, and callers rethrow that as it came.

Ledger entries, all `actor: "human"`, `domain: "system"`:

| action | detail | summary |
|---|---|---|
| `member_invited` | `{ by, invitationId, role }` | `Invitation sent for the ${role} role` |
| `member_joined` | `{ by: userId, role, invitationId }` | `A member joined as ${role}` |
| `member_role_changed` | `{ by, member, from, to }` | `A member's role changed from ${from} to ${to}` |
| `member_removed` | `{ by, member, role }` | `A ${role} was removed` |
| `member_left` | `{ by, role }` | `A ${role} left the workspace` |
| `invitation_revoked` | `{ by, invitationId }` | `An invitation was revoked` |

No entry carries an email address.

- [ ] **Step 1: Write the failing email tests**

`tests/email.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { invitationEmail } from "@/lib/email/invitation";
import { emailSettingsFromEnv, sendEmail } from "@/lib/email/send";

describe("emailSettingsFromEnv", () => {
  it("is null without RESEND_API_KEY", () => {
    expect(emailSettingsFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
  });
  it("defaults the sender to no-reply@vestiarion.xyz", () => {
    expect(emailSettingsFromEnv({ RESEND_API_KEY: "re_test" } as NodeJS.ProcessEnv))
      .toEqual({ apiKey: "re_test", from: "Vestiarion <no-reply@vestiarion.xyz>" });
  });
});

describe("sendEmail", () => {
  const message = { to: "a@example.com", subject: "S", html: "<p>H</p>", text: "H" };

  it("does not call the network when email is not configured", async () => {
    let called = false;
    const result = await sendEmail(message, null, async () => { called = true; return new Response("{}"); });
    expect(result).toEqual({ sent: false, reason: "not_configured" });
    expect(called).toBe(false);
  });

  it("posts to Resend with the key as a bearer and returns the message id", async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const result = await sendEmail(message, { apiKey: "re_test", from: "Vestiarion <no-reply@vestiarion.xyz>" }, async (url, init) => {
      seen = { url: String(url), init };
      return new Response(JSON.stringify({ id: "msg_1" }), { status: 200 });
    });
    expect(result).toEqual({ sent: true, id: "msg_1" });
    expect(seen?.url).toBe("https://api.resend.com/emails");
    expect(new Headers(seen?.init?.headers).get("authorization")).toBe("Bearer re_test");
    expect(JSON.parse(String(seen?.init?.body))).toEqual({
      from: "Vestiarion <no-reply@vestiarion.xyz>", to: ["a@example.com"], subject: "S", html: "<p>H</p>", text: "H",
    });
  });

  it("reports a refused send without throwing", async () => {
    const result = await sendEmail(message, { apiKey: "re_test", from: "x <no-reply@vestiarion.xyz>" },
      async () => new Response(JSON.stringify({ message: "bad" }), { status: 422 }));
    expect(result).toEqual({ sent: false, reason: "status 422" });
  });
});

describe("invitationEmail", () => {
  const base = { role: "approver" as const, link: "https://www.vestiarion.xyz/invite/tok", expiresAt: new Date("2026-10-05T12:00:00Z"), origin: "https://www.vestiarion.xyz" };

  it("names the workspace, the role and the link, and says when it expires", () => {
    const email = invitationEmail({ ...base, orgName: "Acme" });
    expect(email.subject).toBe("You're invited to Acme on Vestiarion");
    for (const part of [email.html, email.text]) {
      expect(part).toContain("Acme");
      expect(part).toContain("approver");
      expect(part).toContain("https://www.vestiarion.xyz/invite/tok");
      expect(part).toContain("2026-10-05");
    }
  });

  it("renders a workspace name as text, never as markup", () => {
    const email = invitationEmail({ ...base, orgName: `<img src=x onerror="alert(1)">&` });
    expect(email.html).not.toContain("<img src=x");
    expect(email.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/email.test.ts`
Expected: FAIL. Cannot find module `@/lib/email/invitation`.

- [ ] **Step 3: Write the email modules**

`src/lib/email/send.ts`:

```ts
/**
 * Transactional email through Resend's HTTP API (no SDK). Optional: without
 * RESEND_API_KEY nothing is sent and the caller is told so, which is how
 * invitations still work before email is configured (spec §10 step 5b).
 */

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export type SendResult = { sent: true; id: string } | { sent: false; reason: string };

const DEFAULT_FROM = "Vestiarion <no-reply@vestiarion.xyz>";

export function emailSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): { apiKey: string; from: string } | null {
  const apiKey = env.RESEND_API_KEY?.trim();
  if (!apiKey) return null;
  return { apiKey, from: env.EMAIL_FROM?.trim() || DEFAULT_FROM };
}

export async function sendEmail(
  message: EmailMessage,
  settings: { apiKey: string; from: string } | null = emailSettingsFromEnv(),
  fetchImpl: typeof fetch = fetch
): Promise<SendResult> {
  if (!settings) return { sent: false, reason: "not_configured" };
  try {
    const response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${settings.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: settings.from, to: [message.to], subject: message.subject, html: message.html, text: message.text }),
    });
    if (!response.ok) return { sent: false, reason: `status ${response.status}` };
    const body = (await response.json()) as { id?: string };
    return { sent: true, id: body.id ?? "" };
  } catch (error) {
    return { sent: false, reason: error instanceof Error ? error.message : "network error" };
  }
}
```

`src/lib/email/invitation.ts`:
- Export `invitationEmail` as specified above.
- Subject: ``You're invited to ${orgName} on Vestiarion``. Subjects are plain text, not HTML.
- HTML: follow the look of `supabase/templates/magic-link.html`, with the logo at `${origin}/email/logo.png`. It has:
  - one paragraph naming the workspace and the role;
  - a button linking to `link`;
  - the link as text;
  - the line `This invitation expires on ${expiresAt.toISOString().slice(0, 10)} (UTC). Accept it while signed in with this email address.`
- Text: the same content without markup.
- Escape every interpolated value in the HTML: `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`, `"` → `&quot;`, `'` → `&#39;`. Use one local `escapeHtml` function, and apply it to `link` as well.

- [ ] **Step 4: Run the email tests to verify they pass**

Run: `npx vitest run tests/email.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing members tests**

`tests/members.test.ts` uses the recorded fake from `tests/support/fake-supabase.ts`. Follow `tests/workspace.test.ts` for how a test builds a context with a fake `fetch`, enters an organization scope, and answers the `append_ledger_entry` RPC.
- Answer the RPCs as PostgREST would. On success, reply with the function's return value. On error, reply `status: 400` with `{ code: "P0001", message: "<code>: text" }`.
- Stub the email send through `vi.mock("@/lib/email/send", ...)`, so the tests control `sent`.

Cover:

1. **`inviteMember` success.**
   - It calls `POST /rest/v1/rpc/invite_member` with `p_org_id` = the scoped organization and `p_actor`, `p_email`, `p_role`.
   - `p_token_hash` is `sha256(token)` hex and not the token itself: pass `token: "fixed-token"` and assert the hash, and that no request body contains `fixed-token`.
   - It returns `link` = `${siteOrigin()}/invite/fixed-token`. Set `SITE_URL` in the test the way `tests/auth-env.test.ts` does.
   - It appends `member_invited`, and no request body to `append_ledger_entry` contains the invited address.
2. **`inviteMember` when email is not configured.** It returns `emailed: false` and still returns the link.
3. **`inviteMember` when the RPC fails.** A reply of `{ message: "role_not_assignable: …" }` throws a `MemberError` with code `role_not_assignable` and the table's message. Nothing is appended to the ledger.
4. **`memberErrorFrom`.**
   - It maps `"the last owner of an organization cannot be removed or demoted"` to `last_owner`.
   - It returns `null` for `"connection refused"`.
5. **`acceptInvitation`.**
   - It calls `accept_invitation` with the hash and the user id.
   - Then, inside the returned organization's scope, it appends `member_joined` with `detail.by` = the user id.
   - It returns `{ orgId, slug, role }`.
6. **`removeMember`.**
   - When `actorId === userId`, it appends `member_left`.
   - Otherwise it appends `member_removed` with `detail.member`.
7. **`changeMemberRole`.** It appends `member_role_changed` with `from` = the RPC's returned previous role and `to` = the new role.

- [ ] **Step 6: Run them to verify they fail**

Run: `npx vitest run tests/members.test.ts`
Expected: FAIL. Cannot find module `@/lib/platform/members`.

- [ ] **Step 7: Write `src/lib/platform/members.ts`**

```ts
import crypto from "node:crypto";
import { siteOrigin } from "../auth/env";
import type { OrgRole } from "../auth/roles";
import { platformDb, unwrap } from "../dal";
import { currentOrgId, withOrg } from "../dal/scope";
import { invitationEmail } from "../email/invitation";
import { sendEmail } from "../email/send";
import { appendLedgerEntry } from "../ledger";

/**
 * Members and invitations (spec §7, §10 step 5b). Every change goes through a
 * service-role function (migration 0021) that is told who is acting and
 * checks that person's role itself; this module adds the signed ledger entry
 * and the email. The ledger records user ids, never an email address.
 */

export type MemberErrorCode =
  | "not_a_member" | "member_not_found" | "role_not_assignable" | "invalid_email" | "already_a_member"
  | "invitation_limit_reached" | "invitation_not_found" | "invitation_used" | "invitation_expired"
  | "invitation_email_mismatch" | "invitation_no_longer_valid" | "last_owner";

const MESSAGES: Record<MemberErrorCode, string> = {
  not_a_member: "You are not a member of this workspace.",
  member_not_found: "That person is not a member of this workspace.",
  role_not_assignable: "Your role cannot grant or change that role.",
  invalid_email: "That does not look like an email address.",
  already_a_member: "That person is already a member of this workspace.",
  invitation_limit_reached: "This workspace already has 20 open invitations. Revoke one first.",
  invitation_not_found: "This invitation link is not valid.",
  invitation_used: "This invitation has already been accepted.",
  invitation_expired: "This invitation has expired. Ask for a new one.",
  invitation_email_mismatch: "This invitation was sent to a different email address. Sign in with that address to accept it.",
  invitation_no_longer_valid: "The person who sent this invitation can no longer grant that role. Ask for a new one.",
  last_owner: "A workspace must keep at least one owner.",
};

export class MemberError extends Error {
  constructor(readonly code: MemberErrorCode) {
    super(MESSAGES[code]);
    this.name = "MemberError";
  }
}

export function memberErrorFrom(error: { message: string }): MemberError | null {
  if (/last owner/.test(error.message)) return new MemberError("last_owner");
  const code = /^([a-z_]+):/.exec(error.message)?.[1];
  return code && code in MESSAGES ? new MemberError(code as MemberErrorCode) : null;
}

function raise(error: { message: string }): never {
  throw memberErrorFrom(error) ?? new Error(error.message);
}

export function hashInvitationToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
```

Then implement the remaining exports to the interfaces above:
- **`inviteMember`**:
  1. token = `input.token ?? crypto.randomBytes(32).toString("base64url")`;
  2. call the RPC through `platformDb().rpc("invite_member", …)`, and `raise` on error;
  3. append `member_invited`;
  4. build `link`;
  5. send `invitationEmail(...)` to the stored, lowercased address, with `origin: siteOrigin()`;
  6. log `invitation email not sent: <reason>` with `console.warn` when the send fails. Log the reason only, never the address or link.
- **`acceptInvitation`**: call the RPC, then run `withOrg(row.org_id, () => appendLedgerEntry(...), { userId })`.
- **`invitationPreview`**: `platformDb().from("invitations").select("role, expires_at, accepted_at, orgs!inner(name)").eq("token_hash", hash).maybeSingle()`. It returns `null` when there is no row.
- **`changeMemberRole`, `removeMember` and `revokeInvitation`** use `currentOrgId()` for `p_org_id`.
- **`listMembers`** uses `rpc("org_members")`.
- **`listOpenInvitations`**: `from("invitations").select("id, email, role, expires_at").eq("org_id", orgId).is("accepted_at", null).gt("expires_at", new Date().toISOString()).order("created_at")`.

Add the Task 1 functions to `PLATFORM_RPCS` in `src/lib/dal/index.ts`: `"invite_member"`, `"accept_invitation"`, `"change_member_role"`, `"remove_member"`, `"revoke_invitation"`, `"org_members"`. The next two tasks add `touch_org_activity`, `delete_sandbox_org` and `begin_cycle_run`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run tests/members.test.ts tests/email.test.ts tests/dal.test.ts`
Expected: PASS. Then `npm run verify`, expecting exit 0.

- [ ] **Step 9: Commit**

Subject: `feat(members): invitations, role changes and removal, recorded in the ledger`

---

### Task 4: The members page and its actions

**Files:**
- Create: `src/app/o/[slug]/members/page.tsx`, `src/app/actions/members.ts`, `src/components/MembersPanel.tsx`
- Modify: `src/components/vx/nav.ts` (the `Controls` group gains `{ key: "members", path: "/members", label: "Members" }` after Audit log), `tests/navigation.test.ts` if it pins the list, `tests/access-gates.test.ts` (the page list, if it enumerates pages)
- Test: `tests/members-actions.test.ts`

**Interfaces:**
- Consumes:
  - from Task 3: `inviteMember`, `changeMemberRole`, `removeMember`, `revokeInvitation`, `listMembers`, `listOpenInvitations`, `MemberError`;
  - `authorize` and `viewerCan` from `@/lib/auth/authorize`;
  - `inOrg` from `@/lib/dal/scope`;
  - `requireMembership`;
  - `can` and `canAssignRole`;
  - `revalidateOrgPages` from `@/lib/auth/revalidate`.
- Produces, from `@/app/actions/members` (file `src/app/actions/members.ts`, `"use server"`):
  - `interface MemberActionResult { ok: boolean; message: string; link?: string; left?: boolean }`;
  - `inviteMemberAction(previous: MemberActionResult, formData: FormData): Promise<MemberActionResult>`. Fields: `orgSlug`, `email`, `role`.
  - `changeMemberRoleAction(previous, formData)`. Fields: `orgSlug`, `userId`, `role`.
  - `removeMemberAction(previous, formData)`. Fields: `orgSlug`, `userId`.
  - `revokeInvitationAction(previous, formData)`. Fields: `orgSlug`, `invitationId`.

Every action must satisfy `tests/access-gates.test.ts`: its first awaited call is `authorize(orgSlug, "<literal>")`, and it does its work in `return inOrg(auth, async () => …)`.

| Action | Permission |
|---|---|
| `inviteMemberAction` | `"members.manage"` |
| `changeMemberRoleAction` | `"members.manage"` |
| `revokeInvitationAction` | `"members.manage"` |
| `removeMemberAction` | `"workspace.read"` |

`removeMemberAction` needs only `"workspace.read"` because leaving is open to everyone. Inside the scope it refuses removing someone else unless `can(auth.membership.role, "members.manage")`. The database checks again.

Each action:
- validates `role` against the four role names;
- maps a `MemberError` to `{ ok: false, message: error.message }`;
- logs anything else and returns `{ ok: false, message: "That did not work. Try again in a moment." }`;
- calls `revalidateOrgPages()` on success.

`inviteMemberAction` returns the invitation link and one of two messages:
- `Invitation sent to <address>.`
- `Email is not configured, so nothing was sent. Share this link with them; it is shown only once.`

`removeMemberAction` returns `left: true` when someone removed themselves.

The page, `/o/[slug]/members`, a server component:
- It is `export const dynamic = "force-dynamic"`, like the other pages.
- Its title is `sectionTitle("members")`.
- It calls `requireMembership(slug)` first.
- It loads `listMembers(membership.orgId)`, and `listOpenInvitations` only when `can(role, "members.manage")`.
- It renders `MembersPanel` (a client component) with:
  - the members;
  - the invitations;
  - the viewer's own user id and role;
  - `assignable = ROLES.filter((r) => canAssignRole(role, r))`.

`MembersPanel`, using `useActionState` per form:
- a table of members: address, role, joined date;
- per row, a role `<select>` limited to `assignable`, shown only when the viewer can change that member (`canAssignRole(viewerRole, member.role)` and not themselves);
- a Remove button under the same condition;
- a Leave button on the viewer's own row. After `left: true` it calls `router.replace("/onboarding")`.
- For managers:
  - the invite form (email, role `<select>` of `assignable`), which shows the returned link once in a read-only input with a Copy button;
  - the open invitations list (address, role, expiry), each with Revoke.
- Addresses render as text: React escapes them, and never use `dangerouslySetInnerHTML`.

- [ ] **Step 1: Write the failing action tests**

`tests/members-actions.test.ts` follows `tests/agent-action.test.ts`:
- mock `server-only`, `@/lib/auth/authorize` and `@/lib/platform/members`;
- use the real `inOrg`.

Cover:
1. `inviteMemberAction`:
   - returns the refusal when `authorize` refuses;
   - rejects a role outside the four, before calling `inviteMember`;
   - returns `link` and the not-configured message when `inviteMember` resolves `emailed: false`;
   - returns a `MemberError`'s message.
2. `removeMemberAction`:
   - by a viewer on someone else is refused without calling `removeMember`;
   - by a viewer on themselves calls it and returns `left: true`.
3. `changeMemberRoleAction` passes `{ actorId: auth.user.id, userId, role }` through.

Also add to `tests/navigation.test.ts`, if it enumerates sections, that `/o/x/members` resolves to `Members`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/members-actions.test.ts`
Expected: FAIL. Cannot find module `@/app/actions/members`.

- [ ] **Step 3: Implement the actions, the page, the panel and the navigation entry**

Read `node_modules/next/dist/docs/` on server actions and `useActionState` first. Follow `src/components/CreateWorkspaceForm.tsx` for `useActionState` and `src/app/o/[slug]/audit/page.tsx` for the page skeleton.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/members-actions.test.ts tests/access-gates.test.ts tests/navigation.test.ts`
Expected: PASS. Then `npm run verify`, expecting exit 0.

- [ ] **Step 5: Commit**

Subject: `feat(members): a members page to invite, change roles, remove and leave`

---

### Task 5: Accepting an invitation

**Files:**
- Create: `src/app/invite/[token]/page.tsx`, `src/app/invite/actions.ts`, `src/components/AcceptInvitationForm.tsx`
- Modify: `src/lib/auth/routes.ts` (`requiresSession` also covers `/invite/…`), `tests/auth-routes.test.ts`, `tests/access-gates.test.ts`
- Test: `tests/invite-action.test.ts`

**Interfaces:**
- Consumes: `acceptInvitation`, `invitationPreview` and `MemberError` from Task 3; `getSessionUser` and `verifySession` from `@/lib/auth/session`; `orgHref` from `@/lib/auth/org-paths`.
- Produces, from `src/app/invite/actions.ts` (`"use server"`): `acceptInvitationAction(previous: { ok: boolean; message: string }, formData: FormData): Promise<{ ok: boolean; message: string }>`. Field: `token`. On success it redirects to `orgHref(slug, "/console")`. `redirect` stays outside the `try`, as in `src/app/onboarding/actions.ts`.

**Behaviour:**
- `requiresSession("/invite/abc")` is true, so the proxy sends a signed-out visitor to `/login?next=/invite/abc`. `safeNext` already allows that path.
- The page:
  - calls `verifySession(\`/invite/${token}\`)`;
  - reads `invitationPreview(token)` and does nothing else. It has no side effect: opening the link never accepts it.
- The page states:

| Situation | Page shows |
|---|---|
| no row | "This invitation link is not valid." |
| `used` | "This invitation has already been accepted." |
| `expired` | "This invitation has expired. Ask for a new one." |
| open | "You're invited to join **{orgName}** as {role}." and an **Accept invitation** button in `AcceptInvitationForm` (POST to the action), plus "Signed in as {user.email}." |

- The action:
  - awaits `getSessionUser()` first;
  - validates the token as a string of 20–100 base64url characters (`/^[A-Za-z0-9_-]{20,100}$/`), or returns "This invitation link is not valid.";
  - calls `acceptInvitation`;
  - maps `MemberError` to its message, and anything else to the generic message.
- `tests/access-gates.test.ts`:
  - the "lives in src/app/actions, except …" expectation becomes `["src/app/invite/actions.ts", "src/app/login/actions.ts", "src/app/onboarding/actions.ts"]`;
  - add a describe that `acceptInvitationAction` awaits `getSessionUser` first, mirroring the onboarding one.

- [ ] **Step 1: Write the failing tests**
  - `tests/auth-routes.test.ts`: `requiresSession("/invite/x")` is true; `loginRedirectFor("/invite/x", "", false)` is `"/login?next=%2Finvite%2Fx"`.
  - `tests/invite-action.test.ts`, mocking `server-only`, `@/lib/auth/session`, `@/lib/platform/members` and `next/navigation`'s `redirect` (which throws a marker):
    - signed out → "Your session has ended. Sign in again.", and `acceptInvitation` is not called;
    - a malformed token is refused without calling it;
    - `MemberError("invitation_email_mismatch")` → its message;
    - success → `redirect("/o/acme/console")`.
  - A structural test in `tests/access-gates.test.ts`: `src/app/invite/[token]/page.tsx` does not import `acceptInvitation`. Only the action does.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/invite-action.test.ts tests/auth-routes.test.ts tests/access-gates.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the route change, the page, the form and the action**

- [ ] **Step 4: Run the tests to verify they pass, then `npm run verify`**

- [ ] **Step 5: Commit**

Subject: `feat(members): accept an invitation from its link`

---

### Task 6: The cycle cap in the database

**Files:**
- Modify: `src/lib/agent/orchestrator.ts` (`runAgentCycle`), `src/lib/agent/sandbox-cap.ts`, `src/app/actions/agent.ts`, `src/lib/dal/index.ts` (`TENANT_RPCS` gains `"begin_cycle_run"`)
- Modify tests: `tests/orchestrator.test.ts`, `tests/agent-action.test.ts`, `tests/sandbox-cap.test.ts` (delete what tested `sandboxCyclesUsedToday`), and any fake that answers the `cycle_runs` insert

**Interfaces:**
- Consumes: `begin_cycle_run` from Task 2.
- Produces:
  - `runAgentCycle(options?: { triggeredBy?: string; dailyCap?: number }): Promise<CycleResult>`;
  - from `src/lib/agent/sandbox-cap.ts`: `SANDBOX_DAILY_CYCLES = 20` (unchanged), and `class SandboxCapReachedError extends Error`, whose message is ``This sandbox has run its ${SANDBOX_DAILY_CYCLES} cycles for today (UTC). It resets at midnight UTC.``;
  - `sandboxCyclesUsedToday` is deleted.

**Behaviour:**
- `runAgentCycle` opens the run first, with `db().rpc("begin_cycle_run", { p_daily_cap: options.dailyCap ?? null, p_started_at: startedAt, p_clock_mode, p_chain_mode, p_screening_mode })`. `p_org_id` is added by the DAL.
- An error whose message starts with `sandbox_cap_reached` throws `SandboxCapReachedError`. Any other error throws as before.
- Only after the run is open does simulate mode advance the day (`advance_sim_day`). It then records it with `update cycle_runs set sim_day = <day> where id = <run id>`. A refused cycle therefore advances nothing.
- Real clock mode computes the day as today.
- The rest of `runAgentCycle` is unchanged. Its catch-all still marks the run failed.
- `runAgentCycleAction` drops the count query. It passes `dailyCap: auth.membership.mode === "sandbox" ? SANDBOX_DAILY_CYCLES : undefined`, and maps `SandboxCapReachedError` to `{ ok: false, message: error.message }`.
- The cron path (`src/app/api/agent/tick/route.ts`) passes no cap, because it runs live organizations only. Update the comment there that names `sandboxCyclesUsedToday`.

- [ ] **Step 1: Write the failing tests**
  - `tests/agent-action.test.ts`: replace the HEAD-count cap tests.
    - A sandbox membership whose `rpc/begin_cycle_run` answers `400 { code: "P0001", message: "sandbox_cap_reached: 20 cycles already started today (UTC)" }` returns the cap message. No `advance_sim_day` and no `cycle_runs` insert are made.
    - A sandbox run sends `p_daily_cap: 20`.
    - A live run sends `p_daily_cap: null`.
  - `tests/orchestrator.test.ts`:
    - wherever the fake answered `POST /rest/v1/cycle_runs` for opening a run, answer `rpc/begin_cycle_run` with the run id instead;
    - add a test that in simulate mode `begin_cycle_run` is requested before `advance_sim_day`, followed by a `PATCH /rest/v1/cycle_runs` whose body carries `sim_day`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/agent-action.test.ts tests/orchestrator.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the tests to verify they pass, then `npm run verify`**

- [ ] **Step 5: Commit**

Subject: `feat(agent): open each cycle run through begin_cycle_run, which enforces the sandbox cap`

---

### Task 7: Activity refresh and the daily cleanup

**Files:**
- Create: `src/lib/platform/activity.ts`, `src/lib/platform/cleanup.ts`, `src/app/api/platform/cleanup/route.ts`, `.github/workflows/sandbox-cleanup.yml`
- Modify: `src/lib/auth/membership.ts` (`requireMembership`), `src/lib/auth/authorize.ts` (`authorize`, on success), `src/lib/dal/index.ts` (`PLATFORM_RPCS` gains `"touch_org_activity"` and `"delete_sandbox_org"`)
- Test: `tests/activity.test.ts`, `tests/cleanup.test.ts`, `tests/cleanup-route.test.ts`

**Interfaces:**
- Consumes: `touch_org_activity` and `delete_sandbox_org` from Task 2; `hasValidAgentBearer` from `@/lib/agent-security`.
- Produces:
  - `touchOrgActivity(orgId: string, now?: number): Promise<void>`. It never throws. It skips the call when this instance already refreshed `orgId` less than an hour before `now`, remembered in a module-level `Map<string, number>`. It logs `console.warn("could not record workspace activity", orgId)` when the RPC fails.
  - `resetActivityMemory(): void`, for tests only.
  - `SANDBOX_IDLE_DAYS = 60`.
  - `deleteAbandonedSandboxes(now?: Date): Promise<{ deleted: string[]; failed: { slug: string; error: string }[] }>`. It computes `cutoff = now − 60 days`.
    1. It lists `platformDb().from("orgs").select("id, slug").eq("mode", "sandbox").lt("last_active_at", cutoff.toISOString())`.
    2. For each organization, it calls `rpc("delete_sandbox_org", { p_org_id, p_inactive_before: cutoff.toISOString() })`.
    3. It pushes the slug to `deleted` when the call returns `true`, skips it silently when it returns `false`, and pushes `{ slug, error: message }` when the call fails.
    4. It logs one line per deletion with the org id only.
  - `POST /api/platform/cleanup`:
    - returns 401 without a valid `AGENT_API_TOKEN` bearer (the same check as `/api/agent/tick`);
    - otherwise returns `{ deleted, failed }` with 200, or 500 when `failed` is non-empty.

**Behaviour:**
- `requireMembership` calls `await touchOrgActivity(membership.orgId)` after the membership is found.
- `authorize` calls it before returning `ok: true`.
- The workflow is a copy of `.github/workflows/agent-cycle.yml` with these changes:
  - `name: Vestiarion sandbox cleanup`;
  - `cron: "41 3 * * *"`;
  - the job is named `cleanup`;
  - the URL is `${VESTIARION_URL%/}/api/platform/cleanup`.

  It keeps `workflow_dispatch`, `permissions: contents: read` and `--fail-with-body`.

- [ ] **Step 1: Write the failing tests**
  - `tests/activity.test.ts`, using the fake Supabase as the platform client (see how `tests/dal.test.ts` stubs `platformDb`):
    - the first call sends `rpc/touch_org_activity` with `p_org_id`;
    - a second call within the hour sends nothing;
    - a call at `now + 3_600_001` sends again;
    - a failing RPC resolves and does not throw.
  - `tests/cleanup.test.ts`:
    - the listing filters `mode=eq.sandbox` and `last_active_at=lt.<cutoff>`, with the cutoff exactly 60 days before a fixed `now`;
    - `true`, `false` and error replies land in `deleted`, nowhere and `failed` respectively;
    - `p_inactive_before` equals the listing's cutoff.
  - `tests/cleanup-route.test.ts`:
    - no bearer → 401;
    - with `deleteAbandonedSandboxes` mocked: an empty `failed` gives 200 with the body, a non-empty `failed` gives 500.

- [ ] **Step 2: Run them to verify they fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the tests to verify they pass, then `npm run verify`**

- [ ] **Step 5: Commit**

Subject: `feat(platform): refresh workspace activity and delete abandoned sandboxes daily`

---

### Task 8: Copy fixes and documentation

**Files:**
- Modify: `src/components/vx/Treasury.tsx`, `src/app/o/[slug]/console/page.tsx`, `src/components/vx/CycleReport.tsx`, `src/lib/agent/orchestrator.ts` (the `cycle_complete` summary), `src/app/actions/agent.ts` (the success message)
- Modify: `README.md`, `ARCHITECTURE.md`, `.env.example`
- Test: extend `tests/orchestrator.test.ts` or the nearest existing test of the `cycle_complete` summary. Add `tests/copy.test.ts` for a pure `plural(n, one, many)` helper, if one is introduced.

**Behaviour:**
- **The balance tile on a sandbox.** Treasury takes a `mode: "sandbox" | "live"` prop, and the console passes `membership.mode`. When `mode === "sandbox"`, the tile's label is `Balance (simulated)` and its sub-line is `Sandbox workspace: these funds are simulated, nothing is on-chain`. Live organizations keep today's text.
- **The cycle report header.** It reads ``{cycleName}: the agent logged {n} {n === 1 ? "entry" : "entries"}``, with `n` = the rows it lists, minus the closing `cycle_complete` row if the report includes it. It no longer uses the word "decisions" for a count that includes a compliance sweep.
- **Singular counts.** The `cycle_complete` summary and the action's success message use the singular when the count is 1:
  - `1 agent decision recorded`, and `N agent decisions recorded` otherwise;
  - `1 decision logged` and `N decisions logged`.
- **`.env.example`.** It documents `RESEND_API_KEY` (optional; without it invitations are shown as links only) and `EMAIL_FROM` (optional; default `Vestiarion <no-reply@vestiarion.xyz>`).
- **`README.md` and `ARCHITECTURE.md`.** Describe what exists now, and nothing that does not:
  - inviting members by email with a link shown once;
  - the members page;
  - the role rule enforced in the database functions;
  - leaving;
  - abandoned sandboxes deleted after 60 days by the daily cleanup workflow;
  - the cycle cap enforced by `begin_cycle_run`.

  Update the list of permissions not yet wired, since `members.manage` is now wired. No hackathon, judging or competition wording anywhere.

- [ ] **Step 1: Write the failing tests** for the singular or plural summary, and for the Treasury label if a component test pattern exists (`grep -rn "renderToString\|render(" tests`). If none exists, pin the label logic in a small pure function, e.g. `balanceTileCopy(mode, simulatedReserve)` in `Treasury.tsx`'s module, and test that.
- [ ] **Step 2: Run them to verify they fail**
- [ ] **Step 3: Implement the copy changes and the docs**
- [ ] **Step 4: Run `npm run verify`.** Expected: exit 0.
- [ ] **Step 5: Commit**

Subject: `fix(ui): sandbox balances say simulated, and cycle counts agree with their entries`, plus a separate `docs: members, invitations and sandbox cleanup` if the docs are a separate commit.

---

## Rollout (controller, after the final review)

1. **Migrations, before the merge.** Run `npm run db:migrate` to apply `0021` and `0022`; both are additive apart from the trigger function body. Then probe:
   - the new functions are executable by `service_role` only, and `begin_cycle_run` also by `vestiarion_tenant`;
   - `org_members('<founding id>')` returns the owner;
   - `delete_sandbox_org` on the founding organization raises `not_a_sandbox`. This is a safe check: it raises before any delete.
2. **Merge when CI is green**, then measure:
   - the cron cycle for founding and the ledger stay valid;
   - a sandbox cycle from `note-one`'s console, where the run opens through `begin_cycle_run`;
   - `workflow_dispatch` of `sandbox-cleanup.yml` returns `{"deleted":[],"failed":[]}`, since nothing is 60 days old.
3. **The partner:**
   - adds `RESEND_API_KEY` to Vercel (optional; the link path works without it);
   - invites a second address into `note-one`;
   - accepts from that address;
   - changes its role, then removes it.

   Measure afterwards:
   - the `member_*` ledger entries carry ids only;
   - the invitation row is accepted;
   - the second account sees `note-one` and nothing else.
4. **Record the outcome** under spec §10 step 5b in a docs PR.
