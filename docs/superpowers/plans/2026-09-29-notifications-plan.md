# Notifications — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After each scheduled cycle, the members who can decide payments get one digest email listing the payables that newly need them. Each member can switch it off.

**Architecture:**
- **Data:** migration `0026` adds `memberships.notify_email` and `invoices.notified_at`.
- **Email:** `src/lib/email/waiting-digest.ts` builds the email.
- **Sending:** `src/lib/notifications/waiting.ts` picks the invoices, the recipients, sends, marks, and records the ledger entry. It never throws.
- **The cron:** calls it after each live workspace's cycle.
- **The Members page:** a switch for the viewer's own membership.

**Tech Stack:** Next.js 16.3.6, supabase-js, Postgres (Supabase), PGlite, Vitest, Resend via `src/lib/email/send.ts`, the component system in `src/components/ui/`.

**Spec:** `docs/superpowers/specs/2026-09-29-notifications-design.md`. Decisions N1–N8 are binding.

## Global Constraints

- **Next.js.** Read the relevant guide in `node_modules/next/dist/docs/` before writing Next code (`AGENTS.md`). Every page calls `requireMembership` itself.
- **No new dependencies.** `npm run verify` is green at every commit.
- **Migrations are idempotent.** `scripts/migrate.ts` replays every file from `0001` each run.
- **Data access.**
  - Tenant data goes through `db()`.
  - Platform tables (`orgs`, `memberships`, `invitations`) and functions go through `platformDb()`.
  - ESLint forbids the raw client outside `src/lib/dal`.
- **Server actions** live in `src/app/actions/`. Each first awaits `authorize(slug, "<literal>")`, and works in `return inOrg(auth, async () => …)`.
- **Who gets notified.** The approving roles are owner, admin and approver (`approval.decide`). At most 25 recipients per digest. At most 10 invoices listed, then "and N more". The reason is at most 140 characters.
- **Email.**
  - It is sent through `sendEmail` from `no-reply@vestiarion.xyz`.
  - Every interpolated value is HTML-escaped.
  - It contains no addresses, wallets or emails of counterparties.
- **Ledger entries** record ids and counts, never email addresses.
- **UI.** Use the primitives in `src/components/ui/`. Outside that folder there are no raw `<button>`, `<select>`, `<textarea>` or visible `<input>` elements, and no colour literals.
- **Safety.**
  - Never print secrets.
  - Never read `.env.local`.
  - Never run anything against production (no `db:migrate`, no dev server).
  - SQL is tested on PGlite only.
- **Commits.** Neutral subjects. Then a blank line, then your harness's Co-Authored-By trailer, committed with `git commit -F <file>`.

## Review Focus

1. **Two scheduled cycles in a row with nothing new.** Expected: no second email. Pinned by Task 3 (`notified_at`).
2. **An escalated invoice.** Expected: it is included again once, then not again until the next escalation. Pinned by Task 3.
3. **Resend down for one recipient.** Expected: the others are still emailed, the invoices are marked, and the ledger counts the failure. Pinned by Task 3.
4. **A counterparty name containing HTML.** Expected: it renders as text. Pinned by Task 2.
5. **A member turning the switch off for someone else by a crafted POST.** Expected: impossible; the action writes only the viewer's own row. Pinned by Task 4.

---

### Task 1: Migration 0026

**Files:**
- Create: `supabase/migrations/0026_notifications.sql`
- Test: `tests/notifications-migration.test.ts`

The migration:

```sql
-- Notifications (docs/superpowers/specs/2026-09-29-notifications-design.md, N4, N6).
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

-- N6: each member decides whether the digest reaches them. On by default.
alter table public.memberships
  add column if not exists notify_email boolean not null default true;

-- N4: when the members who can decide an invoice were last told it waits.
-- An escalation after this (escalated_at > notified_at) makes it news again.
alter table public.invoices
  add column if not exists notified_at timestamptz;
```

- [ ] **Step 1: tests (PGlite; see `tests/control-migration.test.ts` for the pattern).**
  - an existing membership reads `notify_email = true` after the migration;
  - an insert without it defaults to true, and it cannot be set to null;
  - `invoices.notified_at` is nullable with no default;
  - the tenant role can update `notified_at` on its own invoice, and cannot on another org's (RLS);
  - replaying every migration twice succeeds.
- [ ] **Step 2:** run the tests and see them fail. **Step 3:** write the migration. **Step 4:** see the tests pass, then run `npm run verify`.
- [ ] **Step 5: Commit** `feat(db): a notification switch per member, and when an invoice was last announced`.

---

### Task 2: The digest email

**Files:**
- Create: `src/lib/email/waiting-digest.ts`
- Test: `tests/waiting-digest.test.ts`

**Interfaces (produces):**

```ts
export interface DigestItem {
  counterpartyName: string;
  amount: number;
  status: "held" | "flagged" | "awaiting_info";
  reason: string | null;
  escalated: boolean;
}
export const DIGEST_MAX_ITEMS = 10;
export const DIGEST_REASON_MAX = 140;
export function firstSentence(text: string | null, max?: number): string | null;
export function waitingDigestEmail(input: {
  orgName: string;
  items: DigestItem[];      // every item to announce; the email lists the first 10
  link: string;             // `${origin}/o/${slug}/approvals`
  origin: string;           // for the logo, like invitationEmail
}): { subject: string; html: string; text: string };
```

**Behaviour:**
- **The subject** is `` `${n} payment${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} a decision in ${orgName}` ``.
- **The body** has one line per item, for at most 10 items. Each line gives:
  - the counterparty;
  - the amount in USDC;
  - a status label: `Held`, `Flagged` or `Waiting for information`;
  - "(reminder)" when the item is escalated;
  - the reason.
- **Beyond 10 items:** the list ends with "and N more".
- **The reason** is the first sentence of the agent's reasoning, trimmed to at most 140 characters with an ellipsis. Anything in square brackets, such as the guardrail notes, is dropped before cutting.
- **The button and the link** point to the inbox.
- **The footer:** "You get this because you can approve payments in <org>. You can turn these emails off on the Members page."
- **Look and escaping** follow `src/lib/email/invitation.ts`: its HTML look and its `escapeHtml`. Reuse the escaping by exporting it, or by moving it into a shared helper; do not copy it.

- [ ] **Steps.** Write the tests first:
  - singular and plural subjects;
  - 12 items give 10 lines plus "and 2 more";
  - a name containing `<img src=x>` is escaped in the HTML;
  - the text part carries the same content;
  - the reason is cut at 140 characters and drops the bracket notes;
  - "(reminder)" appears for an escalated item.

  Then implement, run `npm run verify`, and commit `feat(email): a digest of the payments waiting for a decision`.

---

### Task 3: Sending the digest after a scheduled cycle

**Files:**
- Create: `src/lib/notifications/waiting.ts`
- Modify: `src/lib/agent/cron.ts` (or the tick route's run function, whichever is cleaner): notify after each cycle that ran.
- Test: `tests/notifications.test.ts`, and extend `tests/cron.test.ts`.

**Interfaces (produces):**

```ts
export interface WaitingInvoice {
  id: string; counterpartyName: string; amount: number;
  status: "held" | "flagged" | "awaiting_info"; reasoning: string | null;
  escalated: boolean;       // escalated_at > notified_at
}
export const DIGEST_MAX_RECIPIENTS = 25;
export async function waitingToNotify(): Promise<WaitingInvoice[]>;               // in scope
export async function markNotified(ids: string[], at?: Date): Promise<void>;      // in scope
export async function notifyWaitingDecisions(): Promise<{ sent: number; failed: number; invoices: number }>; // in scope; never throws
```

**Behaviour:**
- **`waitingToNotify`** reads through `db().from("invoices")`:
  - the columns: `id, amount, status, agent_reasoning, notified_at, escalated_at, counterparties(name)`;
  - filtered to direction `payable` and status in `held`, `flagged`, `awaiting_info`;
  - ordered by `due_date`.

  It keeps the rows where `notified_at` is null, or where `escalated_at` is set and later than `notified_at`. Filter in code if the PostgREST `or` filter is awkward, and say which you chose. `escalated` is true only for the second case.
- **`notifyWaitingDecisions`:**
  1. **Invoices:** load them. If there are none, return `{ sent: 0, failed: 0, invoices: 0 }`.
  2. **Email configured?** If `emailSettingsFromEnv()` is null, log `notifications: email not configured` with the org id, and return with nothing marked.
  3. **The workspace:** load its `orgs` row (`name`, `slug`) through `platformDb()`, using `currentOrgId()`.
  4. **Recipients:**
     - `listMembers(orgId)` from `src/lib/platform/members.ts`, which gives ids, emails and roles;
     - joined with `platformDb().from("memberships").select("user_id, notify_email").eq("org_id", orgId)`;
     - kept only for roles owner, admin and approver with `notify_email` true;
     - sorted by role (owner, then admin, then approver), then by email;
     - capped at 25, logging the count skipped.
  5. **Send:** build one email with `waitingDigestEmail`, where `link` is `${siteOrigin()}/o/${slug}/approvals`. Send it to each recipient separately with `sendEmail`, and count `sent` and `failed`.
  6. **Mark and record:** if `sent > 0`, call `markNotified(ids)`. Then append a best-effort ledger entry:
     - action `notification_sent`, actor `system`, domain `system`;
     - summary `` `Told ${sent} member(s) that ${n} payment(s) need a decision` ``;
     - detail `{ invoiceIds, escalatedIds, recipients: sent, failed }`.

     Follow the best-effort pattern of `recordLedgerEntry` in the members library.
  7. **Never throws:** wrap everything, log with the org id, and return the counts.
- **The cron:** in the per-organization run, after the cycle resolves successfully, call `notifyWaitingDecisions()` in the same scope. A skipped (paused) or failed workspace is not notified. The notification result does not change the tick's per-organization `ok`.
  - The tick route passes `() => runAgentCycle()` to `runLiveOrganizations`. Put the notify call where both stay simple, for example a `runScheduledCycle()` in `src/lib/agent/cron.ts` that runs the cycle, then notifies, and returns the cycle result.

- [ ] **Steps.** Write the tests first, using the recorded fake as `tests/approvals.test.ts` and `tests/members.test.ts` do, and mocking `@/lib/email/send`. Cover:
  - `waitingToNotify` selection: new, already notified, escalated-after, and an escalation older than the notification;
  - recipients filtered by role and switch;
  - one message per recipient;
  - marked only after at least one success;
  - nothing marked when email is not configured or every send fails;
  - the ledger detail holds ids and counts only, with no `@`;
  - never throws, even when the invoice read fails;
  - the cron: notify runs after a successful cycle, does not run for a paused or failed one, and a throwing notify does not fail the workspace.

  Then implement, run `npm run verify`, and commit `feat(notifications): members who can decide are emailed when payments wait for them`.

---

### Task 4: The switch, and the docs

**Files:**
- Create or modify: `src/app/actions/members.ts` gets `setNotifyEmailAction`, or a new `src/app/actions/notifications.ts`.
- Modify: the members page and its panel (`src/app/o/[slug]/members/page.tsx`, `src/components/MembersPanel.tsx`) to show the switch on the viewer's own row, or as a line above the table.
- Modify: `README.md`, `ARCHITECTURE.md`, `.env.example` (note that the digest needs `RESEND_API_KEY`).
- Test: `tests/notifications-actions.test.ts`, plus the page source checks that exist for the members page.

**Behaviour:**
- **The action:** `setNotifyEmailAction(previous, formData)` with fields `orgSlug` and `on` (`"true"` or `"false"`).
  - It first awaits `authorize(slug, "workspace.read")`.
  - Inside `inOrg`, it runs `platformDb().from("memberships").update({ notify_email: on }).eq("org_id", auth.membership.orgId).eq("user_id", auth.user.id)`. It never takes a user id from the form.
  - It returns "Emails on." or "Emails off.", and revalidates.
- **The page:** it reads the viewer's own `notify_email` through `platformDb()`.
  - Show the switch only to roles that can decide. For a viewer, show nothing, because they receive nothing.
  - Use the Checkbox, or a switch primitive if one exists, from `src/components/ui/`, with the label "Email me when payments need a decision".
- **The docs** describe only what is built:
  - who gets the digest, when, and what it contains;
  - the switch;
  - the `notification_sent` ledger action;
  - that it needs `RESEND_API_KEY`.

- [ ] **Steps.** Write the tests first:
  - the action updates only the viewer's row: the request filters on the session's user id, and a `userId` field in the form is ignored;
  - invalid `on` values are refused;
  - authorize refusal passes through.

  Then implement, run `npm run verify` and `npm run build`, and commit `feat(notifications): each member can turn the digest off`, plus `docs: notifications`.

---

## Rollout (controller)

1. Apply `0026` before the merge (`npm run db:migrate`). It is additive. Probe:
   - the columns;
   - the founding owner's `notify_email` is true.
2. Merge when CI is green. Founding has payables waiting, so the next scheduled cycle, or a `workflow_dispatch`, should send one digest to founding's approving members:
   - check the Resend log (the partner);
   - check `notification_sent` in the ledger, with ids only;
   - check `notified_at` is set;
   - check that a second dispatch sends nothing.
3. Record the outcome in the spec.
