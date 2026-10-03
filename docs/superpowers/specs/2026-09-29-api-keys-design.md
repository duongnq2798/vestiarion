# API keys: each workspace reads its own data over the API

Tier 2, part b, of the "demo to usable product" work. It follows the notifications design (`2026-09-29-notifications-design.md`). It also ends the transitional binding recorded in §4.5 of the identity and tenancy design, where the v1 API reads the founding organization only, with the platform token.

Decided on 2026-09-29 by the implementer under the partner's standing instruction. Each decision states its reason.

## 1. The problem

`/api/v1/*` has nine read routes: status, ledger, ledger verification, invoices, counterparties, milestones, treasury and insights. They are the surface an MCP server, a bot or an accounting sync would build on. Today they have three problems:
- They accept one platform-wide bearer token, `AGENT_API_TOKEN`, which is also the cron's secret.
- They serve the founding organization only (`withFoundingOrg` in `src/lib/api/guard.ts`).
- No other workspace can use them at all, and the only credential that works for founding also runs its cycles.

## 2. What this builds

1. **API keys per workspace.**
   - Owners and admins create them on a new Settings page, name them, and revoke them.
   - The full key is shown once, at creation. Only its SHA-256 hash is stored.
2. **Every `/api/v1` route authenticates with a workspace key** and serves that workspace's data, through the tenant role and RLS, like every other request.
3. **The platform token no longer opens `/api/v1`.** It stays the secret of the cron routes (`/api/agent/tick`, `/api/platform/cleanup`), and nothing else.
4. **Ledger entries** record `api_key_created` and `api_key_revoked` with ids only.

## 3. Decisions

- **K1. The key format is `vxk_<prefix>_<secret>`.**
  - `prefix` is 8 random base32 characters; it identifies the key and is shown in lists.
  - `secret` is 32 random bytes, base64url.
  - The database stores `prefix` (unique) and `sha256(secret)` as hex.
  - A request is authenticated by looking the prefix up and comparing hashes with `crypto.timingSafeEqual`.
  - A fast hash is right here: the secret has 256 bits of entropy, so there is nothing to brute-force.
- **K2. The only scope today is `read`.**
  - `scopes text[]` exists and is checked on every route (`guardApiRequest`'s `scope`). A key can then later be issued for more without an audit of every route.
  - Only `read` is a valid value until a write endpoint exists.
  - There is deliberately no endpoint to decide an approval. Approval is a person's decision, and "no one approves what they created" rests on a person's identity.
- **K3. Owners and admins manage keys.**
  - A new permission `api_keys.manage` covers owner and admin.
  - A key reads everything a member can read, which is an admin-level grant.
- **K4. A key belongs to its workspace, not to the person who created it.**
  - ~~The key survives its creator leaving the workspace.~~ Replaced on 2026-10-03 by
    `2026-10-03-member-api-keys-design.md`: a key works only while its creator is a member, and leaving, being
    removed or deleting the account revokes it (migration 0069).
  - `created_by` becomes null if the account is deleted. Since 0069 the key is revoked in the same update.
  - Revoking is the way to end a key. A revoked key fails exactly like an unknown one.
- **K5. `last_used_at` is refreshed at most once a minute.** It uses a conditional update, is best-effort, and is shown in the list so an unused key can be found and revoked.
- **K6. The v1 surface is a clean cut from the platform token.**
  - After this deploys, `AGENT_API_TOKEN` on `/api/v1` answers 401.
  - Nothing in the repository calls `/api/v1` with it. The rollout creates a founding key first if the partner uses one anywhere.
- **K7. Limits.**
  - A workspace holds at most 20 active keys, checked in the database.
  - A name is 1–60 characters.
- **K8. The ledger records key events with ids only:**
  - `api_key_created`: `{ by, keyId, scopes }`;
  - `api_key_revoked`: `{ by, keyId }`. Since 2026-10-03 it also carries `reason`, and `member` for a removal
    (`2026-10-03-member-api-keys-design.md` R5).

  Neither the name nor the prefix is recorded.

## 4. Data

Migration `0027_api_keys.sql`, idempotent, adds a platform table:

```sql
api_keys (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id) on delete cascade,
  name         text not null check (char_length(btrim(name)) between 1 and 60),
  prefix       text not null unique check (prefix ~ '^[a-z2-7]{8}$'),
  secret_hash  text not null check (secret_hash ~ '^[0-9a-f]{64}$'),
  scopes       text[] not null default '{read}' check (scopes <@ array['read'] and cardinality(scopes) > 0),
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
)
```

- RLS is enabled, with no policy for any browser or tenant role. Only the service role reads or writes it, like `orgs` and `memberships`.
- An index on `org_id`.
- A function `create_api_key(p_org_id, p_name, p_prefix, p_secret_hash, p_scopes, p_by)`, service role only:
  - it counts the active keys under a per-organization advisory lock;
  - at 20 it raises `api_key_limit_reached`;
  - otherwise it inserts and returns the row.

## 5. Components

- **`src/lib/platform/api-keys.ts`:**
  - `generateApiKey()`;
  - `createApiKey({ orgId, actorId, name })`, which returns the stored row plus the token, once;
  - `listApiKeys(orgId)`, which returns rows without the hash;
  - `revokeApiKey({ orgId, actorId, keyId })`;
  - `authenticateApiKey(authorizationHeader)`, which returns `{ orgId, keyId, scopes }` or null;
  - `touchApiKeyUsed(keyId)`.
- **`src/lib/api/guard.ts`:**
  - `guardApiRequest` becomes async. It resolves the key and checks the scope, then returns either the response to send or the authenticated key.
  - `handleApiRequest(label, key, handler)` runs the handler inside `withOrg(key.orgId)`.
  - `withFoundingOrg` leaves the v1 surface.
- **The routes:** the nine `/api/v1` routes pass the key through.
- **The Settings page:**
  - it lives at `/o/[slug]/settings`, as a nav section "Settings" with its icon;
  - it lists keys (name, prefix, created, last used, status);
  - "Create key" is a dialog that shows the full key once, with Copy;
  - "Revoke" asks for confirmation;
  - members without `api_keys.manage` see the list without actions.
- **The actions:** `createApiKeyAction` and `revokeApiKeyAction`, both `api_keys.manage`.

## 6. Error handling

| Situation | Result |
|---|---|
| No, malformed, unknown or revoked key | 401 `unauthorized`, "A valid API key is required.", with no detail about which |
| A key without the route's scope | 403 `forbidden` |
| 20 active keys | "This workspace already has 20 API keys. Revoke one first." |
| Name empty or over 60 characters | Refused in the action |
| Touching `last_used_at` fails | Logged; the request is served |

## 7. Testing

- **PGlite:**
  - the table's checks, including the `scopes` subset and the prefix and hash formats;
  - RLS: tenant, anon and authenticated read nothing;
  - `create_api_key`'s limit;
  - a cascade when the organization is deleted;
  - replay.
- **The library:**
  - the token format;
  - only the hash is stored, and the token is returned once;
  - authentication succeeds for a live key, and fails for a revoked, unknown or malformed one;
  - the comparison is timing-safe;
  - the last-used throttle.
- **The guard and routes:**
  - each route answers 401 without a key and with the platform token;
  - each route serves the key's own workspace, checked through `p_org_id` or `org_id` filters on the recorded fake;
  - a key without `read` gets 403.
- **The actions:** the permission literal, name validation and error mapping.

## 8. Rollout

1. Apply `0027` before the merge. It is additive.
2. Before the merge, ask the partner whether anything calls `/api/v1` with `AGENT_API_TOKEN`. If something does, the partner creates a founding key after the deploy and switches that caller to it.
3. After the deploy:
   - `/api/v1/status` with the platform token answers 401;
   - with a new founding key it answers 200 for founding;
   - with a `note-one` key it answers `note-one`'s data;
   - a revoked key answers 401.
4. Record the outcome here.

## 9. Out of scope, for later

- **Write scopes and endpoints,** such as creating invoices from an accounting sync or running a sandbox cycle.
- **Per-key rate limits.**
- **Key expiry.**
- **Signed webhooks.** That is Tier 2, part c.
