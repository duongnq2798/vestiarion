# Identity and tenancy — Plan 3a: self-serve workspaces and roles

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in person with no workspace can create one, every action is gated by the §7 permission map, an organization always keeps an owner, sandbox cycles are capped, and the cron runs every `live` organization.

**Architecture:**
- Migration `0020` adds:
  - `create_org(p_org_id, p_user_id, p_name, p_slug, p_ledger_key_enc)`, executable by the service role only. It enforces the 3-workspace limit, inserts a sandbox organization, and makes the caller its owner.
  - A trigger that refuses to remove or demote the last owner.
- `src/lib/platform/workspace.ts` creates a workspace:
  1. pick the slug;
  2. generate the Ed25519 key;
  3. encrypt it under the new organization's id;
  4. call the RPC;
  5. inside the new scope, add the simulated accounts and the signed `org_created` entry.
- `roles.ts` becomes the §7 table (`can`, `canAssignRole`). `authorize(slug, permission)` replaces `authorizeMutation`.
- `src/lib/agent/cron.ts` runs a function in every `live` organization, isolating failures.

**Tech Stack:** Next.js 16.3.6, supabase-js 2.117, Postgres (Supabase), PGlite, Vitest, Node `crypto`.

**Spec:** `docs/superpowers/specs/2026-09-27-identity-and-tenancy-design.md` — §6 (onboarding, limits), §7 (roles), §4.4 (cron, sandbox cap), §10 step 5a.

## Global Constraints

- Read the relevant guide in `node_modules/next/dist/docs/` before writing Next code (`AGENTS.md`).
- No new dependencies. `npm run verify` green at every commit.
- Migrations are idempotent; `scripts/migrate.ts` replays every file from `0001` each run.
- Founding organization: id `00000000-0000-4000-8000-000000000001`, slug `founding`, mode `live`.
- Slugs match `^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$` (`isValidSlug`, the `orgs.slug` check).
- Per-user limit: at most **3** existing organizations with `created_by` = the user. Sandbox cap: at most **20** cycles per organization per UTC day, counted from `cycle_runs`.
- A new sandbox gets exactly two accounts: `Operating (simulated)` (`operating`, `ARC-TESTNET`, balance `10000`) and `Reserve (simulated)` (`reserve`, `ARC-TESTNET`, balance `0`).
- Ledger entries record `detail.by = <user id>`, never an email address (§7).
- Tenant data goes through `db()` (the tenant role, RLS). Platform data goes through `platformDb()`. ESLint forbids the raw client outside `src/lib/dal`.
- Never print secrets or tokens. Never run anything against the Supabase project in `.env.local` (production). SQL is tested on PGlite only.
- Commit messages are neutral descriptions of the change, never framed against feedback or review: subject, blank line, `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, via `git commit -F <file>`.

## Review Focus

1. **Two people creating workspaces with the same name at the same moment.** Expected: both succeed with different slugs, and no one ever overwrites another's organization. Pinned by Task 3 (a slug collision is retried with a suffix).
2. **A fourth workspace.** Expected: the database refuses it, and the person sees a message naming the limit (§8). Pinned by Tasks 2 and 3.
3. **Removing or demoting the last owner** (including through `org:grant`). Expected: the database refuses it; deleting the whole organization still works. Pinned by Task 2.
4. **A viewer or approver submitting a form directly.** Expected: the action refuses with a message naming the missing permission, and the control is not rendered for them. Pinned by Task 1.
5. **One `live` organization's cycle failing inside the cron.** Expected: the others still run, and the response says which failed. Pinned by Task 5.

## Rulings made while writing this plan

- **The server generates the organization id.** The ledger key's ciphertext binds the organization id through the AAD (§5.4), so it must be encrypted before the row exists.
- **Slug:** derived from the name (lowercase ASCII, hyphens, at most 36 characters), with `workspace` as the fallback. A taken slug gets `-` plus 4 random hex characters, retried up to 5 times.
- **A sandbox starts with 10,000 simulated USDC** in its operating account. With nothing to reason about, the first cycle would show nothing; Tier 3's sample-data loader will replace this.
- **`agent.pause` / `agent.resume` / `approval.decide` exist in the permission table only.** Their features are Tier 1.
- **`org:grant` may now grant in any organization.** It remains an operator tool; invitations (Plan 3b) are the product path.

---

### Task 1: The permission map and `authorize`

**Files:**
- Modify: `src/lib/auth/roles.ts`, `src/lib/auth/authorize.ts`
- Modify: `src/app/actions/agent.ts`, `src/app/actions/intake.ts`, `src/app/actions/milestones.ts`
- Modify: `src/components/AgentControls.tsx`, `src/app/o/[slug]/invoices/page.tsx`, `src/app/o/[slug]/counterparties/page.tsx`, `src/app/o/[slug]/contractors/page.tsx`, and any other `viewerCanMutate` caller (`grep -rn viewerCanMutate src`)
- Modify: `tests/roles.test.ts`, `tests/access-gates.test.ts`

**Interfaces:**
- Produces, from `@/lib/auth/roles`:
  - `PERMISSIONS: Record<Permission, readonly OrgRole[]>`, `type Permission`;
  - `can(role: OrgRole | null | undefined, permission: Permission): boolean`;
  - `canAssignRole(actor: OrgRole | null | undefined, target: OrgRole): boolean`.
- Produces, from `@/lib/auth/authorize`:
  - `authorize(orgSlug: unknown, permission: Permission): Promise<Authorization>`;
  - `viewerCan(orgSlug: string, permission: Permission): Promise<boolean>`.
  - `authorizeMutation`, `viewerCanMutate` and `canMutate` are removed.

- [ ] **Step 1: Write the failing tests**

`tests/roles.test.ts`: replace the `canMutate` block with the table below (hand-written expected values, spec §9), and keep the `isOrgRole` block.

```ts
import { can, canAssignRole, isOrgRole, type Permission } from "@/lib/auth/roles";

// Spec §7, row by row. ✓ = allowed.
const TABLE: Array<[Permission, { owner: boolean; admin: boolean; approver: boolean; viewer: boolean }]> = [
  ["workspace.read",   { owner: true,  admin: true,  approver: true,  viewer: true  }],
  ["agent.pause",      { owner: true,  admin: true,  approver: true,  viewer: false }],
  ["approval.decide",  { owner: true,  admin: true,  approver: true,  viewer: false }],
  ["records.write",    { owner: true,  admin: true,  approver: false, viewer: false }],
  ["agent.run_cycle",  { owner: true,  admin: true,  approver: false, viewer: false }],
  ["agent.resume",     { owner: true,  admin: true,  approver: false, viewer: false }],
  ["members.manage",   { owner: true,  admin: true,  approver: false, viewer: false }],
  ["org.administer",   { owner: true,  admin: false, approver: false, viewer: false }],
];

describe("can — the §7 permission map", () => {
  it.each(TABLE)("%s", (permission, expected) => {
    for (const role of ["owner", "admin", "approver", "viewer"] as const) {
      expect(can(role, permission), `${role} → ${permission}`).toBe(expected[role]);
    }
  });

  it("gives no permission to someone without a role", () => {
    for (const [permission] of TABLE) {
      expect(can(null, permission)).toBe(false);
      expect(can(undefined, permission)).toBe(false);
    }
  });
});

describe("canAssignRole — no one grants a role above their own", () => {
  it.each([
    ["owner", "owner", true], ["owner", "admin", true], ["owner", "approver", true], ["owner", "viewer", true],
    ["admin", "owner", false], ["admin", "admin", false], ["admin", "approver", true], ["admin", "viewer", true],
    ["approver", "viewer", false], ["viewer", "viewer", false],
  ] as const)("%s may assign %s: %s", (actor, target, expected) => {
    expect(canAssignRole(actor, target)).toBe(expected);
  });
});
```

`tests/access-gates.test.ts`: change "awaits authorizeMutation first" to "awaits authorize first" (`expect(awaitedNames(body)[0]).toBe("authorize")`). Add a test that every `authorize(` call in `src/app/actions/*.ts` passes a permission string literal as its second argument (regex `authorize\([^,]+,\s*"[a-z_.]+"\)`), counting at least 5 matches.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/roles.test.ts tests/access-gates.test.ts`
Expected: FAIL — `can` and `canAssignRole` are not exported; the actions still await `authorizeMutation`.

- [ ] **Step 3: Implement**

`src/lib/auth/roles.ts` (keep `ORG_ROLES`, `OrgRole`, `isOrgRole`):

```ts
/**
 * Spec §7 as data. Pause and resume are asymmetric on purpose: anyone who can
 * approve money leaving can stop it; starting it again is deliberate. An
 * approver cannot create records, separating maker from checker.
 */
export const PERMISSIONS = {
  "workspace.read": ["owner", "admin", "approver", "viewer"],
  "agent.pause": ["owner", "admin", "approver"],
  "approval.decide": ["owner", "admin", "approver"],
  "records.write": ["owner", "admin"],
  "agent.run_cycle": ["owner", "admin"],
  "agent.resume": ["owner", "admin"],
  "members.manage": ["owner", "admin"],
  "org.administer": ["owner"],
} as const satisfies Record<string, readonly OrgRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: OrgRole | null | undefined, permission: Permission): boolean {
  return !!role && (PERMISSIONS[permission] as readonly OrgRole[]).includes(role);
}

const RANK: Record<OrgRole, number> = { viewer: 0, approver: 1, admin: 2, owner: 3 };

/**
 * An owner may assign any role. An admin may assign approver and viewer only,
 * and nobody else assigns roles at all (spec §7: no one grants a role above
 * their own, and admin and owner changes are the owner's).
 */
export function canAssignRole(actor: OrgRole | null | undefined, target: OrgRole): boolean {
  if (actor === "owner") return true;
  if (actor === "admin") return RANK[target] < RANK.admin;
  return false;
}
```

`src/lib/auth/authorize.ts`: `authorize(orgSlug, permission)` has the same flow as today's `authorizeMutation`, with the role test replaced by `can(membership.role, permission)`.
- Message on refusal: `` `Your role in this workspace (${membership.role}) cannot do that.` ``
- Not a member: keep the existing message.
- `viewerCan(orgSlug, permission)` returns `(await authorize(orgSlug, permission)).ok`.

Callers:

| Caller | Permission |
|---|---|
| `runAgentCycleAction` | `"agent.run_cycle"` |
| `createCounterpartyAction` / `createInvoiceAction` / `importInvoicesAction` | `"records.write"` |
| `manualMilestoneVerificationAction` | `"records.write"` |
| `AgentControls` | `viewerCan(orgSlug, "agent.run_cycle")` |
| invoices / counterparties / contractors pages | `viewerCan(slug, "records.write")` |

Keep each action's first statement as `const auth = await authorize(…)`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/roles.test.ts tests/access-gates.test.ts`, then `npm run verify`.
Expected: green. `grep -rn "authorizeMutation\|viewerCanMutate\|canMutate" src tests` prints nothing.

- [ ] **Step 5: Commit** — subject `feat(auth): the §7 permission map gates every action and control`.

---

### Task 2: Migration 0020 — `create_org` and the last-owner guard

**Files:**
- Create: `supabase/migrations/0020_create_org.sql`
- Create: `tests/create-org.test.ts`
- Modify: `tests/support/pglite.ts` (`createUser(db, email): Promise<string>` inserts into `auth.users`)

**Interfaces:**
- Produces (SQL):
  - `public.create_org(p_org_id uuid, p_user_id uuid, p_name text, p_slug text, p_ledger_key_enc jsonb) returns public.orgs`, executable by `service_role` only;
  - trigger `memberships_keep_an_owner` (before update or delete on `memberships`).
- Error text: the limit raises `org_limit_reached: at most 3 workspaces per person`; a slug clash surfaces as the unique violation on `orgs_slug_key`.

- [ ] **Step 1: Write the failing tests**

`tests/create-org.test.ts`. The first beforeAll applies all migrations and creates users `alice`, `bob` and `carol` via `createUser`. Then:
- `create_org(id, alice, 'Alice Co', 'alice-co', '{"k":"x"}')` returns a row with `mode = 'sandbox'`, `created_by = alice`, the given `ledger_signing_key_enc`, and an `owner` membership for alice;
- a fourth `create_org` for alice fails with `/org_limit_reached/`, after three succeeded with different slugs;
- deleting one of alice's orgs lets her create another (the limit counts existing organizations only);
- a duplicate slug fails with `/orgs_slug_key|duplicate key/`;
- an invalid slug (`'A'`) fails on the slug check;
- `create_org` is not executable by `anon`, `authenticated` or `vestiarion_tenant` (`has_function_privilege` false), and is executable by `service_role`.
- Last-owner guard:
  - deleting the only owner's membership fails with `/last owner/`;
  - updating the only owner to `admin` fails with `/last owner/`;
  - with a second owner (bob) inserted, demoting alice succeeds;
  - deleting an organization cascades its memberships, including its last owner, without error;
  - replaying all migrations twice works.

Write these as concrete `it` blocks with real SQL, following the style of `tests/rls.test.ts` and `tests/org-chains.test.ts`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/create-org.test.ts`. Expected: FAIL — `function public.create_org(...) does not exist`.

- [ ] **Step 3: Write the migration**

```sql
-- Self-serve workspaces (spec §6, §10 step 5a).
--
-- create_org is the only way an organization is born outside the operator's
-- scripts. The server generates p_org_id first because the ledger key's
-- ciphertext is bound to it (§5.4); the function checks the per-person limit,
-- inserts the organization in sandbox mode and makes the caller its owner, in
-- one transaction.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

create or replace function public.create_org(
  p_org_id          uuid,
  p_user_id         uuid,
  p_name            text,
  p_slug            text,
  p_ledger_key_enc  jsonb
) returns public.orgs
language plpgsql
set search_path = ''
as $$
declare
  v_existing int;
  v_org      public.orgs;
begin
  -- Serialise one person's creations so two concurrent requests cannot both
  -- pass the limit.
  perform pg_advisory_xact_lock(hashtext('vestiarion_create_org:' || p_user_id::text));
  select count(*) into v_existing from public.orgs where created_by = p_user_id;
  if v_existing >= 3 then
    raise exception 'org_limit_reached: at most 3 workspaces per person';
  end if;

  insert into public.orgs (id, slug, name, mode, created_by, ledger_signing_key_enc)
  values (p_org_id, p_slug, btrim(p_name), 'sandbox', p_user_id, p_ledger_key_enc)
  returning * into v_org;

  insert into public.memberships (org_id, user_id, role) values (p_org_id, p_user_id, 'owner');
  return v_org;
end;
$$;

revoke execute on function public.create_org(uuid, uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.create_org(uuid, uuid, text, text, jsonb) to service_role;

-- Every organization keeps at least one owner. Deleting the organization itself
-- still cascades: by the time its memberships go, the organization row is gone.
create or replace function public.keep_an_owner() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.role = 'owner'
     and (tg_op = 'DELETE' or new.role <> 'owner')
     and exists (select 1 from public.orgs where id = old.org_id)
     and not exists (
       select 1 from public.memberships
        where org_id = old.org_id and role = 'owner' and user_id <> old.user_id
     )
  then
    raise exception 'the last owner of an organization cannot be removed or demoted';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists memberships_keep_an_owner on public.memberships;
create trigger memberships_keep_an_owner
  before update or delete on public.memberships
  for each row execute function public.keep_an_owner();

-- Rollback:
-- drop trigger if exists memberships_keep_an_owner on public.memberships;
-- drop function if exists public.keep_an_owner();
-- drop function if exists public.create_org(uuid, uuid, text, text, jsonb);
```

If the PGlite cascade test shows the organization row still visible in the trigger during `on delete cascade`, stop and report NEEDS_CONTEXT. Do not weaken the guard.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/create-org.test.ts tests/rls.test.ts tests/org-chains.test.ts`, then `npm run verify`. Expected: green.

- [ ] **Step 5: Commit** — subject `feat(db): create_org and an owner every organization keeps (0020)`.

---

### Task 3: Creating a workspace

**Files:**
- Modify: `src/lib/dal/index.ts` (`platformDb().rpc` for an allowlist `PLATFORM_RPCS = ["create_org"]`)
- Create: `src/lib/platform/workspace.ts`
- Create: `tests/workspace.test.ts`
- Modify: `tests/support/fake-supabase.ts` if a reply needs a status or headers the helper cannot express yet (extend `FakeReply` minimally)

**Interfaces:**
- Consumes: `withOrg` (scope.ts), `db()`, `platformDb()`, `appendLedgerEntry`, `encryptSecret`, `masterKeysFromEnv`, `ledgerKeyId`, `isValidSlug`.
- Produces:
  - `slugFromName(name: string): string`;
  - `createWorkspace(input: { userId: string; name: string; random?: () => string }): Promise<{ orgId: string; slug: string }>`;
  - `class WorkspaceLimitError extends Error`.

- [ ] **Step 1: Write the failing tests**

`tests/workspace.test.ts`, using `fakeSupabase` and a base context `runWith({ config, db: fake.client, fetch: fake.fetch }, …)`. The config comes from `configFromEnv` with URL, service key, anon key and JWT secret placeholders. Set `process.env.VESTIARION_MASTER_KEYS` to a generated `t1:<base64 32 bytes>` inside the test, and restore it afterwards.

Test cases:
- `slugFromName`:
  - `"Northstar Studio"` → `"northstar-studio"`;
  - `"  Café Ümlaut & Co.  "` → `"cafe-umlaut-co"` (NFKD, strip marks);
  - `"日本"` → `"workspace"`;
  - a 60-character name gives at most 36 characters, with no trailing hyphen;
  - every output satisfies `isValidSlug`.
- `createWorkspace` happy path. The fake answers:
  - `GET /rest/v1/orgs?slug=eq.…` (slug check) with `[]`;
  - `POST /rest/v1/rpc/create_org` with the org row;
  - `GET /rest/v1/orgs?id=eq.…` (scope entry) with that row, including the `ledger_signing_key_enc` the RPC received;
  - `POST /rest/v1/accounts` with `[]`;
  - the ledger head read with `[]`;
  - `POST /rest/v1/rpc/append_ledger_entry` with a row.

  Assert:
  - the RPC body has `p_org_id` (a uuid), `p_user_id`, `p_name` trimmed, `p_slug` `"northstar-studio"`, and a `p_ledger_key_enc` envelope;
  - decrypting that envelope with the test master key, bound to `p_org_id` and `ledger_signing_key_enc`, gives a PKCS8 Ed25519 PEM;
  - the accounts insert carries exactly the two simulated accounts from Global Constraints, stamped with the new org id;
  - the append RPC has `p_action: "org_created"`, `p_actor: "human"`, `p_detail.by = userId`, and `p_signing_key_id` equal to `ledgerKeyId` of the decrypted key;
  - the append's token (Authorization header) names the new org with `sub = userId`;
  - the result is `{ orgId, slug }`.
- A taken slug: the first slug check returns a row. The second attempt uses `northstar-studio-<4 hex>` from the injected `random`.
- A clash inside the RPC: `create_org` replies 409 with code `23505` and a message containing `orgs_slug_key` the first time, then succeeds. The workspace is created with a suffixed slug. After 5 clashes it throws.
- The RPC replies with a message containing `org_limit_reached`: `createWorkspace` throws `WorkspaceLimitError` with message `"You already have 3 workspaces, the most one person can create."`.
- Names: an empty or whitespace-only name, or one over 80 characters, throws before any request is made.

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL — module `@/lib/platform/workspace` not found.

- [ ] **Step 3: Implement**

`platformDb()` gains:

```ts
rpc(name: PlatformRpc, args: Row = {}) {
  if (!(PLATFORM_RPCS as readonly string[]).includes(name)) throw new Error(`${name} is not a platform function`);
  return client.rpc(name, args);
}
```

with `export const PLATFORM_RPCS = ["create_org"] as const; export type PlatformRpc = …`.

`src/lib/platform/workspace.ts`:
- `slugFromName`: NFKD → strip combining marks → lowercase → replace runs of `[^a-z0-9]` with `-` → trim hyphens → cut to 36 → trim hyphens again → if the result has fewer than 3 characters or fails `isValidSlug`, return `"workspace"`.
- `createWorkspace({ userId, name, random = () => crypto.randomBytes(2).toString("hex") })`:
  1. Validate the trimmed name: 1–80 characters.
  2. `const keys = masterKeysFromEnv()`. A missing key throws; the deployment cannot store a secret.
  3. Loop up to 5 attempts:
     - `slug = attempt === 0 ? base : `${base.slice(0, 35)}-${random()}``;
     - skip to the next attempt if `platformDb().from("orgs").select("id").eq("slug", slug).maybeSingle()` returns a row;
     - `orgId = crypto.randomUUID()`;
     - generate the Ed25519 key pair; PKCS8 PEM;
     - `envelope = encryptSecret(pem, { orgId, column: "ledger_signing_key_enc" }, keys)`;
     - `platformDb().rpc("create_org", { p_org_id: orgId, p_user_id: userId, p_name: trimmed, p_slug: slug, p_ledger_key_enc: envelope })`;
     - on an error whose message contains `org_limit_reached`, throw `WorkspaceLimitError`;
     - on a unique violation mentioning `orgs_slug_key`, continue;
     - on any other error, throw it;
     - on success, break.
  4. After 5 failed attempts, throw `"Could not find a free address for this workspace; try a different name."`.
  5. `await withOrg(orgId, async () => { … }, { userId })`:
     - insert the two accounts through `db().from("accounts").insert([...])`;
     - `await appendLedgerEntry({ actor: "human", domain: "system", action: "org_created", summary: `Workspace created: ${trimmed}`, detail: { by: userId, slug, mode: "sandbox", ledgerKeyId: ledgerKeyId(publicKey) } })`.
  6. Return `{ orgId, slug }`.

- [ ] **Step 4: Run to verify it passes**, then `npm run verify`.

- [ ] **Step 5: Commit** — subject `feat(platform): create a workspace with its own key and simulated accounts`.

---

### Task 4: `/onboarding` creates a workspace

**Files:**
- Create: `src/app/onboarding/actions.ts` (`"use server"`, `createWorkspaceAction`)
- Create: `src/components/CreateWorkspaceForm.tsx` (client component, `useActionState`)
- Modify: `src/app/onboarding/page.tsx`
- Modify: `tests/access-gates.test.ts`

**Interfaces:**
- Consumes: `createWorkspace`, `WorkspaceLimitError` (Task 3); `getSessionUser`; `orgHref`.
- Produces: `createWorkspaceAction(previous: { ok: boolean; message: string }, formData: FormData): Promise<{ ok: boolean; message: string }>`, which redirects to `/o/<slug>/console` on success.

- [ ] **Step 1: Extend the structural test (failing)**

In `tests/access-gates.test.ts`:
- The allowed list of `"use server"` files outside `src/app/actions` becomes `["src/app/login/actions.ts", "src/app/onboarding/actions.ts"]`.
- New test: every exported async function in `src/app/onboarding/actions.ts` awaits `getSessionUser` first. It is not an organization action: there is no organization yet.

Run it. Expected: FAIL (the file does not exist).

- [ ] **Step 2: Implement**

`src/app/onboarding/actions.ts`:

```ts
"use server";

import "server-only";
import { redirect } from "next/navigation";
import { orgHref } from "@/lib/auth/org-paths";
import { getSessionUser } from "@/lib/auth/session";
import { createWorkspace, WorkspaceLimitError } from "@/lib/platform/workspace";

export interface CreateWorkspaceResult {
  ok: boolean;
  message: string;
}

export async function createWorkspaceAction(_previous: CreateWorkspaceResult, formData: FormData): Promise<CreateWorkspaceResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, message: "Your session has ended. Sign in again." };
  const name = formData.get("name");
  if (typeof name !== "string" || !name.trim()) return { ok: false, message: "Give the workspace a name." };
  let slug: string;
  try {
    ({ slug } = await createWorkspace({ userId: user.id, name }));
  } catch (error) {
    if (error instanceof WorkspaceLimitError) return { ok: false, message: error.message };
    console.error("workspace creation failed", error);
    return { ok: false, message: error instanceof Error ? error.message : "The workspace could not be created." };
  }
  redirect(orgHref(slug, "/console"));
}
```

Read Next 16's docs on `redirect` inside server actions (it throws; call it outside `try`), and on `useActionState`, in `node_modules/next/dist/docs/`.

`CreateWorkspaceForm.tsx`: a small client component. It has one text input `name` (required, `maxLength={80}`, label "Workspace name") and a submit button "Create workspace". While pending, the button reads "Creating…" and is disabled. The returned message renders under the form, in the danger style when `ok === false`. Match the visual language of the existing `/login` form and `src/components/intake/*` forms: Tailwind tokens `border-line`, `bg-surface`, `text-ink`, `text-ink-3`, `surface-shadow`.

`src/app/onboarding/page.tsx`:
- **No memberships:** the "No workspace yet" copy becomes: "Create a workspace to try Vestiarion with simulated money. A teammate can also invite you to theirs." Then show the form.
- **One or more memberships:** the list, then a heading "Create another workspace" with the form. The page no longer auto-redirects when there is exactly one membership, because otherwise a second workspace could never be created. The sign-in callback sends people to `/onboarding` by default, so check `src/lib/auth/routes.ts` `DEFAULT_AFTER_LOGIN`. If it is `/onboarding`, keep the auto-redirect only when no `?new` query parameter is present, and link "Create another workspace" to `/onboarding?new`. Say in the report which you chose and why.
- Keep sign-out.

- [ ] **Step 3: Verify**

- Run `npx vitest run tests/access-gates.test.ts`, then `npm run verify`.
- Start the dev server with the preview tools; do not use a terminal command. On the partner's dev server if one is already running on :3000, check read-only that `/onboarding` redirects to `/login` when signed out.
- Do not create a workspace against the production database from the dev server.

- [ ] **Step 4: Commit** — subject `feat(onboarding): create a workspace from the first screen`.

---

### Task 5: The cron runs every live organization; sandbox cycles are capped

**Files:**
- Create: `src/lib/agent/cron.ts`
- Create: `src/lib/agent/sandbox-cap.ts`
- Modify: `src/app/api/agent/tick/route.ts`
- Modify: `src/app/actions/agent.ts`
- Create: `tests/cron.test.ts`, `tests/sandbox-cap.test.ts`
- Modify: `scripts/org-grant.ts` (lift the founding-only refusal)

**Interfaces:**
- Produces:
  - `runLiveOrganizations<T>(run: () => Promise<T>): Promise<Array<{ slug: string; ok: true; result: T } | { slug: string; ok: false; error: string }>>`;
  - `SANDBOX_DAILY_CYCLES = 20`;
  - `sandboxCyclesUsedToday(now?: Date): Promise<number>`.

- [ ] **Step 1: Write the failing tests**

`tests/cron.test.ts` (fake fetch):
- The orgs query (`GET /rest/v1/orgs` with `mode=eq.live`) returns two live orgs, A and B, and the scope-entry reads return their rows.
- `run` records `currentOrgId()`, and throws `new Error("boom")` for B.
- Assert:
  - the result is `[{slug A, ok true}, {slug B, ok false, error "boom"}]`;
  - both ran, each in its own scope;
  - the orgs query filtered `mode=eq.live`.

`tests/sandbox-cap.test.ts` (fake fetch; the fake replies with a `content-range` header so supabase-js sees a count):
- `sandboxCyclesUsedToday(new Date("2026-09-28T15:00:00Z"))` issues a HEAD count on `cycle_runs` with `started_at=gte.2026-09-28T00:00:00.000Z` and `org_id=eq.<org>`, and returns the count.
- `SANDBOX_DAILY_CYCLES === 20`.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement**

`src/lib/agent/cron.ts`:
- Read `platformDb().from("orgs").select("id, slug").eq("mode", "live").order("slug")`.
- For each organization, run `await withOrg(org.id, run)` in a `try`. Collect results; a failure is logged with `console.error("cycle failed for", slug, error)` and recorded, and never stops the loop.
- Comment: spec §4.4, one organization's failure is its own.

`src/lib/agent/sandbox-cap.ts`: count `cycle_runs` through `db()`, head-only, with `started_at >= ` today 00:00 UTC.

`src/app/api/agent/tick/route.ts`:
- Replace `withFoundingOrg(() => runAgentCycle())` with `runLiveOrganizations(() => runAgentCycle())`.
- Respond `{ organizations: results.map(({ slug, ok, error }) => …) }`, where each entry carries `slug`, `ok`, the line count on success, and the error on failure. Never echo more than `error.message`.
- Status 200 when every organization succeeded, 500 when any failed, so the workflow's `--fail-with-body` flags it.
- Update the route's comment.

`src/app/actions/agent.ts` `runAgentCycleAction`: inside `inOrg`, before running, when `auth.membership.mode === "sandbox"` and `await sandboxCyclesUsedToday() >= SANDBOX_DAILY_CYCLES`, return `{ ok: false, message: "This sandbox has run its 20 cycles for today (UTC). It resets at midnight UTC." }`.

`scripts/org-grant.ts`: remove the founding-only refusal and its message. Keep the slug validation. Update the header comment: invitations (Plan 3b) are the product path, and this stays the operator's tool.

- [ ] **Step 4: Verify** — the new tests, then `npm run verify`.

- [ ] **Step 5: Commit** — subject `feat(agent): the cron runs every live organization; sandbox cycles are capped`.

---

### Task 6: Documentation and the rollout record

**Files:**
- Modify: `README.md`: creating a workspace, roles, and the sandbox with its daily cycle cap. Product-focused wording only.
- Modify: `ARCHITECTURE.md` (`create_org`, the permission map, the cron over organizations).
- Modify: `docs/api.md` (the `/api/agent/tick` response shape, if documented).

- [ ] **Step 1: Update the docs** — subject `docs: workspaces, roles and the cron over organizations`.

- [ ] **Step 2: Rollout (the controller's, not a subagent's).**

1. `npm run db:migrate` (0020 is additive; the deployed code does not call it). Measure:
   - `create_org` exists, is executable by `service_role` only, and `anon`/`authenticated`/`vestiarion_tenant` cannot run it;
   - the trigger exists;
   - the founding organization has an owner, so the trigger cannot block anything existing.
2. Open the PR, then merge once CI is green. Measure:
   - a cron cycle (`workflow_dispatch`) returns `organizations: [{ slug: "founding", ok: true, … }]`;
   - the ledger is `valid: true`;
   - the owner's pages render with their controls;
   - the partner creates a sandbox workspace from `/onboarding`, then runs a cycle in it;
   - in the new workspace, the ledger's first entry is `org_created`, signed by that workspace's own key, and verification is `valid: true`;
   - the founding organization's data is not visible from the sandbox, and the reverse.
3. Record the outcome under §10 step 5a in a docs pull request.
