# Collections that follow the customer's context

Date: 2026-10-13. Status: built (F12, with I11). Branch `feat/collections-context`. Migration 0110.

## Why

The agent reminded a customer by the due date alone (2026-10-03-collections-design.md). That annoys a customer who is
disputing the invoice, who says it paid already, or whom sales gave more time; and it reminds a customer who promised a
day and missed it, when finance should look first. The context was all in Vestiarion already (what the customer said on
its statement, payments applied, the HubSpot deal it was sold through, the reminders sent); nothing weighed it.

## The rules (decided here)

- **C1. One proposal per receivable.** `proposeNextAction` (`src/lib/collection-context/model.ts`, pure) gives each open
  receivable one next step: nothing (paid, or nothing owed), wait, ask the account owner, remind (with a tone), or
  escalate to finance, with the facts it rests on, each a sentence. The page shows it; the collections stage acts on it.
  Both read it from the same function, so the page shows what the agent will do.
- **C2. What holds every reminder.** An open dispute (until a person resolves it), an open claim of payment ("I paid",
  until a person finds the payment or marks it not received), an open promise through its day, and a hold a person
  chose. In that order: a dispute outranks a claim, a claim a promise. This changes customer portal P7: a claim of
  payment now holds the reminders. A claim waits through the 7 days after the day it was made (`CLAIM_REVIEW_DAYS`);
  still open after them, it escalates to a finance review task (`claim_unverified`), so a customer cannot silence
  reminders for good by saying it paid. Resolving that task marks the claim not received (the customer's statement
  says so) and lets reminders go again or holds them until a day; a payment that did arrive is applied instead, and the
  task closes as no longer needed.
- **C3. A broken promise goes to finance.** A promise whose day passed with money still owed never brings an automatic
  reminder: it opens a finance review task. Resolving it closes the promise (customer portal's own close, signed
  `customer_request_closed`) and either lets reminders go again or holds them until a day.
- **C4. A customer's rules, versioned.** `collection_policies`: whether reminders go on their own or ask first (for a
  VIP), the strongest tone (friendly only, up to firm, any), the fewest days between two reminders (3 to 30; code's 3
  stays the floor), the channel (email, the only one), and the account owner asked first (an owner or admin; none means
  the owners and admins). Each save is a new version, the last plus one, over the version the person saw (a newer one
  saved since is refused as changed); a version never changes. Saving confirms the tone and channel for that customer.
  Without rules a customer follows the workspace's schedule, as before. `collection_policy_set` is signed.
- **C5. A HubSpot deal's owner.** A receivable released from a deal planned from a HubSpot deal that has an owner there
  (`hubspot_owner_id`, read with the deal, no new scope) asks before its first overdue reminder whether sales gave more
  time: once per receivable. The owner's name needs HubSpot's owners scope, which the app does not ask for: the card
  links to the deal in HubSpot instead.
- **C6. Tasks, once each.** When a proposal needs a person, the stage opens a `collection_tasks` row, unique per
  receivable and subject (`policy:<version>:reminder:<n>`, `hubspot:<deal>`, `promise:<request>`, `claim:<request>`,
  `no_contact`, `reminders_done`), keeping the proposal it was opened for, signed `collection_task_opened`. A person resolves it once:
  approve the drafted reminder at a tone it offered, hold reminders until a day (up to 60 days), no reminders (turns the
  invoice's reminders off, `ar_reminders_off`), let reminders go again, or done; signed `collection_task_resolved`. An
  approval or reminders let go start a cycle (`reminder_approved`). The stage closes a task no longer needed as
  obsolete. A stage only opens tasks where they act: ask first and the HubSpot ask only while reminders are on, no
  contact only once due, reminders done only where the agent sent some, a broken promise always. Tasks open only from
  the day the stage first ran in the workspace (`collection_task_starts`): a need about a day before it (a promise's
  day, a claim's last day of waiting, the day reminders were done, a due day) opens none and emails nobody, the card
  saying so, and a HubSpot receivable already overdue then is reminded as before, without the ask. Each member gets at
  most one task email a cycle, the task waiting longest first; the rest wait for the next cycle.
- **C7. Nothing a customer or a CRM writes sends an email by itself.** Every reminder still goes through the stage: the
  receivable's reminders on (a person's), code's cadence and tone bounds, the customer's rules, and the fixed template.
  An approved reminder goes without the model, at the tone the person chose, under the version it was approved under.
  What a customer or HubSpot said can only hold reminders or ask a person.
- **C8. On the Receivables tab.** A **Collections** panel above From customers: receivables waiting on a person, reminders
  sent this week, promises kept and broken (of the last 90 days, a replaced promise not counted), and the receivables to
  look at first with the fact that decides each. A receivable's card shows its next step and why, the reminder it would
  send exactly as the customer reads it (subject, body, channel, the address mostly hidden), its open task with the
  ways to resolve it, the last resolution, and **Rules for** the customer. Members who are not owners or admins read
  it all and change nothing.
- **I11. Each email once.** Every email the stage sends (a reminder to a customer, a task's email to a member) has an
  idempotency key: the SHA-256 of what it is, the event (`reminder:<invoice>:<n>`, `task:<id>`) and the recipient's
  address hashed. The rules' version is recorded beside the key, never in it: a retry after the rules changed is the
  same email under the same key, never a second one. It is claimed in `notification_deliveries` before the send and
  given to Resend as its `Idempotency-Key`; a key sent already is never sent again (the reminder's own claim stays); a
  failed send releases the claim so the next cycle retries under the same key. Resend's 409
  `invalid_idempotent_request` (the key went with an email already, say after a send that timed out) is kept as sent. A
  claim a stopped run left unsent is taken over after 15 minutes, under the same key, while Resend keeps it (23 hours).
  Right before the send, the opt-out is read again: a receivable's reminders turned off, its link stopped or its
  customer's rules changed since the decision; a member's email switch turned off. Either stops the send and releases
  both claims. Each email is metered once, when it is handed to Resend.

## Data (0110)

- `collection_policies (id, org_id, counterparty_id, version, approval, max_tone, min_days_between, channel,
  account_owner, created_by, created_at)`; unique per customer and version; composite FK to the counterparty; triggers:
  a client only, the next version only, never changed (a person's account deleted sets null). Tenant: select, insert.
- `collection_tasks (id, org_id, invoice_id, counterparty_id, kind, reason, subject_key, assignee, policy_version,
  proposal, status, outcome, hold_until, approved_number, approved_tone, resolved_at, resolved_by, notified_at,
  created_at)`; unique per receivable and subject; composite FKs to the receivable and its customer; checks: an outcome
  with its fields; triggers: a receivable of the customer named, opened open, resolved once, `notified_at` set once.
  Tenant: select, insert, update of the resolution columns.
- `notification_deliveries (id, org_id, idempotency_key, kind, subject_id, recipient_hash, policy_version, claimed_at,
  sent_at, provider_id)`; unique per key; a trigger keeps a sent row (only its workspace's deletion removes it). Tenant:
  select, insert, update of `sent_at` and `provider_id`, delete of an unsent claim.
- `collection_task_starts (org_id, starts_on, created_at)`; one row per workspace, set once by the stage's first run.
  Tenant: select, insert.
- `invoices_open_receivables_idx` on `invoices (org_id, due_date)` for open receivables: the stage reads up to 500 a
  cycle by due day, and their context 100 at a time.
- `crm_deals.owner_external_id`. Written apart from the deal's facts, so HubSpot sync keeps working before 0110 runs.
- RLS on, permissive and restrictive tenant policies, no grants to anon or authenticated, trigger functions with an empty
  `search_path` and no browser role's execute.

## Before 0110 runs

Rules read as none (every customer follows the workspace's schedule), tasks as none, deliveries are not recorded (each
email goes as before, with its key still sent to Resend), the HubSpot owner is left out, and the card says rules are not
set up. A dispute, a claim and a promise hold reminders as soon as 0109 is there.

## Screens

`/docs-shots/collections/<state>` (`panel`, `vip`, `rules`, `hubspot`, `promise`, `remind`), behind
`DOCS_SCREENSHOTS=1`, built by the page's own `buildCollections` and components over sample data
(`src/app/docs-shots/collections-fixture.ts`), photographed into `collections-context-shots/` at 1440 and 390 px.

## Situations tested

`tests/collections-context.test.ts`: overdue, VIP (ask first, approved, rules changed after the approval), dispute open,
dispute resolved, promise active, promise expired, part paid, paid, "I paid" claim pending and a week old, needs from
before tasks began, stale (no billing email, with
and without an account owner), HubSpot deal with an owner (asked, held, after the hold), tone cap and spacing, reminders
done, reminders off, not due yet, precedence. `tests/collections-stage.test.ts`: the stage end to end against a recorded
database, I11 included. `tests/collections-context-migration.test.ts`: 0110 on PGlite.

## Not in this change

- Channels other than email (the column takes only `email`).
- The HubSpot owner's name and email (needs `crm.objects.owners.read`); writing a task back to HubSpot.
- A HubSpot deal read before 0110 gets its owner when it next changes in HubSpot.
- Tasks in a sandbox: the stage is live-only, as before; the card still shows each proposal.
