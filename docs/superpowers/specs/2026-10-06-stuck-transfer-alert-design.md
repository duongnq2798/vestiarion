# A payment that does not confirm reaches a person: phase 2d of the mainnet plan

Date: 2026-10-06. Status: designed on `feat/stuck-transfer-alert`. Designed under the standing autonomy grant, after
phase 2c (#221, every workspace names its network and going live opens on Arc mainnet). Rulings carry their cost if wrong.

## 1. Why

- **A payment can sit in flight unseen.** The agent or a person sends a payment, and Circle answers that it is on its
  way. Until Circle confirms it, the invoice reads "Payment in flight" and the milestone stays verified.
  - The cycle asks Circle again every 6 hours. Until it confirms, the cycle writes `ap_reconcile` with the payment still
    pending, and tells no one.
  - Circle's `STUCK` state counts as pending, like `QUEUED` or `SENT`.
  - The only age rule is for a payout across chains (`MINT_OVERDUE_HOURS`, 2 hours from the decision). Arc mainnet has
    no such payout.
  - A payment in flight never reaches Approvals, the email digest, the console's toasts, Slack or Telegram:
    `ap_reconcile` is not an activity action.
- **On Arc mainnet this is real money.** A stuck transfer is one where a payee is owed and nothing moves. The
  workspace's people should hear of it within minutes, not find it by chance.
- **The decision trail says the opposite.** It tells every `ap_reconcile` as "The agent confirmed the payment", including
  one whose payment was still pending, or was held.
- **There is no stable send time.** `payment_intents` records `created_at` for the first attempt only, and
  `executed_at` and `updated_at` are rewritten by every reconcile.
- **Done when:**
  - a live payment not confirmed 15 minutes after its attempt was sent is told to the workspace's people once, through
    the console, Slack, Telegram, webhooks and email;
  - it is told whatever the switches say;
  - the trail tells a reconcile as what it found;
  - nothing is sent, retried or settled by the alert.

## 2. Rulings

- **D1. What is stuck.**
  - A payment is stuck when all four hold:
    - it is a live payment intent (`provider_mode = 'live'`);
    - it is `submitting` or `pending`;
    - its current attempt was sent more than the network's `stuckAfterMinutes` ago;
    - Circle, asked again, does not show it confirmed or failed.
  - `stuckAfterMinutes` is a new network profile field: 15 on Arc testnet and on Arc mainnet.
    - Arc confirms in seconds and Circle within a minute, so 15 minutes is far past normal.
    - It matches the 15 minutes the cycle waits before it resends a send Circle never answered.
  - *Cost if wrong:* a slow but healthy transfer could alert once. Each attempt alerts at most once (D5).
- **D2. When an attempt was sent: `submitted_at`.** Migration 0080 adds `payment_intents.submitted_at`.
  - A trigger stamps it whenever a row's status becomes `submitting`. That covers a first send, a retry after
    `begin_payment_retry`, and a claim taken again after the 2-minute window. So no SQL function is redefined.
  - Rows in flight when the migration runs are backfilled from `executed_at`, else `created_at`.
  - A partial index serves the watch's query, over in-flight rows only.
  - *Cost if wrong:* a backfilled row could alert early, once.
- **D3. Where it runs: a transfer watch every 5 minutes.**
  - A GitHub Actions workflow, `transfer-watch.yml`, calls a protected route, `/api/agent/transfer-watch`, with the
    agent's bearer token. It is rate-limited like the FX watch's.
  - It reads and tells. It never sends, retries, settles or holds anything: the cycle keeps doing that, as before.
  - *Cost if wrong:* the alert lags by up to 5 minutes, plus the workflow's own delay.
- **D4. It tells whatever the switches say.**
  - It still runs when payments are off, the agent is paused, Arc mainnet is switched off, or the workspace is not live.
    A payment already sent can be stuck in any of those states, and that is when a person most needs to know.
  - Where Circle cannot be asked, it tells from the age alone and says Circle could not be asked. That happens when
    stored credentials cannot be read, or Arc mainnet is switched off and withholds them.
  - A send Circle never answered (no transaction id) is told as such.
  - *Cost if wrong:* a workspace whose credentials cannot be read hears about a payment Circle may have confirmed. The
    entry says Circle was not asked.
- **D5. Once per attempt, signed.** The watch writes a ledger entry, `payment_stuck`.
  - Actor `agent`. Domain `ap` for an invoice, `contractor` for a milestone.
  - Its `detail`: `invoiceId` or `milestoneId`, `counterpartyId`, `amount`, `currency`, `idempotencyKey`, `attempt`,
    `submittedAt`, `minutes`, `circleAsked`, `providerState`, `txHash` and `network`.
  - An entry for the same idempotency key means the attempt was told. A retry is a new key, and may be told again.
  - The watch runs one at a time (the workflow's concurrency group), so checking the ledger is enough to tell once.
  - *Cost if wrong:* two watches at once could tell twice. The workflow's concurrency rules that out.
- **D6. Who is told.**
  - `payment_stuck` joins the activity actions. So the console's toasts, Telegram and Slack carry it, as they carry the
    agent's decisions, and every webhook endpoint gets it as `ledger.appended`.
  - Owners, admins and approvers with email notices on get an email, one each, up to 25. These are the email digest's
    recipients.
  - An email that fails to send is logged and not retried. The entry and the chats still carry the alert.
  - *Cost if wrong:* someone with email notices off, and no chat linked, sees it only in the console.
- **D7. What it says.**
  - "The payment of *12.50 USDC* to *Jiren*, sent *18 minutes* ago on *Arc mainnet*, has not confirmed."
  - Then Circle's state, or that Circle could not be asked, or that Circle never answered the send.
  - Then: "Vestiarion sends nothing again while it may still settle, and checks it again at the next cycle."
  - For a `STUCK` transfer: "Circle shows it stuck: check it in Circle's console, or contact Circle support." Speeding
    up or cancelling a transfer stays out of scope, as the failed-transfer retry design ruled.
- **D8. The trail tells a reconcile as what it found.**
  - **Paid:** "The agent confirmed the payment on *network*."
  - **Still pending:** "The agent checked the payment: still in flight on *network*."
  - **Held:** "The agent checked the payment: it did not go through, and the invoice is held."
  - `payment_stuck` shows as "Not confirmed *N* minutes after it was sent; the workspace's people were told."
- **D9. Only live payments.** A simulated payment confirms when it is made, and is never watched.
- **D10. A payment confirmed by the time the watch asks is not told.** The watch settles nothing: the next cycle records
  it, as now. Settling sooner is out of scope.

## 3. Testing

- **Migration 0080 (PGlite):**
  - the column, the backfill, and the index;
  - the trigger on a first claim, a retry and a reclaim;
  - no stamp on other status changes.
- **The watch:**
  - it tells a pending live payment older than 15 minutes once, and never a younger one, a simulated one, or one already
    told;
  - it does not tell one Circle now shows confirmed or failed;
  - it tells a never-answered send, and tells with `circleAsked: false` where no provider can be had;
  - it tells while payments are off and while Arc mainnet is switched off;
  - each workspace's failure is its own.
- **Telling:** the entry's detail; the activity item; the email's recipients and text; Slack and Telegram carrying it.
- **The trail:** a reconcile that left the payment pending, or held it, is not told as confirmed.
- **The route:** it refuses without the agent's bearer, is rate-limited, and answers per workspace.

## 4. Rollout

- **Migration 0080:** the partner runs it before the merge. Without it, the watch's query fails, and the route answers
  500 with nothing told.
- **The workflow** uses the secrets the FX watch already uses (`VESTIARION_URL`, `AGENT_API_TOKEN`).
- **Production:** on Arc testnet the watch tells the people of a live workspace about a payment stuck over 15 minutes.
  None is today: pending live payments are probed read-only before merge.
- **Rollback:** revert. The column and its trigger are harmless left in place.
