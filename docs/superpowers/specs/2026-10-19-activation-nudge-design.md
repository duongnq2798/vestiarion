# A nudge when a workspace stops

Date: 2026-10-19. Status: built. Branch `feat/activation-nudge`. No migration.

## Why

Both self-serve customer workspaces still on the platform stopped before their first bill (activation funnel, Oct 9 and
Oct 19): opened, then left. Every workspace that reached a decision was set up on a call, with its first bill in
minutes. Shadow mode has a second place to stop: the agent decides the bills, and nobody says whether they agree, so no
agreement rate builds up. Nothing reaches these people once they close the tab. The waiting-decisions digest and the
weekly brief run only in the scheduled cycle, and that cycle visits only `live` workspaces. A new workspace is a sandbox.

## The rules (decided here)

- **A1. Two moments, one email each, ever.**
  - **First bill** (`first_bill`): a customer workspace opened at least 24 hours ago with no real bill (sample
    counterparties' bills do not count, as in `growth_workspaces`).
  - **First verdict** (`first_verdict`): a customer workspace in shadow mode whose agent first decided a real bill at
    least 72 hours ago, where nobody has given a verdict and at least one decision still waits for one.
  - Each moment goes once per workspace. Nothing is sent about a workspace opened more than 30 days ago.
- **A2. Who is a customer.** A workspace's side is the one `growth_workspaces` gives it: one opened by someone outside
  the platform team. Team workspaces never get it.
- **A3. Who is told.** The members who decide payments and keep the workspace's emails on (`decidingRecipients`: owners,
  admins, approvers), at most 5. A workspace with nobody to tell is skipped and tried again on the next tick.
- **A4. What it says.**
  - First bill: "Your agent has no bill to work on yet". It says the agent decides a bill within minutes (pay, schedule
    before its due date, or hold and say why, each decision signed). It names the three ways in: **New**, then **Bill to
    pay** on Bills; importing a bill list; forwarding bills to the workspace's own address (Settings, under Invoices by
    email). In shadow mode it adds that the business keeps paying as it does. In a sandbox that can load sample data and
    has none, it offers **Load sample data**. The button opens the console, where the checklist is.
  - First verdict: "{n} decisions wait for your verdict". It says how many decisions wait and since when, and why a
    verdict matters: the agreement rate is the record of how often the agent would have been right. The button opens
    Bills, where each decision has Agree and Disagree.
  - Both end with why the person gets it, that it is sent once, and where to turn emails off. No amount, address or
    wallet. The member email look (`actionEmailHtml`), no counterparty loop link.
- **A5. Where it runs.** A pass in the agent tick (every 6 hours) after the live workspaces' cycles and before the
  webhook dispatch. It reads `growth_workspaces` for the last 30 days once, picks the due moments in code, and enters
  each workspace's scope in turn. At most 20 workspaces a tick, and none started after 240 seconds into the tick.
  It runs when payments are switched off: it sends email only.
- **A6. Claimed before it is sent.** In the workspace's scope:
  - The moment is skipped when an `activation_nudge_sent` for it is signed, or after 3 `activation_nudge_failed` for it.
  - The facts are read again: a first verdict still needs a decision waiting.
  - `activation_nudge_sent` is signed (actor `system`, domain `system`, detail `stage`, `recipients`, and `days` or
    `waiting`) before the emails go. A claim that cannot be signed sends nothing.
  - Each email carries an idempotency key of the workspace, moment and member, so two ticks at once cannot send it twice.
  - When no email went, `activation_nudge_failed` (detail `stage`, `failed`) lets the claim go, and a later tick tries again.
  - It never throws: one workspace's failure is logged and the rest go on.
- **A7. Measured.** `/admin/growth` gets a tile **Nudged to finish setup**: customer workspaces in the window that got
  either email, and how many came back. A workspace came back when it added a real bill after a first-bill email, or
  gave a verdict after a first-verdict email. It is read from each nudged workspace's ledger, only for customer
  workspaces in the window.
- **A8. Metered.** Each email is metered as `email` / `activation_nudge` ("Setup reminders" on Usage).

## What it does not do

- Send more than one email per moment, or any email to a workspace opened more than 30 days ago.
- Email anyone who turned the workspace's emails off, or any counterparty.
- Load sample data, add a bill or give a verdict for anyone. Each link opens a page; the person acts there.
- Show the forwarding address in the email: knowing it lets anyone file a draft, so the email points to Settings.

## Cost if wrong

- If a moment is chosen badly, one extra email reaches a real person once. The ledger shows which moment and when.
- If the pass is slow, the webhook dispatch after the tick gets less time. The 10-minute dispatch schedule picks up the
  rest, and the pass stops starting workspaces after 240 seconds.
