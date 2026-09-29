# Webhooks: a workspace's ledger, pushed to its own systems

Tier 2, part c, of the "demo to usable product" work. It follows the API keys design (`2026-09-29-api-keys-design.md`). API keys let a system pull a workspace's records; webhooks push each new record the moment the workspace has it.

Decided on 2026-09-29 by the implementer under the partner's standing instruction. Each decision states its reason.

## 1. What this builds

1. **Webhook endpoints per workspace.**
   - Owners and admins add an HTTPS URL on the Settings page.
   - The endpoint's signing secret is shown once.
   - An endpoint can be sent a test event, and removed.
2. **Every new ledger entry of the workspace is delivered to each of its active endpoints** as a signed `ledger.appended` event: a decision, a payment, an approval, the pause, a membership change.
3. **Retries.** A failed delivery is retried with backoff for about a day. An endpoint that keeps failing is disabled, and says so on the page.
4. **Receivers can check everything.** The HMAC signature proves the request came from Vestiarion. The entry inside carries its own Ed25519 signature and hash links, so a receiver can also verify it against the workspace's public key.

## 2. Decisions

- **W1. The event is the ledger entry.**
  - The ledger already records every decision and action, signed, with ids only (no email addresses).
  - Delivering entries rather than inventing a second event model means a receiver sees exactly what the audit log shows, in the same order (`seq`), and can verify it.
  - There is one event type, `ledger.appended`, plus `webhook.test`. Receivers filter on `entry.action`. There is no per-endpoint filter in this version.
- **W2. The database enqueues, in the same transaction.**
  - An `after insert` trigger on `ledger_entries` inserts one `webhook_deliveries` row per active endpoint of the entry's workspace.
  - It is `security definer`, because it runs under the tenant role that appends.
  - Its body catches every error and raises a warning instead, so enqueueing can never fail a ledger append. The money path does not change.
- **W3. When deliveries are sent.**
  - Right after each scheduled tick finishes its cycles.
  - By a GitHub Actions schedule every 10 minutes, which calls `POST /api/platform/webhooks` with the platform token. The token is still the cron secret.
  - Latency is therefore at most about 10 minutes, and usually less for cycle events.
  - The one exception is a test event: a person asks for it and waits on it, so it is sent inside their own request, as a single attempt of up to about 10 seconds, never retried.
- **W4. The signature.** Each request carries these headers:
  - `Vestiarion-Event-Id: <uuid>`, one per event, the same on every retry;
  - `Vestiarion-Event-Type`;
  - `Vestiarion-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`.

  The secret is `whsec_` followed by 32 random bytes in base64url. It is shown once. It is stored encrypted under the platform master key, bound to the workspace and the endpoint, because signing needs the plaintext and a hash would not do. The docs tell receivers to reject a timestamp older than 5 minutes.
- **W5. Retries.**
  - Up to 7 attempts, at about 1 minute, 5 minutes, 30 minutes, 2 hours, 6 hours and 12 hours after the first. Then the delivery is `failed`.
  - A 2xx response is success; anything else, including a timeout, is a failure.
  - After 20 consecutive failed attempts across its deliveries, an endpoint is disabled, and its pending deliveries stop. Re-enabling means removing it and adding it again.
- **W6. SSRF.**
  - The URL must be `https:`, on port 443 or unspecified, with no credentials in it.
  - At send time, the host must resolve only to public addresses. Loopback, private, link-local, CGNAT, multicast and IPv6 ULA ranges are refused, and so are IPv4-mapped forms of any of them.
  - Redirects are not followed (`redirect: "manual"`, and a 3xx counts as a failure).
  - The timeout is 10 seconds, and at most 1 KB of the response body is read.
- **W7. Limits.**
  - At most 5 active endpoints per workspace, checked in the database.
  - A dispatch run sends at most 50 deliveries and stops after 60 seconds.
  - Delivered rows older than 30 days are deleted by the daily cleanup.
- **W8. Permissions and ledger.**
  - `webhooks.manage` covers owner and admin.
  - Adding and removing an endpoint are ledger entries: `webhook_endpoint_created` with `{ by, endpointId }`, and `webhook_endpoint_removed` with `{ by, endpointId }`. The URL is left out, because it may carry a customer's hostname.
  - Those entries are delivered too, like any other entry, to the endpoints active at that moment.

## 3. Data (migration `0028_webhooks.sql`)

```sql
webhook_endpoints (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references orgs(id) on delete cascade,
  url            text not null check (url ~ '^https://' and char_length(url) <= 500),
  secret_enc     jsonb not null,          -- envelope, like orgs.*_enc
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  disabled_at    timestamptz,             -- set after 20 consecutive failures
  removed_at     timestamptz,             -- removed by a person
  consecutive_failures int not null default 0,
  last_success_at timestamptz,
  last_failure_at timestamptz
)
webhook_deliveries (
  id              uuid primary key default gen_random_uuid(),   -- the event id
  org_id          uuid not null references orgs(id) on delete cascade,
  endpoint_id     uuid not null references webhook_endpoints(id) on delete cascade,
  ledger_entry_id uuid references ledger_entries(id) on delete cascade,   -- null for a test event
  event_type      text not null check (event_type in ('ledger.appended', 'webhook.test')),
  status          text not null default 'pending' check (status in ('pending', 'sending', 'delivered', 'failed')),
  attempts        int not null default 0,
  next_attempt_at timestamptz not null default now(),
  claimed_at      timestamptz,
  last_status     int,
  last_error      text,
  created_at      timestamptz not null default now(),
  delivered_at    timestamptz
)
```

- RLS is enabled with no policies. The tables are service role only, like `api_keys`.
- Indexes:
  - `(status, next_attempt_at)`;
  - `endpoint_id`;
  - `ledger_entry_id`, if the column type needs one for the cascade.
- **`enqueue_webhook_deliveries()`** is the `after insert` trigger function on `ledger_entries` (W2). It inserts a row for every endpoint with `removed_at is null and disabled_at is null` in `new.org_id`.
- **`create_webhook_endpoint(p_org_id, p_url, p_secret_enc, p_by)`**, service role only:
  1. takes an advisory lock;
  2. raises `webhook_limit_reached` at 5 active endpoints;
  3. inserts and returns the row.
- **`claim_webhook_deliveries(p_limit int)`**, service role only. It moves up to `p_limit` rows that are due into `sending`:
  - due means `status = 'pending'` and `next_attempt_at <= now()`, or `status = 'sending'` with `claimed_at` older than 5 minutes (a crashed run);
  - it uses `for update skip locked`;
  - it sets `claimed_at` and returns them.
- **`delete_sandbox_org`** (0022) keeps working through the cascades. The migration's tests prove it.

## 4. Components

- **`src/lib/webhooks/sign.ts`:**
  - `signWebhook(secret, body, t)` returns the header value;
  - `verifyWebhookSignature(secret, body, header, now, tolerance)`, which the docs example and the tests use.
- **`src/lib/webhooks/safe-url.ts`:**
  - `validateWebhookUrl(url)` checks the syntax, for the form;
  - `assertPublicDestination(url)` resolves the host and checks every address, at send time.
- **`src/lib/webhooks/deliver.ts`:**
  - `deliverPendingWebhooks({ limit, deadlineMs })` claims, builds each payload, signs, posts, and records the result, the backoff and the endpoint's counters. It never throws.
  - `sendTestEvent(endpointId)` enqueues a `webhook.test` delivery and dispatches it immediately.
- **`src/lib/platform/webhooks.ts`:**
  - `createWebhookEndpoint`, which returns the row and the secret, once;
  - `listWebhookEndpoints(orgId)`;
  - `removeWebhookEndpoint`.
- **Actions:** `src/app/actions/webhooks.ts`, all `webhooks.manage`: create, remove and send a test.
- **Settings page:** a Webhooks section below API keys. It lists each endpoint's host, status, last success and failure, and failure count. It holds the "Add endpoint" dialog, which shows the secret once, plus Send test and Remove.
- **`POST /api/platform/webhooks`** (platform token), and `.github/workflows/webhooks.yml` every 10 minutes, with a concurrency group.
- **The tick route** calls `deliverPendingWebhooks` after `runLiveOrganizations`, best-effort.

## 5. Payload

```json
{
  "id": "<delivery/event id>",
  "type": "ledger.appended",
  "createdAt": "<ISO time of the entry>",
  "workspace": { "slug": "acme" },
  "entry": {
    "seq": 257, "ts": "…", "actor": "agent", "domain": "ap", "action": "ap_hold",
    "summary": "…", "detail": { … },
    "bodyHash": "…", "prevHash": "…", "hash": "…", "signature": "…", "signingKeyId": "…"
  }
}
```

A test event has `"type": "webhook.test"` and no `entry`.

## 6. Error handling

| Situation | Result |
|---|---|
| The URL is not HTTPS, has credentials, or is too long | Refused in the form |
| The URL resolves to a private address at send time | The attempt fails with "destination is not public"; it counts toward disabling |
| The receiver answers 3xx, 4xx or 5xx, or times out | The attempt fails and is retried per W5 |
| The master key cannot decrypt the secret | The attempt fails with "secret unavailable" and is logged with the endpoint id |
| A 6th endpoint | "This workspace already has 5 webhook endpoints. Remove one first." |
| Enqueueing fails inside the trigger | A warning is raised; the ledger entry is appended normally |

## 7. Testing

- **PGlite:**
  - the trigger enqueues one row per active endpoint and none for a removed or disabled one;
  - the trigger never fails an append, even with a broken endpoint table state;
  - the claim moves only due rows, and reclaims stale `sending` rows;
  - the endpoint limit;
  - RLS is closed to tenant, anon and authenticated;
  - an organization cascade, and `delete_sandbox_org` still succeeding with webhook rows present;
  - replay.
- **Signing:** a known vector, verification succeeding and failing, and the tolerance.
- **Safe URL:** every refused range, including IPv6 and IPv4-mapped forms, DNS returning mixed addresses, and a non-https URL.
- **Delivery,** with a fake fetch and fake DNS:
  - the headers and signature, and the body is exactly what was signed;
  - 2xx gives delivered, and resets the failure count;
  - a failure gives backoff and `next_attempt_at`;
  - the 7th failure gives `failed`;
  - the 20th consecutive failure disables the endpoint;
  - a redirect is not followed;
  - the 10 s timeout;
  - the dispatch deadline;
  - never throws.
- **Actions and UI:** the permission, the secret shown once and never logged, and the limit message.

## 8. Rollout

1. Apply `0028` before the merge. It is additive. The trigger only enqueues when endpoints exist, and there are none at first.
2. Merge. A person adds an endpoint for `note-one` pointing at a request inspector the partner controls, and sends a test. Then run a cycle in `note-one`. Check:
   - the test and the cycle's entries arrive;
   - the signature verifies with the docs' example;
   - the entry's Ed25519 signature verifies.
3. Record the outcome here.

## 9. Out of scope

- Per-endpoint event filters.
- Re-enabling a disabled endpoint in place, and replaying past events.
- Delivery logs in the UI beyond the counters.
- Other event sources than the ledger.
