# API keys — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every workspace can create read-only API keys. Every `/api/v1` route serves the key's own workspace, and the platform token no longer opens that surface.

**Architecture:**
- **Migration `0027`** adds the platform table `api_keys` and `create_api_key`.
- **`src/lib/platform/api-keys.ts`** generates, stores (hash only), lists, revokes and authenticates keys.
- **`src/lib/api/guard.ts`** resolves the key and its scope, and `handleApiRequest` runs inside `withOrg(key.orgId)`.
- **A Settings page** manages the keys, with a new permission `api_keys.manage`.

**Tech Stack:** Next.js 16.3.6, supabase-js, Postgres (Supabase), PGlite, Vitest, Node `crypto`, the component system in `src/components/ui/`.

**Spec:** `docs/superpowers/specs/2026-09-29-api-keys-design.md`. K1–K8 are binding.

## Global Constraints

- **Next.js.** Read the relevant guide in `node_modules/next/dist/docs/` before writing Next code (`AGENTS.md`). Every page calls `requireMembership` itself.
- **Checks and dependencies.** No new dependencies. `npm run verify` is green at every commit.
- **Migrations** are idempotent. `scripts/migrate.ts` replays every file from `0001`.
- **The key format** is `vxk_<prefix>_<secret>`:
  - the prefix is 8 characters from `a-z2-7`;
  - the secret is 32 random bytes, base64url;
  - only `sha256(secret)` is stored, as hex;
  - comparisons use `crypto.timingSafeEqual`.
- **Scopes:** only `read` is valid.
- **Limits:** at most 20 active keys per workspace, and a name of 1–60 characters.
- **Permissions:**
  - `api_keys.manage` is for owner and admin;
  - server actions live in `src/app/actions/`, first await `authorize(slug, "<literal>")`, and work inside `return inOrg(auth, async () => …)`.
- **Data access:**
  - tenant data goes through `db()`;
  - platform tables (`orgs`, `memberships`, `invitations`, `api_keys`) go through `platformDb()`;
  - ESLint forbids the raw client outside `src/lib/dal`.
- **Ledger** entries record ids only (K8). Never log or record a token, a secret or a hash.
- **UI:**
  - use the primitives in `src/components/ui/`;
  - no raw controls or colour literals outside that folder;
  - every nav section has an icon in `src/components/vx/nav-icons.ts`, plus its command keywords.
- **Safety:** never print secrets. Never read `.env.local`. Never run anything against production. SQL is tested on PGlite only.
- **Commits** have neutral subjects, a blank line, then your harness's Co-Authored-By trailer, via `git commit -F <file>`.

## Review Focus

1. **A key from workspace A reads workspace B.** Expected: impossible, because every route runs in `withOrg(key.orgId)`. Pinned by Task 3.
2. **A revoked, unknown or malformed key, or the platform token.** Expected: 401, with no hint of which. Pinned by Tasks 2 and 3.
3. **A token that appears in a log, the ledger or a later page view.** Expected: never; the token is shown once in the create dialog. Pinned by Tasks 2 and 4.
4. **A 21st key.** Expected: refused by the database. Pinned by Task 1.
5. **Timing.** Expected: the hash comparison is constant-time, and a missing prefix takes the same comparison path. Pinned by Task 2.

---

### Task 1: Migration 0027

**Files:** create `supabase/migrations/0027_api_keys.sql`; test `tests/api-keys-migration.test.ts`.

The SQL:
- **The table** comes from spec §4.
- **RLS:** enable it, and revoke all from anon and authenticated. The tenant role gets no grant, and service_role gets all, following `0015`'s platform tables.
- **Index:** `api_keys_org_idx on (org_id)`.
- **`create_api_key(p_org_id uuid, p_name text, p_prefix text, p_secret_hash text, p_scopes text[], p_by uuid) returns public.api_keys`:**
  - `security definer`, `search_path = ''`;
  - takes `pg_advisory_xact_lock(hashtext('vestiarion_api_keys:' || p_org_id))`;
  - counts rows with `revoked_at is null`; at 20 or more it raises `api_key_limit_reached: at most 20 active API keys per organization`;
  - inserts with `btrim(p_name)`, and returns the row;
  - is executable by service_role only.

Tests (PGlite, like `tests/control-migration.test.ts`):
- the prefix, hash, name and scopes checks: `{read,write}` and `{}` are refused, and `{read}` is accepted;
- the unique prefix;
- the 21st active key is refused, and revoking one frees a slot;
- deleting the organization cascades;
- anon, authenticated and the tenant role cannot select from the table or execute the function;
- replaying every migration twice succeeds.

Commit: `feat(db): API keys per workspace, stored as hashes`.

---

### Task 2: The key library and the permission

**Files:**
- Create `src/lib/platform/api-keys.ts`.
- Modify `src/lib/auth/roles.ts`: add `"api_keys.manage": ["owner", "admin"]` to PERMISSIONS, and update `tests/roles.test.ts`.
- Modify `src/lib/dal/index.ts`: add `create_api_key` to `PLATFORM_RPCS`, and `api_keys` to the platform tables list, if the DAL keeps one.
- Test `tests/api-keys.test.ts`.

**Interfaces (produces):**

```ts
export const API_KEY_SCOPES = ["read"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];
export interface ApiKeyRow { id: string; name: string; prefix: string; scopes: ApiKeyScope[]; createdAt: string; lastUsedAt: string | null; revokedAt: string | null; }
export interface AuthenticatedKey { keyId: string; orgId: string; scopes: ApiKeyScope[]; }
export class ApiKeyError extends Error { readonly code: "api_key_limit_reached" | "invalid_name" | "not_found" }
export function generateApiKey(random?: (n: number) => Buffer): { token: string; prefix: string; secretHash: string };
export function parseApiKey(token: string): { prefix: string; secret: string } | null;
export async function createApiKey(input: { orgId: string; actorId: string; name: string }): Promise<{ key: ApiKeyRow; token: string }>;
export async function listApiKeys(orgId: string): Promise<ApiKeyRow[]>;
export async function revokeApiKey(input: { orgId: string; actorId: string; keyId: string }): Promise<void>;
export async function authenticateApiKey(authorization: string | null): Promise<AuthenticatedKey | null>;
export async function touchApiKeyUsed(keyId: string, now?: Date): Promise<void>; // never throws
```

**Behaviour:**
- **`generateApiKey`:**
  - the prefix is 8 characters from `a-z2-7`, derived from random bytes;
  - the secret is 32 bytes, base64url;
  - the token is `vxk_${prefix}_${secret}`;
  - `secretHash` is `sha256(secret)` as hex.
- **`parseApiKey`** requires exactly `^vxk_([a-z2-7]{8})_([A-Za-z0-9_-]{43})$`.
- **`authenticateApiKey`:**
  1. strips `Bearer `;
  2. parses the token, returning null when it is malformed;
  3. selects `id, org_id, secret_hash, scopes, revoked_at` by `prefix` through `platformDb()`;
  4. compares the hashes with `timingSafeEqual`. When no row exists, it still compares against a fixed dummy hash, so both paths do one comparison;
  5. returns null for a revoked key;
  6. never logs the token.
- **`createApiKey`:**
  - trims the name and validates 1–60 characters, raising `invalid_name` otherwise;
  - generates a key and calls the RPC, mapping `api_key_limit_reached`;
  - records `api_key_created` best-effort (`appendLedgerEntryBestEffort` from `src/lib/ledger-best-effort.ts`), with `{ enterScope: { userId: actorId } }` if the caller is not in scope. The actions run in scope, so check which applies;
  - the ledger detail is `{ by, keyId, scopes }`.
- **`revokeApiKey`:**
  - updates `revoked_at = now()` where `id` and `org_id` match and `revoked_at` is null, with `.select("id")`;
  - raises `not_found` when no row changes;
  - records `api_key_revoked` with `{ by, keyId }`.
- **`touchApiKeyUsed`:**
  - runs a conditional update where `last_used_at` is null or older than a minute;
  - never throws, and logs the key id only.

**Tests** use the recorded fake from `tests/support/fake-supabase.ts` and the patterns in `tests/members.test.ts`:
- the format and the parse round trip;
- only the hash leaves the process: no request body contains the token or the secret;
- authentication:
  - a live key returns the org and scopes;
  - a revoked, unknown, malformed, or `Bearer`-less value returns null;
  - a wrong secret with a right prefix returns null;
- a timing-safe spy is called in both the unknown-prefix and the known-prefix paths;
- limit mapping, name validation, and the revoke `not_found` case;
- the touch throttle filter;
- the ledger details carry ids only.

Commit: `feat(api): workspace API keys — create, list, revoke and authenticate`.

---

### Task 3: `/api/v1` serves the key's workspace

**Files:**
- Modify `src/lib/api/guard.ts` and the nine `src/app/api/v1/**/route.ts` files.
- Tests: update `tests/api-contract.test.ts`. Replace `tests/api-founding-scope.test.ts` with `tests/api-key-scope.test.ts`. Update `tests/access-gates.test.ts` where it pins `withFoundingOrg` or the v1 guard.

**Interfaces:**

```ts
export type ApiScope = ApiKeyScope; // "read"
export async function guardApiRequest(request: Request, options: { scope: ApiScope; rateLimited?: boolean }):
  Promise<{ denied: NextResponse } | { key: AuthenticatedKey }>;
export async function handleApiRequest<T>(label: string, key: AuthenticatedKey, handler: () => Promise<T | NextResponse>): Promise<NextResponse>;
```

**Behaviour:**
- **`guardApiRequest`:**
  - calls `authenticateApiKey(request.headers.get("authorization"))`;
  - with no key, returns `apiError("unauthorized", "A valid API key is required.")`;
  - when the scope is missing, returns `apiError("forbidden", "This key cannot do that.")`;
  - keeps the optional rate limit;
  - calls `touchApiKeyUsed` without awaiting its failures, so it never blocks.
- **`handleApiRequest`** runs `withOrg(key.orgId, handler)` and keeps the same error shaping.
- **`AGENT_API_TOKEN`** is no longer read anywhere in `src/lib/api`.
- **Each route** becomes:

  ```ts
  const guard = await guardApiRequest(request, { scope: "read" });
  if ("denied" in guard) return guard.denied;
  return handleApiRequest(label, guard.key, …);
  ```
- **`/api/v1/status`** keeps its payload for the key's workspace. Check that nothing in it assumed founding.
- **Doc comments** stop describing the founding binding.

**Tests:**
- every route:
  - answers 401 with no header;
  - answers 401 with `Bearer <AGENT_API_TOKEN value from tests/setup.ts>`;
  - answers 401 with a malformed key;
- with a valid key for org A, the handler runs in org A: assert the recorded tenant requests carry org A's scope, for example a `p_org_id` or `org_id` filter, or the scoped client's org;
- a key for org B reaches org B only;
- `touchApiKeyUsed` is called.

Mock `authenticateApiKey` at the module level for the route tests, keeping one test through the real function.

Commit: `feat(api): every v1 route serves the workspace of the key that calls it`.

---

### Task 4: The Settings page

**Files:**
- Create:
  - `src/app/o/[slug]/settings/page.tsx`;
  - `src/app/actions/api-keys.ts`;
  - `src/components/ApiKeysPanel.tsx`.
- Modify:
  - `src/components/vx/nav.ts`: a `settings` item in the Controls group, last;
  - `src/components/vx/nav-icons.ts`: an icon, e.g. lucide `KeyRound` or `Settings`;
  - `src/components/vx/command-items.ts`: its keywords;
  - `tests/navigation.test.ts`.
- Test: `tests/api-keys-actions.test.ts`, plus the access-gates checks, which run automatically.

**Behaviour:**
- **The page** is `force-dynamic`. It follows the access-gates shape: `await params`, then `requireMembership`, then `return inOrg(access, …)`. It loads `listApiKeys(orgId)` and computes `canManage = can(role, "api_keys.manage")`.
- **The panel** follows the component system and `src/components/MembersPanel.tsx`'s patterns:
  - a table of keys with name, `vxk_<prefix>_…`, created, last used ("never" when there is none) and status (Active or Revoked);
  - for managers, "Create key", which opens a Dialog with a name field. On success, the dialog shows the full token once, in a read-only field with Copy, next to the text "Copy this key now. It will not be shown again.";
  - for managers, "Revoke" on active keys, behind a ConfirmDialog;
  - for everyone else, the list without actions.
- **The actions,** both with `authorize(slug, "api_keys.manage")`:
  - `createApiKeyAction(previous, formData)`, with field `name`, returns `{ ok, message, token? }`;
  - `revokeApiKeyAction(previous, formData)`, with field `keyId`, which must be a uuid.
  - Both map `ApiKeyError` to its message, log other errors, return a generic message, and revalidate.
  - The token appears only in the create action's return value. It is never logged, never revalidated into a page, and never stored.

Tests:
- the permission literal is used, and a refusal passes through;
- name and uuid validation;
- error mapping;
- the create result carries the token, and nothing logs it: spy on the console;
- navigation resolves `/o/x/settings` to "Settings".

Commit: `feat(api): a Settings page to create and revoke API keys`.

---

### Task 5: Documentation

**Files:**
- `docs/api.md`: the auth section, keys, the 401 and 403 errors, and a curl example with `vxk_…`.
- `README.md`.
- `ARCHITECTURE.md`: the API section, and `api_keys.manage` in the permission list.
- The identity and tenancy spec's §4.5: note that the transitional binding ended, pointing to the API keys design.

Describe only what is built. No plan numbers, and no hackathon wording.

Commit: `docs: API keys`.

---

## Rollout (controller)

1. Apply `0027` before the merge. Probe the grants and the RLS.
2. Merge when CI is green.
3. Measure:
   - the platform token on `/api/v1/status` answers 401;
   - the partner creates a founding key on Settings;
   - `/api/v1/status` with that key answers 200 for founding, and `/api/v1/ledger/verify` answers `valid: true`;
   - a `note-one` key serves `note-one`;
   - a revoked key answers 401;
   - the ledger holds `api_key_created` and `api_key_revoked` entries with ids only.
4. Record the outcome in the spec.
