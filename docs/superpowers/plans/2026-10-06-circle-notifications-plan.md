# Circle notifications — implementation plan

> For agentic workers: executed inline (superpowers:executing-plans) under the 2026-10-05 autonomy grant, TDD per step.

**Goal:** Circle's signed transaction notifications start the existing reconcile within seconds (N1–N8).
**Spec:** `docs/superpowers/specs/2026-10-06-circle-notifications-design.md`.
**Architecture:** one route verifies Circle's ECDSA signature with the matched workspace's own Circle client, finds the
workspace whose in-flight intent or wallet the notification names, and raises an event cycle through `runCycleSoon`.
Subscriptions are found-or-made per Circle account: at Connect Circle, and by `npm run circle:subscribe` for the hosted
platform account and accounts connected before. No migration.

## Global constraints

- Nothing from a notification body is written anywhere (N1); the cycle re-reads Circle.
- 401 bad or missing signature; 400 bad envelope; 200 otherwise, including dropped notifications (N2).
- Endpoint `${publicOrigin()}/api/circle/notifications`; types `transactions.outbound`, `transactions.inbound` (N6).
- Copy names a network only from its profile label (mainnet copy C1).

## Review focus

1. A notification whose signature verifies with the platform's key but names a wallet of an own-account workspace (or
   the reverse): must be verified with the matched workspace's client, never another's.
2. A burst: QUEUED, SENT, CONFIRMED, COMPLETE for one transfer must start at most one cycle (only COMPLETE counts).
3. The usual payment, already confirmed inside its sending cycle: starts nothing.
4. Circle down or the key fetch failing: 401 is wrong (Circle would stop?); answer 503 so Circle retries, start nothing.
5. Connect Circle must never fail because the subscription could not be made.

---

### Task 1: the verifier and the envelope (`src/lib/circle/notifications.ts`)

Produces:
- `parseCircleNotification(raw: string): CircleNotification | null` — `{ subscriptionId, notificationId,
  notificationType, notification: { id?, walletId?, state?, transactionType? }, timestamp }`, null when not the envelope.
- `verifyCircleSignature(raw: string, signatureB64: string, publicKeyB64: string): boolean` — P-256/SHA-256, DER
  signature, SPKI DER public key; false (never throws) on malformed input.
- `notificationPublicKey(keyId: string, fetchKey: (keyId) => Promise<string>): Promise<string>` — cached by key id.
- `NOTIFICATION_TYPES = ["transactions.outbound", "transactions.inbound"] as const`;
  `notificationEndpoint(origin = publicOrigin())`.

Tests (`tests/circle-notifications.test.ts`): a key pair made with `crypto.generateKeyPairSync("ec", { namedCurve:
"prime256v1" })` signs a body → true; a changed body, another key, garbage base64 → false; the key fetch runs once per
key id; the envelope parser accepts Circle's documented sample and rejects other JSON, non-JSON, and a missing
`notificationType`.

### Task 2: subscriptions (`ensureNotificationSubscription`, Connect Circle, the operator script)

Produces:
- `type SubscriptionClient = Pick<CircleDeveloperControlledWalletsClient, "listSubscriptions" | "createSubscription">`.
- `ensureNotificationSubscription(client, endpoint): Promise<"exists" | "created">`.
- `subscribeToNotifications(credentials, endpoint?)`: builds the SDK client and ensures.
- `connectCircle` gains `subscribe?: (credentials) => Promise<unknown>`; called after the credentials are stored and
  the connect recorded; a throw is logged and swallowed.
- `scripts/circle-subscribe.ts` + `"circle:subscribe"`: the hosted pair from the environment, then every workspace with
  credentials stored, each found-or-made, printing slug and result only (never a key).

Tests (`tests/circle-subscription.test.ts`, `tests/go-live.test.ts`): creates when no subscription has the endpoint,
asking for both types; leaves one that has it; another endpoint does not count; Connect Circle calls `subscribe` with
the stored pair after storing, and still connects when it throws.

### Task 3: the route and the cycle (`src/app/api/circle/notifications/route.ts`, `src/lib/circle/notify.ts`)

Produces:
- `CycleEventKind` gains `"payment_settled"`; `CycleEvent.userId` optional (N5).
- `matchNotification(note): Promise<{ orgId, slug, mode, kind: "payment_settled" | "payment_received" } | null>` —
  candidates as the transfer watch; outbound COMPLETE/FAILED/DENIED/CANCELLED with an in-flight intent of that
  `provider_tx_id`; inbound COMPLETE to an account's `circle_wallet_id`.
- `handleCircleNotification(request, deps)`: rate limit → read raw (64 KB) → headers → parse → `webhooks.test` → match →
  in the matched workspace's scope, fetch the key with its Circle client and verify → `runCycleSoon`.

Tests (`tests/circle-notifications-route.test.ts`, `tests/cycle-soon.test.ts`): each status of N2; COMPLETE with an
in-flight intent → `payment_settled` for that workspace; same transfer not in flight → nothing; CONFIRMED → nothing;
inbound COMPLETE to an operating wallet → `payment_received`; unknown wallet → nothing; key fetch failing → 503 and
nothing; the key is fetched with the matched workspace's credentials; an event without a person schedules a cycle.

### Task 4: docs

ARCHITECTURE (a "Circle notifications" section), README (operator step), the first-payment guide (a confirmation
arriving after the agent stopped waiting is recorded within seconds), the go-live guide (Connect Circle adds a webhook
to the workspace's Circle account).
