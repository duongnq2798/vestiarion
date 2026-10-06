# Stuck-Transfer Alert (Phase 2d) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A live payment not confirmed 15 minutes after its attempt was sent is told, once per attempt, to the workspace's people, and the decision trail tells a reconcile as what it found.

**Architecture:** Migration 0080 stamps `payment_intents.submitted_at` with a trigger. A transfer watch (`src/lib/agent/transfer-watch.ts`) runs every 5 minutes through a protected route and a GitHub Actions workflow, like the FX watch. It asks Circle again, read-only, and writes a signed `payment_stuck` entry. The console, Slack, Telegram and webhooks carry that entry as an activity action, and the deciding members get an email.

**Tech Stack:** Next.js route handlers, TypeScript, Supabase (PostgREST + SQL migrations, PGlite in tests), Vitest, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-06-stuck-transfer-alert-design.md` (rulings D1–D10).

## Global Constraints

- **The watch never moves money.** It does not call `transfer`, `batchTransfer`, `recordResult`, `begin_payment_retry`, or any invoice or milestone status update. It reads, and appends ledger entries.
- **Migrations are the partner's.** 0080 is idempotent, because `db:migrate` runs every file again. It redefines no existing function.
- **Copy names the network from its profile's `label`.** The copy ratchet (`tests/network-copy-ratchet.test.ts`) must stay green with no new allowance.
- **Testnet behaviour is unchanged** apart from the new alert and the trail's reconcile text (D8).
- **Each task ends with `npm run verify` green.** The last also runs `npx next build`.
- **Docs move with the change:** the first-payment guide, the changelog (a new ledger action reaches webhooks), ARCHITECTURE and README.

## Review Focus

1. **A retried payment.** Its new attempt is stamped again when it is claimed, and is told only 15 minutes after that, under its new key. Task 1's trigger test and Task 3's watch test pin it.
2. **A workspace with no provider.** This covers Arc mainnet switched off, and credentials that cannot be read. The watch tells with `circleAsked: false` and never throws for the whole run. Task 3 pins it.
3. **Circle failing to answer the watch's read.** The watch tells with `circleAsked: false`, rather than skipping forever or failing the run. Task 3 pins it.
4. **A batch.** Each intent in a batch is its own payment, and is told on its own. Task 3 includes a batch row.
5. **No deciding member with email notices on.** No email is sent, and the entry and the chats still carry the alert. Task 4 pins it.

---

### Task 1: Migration 0080 stamps when an attempt was sent

**Files:**
- Create: `supabase/migrations/0080_payment_submitted_at.sql`
- Test: `tests/payment-submitted-at-migration.test.ts` (PGlite, the `tests/payment-notices-migration.test.ts` shape)

```sql
-- When a payment's current attempt was sent (docs/superpowers/specs/2026-10-06-stuck-transfer-alert-design.md D2): a
-- trigger stamps it whenever a row becomes `submitting` — a first send, a retry after begin_payment_retry, or a claim
-- taken again — so no function is redefined. Rows in flight are backfilled. Idempotent.
alter table public.payment_intents add column if not exists submitted_at timestamptz;

update public.payment_intents
   set submitted_at = coalesce(executed_at, created_at)
 where submitted_at is null and status in ('submitting', 'pending');

create or replace function public.payment_intents_stamp_submitted()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'submitting' and (tg_op = 'INSERT' or old.status is distinct from 'submitting') then
    new.submitted_at := now();
  end if;
  return new;
end
$$;

drop trigger if exists payment_intents_submitted on public.payment_intents;
create trigger payment_intents_submitted
  before insert or update of status on public.payment_intents
  for each row execute function public.payment_intents_stamp_submitted();

create index if not exists payment_intents_in_flight on public.payment_intents (submitted_at)
  where status in ('submitting', 'pending') and provider_mode = 'live';

comment on column public.payment_intents.submitted_at is
  'When the current attempt was sent: stamped when the row becomes submitting (0080). The transfer watch reads it.';
```

- [ ] Step 1: write the test.
  - The column exists.
  - Insert a payment intent as `created`, update it to `submitting`, and `submitted_at` is set. Update it to `pending`, and the stamp does not change.
  - A row moved to `failed`, then put back to `created` (as `begin_payment_retry` does) and claimed again, gets a later stamp.
  - A row inserted as `submitting` is stamped.
  - Applying the migrations twice leaves one trigger.

  Run `npx vitest run tests/payment-submitted-at-migration.test.ts`. Expected: FAIL (no column).
- [ ] Step 2: write the migration.
- [ ] Step 3: run the test. Expected: PASS. Then `npm run verify`, and commit "Stamp when a payment's attempt was sent".

### Task 2: The profile names how long a transfer may take

**Files:** `src/lib/network.ts` (`stuckAfterMinutes: number`, 15 on both networks, with a doc comment citing D1), `tests/network.test.ts`.

- [ ] Step 1: add `stuckAfterMinutes: 15` to both whole-profile expectations. Run the test. Expected: FAIL.
- [ ] Step 2: add the field. Run the test. Expected: PASS. Then `npm run verify`, and commit "Name in each network's profile how long a transfer may take before a person is told".

### Task 3: The transfer watch finds a stuck payment and signs it once

**Files:**
- Create: `src/lib/agent/transfer-watch.ts`
- Test: `tests/transfer-watch.test.ts` (`fakeSupabase`, the `tests/fx-watch.test.ts` shape)

**Interfaces:**
- Produces:
  - `watchStuckTransfers(deps?: { now?: () => number; provider?: () => ChainProvider }): Promise<TransferWatchResult[]>`, one result per workspace with a payment told or examined.
  - `interface TransferWatchResult { slug: string; inFlight: number; told: number; error?: string }`.
  - `stuckLedgerDetail(...)`, the entry's detail, exported for Task 4's email.
- Behaviour:
  1. Read the live payment intents still in flight, through `platformDb()`: `status in (submitting, pending)`, `provider_mode = live`, and `submitted_at` before now − 15 minutes, the smallest `stuckAfterMinutes` of the profiles.
  2. Group them by `org_id`, then read each workspace's `slug` from `orgs`.
  3. Inside `withOrg(org)`, for each intent:
     - skip it while it is younger than its own network's `stuckAfterMinutes` (from the intent's `network`);
     - skip it if a `payment_stuck` entry with `detail->>idempotencyKey` equal to its key exists;
     - otherwise ask Circle: `getChainProvider().reconcileTransfer(provider_tx_id)` when there is a transaction id. A thrown provider or a thrown read means `circleAsked: false`.
  4. A `confirmed` or `failed` answer is not told (D10).
  5. Otherwise append the entry:
     - `actor: "agent"`, `action: "payment_stuck"`, and domain `ap` for an invoice or `contractor` for a milestone;
     - summary: "Payment of {amount} {currency} to {name} not confirmed {minutes} min after it was sent on {network label}";
     - detail: D5's fields.

     Names come from `invoices` (`counterparty_name`) or `milestones` with their contractor.
  6. One workspace's failure is its own (`console.error`, and `error` in its result). The run goes on.
- Never: a status write to `payment_intents`, `invoices` or `milestones`.

- [ ] Step 1: write the tests. Expected: FAIL (module missing).
  - It tells a pending live intent sent 20 minutes ago with Circle answering `STUCK`. Pin the entry's action, domain, summary and detail, and that there is exactly one append.
  - It does not tell one sent 10 minutes ago.
  - It does not tell a `simulate` one: not even read, because the query filters on live.
  - It does not tell one already told: the ledger read returns an entry with the same key.
  - It does not tell one Circle answers `COMPLETE`.
  - It tells a `submitting` one with no transaction id, as never answered, with `circleAsked: false` and no Circle call.
  - It tells with `circleAsked: false` when the provider throws `MAINNET_NOT_CONNECTED`, and when `reconcileTransfer` rejects.
  - It tells a milestone intent under domain `contractor`.
  - Two workspaces: one failing to read its names still lets the other be told.
  - A retried intent (attempt 2, a new key, a fresh `submitted_at`) is told even though attempt 1 was.
  - It writes nothing to `payment_intents`, `invoices` or `milestones`: no PATCH or POST to those paths in the recorded requests.
- [ ] Step 2: implement.
- [ ] Step 3: run the tests. Expected: PASS. Then `npm run verify`, and commit "Watch for a live payment that has not confirmed, and sign it once".

### Task 4: Telling people, and the trail telling a reconcile as it found

**Files:**
- Modify: `src/lib/agent-activity.ts`
  - `payment_stuck` joins `ACTIVITY_ACTIONS`.
  - An invoice's item says "Payment of {amount} to {name} has not confirmed {minutes} min after it was sent; {network} has not confirmed it." with tone `stopped`, path `/invoices#trail-{id}` and label "How it decided".
  - A milestone's item says the same with path `/contractors`.
  - The milestone branch routes `payment_stuck` with a `milestoneId`.
- Modify: `src/lib/decision-trail.ts`
  - `ap_reconcile` by `execution.resultingStatus`, as D8 words it.
  - `payment_stuck` as "Not confirmed {minutes} minutes after it was sent; the workspace's people were told.", with tone `stopped`.
- Create: `src/lib/email/payment-stuck.ts`, giving `paymentStuckEmail({ orgName, payeeName, amount, currency, minutes, network, circle, txUrl, workspaceUrl, origin })`. `circle` is `{ asked: true, state }` or `{ asked: false }` or `{ answered: false }`. The text follows D7.
- Modify: `src/lib/notifications/waiting.ts`, which exports `decidingRecipients`.
- Modify: `src/lib/agent/transfer-watch.ts`. After a workspace's entries are appended, it emails each deciding recipient, one message each, up to 25. A failed send is logged, and the watch goes on.
- Tests:
  - `tests/agent-activity.test.ts`: the item, for an invoice and a milestone, on each network.
  - `tests/decision-trail.test.tsx`: a reconcile still pending, or held, is not "confirmed", and the stuck step.
  - `tests/payment-stuck-email.test.ts`: the subject, the text, `STUCK` advice, never-answered, not-asked, and HTML escaping.
  - `tests/transfer-watch.test.ts`: the email reaches the deciding recipients only, with none sent when there are none.
  - `tests/slack-blocks.test.ts` and `tests/telegram-messages.test.ts`: a `payment_stuck` item renders, with its link.

- [ ] Step 1: write the tests. Expected: FAIL.
- [ ] Step 2: implement.
- [ ] Step 3: run the tests. Expected: PASS. Then `npm run verify`, and commit "Tell the workspace's people about a payment that has not confirmed, and tell a reconcile as it found".

### Task 5: The route and its workflow

**Files:**
- Create: `src/app/api/agent/transfer-watch/route.ts`, the fx-watch route's shape: the agent's bearer, `takeTransferWatchToken`, `maxDuration = 300`, and a 500 with no detail on failure.
- Modify: `src/lib/rate-limit.ts`, adding `takeTransferWatchToken`, the FX watch's budget.
- Create: `.github/workflows/transfer-watch.yml`, the fx-watch workflow with `cron: "*/5 * * * *"`, `concurrency: transfer-watch` and `cancel-in-progress: false`.
- Test: `tests/transfer-watch-route.test.ts`, the `tests/fx-watch-route.test.ts` shape.
  - It answers 401 without the bearer, and 429 past the budget.
  - It answers 200 with the results.
  - It answers 500 with only "The transfer watch failed." when the watch throws.
  - The workflow file calls the route with the bearer and has the concurrency group.

- [ ] Step 1: write the tests. Expected: FAIL.
- [ ] Step 2: implement.
- [ ] Step 3: run the tests. Expected: PASS. Then `npm run verify`, and commit "Run the transfer watch every 5 minutes".

### Task 6: Docs

**Files:**
- `content/docs/guides/first-payment.mdx`: a section, "When a payment does not confirm", covering what is told, to whom, when, and what to do.
- `content/docs/changelog.mdx`: a dated entry for the new `payment_stuck` ledger action, its detail, and that webhooks carry it.
- `ARCHITECTURE.md`: the transfer watch, beside the FX watch.
- `README.md`: the workflows list, wherever it names the FX watch.
- `tests/docs-guides.test.ts`, if the guide's quotes are held to the source.

- [ ] Step 1: write the docs, with the guide quoting the email's subject and the activity item's text. Add any quote entries to the docs test.
- [ ] Step 2: `npm run verify` and `npx next build`, then commit "Document the alert for a payment that has not confirmed".
