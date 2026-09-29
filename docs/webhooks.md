# Webhooks

A workspace can register HTTPS endpoints that receive its ledger, pushed the
moment each entry is appended, instead of polled through [the read
API](api.md). Every request is signed, so a receiver can prove it came from
Vestiarion without trusting the network.

## Adding an endpoint

An owner or admin adds an endpoint on the workspace's Settings page
(`/o/<slug>/settings`, `webhooks.manage` — see [Who sees what](#who-sees-what)
below). The URL is validated on the spot (see [SSRF rules](#ssrf-rules)), and
on success the response carries the endpoint's signing secret — `whsec_`
followed by 32 random bytes, base64url-encoded — **shown once**. It is stored
encrypted under the platform master key, bound to the workspace and the
endpoint id, and cannot be shown again; losing it means removing the endpoint
and adding it back with a fresh one. A workspace holds **at most 5 active
endpoints**, enforced under an advisory lock in the database
(`create_webhook_endpoint`, `supabase/migrations/0028_webhooks.sql`).

The same panel can send a **test event** to an endpoint, and remove it. There
is no re-enable: a disabled endpoint (see [Retries](#retries-and-disabling))
is removed and added again, which also issues it a new secret.

## Timing

Deliveries go out from two places, never inside an unrelated request:

- **Right after each scheduled agent tick**, for the entries that tick just
  appended (`src/app/api/agent/tick/route.ts`). The dispatch gets what is
  left of the tick's own time budget: at most 30 seconds, less when the
  tick's cycles used most of it, and none at all (the dispatch is skipped)
  when nothing is left.
- **Every 10 minutes**, from a bearer-token-protected dispatcher
  (`POST /api/platform/webhooks`, `src/app/api/platform/webhooks/route.ts`)
  that a GitHub Actions schedule calls (`.github/workflows/webhooks.yml`).

A run is bounded by 60 seconds and 500 deliveries (`WEBHOOK_RUN_DEADLINE_MS`,
`WEBHOOK_RUN_LIMIT` in `src/lib/webhooks/deliver.ts`), claimed in batches of
25. No batch is claimed with less than about 12 seconds left, and no request
is started that its 10-second timeout could carry past the deadline, so
nothing is left half-sent when a run ends; a queue larger than one run is
finished by the next.

**A test event is the one exception.** Sending it from the Settings page
(`sendTestEvent`, `src/lib/webhooks/deliver.ts`) delivers it synchronously,
inside that person's own request — a single attempt, at most about 10
seconds, with no retry regardless of the result. Every other delivery is
queued by a database trigger on `ledger_entries` and picked up by the tick or
the 10-minute dispatcher above.

## What is sent

Every delivery is `POST`, `Content-Type: application/json`, with these
headers:

| Header | Value |
| --- | --- |
| `User-Agent` | `Vestiarion-Webhooks/1` |
| `Vestiarion-Event-Id` | The delivery's id (a UUID) — the same on every retry of the same delivery. |
| `Vestiarion-Event-Type` | `ledger.appended` or `webhook.test`. |
| `Vestiarion-Signature` | `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>` — see [Verifying the signature](#verifying-the-signature). |

The body is one JSON object:

```json
{
  "id": "3fa1e2b0-...",
  "type": "ledger.appended",
  "createdAt": "2026-09-29T11:55:00.370366+00:00",
  "workspace": { "slug": "acme" },
  "entry": {
    "seq": 82,
    "ts": "2026-09-29T11:55:00.370366+00:00",
    "actor": "agent",
    "domain": "treasury",
    "action": "sweep_to_reserve",
    "summary": "Swept idle cash to the yield reserve",
    "detail": { "amount": 1000.5 },
    "bodyHash": "8780d07cb3d0...",
    "prevHash": "0000...0000",
    "hash": "b0ac72908868...",
    "signature": "c14f06b7...",
    "signingKeyId": "97a8a48af020f908"
  }
}
```

`entry` carries the same fields as [`GET /api/v1/ledger`](api.md) reports
for that row, without the row `id`, so a receiver already reading that API
recognizes the shape. A
`webhook.test` delivery has no `entry` at all — only `id`, `type`,
`createdAt` (the queued time) and `workspace`.

## Verifying the signature

Recompute the HMAC over the exact raw request body you received (not a
re-serialized copy of it — whitespace and key order must match byte for
byte), reject anything outside a 5-minute window, and compare in constant
time:

```js
const crypto = require("node:crypto");

function verifyVestiarionSignature(secret, rawBody, header, toleranceS = 300) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > toleranceS) {
    return false; // missing/malformed timestamp, or too old
  }
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${t}.${rawBody}`, "utf8")
    .digest();
  const given = Buffer.from(parts.v1 ?? "", "hex");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// verifyVestiarionSignature(secret, rawBody, request.headers["vestiarion-signature"])
```

`secret` is the full string shown at creation, `whsec_` prefix included — it
is the HMAC key as-is, not decoded first. This was run against the repository's
own `signWebhook` (`src/lib/webhooks/sign.ts`): a genuine signature verifies,
a tampered body is rejected, and a timestamp older than the tolerance is
rejected.

## Verifying a ledger entry's Ed25519 signature

The HMAC above proves the request came from Vestiarion. The `entry` inside it
carries its own, independent signature — the same one the audit chain uses —
so a receiver can also check that the entry itself is authentic, apart from
the delivery.

What is signed is **not** the entry, and **not** the `bodyHash` string — it is
the 32 raw bytes you get by hex-decoding `bodyHash`. `bodyHash` is
`sha256(canonicalJson({actor, domain, action, summary, detail}))`, where
`canonicalJson` sorts object keys at every level (`src/lib/ledger.ts`); if you
want to confirm the entry's content matches its `bodyHash` too, rather than
only checking the signature, you need that same canonicalization. Checking
the signature alone does not require it — `bodyHash` is already given.

The public key is not returned by either verify endpoint's JSON
(`GET /api/v1/ledger/verify` or the legacy `GET /api/ledger/verify?org=`,
documented in [api.md](api.md#get-apiv1ledgerverify)) — both report only
whether the chain checks out. The PEM itself, and the `signingKeyId` it
matches, are shown to any signed-in member on the workspace's Audit page
(`/o/<slug>/audit`, under "Ledger signing public key"). Match `entry.signingKeyId`
against the id shown there before trusting a signature — a workspace that has
rotated its key may have entries signed by more than one.

```js
const crypto = require("node:crypto");

function verifyLedgerEntrySignature(entry, publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem);
  return crypto.verify(
    null, // Ed25519: no separate digest algorithm
    Buffer.from(entry.bodyHash, "hex"),
    key,
    Buffer.from(entry.signature, "hex")
  );
}

// verifyLedgerEntrySignature(payload.entry, pemFromTheAuditPage)
```

This was run against the repository's own signing path — an entry built and
signed with `bodyHashOf`, `crypto.sign(null, ...)` and `ledgerKeyId` exactly as
`src/lib/ledger.ts` does it, then checked with the snippet above: a genuine
entry verifies, a tampered `detail` fails (because the recomputed `bodyHash`
no longer matches, so the signature — over the original hash — no longer
matches the entry either), and the wrong public key is rejected.

## Retries and disabling

A non-2xx response, a timeout, or a redirect (redirects are never followed —
a 3xx counts as a failure, same as any other non-2xx) schedules a retry,
**except for `webhook.test`, which never retries: a failure is final on its
first and only attempt.** For `ledger.appended` deliveries, up to 7 attempts
are made in total, with backoff of about 1 minute, 5 minutes, 30 minutes, 2
hours, 6 hours and 12 hours between them (`WEBHOOK_BACKOFF_MS`,
`src/lib/webhooks/deliver.ts`); after the 7th failed attempt the delivery is
`failed` for good. Each request has a 10-second timeout, and at most 1 KB of
the response body is read (neither the body nor headers of the response are
otherwise inspected).

Every failed attempt, `webhook.test` included, counts against the endpoint's
consecutive-failure count. After **20 consecutive failed attempts**, the
endpoint is disabled and its still-pending deliveries are failed outright.
There is no re-enabling in place — remove the endpoint and add it back, which
also issues a fresh secret.

A failure on Vestiarion's side — the endpoint's secret cannot be read, or its
stored URL no longer passes the rules below — is retried on the same
schedule and still ends the delivery `failed` after the 7th attempt, but it
**never counts against your endpoint and never disables it**. A host that
resolves to a non-public address is not such a failure: it counts, like any
other failed attempt.

## Delivery guarantees

- **At least once.** The same event can arrive more than once — for example
  when your endpoint answered but the answer was lost, or a dispatch run
  stopped mid-request. Every retry of an event carries the same
  `Vestiarion-Event-Id` (and the same `id` in the body), so de-duplicate on
  it.
- **Not in order.** Deliveries can arrive out of order: a retry of an older
  entry can land after a newer one, and several dispatch runs may be at work.
  Each `ledger.appended` event carries the entry's `seq`; order by
  `entry.seq`, which ascends within a workspace (with gaps — the hash chain,
  not `seq`, proves continuity).

## SSRF rules

The URL is checked when an endpoint is added, and again at send time
(`src/lib/webhooks/safe-url.ts`, `src/lib/webhooks/http.ts`):

- `https:` only, port 443 or unspecified, no username/password in the URL,
  at most 500 characters.
- Every address the destination has must be public. Refused: this-network,
  private (RFC 1918), CGNAT, loopback, link-local (including cloud metadata
  addresses), IETF protocol assignments, benchmarking, documentation,
  multicast/reserved ranges, and their IPv6 equivalents (unique local,
  link-local, documentation, Teredo); an address that carries an IPv4 one —
  IPv4-mapped, NAT64, or 6to4 — is judged by that IPv4 address. Only global
  IPv6 unicast is otherwise accepted.
- A host name is resolved once, at connect time, inside the request's
  10-second timeout: every answer must be public, and the connection is
  pinned to only the addresses just checked, so a name cannot answer with a
  public address for a check and a private one for the connection (DNS
  rebinding). An IP-literal host is never resolved; it is checked directly,
  when the endpoint is added and again before connecting.
- Redirects are never followed.

## Retention

Delivery records are deleted by the daily cleanup job
(`WEBHOOK_DELIVERY_RETENTION_DAYS`, `src/lib/platform/cleanup.ts`) after 30
days: a `delivered` record 30 days after its delivery, a `failed` one 30 days
after it was created. Records still pending or being sent are never deleted.

## Who sees what

`webhooks.manage` (owner, admin) can add an endpoint, send it a test event,
and remove it, and is the only role shown each endpoint's full URL. Every
other member of the workspace sees the endpoint list — status, last success,
last failure, failure count — with only each endpoint's **host**, never its
full URL, since a URL may name a customer's own system
(`toWebhookEndpointViews`, `src/lib/platform/webhooks.ts`).
