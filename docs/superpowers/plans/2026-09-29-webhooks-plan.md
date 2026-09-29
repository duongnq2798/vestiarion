# Webhooks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every new ledger entry of a workspace is delivered, signed, to the HTTPS endpoints its owners and admins register. Delivery retries with backoff and refuses private destinations.

**Architecture:**
- **Data:** migration `0028` adds `webhook_endpoints` and `webhook_deliveries`, which are platform tables. A security-definer `after insert` trigger on `ledger_entries` enqueues one delivery per active endpoint and never fails the append. `claim_webhook_deliveries` uses skip locked.
- **Delivery code:** `src/lib/webhooks/` signs payloads (HMAC-SHA256), checks destinations, and delivers.
- **Scheduling:** a platform route and a 10-minute GitHub Actions schedule drive delivery, and so does the end of the tick.
- **Settings:** the page gains a Webhooks section.

**Tech Stack:** Next.js 16.3.6, supabase-js, Postgres (Supabase), PGlite, Vitest, Node `crypto` and `dns/promises`, and the component system.

**Spec:** `docs/superpowers/specs/2026-09-29-webhooks-design.md`. W1–W8, §3, §5 and §6 are binding.

## Global Constraints

- **Next.js:** read `node_modules/next/dist/docs/` before writing Next code (`AGENTS.md`). Every page calls `requireMembership` itself.
- **Checks:** no new dependencies. `npm run verify` is green at every commit.
- **Migrations** are idempotent; `scripts/migrate.ts` replays every file from `0001`.
- **Data access:**
  - tenant data goes through `db()`;
  - platform tables (`orgs`, `memberships`, `invitations`, `api_keys`, `webhook_endpoints`, `webhook_deliveries`) go through `platformDb()`;
  - platform RPCs are listed in `PLATFORM_RPCS`;
  - ESLint forbids the raw client outside `src/lib/dal`.
- **Server actions** live in `src/app/actions/`. Each first awaits `authorize(slug, "<literal>")`, and works inside `return inOrg(auth, async () => …)`.
- **Secrets:**
  - A webhook secret is `whsec_` plus 32 random bytes in base64url.
  - It is stored with `encryptSecret` (`src/lib/secrets.ts`), whose context is `{ orgId, column: "webhook_secret:<endpointId>" }`.
  - It is shown once, and never logged, recorded or rendered again.
- **Signature header:** `Vestiarion-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`.
- **Limits:**
  - 5 active endpoints per workspace;
  - 7 attempts per delivery, with backoff after the first of 1m, 5m, 30m, 2h, 6h and 12h;
  - an endpoint is disabled after 20 consecutive failed attempts;
  - 10 s per request;
  - at most 50 deliveries and 60 s per dispatch run;
  - delivered rows are kept 30 days.
- **SSRF (W6):**
  - https only, with no credentials, on port 443 or no port;
  - every resolved address must be public;
  - redirects are never followed;
  - at most 1 KB of the response is read.
- **Permissions:** `webhooks.manage` is for owner and admin.
- **Ledger:** entries record ids only. `webhook_endpoint_created` and `webhook_endpoint_removed` carry `{ by, endpointId }` and no URL.
- **UI:**
  - use the primitives in `src/components/ui/`;
  - no raw controls or colour literals outside that folder.
- **Safety:** never read `.env.local`, never run anything against production, never create worktrees, never push. SQL is tested on PGlite only.
- **Commits:** neutral subjects, then a blank line, then your harness's Co-Authored-By trailer, via `git commit -F <file>`.

## Review Focus

1. **A webhook URL pointing at `169.254.169.254`, `localhost`, a private IP, or a hostname that resolves to one, or that redirects to one.** Expected: never contacted. Pinned by Tasks 2 and 3.
2. **The enqueue trigger failing.** Expected: the ledger append still succeeds. Pinned by Task 1.
3. **A receiver that is down for a day.** Expected: bounded retries, then `failed`, and the endpoint is disabled after 20 consecutive failures. No retry storm. Pinned by Task 3.
4. **The secret appearing in logs, the ledger, a page payload or an error message.** Expected: never. Pinned by Tasks 3 and 4.
5. **Two dispatch runs at once.** Expected: no delivery is sent twice concurrently, thanks to the claim with skip locked. Pinned by Task 1, with a claim test, and Task 3.

---

### Task 1: Migration 0028

Files:
- create `supabase/migrations/0028_webhooks.sql`;
- test `tests/webhooks-migration.test.ts`;
- update the inventory tests if needed: the account-deletion foreign-key list and the rls platform-table list.

The migration follows spec §3 exactly: both tables, RLS with service role only, the indexes, the trigger function and trigger, `create_webhook_endpoint` and `claim_webhook_deliveries`.
- **The trigger function** wraps its insert in `begin … exception when others then raise warning 'webhook enqueue failed: %', sqlerrm; end`, and returns `new`.
- **Grants:** every function is executable by service_role only, except the trigger function, which needs no grant.

Tests (PGlite; patterns in `tests/api-keys-migration.test.ts` and `tests/control-migration.test.ts`):
- **enqueue:**
  - appending an entry, via `appendSignedForOrg` in tests/support/pglite.ts, enqueues exactly one delivery per active endpoint of that org;
  - it enqueues none for a removed or disabled endpoint, and none for another org's endpoint;
- **the trigger cannot break an append:** make the enqueue insert fail on purpose, for example with a temporary check constraint added in the test, then append; the entry is appended and no delivery exists;
- **claim:**
  - it returns only due pending rows, up to the limit, and sets `sending` and `claimed_at`;
  - a second claim does not return them;
  - a `sending` row whose `claimed_at` is 6 minutes old is claimed again;
- **limit:** the 6th active endpoint is refused;
- **access:** tenant, anon and authenticated cannot select or execute;
- **cascade:** deleting an org cascades;
- **sandbox deletion:** `delete_sandbox_org` succeeds for a sandbox with endpoints and deliveries;
- **replay:** replaying twice succeeds.

Commit: `feat(db): webhook endpoints and a delivery queue fed by the ledger`.

---

### Task 2: Signing and safe destinations

Files:
- create `src/lib/webhooks/sign.ts` and `src/lib/webhooks/safe-url.ts`;
- tests `tests/webhook-sign.test.ts` and `tests/webhook-safe-url.test.ts`.

**Interfaces:**

```ts
// sign.ts
export const SIGNATURE_TOLERANCE_S = 300;
export function generateWebhookSecret(random?: (n: number) => Buffer): string;             // "whsec_" + base64url(32)
export function signWebhook(secret: string, body: string, t: number): string;               // "t=<t>,v1=<hex>"
export function verifyWebhookSignature(secret: string, body: string, header: string, nowS: number, toleranceS?: number): boolean; // timing-safe
// safe-url.ts
export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };
export function validateWebhookUrl(raw: string): UrlCheck;                                  // syntax only
export function isPublicAddress(ip: string): boolean;                                       // v4 + v6 + v4-mapped
export async function assertPublicDestination(url: URL, lookup?: (host: string) => Promise<{ address: string; family: number }[]>): Promise<UrlCheck>;
```

**Behaviour:**
- `validateWebhookUrl` checks the rules in W6.
- `isPublicAddress` refuses:
  - 0.0.0.0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.168/16, 198.18/15 and 224/4 and above;
  - IPv6 `::`, `::1`, fc00::/7, fe80::/10 and ff00::/8;
  - IPv4-mapped forms of any of the above.
- `assertPublicDestination` resolves with `dns.promises.lookup(host, { all: true })`, which can be injected. It fails when any resolved address is not public, and when resolution fails.

**Tests:**
- a known HMAC vector, computed in the test with `crypto`;
- verification fails for a wrong secret, a changed body, a timestamp outside the tolerance, and a malformed header;
- every refused range listed above, plus public examples such as 1.1.1.1 and 2606:4700::1111;
- a mixed DNS answer is refused;
- `http:`, credentials, and a port other than 443 are refused by `validateWebhookUrl`.

Commit: `feat(webhooks): signing and a check that destinations are public`.

---

### Task 3: Delivery, the schedule and retention

Files:
- create `src/lib/webhooks/deliver.ts`, `src/app/api/platform/webhooks/route.ts` and `.github/workflows/webhooks.yml`;
- modify:
  - `src/app/api/agent/tick/route.ts`: deliver after the cycles, best-effort;
  - `src/lib/platform/cleanup.ts`: delete delivered rows older than 30 days, best-effort and counted;
  - `src/lib/dal/index.ts`: `PLATFORM_RPCS` and the platform tables;
- tests `tests/webhook-deliver.test.ts` and `tests/webhooks-route.test.ts`; extend the cleanup and tick tests.

**Interfaces:**

```ts
export const WEBHOOK_BACKOFF_MS = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000]; // after attempts 1..6
export const WEBHOOK_MAX_ATTEMPTS = 7;
export const WEBHOOK_DISABLE_AFTER = 20;
export const WEBHOOK_TIMEOUT_MS = 10_000;
export async function deliverPendingWebhooks(options?: { limit?: number; deadlineMs?: number; fetchImpl?: typeof fetch; lookup?: …; now?: () => Date }): Promise<{ delivered: number; failed: number; retried: number }>; // never throws
export async function sendTestEvent(input: { orgId: string; endpointId: string }): Promise<{ ok: boolean; status: number | null; error: string | null }>;
```

**Behaviour:**
- `deliverPendingWebhooks`:
  1. claims through the RPC;
  2. for each delivery, in order, loads the endpoint (url, `secret_enc`, `org_id`) and the org's slug through `platformDb()`;
  3. loads the ledger entry by id through `platformDb()`, because the dispatcher runs outside any workspace;
  4. builds the payload of spec §5 with `JSON.stringify` and signs that exact string;
  5. decrypts the secret with `decryptSecret` and the master keys;
  6. calls `assertPublicDestination`;
  7. posts with `redirect: "manual"`, `AbortSignal.timeout(10s)`, and the headers from W4 plus `User-Agent: Vestiarion-Webhooks/1`;
  8. reads at most 1 KB of the body.
- **Success, a 2xx response:**
  - `delivered`, with `delivered_at` and `last_status` set;
  - the endpoint gets `consecutive_failures = 0` and `last_success_at`.
- **Failure:**
  - `attempts + 1`;
  - `last_status` and `last_error` are set; the error is a short reason and never includes the secret;
  - below 7 attempts, the delivery goes back to `pending` with `next_attempt_at = now + backoff[attempts - 1]`; otherwise it becomes `failed`;
  - the endpoint's `consecutive_failures` goes up by 1, with `last_failure_at`; at 20, `disabled_at` is set, and the endpoint's pending deliveries become `failed`.
- **Limits and errors:** stop claiming or sending once the deadline passes. Unsent claimed rows go back to `pending` and keep their attempt count. Never throw, and log with the endpoint and delivery ids only.
- **`sendTestEvent`** inserts a `webhook.test` delivery for the endpoint and delivers that one row immediately through the same send path. It returns the outcome for the UI.
- **The route** `POST /api/platform/webhooks` uses the same bearer check as `/api/platform/cleanup` and `maxDuration = 300`. It returns `{ delivered, failed, retried }` as counts only, with status 200 when it ran.
- **The workflow** is a copy of `sandbox-cleanup.yml` with `cron: "*/10 * * * *"`, a concurrency group `webhooks`, and the route URL.
- **The tick route** runs `await deliverPendingWebhooks({ deadlineMs: 30_000 })` after `runLiveOrganizations`, inside a try/catch, and it never changes the tick's status or body.

Tests, with a fake fetch, a fake lookup and the recorded Supabase fake:
- the exact headers;
- the body is byte-identical to the signed string, verified with `verifyWebhookSignature`;
- 2xx, 500, a timeout and a 302, each with its backoff;
- the 7th attempt becomes `failed`;
- the 20th consecutive failure disables the endpoint and fails its pending rows;
- a private destination is never fetched;
- a secret that cannot be decrypted;
- the deadline;
- never throws;
- no log line contains the secret;
- the route answers 401 without the token and 200 with counts;
- the cleanup deletes delivered rows older than 30 days;
- a failing delivery does not change the tick's response.

Commit: `feat(webhooks): deliver signed ledger events with retries, every 10 minutes and after each tick`.

---

### Task 4: Endpoint management and the Settings section

Files:
- create:
  - `src/lib/platform/webhooks.ts`;
  - `src/app/actions/webhooks.ts`;
  - `src/components/WebhooksPanel.tsx`;
- modify:
  - `src/lib/auth/roles.ts`: add `webhooks.manage` for owner and admin;
  - `src/app/o/[slug]/settings/page.tsx`: the Webhooks section below the API keys panel;
  - `tests/roles.test.ts`;
- test `tests/webhooks-actions.test.ts` and `tests/webhooks-lib.test.ts`.

**Interfaces:**

```ts
export interface WebhookEndpointRow { id: string; host: string; url: string; createdAt: string; disabledAt: string | null; consecutiveFailures: number; lastSuccessAt: string | null; lastFailureAt: string | null; }
export class WebhookError extends Error { readonly code: "invalid_url" | "webhook_limit_reached" | "not_found" }
export async function createWebhookEndpoint(input: { orgId: string; actorId: string; url: string }): Promise<{ endpoint: WebhookEndpointRow; secret: string }>;
export async function listWebhookEndpoints(orgId: string): Promise<WebhookEndpointRow[]>; // removed ones excluded
export async function removeWebhookEndpoint(input: { orgId: string; actorId: string; endpointId: string }): Promise<void>;
```

**Behaviour:**
- **`createWebhookEndpoint`:**
  1. validates the URL with `validateWebhookUrl`;
  2. picks the endpoint id client-side (`crypto.randomUUID()`), so the secret's envelope can be bound to it;
  3. generates the secret and encrypts it under `webhook_secret:<id>`;
  4. calls the RPC, passing the id, and maps the limit error. To pass the id, give `create_webhook_endpoint` an extra `p_id` parameter, and tell Task 1's reviewer; or have Task 4 adjust the migration, which is not applied yet;
  5. records `webhook_endpoint_created` best-effort.
- **`removeWebhookEndpoint`** sets `removed_at`, fails the endpoint's pending deliveries, and records `webhook_endpoint_removed`.
- **The actions** use `authorize(slug, "webhooks.manage")`:
  - create, with field `url`, returns `{ ok, message, secret? }`;
  - remove, with field `endpointId` (a uuid);
  - send a test, with field `endpointId`, calls `sendTestEvent` and returns "Delivered (HTTP 200)." or "Not delivered: <reason>.".
- **The panel** follows `ApiKeysPanel.tsx`:
  - a table with host, status (Active, Disabled after failures), last success, last failure and failure count;
  - "Add endpoint" opens a dialog with a URL field, then shows the secret once, with Copy and the text "Copy this signing secret now. It will not be shown again.";
  - each row has "Send test" and "Remove" (behind a confirm);
  - people without `webhooks.manage` see the list only;
  - the full URL appears only to managers, and everyone else sees the host.

Tests:
- the permission literal;
- URL validation messages;
- limit mapping;
- the secret appears only in the create result and is never logged;
- the ledger details carry ids only;
- remove fails the pending deliveries.

Commit: `feat(webhooks): owners and admins add, test and remove endpoints`.

---

### Task 5: Documentation

- Create `docs/webhooks.md`. It covers:
  - the payload;
  - the headers;
  - the retries;
  - the SSRF rules;
  - a verification example in Node (about 20 lines, using `crypto.createHmac` and `timingSafeEqual`, with the 5-minute tolerance);
  - how to verify the entry's Ed25519 signature against the key the ledger verify endpoint reports.
- Update README.md, ARCHITECTURE.md (permissions; webhooks) and `.env.example`, if anything changes there.
- Describe only what is built. No plan numbers, and no hackathon wording.

Commit: `docs: webhooks`.

---

## Rollout (controller)

1. Apply `0028` before the merge. Probe the grants, the RLS and that the trigger exists.
2. Merge when CI is green.
3. The partner adds an endpoint in `note-one`, for example a request inspector they control, and sends a test. They then run a cycle. Check:
   - the deliveries show as `delivered`;
   - the signature verifies with the docs' example;
   - a later scheduled dispatch sends nothing new.
4. Record the outcome in the spec.
