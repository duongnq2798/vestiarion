# Notifications: telling people when a payment needs them

Tier 2 of the "demo to usable product" work has three parts: notification email, scoped API keys and signed webhooks. This spec covers the first. It was decided on 2026-09-29 by the implementer under the partner's standing instruction to decide and proceed, and each decision states its reason.

## 1. The problem

The agent now stops on the right payables. The approval inbox (the control spec, `2026-09-29-control-design.md`) lets a person decide them. But nobody is told:
- The cron runs every live workspace every six hours, unattended.
- When the agent holds a payment over a limit, flags a counterparty or asks for a purchase order, the only trace is the inbox and a ledger entry.
- The follow-up stage "escalates" an invoice that sat unanswered (`invoice_escalated`), but that escalation, too, is only a ledger entry.

A held bill stays held until someone happens to open the console.

## 2. What this builds

1. **One digest email per workspace per scheduled cycle**, when payables are waiting for a person that they have not yet been told about. It goes to every member who can decide them (`approval.decide`: owner, admin, approver) and has not turned the email off.
2. **An escalation is news again.** An invoice the follow-up stage escalated since the last email is included again.
3. **A per-member switch**, "Email me when payments need a decision", on the Members page, for the viewer's own membership. It is on by default.
4. **A ledger entry** for each digest sent: `notification_sent`, with ids and counts only.

Out of scope for now, recorded in §8: notifying about the pause, failed cycles or members; a digest for console-run cycles; other channels; per-invoice emails.

## 3. Decisions

- **N1. Only scheduled cycles notify.** A cycle started from the console has a person watching it, and a sandbox's cycles only ever start there. An email would tell them what the screen just showed. The cron runs `live` workspaces only, so in practice notifications serve the unattended live treasury. That is where they matter.
- **N2. Notifying runs after the cycle, outside it.**
  - The cron's per-workspace run calls the cycle, then `notifyWaitingDecisions()` in the same workspace scope.
  - A failure to notify is logged and never fails the cycle or the tick.
  - The cycle's money path does not change.
- **N3. A digest, not an email per invoice.** One scheduled cycle produces at most one email per recipient per workspace. It lists up to 10 invoices, then "and N more", and links to the inbox.
- **N4. `invoices.notified_at` records who has been told what.** An invoice is included when it is waiting (`held`, `flagged` or `awaiting_info`) and either:
  - `notified_at` is null; or
  - `escalated_at > notified_at`: the follow-up stage escalated it since the last email.

  After at least one recipient's send succeeds, the included invoices get `notified_at = now()`. If every send fails, or email is not configured, nothing is marked, and the next scheduled cycle tries again.
- **N5. Each recipient gets their own message.** Addresses are never shared between recipients. A workspace sends to at most 25 recipients per digest; members beyond that are logged, not emailed.
- **N6. The switch is the member's own.**
  - It is stored as `memberships.notify_email boolean not null default true`.
  - Only the member changes it, through an action gated by `workspace.read` that updates the viewer's own row and no one else's.
  - A viewer can hold the switch but receives nothing, because viewers cannot decide.
- **N7. What an email may contain.** Only what every recipient can already see in the workspace:
  - the workspace name;
  - the counterparty's name;
  - the amount;
  - the status;
  - the first sentence of the agent's reasoning, at most 140 characters.

  No counterparty address, wallet or email. Every value is HTML-escaped. The sender is `no-reply@vestiarion.xyz`, through the existing `sendEmail` (Resend). Without `RESEND_API_KEY` no digest is sent, and nothing is marked.
- **N8. The ledger records that people were told**, not whom:
  - action `notification_sent`, actor `system`, domain `system`;
  - detail `{ invoiceIds, escalatedIds, recipients: <count>, failed: <count> }`.

## 4. Data

Migration `0026_notifications.sql`, idempotent:
- `memberships.notify_email boolean not null default true`;
- `invoices.notified_at timestamptz`.

No new functions: the platform code reads and writes `memberships` through the service role, and the tenant role writes `invoices.notified_at` under RLS, as it writes the invoice's other columns.

## 5. Components

- **`src/lib/notifications/waiting.ts`:**
  - `waitingToNotify()` returns the invoices to include;
  - `markNotified(ids)`;
  - `notifyWaitingDecisions()` for the workspace in scope.

  The last one:
  1. loads the invoices;
  2. returns if there are none;
  3. loads the recipients (`org_members`, filtered to the approving roles, joined with `notify_email`);
  4. sends;
  5. marks;
  6. records the ledger entry.

  It returns `{ sent, failed, invoices }` and never throws; every failure is logged with the workspace id.
- **`src/lib/email/waiting-digest.ts`:** `waitingDigestEmail({ orgName, items, more, link, origin })` returns `{ subject, html, text }`.
  - The subject is `"<n> payment(s) need a decision in <workspace>"`, pluralised.
  - It is escaped like `invitationEmail`.
  - The footer says why the recipient gets it, and where to turn it off.
- **The cron.** `src/lib/agent/cron.ts` or the tick route calls the cycle, then `notifyWaitingDecisions()`, for each live workspace that was not skipped.
- **The Members page.** A switch on the viewer's own row, backed by `setNotifyEmailAction`. It uses the component system's primitives. The members page was just migrated onto them, so keep the change small.

## 6. Error handling

| Situation | Result |
|---|---|
| `RESEND_API_KEY` not set | Nothing sent, nothing marked; one log line per workspace per cycle |
| A recipient's send fails | Others still sent; the invoices are marked if at least one succeeded; `failed` is counted in the ledger |
| Every send fails | Nothing marked; the next scheduled cycle retries |
| Loading or marking fails | Logged; the tick still answers for the cycle; the next cycle retries |
| More than 25 recipients | The first 25 by role then address get the email; the rest are logged as skipped |

## 7. Testing

- **The migration,** on PGlite: both columns, their defaults, and replay.
- **`waitingToNotify`** (recorded fake):
  - a new waiting invoice is included;
  - one notified earlier is not;
  - one escalated after its notification is included again;
  - a paid or rejected invoice never is.
- **`notifyWaitingDecisions`:**
  - recipients filtered by role and switch;
  - one message per recipient;
  - marked only after a success;
  - nothing marked when every send fails or email is not configured;
  - the ledger detail holds ids and counts only;
  - it never throws.
- **`waitingDigestEmail`:** pluralisation, the 10-item cap with "and N more", escaping, and the 140-character reason.
- **The cron:** a skipped (paused) workspace is not notified, and a failing notification does not fail the workspace's result.
- **The switch action:** it changes only the viewer's row, and permissions are checked.

## 8. Out of scope, for later

- **Other events:** notifying members about the pause and resume, a failed cycle, or membership changes.
- **Other channels:** Slack or webhook delivery, which is the webhooks part of Tier 2.
- **Per-workspace schedules** for digests, and quiet hours.
