# Circle notifications: a payment settles in seconds, not at the next cycle

Status: design, 2026-10-06. Partner asked to look at Circle's webhooks ("Xem coi có giúp gì cho bạn được không"); this
is the design I chose under the autonomy grant of 2026-10-05.

## Why

Today Vestiarion learns a payment's outcome by asking Circle:

- **Paying out.** The cycle that sends a transfer waits at most 45 seconds for Circle to confirm it
  (`awaitSettlement`, `src/lib/circle/settlement.ts`). A transfer that confirms later stays in flight until the next
  cycle reconciles it, which for a live workspace is the six-hourly tick. The invoice, its receipt facts, the payment
  notice to the payee and the chats all wait with it. The transfer watch only tells people after 15 minutes.
- **Money coming in.** A client's payment, or a funding transfer, is seen when a cycle's receipts stage reads Circle's
  inbound transfers (`listInboundTransfers`), or when the payer presses the pay page's check.

Circle Wallets sends signed notifications when a transaction's state changes (`transactions.outbound`,
`transactions.inbound`). Listening to them settles these within seconds, and adds Circle's notifications API to the
Circle products Vestiarion uses.

In production on 2026-10-06, 7 of the 8 live workspaces pay from hosted wallets on the platform's Circle testnet
account, and 1 from its own Circle account; a workspace on Arc mainnet always uses its own account.

## Rulings

**N1. A notification starts work; it never writes money.** A verified notification only starts the reconcile paths
that already exist, which read the transaction back from Circle with the workspace's own credentials before anything is
recorded. Nothing from a notification's body is written to the ledger, an intent or an invoice. A forged or replayed
notification can at worst start a cycle that finds nothing to do.

**N2. One endpoint.** `POST /api/circle/notifications`, for every Circle account Vestiarion subscribes:
- the body is read raw, at most 64 KB, and parsed as Circle's envelope (`subscriptionId`, `notificationId`,
  `notificationType`, `notification`, `timestamp`, `version`);
- `webhooks.test` (sent when a subscription is made, which Circle makes only once the endpoint answers it with a 2xx)
  answers 200 and does nothing, before the headers are looked at;
- the signature is verified before anything is started: ECDSA P-256 with SHA-256 over the raw body, `X-Circle-Signature`
  (base64 DER) against the public key Circle names in `X-Circle-Key-Id`, fetched with the matching Circle account's
  client (`getNotificationSignature`) and cached by key id for the life of the instance (Circle says a key id's key never
  changes);
- a request without both headers, or whose signature does not verify, answers 401; a body that is not the envelope,
  400; a key that cannot be fetched (Circle not answering), 503, so Circle sends it again and nothing is started;
  everything else 200, whether it started work or not, so Circle does not retry what was decided;
- its own rate limit by caller address, as the watches have.

**N3. Which workspace, and only if something waits.** The candidates are the workspaces that can hold a live payment,
as the transfer watch lists them (a hosted wallet, or Circle credentials stored). In each, read-only:
- **outbound** (`transactions.outbound`): a payment intent still in flight (`submitting` or `pending`) whose
  `provider_tx_id` is the notification's transaction `id`;
- **inbound** (`transactions.inbound`): an account whose `circle_wallet_id` is the notification's `walletId`.

The first workspace that matches is the one; none, and the notification is acknowledged and dropped. The signature is
verified with that workspace's Circle client (hosted wallets: the platform's account; own credentials: the workspace's),
so a key id is fetched from the account the notification is about. One read per candidate workspace (8 today); a
platform function that maps a wallet or transaction to its workspace replaces the loop when there are many.

**N4. Which states start a cycle.**
- outbound `COMPLETE`, `FAILED`, `DENIED` or `CANCELLED` for an intent still in flight: a cycle with the new event
  `payment_settled`; its AP stage reconciles the intent as it does on the schedule;
- inbound `COMPLETE`: a cycle with the existing event `payment_received`, as the pay page's check starts;
- every other state is acknowledged and ignored. `CONFIRMED` is passed over for the `COMPLETE` that follows within
  seconds on Arc, so one transfer starts one cycle; `STUCK` stays the transfer watch's (every 5 minutes, 2026-10-06
  Supabase Cron).

The usual payment confirms inside its sending cycle's 45-second wait: its intent is no longer in flight when the
notification arrives, so it starts nothing (no second cycle per payment).

**N5. Through the event-driven cycle.** `runCycleSoon` already debounces (2 s), waits for a running cycle, and drops
the event for a paused agent, a sandbox past its daily cap, or the stop switch. A notification has no person behind it:
`CycleEvent.userId` becomes optional, and a cycle started without one records no `triggeredBy`, as the FX watch's
cycles do.

**N6. One subscription per Circle account, found or made.** Endpoint `${publicOrigin()}/api/circle/notifications`,
notification types `transactions.outbound` and `transactions.inbound`. `ensureNotificationSubscription(client)` lists
the account's subscriptions and creates one only if none has that endpoint, so connecting twice, or two workspaces on
one account, never makes two (Circle allows 20 per account and environment).
- **A workspace's own account:** ensured when Connect Circle succeeds, after the credentials are stored. A failure is
  logged and never fails the connect: the schedule still settles everything.
- **The platform's hosted account, and accounts connected before this:** ensured by `npm run circle:subscribe`, which
  the operator runs once per deployment. It never runs on a request path.

**N7. Mainnet.** The same endpoint and rules. A mainnet workspace always has its own account, so its subscription is
made at its Connect Circle, and its notifications are verified with its live key.

**N8. Not in this slice.** Telling `STUCK` at once; transfers whose stored id is prefixed (`cctp:`, `gateway:`), which
the schedule keeps reconciling; a notification log or dedupe table (duplicates fall into one debounced cycle); showing
the subscription in Settings; a platform function in place of the loop.

## Testing

- The verifier: a P-256 key pair made in the test signs a body; a good signature passes, a changed body or another
  key fails, a key fetched once is cached.
- The route, with Circle and the cycle stubbed: 401 without headers or with a bad signature, 400 for a bad envelope,
  200 for `webhooks.test`; an outbound `COMPLETE` whose intent is in flight starts `payment_settled` in that workspace;
  one no longer in flight, or of another state, starts nothing; an inbound `COMPLETE` to an operating wallet starts
  `payment_received`; an unknown wallet starts nothing; the signature is checked with the matched workspace's client.
- `ensureNotificationSubscription`: creates when missing, leaves an existing one, asks for the two notification types.
- Connect Circle calls it after storing the credentials, and still connects when it throws.
- `runCycleSoon` accepts an event without a person.

## Final review (2026-10-06), after #230 merged

A fresh review of the whole branch found one critical and one important issue, fixed with tests in the follow-up:

- **C1.** The route allowed 60 seconds, but the event cycle it starts runs after the answer in the same invocation,
  bounded by the route's duration: a cycle cut short leaves its run row `running` and blocks the workspace's cycles for
  15 minutes. The route allows 300 seconds, as every route that starts a cycle; so does the GitHub App's webhook, whose
  deferred work raises the same cycles.
- **I2.** Any inbound `COMPLETE` to any of a workspace's wallets started a full cycle, so dust sent again and again,
  funding transfers and the agent's own moves each cost one. N3 and N4 now match the operating account only, read its
  inbound transfers at once (`recordIncomingTransfers`, as the pay page's check does), at most once in 15 seconds per
  workspace, and raise `payment_received` only when a receivable was paid.

And these minor ones:
- **M4.** The subscription at Connect Circle has a 10-second deadline.
- **M5.** It is made from the production deployment only, never from a preview or a developer's machine.
- **M7.** An intent recorded `failed` that may still move is matched too. A workspace that cannot be read, with none
  matched, answers 503 so Circle retries.
- **M8.** The operator script goes on past a failing account, and says to run after the deploy is live.
- **M9.** The docs say when "within seconds" holds, and that `by` is absent unless a person's event joined the cycle.
- **M10.** Only `circleFailureLabel` of a Circle failure is logged.

Deferred:
- **M3.** The candidate loop reads before it verifies. The per-client limit is keyed on Circle's few sending addresses,
  which another account subscribed to this endpoint can fill. Needs a platform function mapping a transaction or wallet
  to its workspace, which is a migration.
- **M6.** "Exists" ignores a subscription's `enabled` and types, and list-then-create can race.
- **M7b.** A `COMPLETE` landing between the settlement re-read and `recordResult` is left to the schedule.
