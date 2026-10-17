# The agent's weekly brief

Date: 2026-10-18. Status: building.

## Problem

People who open a workspace activate in minutes and then do not come back: no repeat payments, no second member
(activation funnel, Oct 9). The agent keeps working, but an owner who does not open the console only hears from it when a
payment waits for them. They never see what it did for them last week, or what is coming. A short weekly email that says
both, with the numbers, gives them a reason to look, and tells them when they need to act before the week starts.

## Design

**W1. When.** The first scheduled cycle on a Monday (UTC) sends the week's brief, once per workspace per ISO week: the
ledger's `weekly_brief_sent` with `week` (`2026-W43`) says it went. Scheduled cycles run for live workspaces only. Not in
shadow mode, where the business pays its bills in its own money (out of scope for now).

**W2. To whom.** The digest's recipients: owners, admins and approvers with "Email me when payments need a decision" on
(`decidingRecipients`), at most 25. A line under the switch says it now covers the weekly summary too.

**W3. What, all worked out by code.**
- *Last 7 days*: payments confirmed (count and USDC, from `payment_intents`), what customers paid (count and USDC, from
  `ar_received`), and the agent's decisions (count of its `ap_*` and `milestone_*` entries).
- *Waiting for you now*: payables held, flagged or waiting for information.
- *Next 7 days*: the bills leaving, from the console's cash outlook (`cashOutlook`, open rows only, as the cash alert reads
  them), the first five by day with payee and amount, the total, and the customer money expected.
- *Cash*: covered for the next 30 days, or "runs short on Oct 23 by 147.98 USDC", from `cashShortOf`.
- Links to the console, Approvals and the payment plan.

**W4. Send it now.** In Settings, under Notifications, a member who decides payments can press "Send me this week's
summary" and get the brief at once, to their own address only. It is signed `weekly_brief_sent` with `preview: true`,
which does not count as the week's brief.

**W5. Never in the way.** The send never throws: a failure is logged, and the cycle's result stands. The week is
claimed (`weekly_brief_sent`) just before the emails go, so a cycle that starts while they go sends nothing again; when
no email went, `weekly_brief_failed` lets the claim go, and the next scheduled cycle that Monday tries again (review of
the brief).

## Out of scope

- Shadow mode's own summary (verdicts given, agreement).
- Telegram and Slack: they already hear each decision as it happens.

## Tests

- `isoWeek` and `briefDue` (Monday only, once a week, a preview not counting).
- `weeklyBriefFacts` over fakes: payments, receipts, decisions, waiting, next 7 days, cash short and covered.
- The email: subject, figures, links, escaping, the short and covered lines.
- The sender: sends to each recipient and signs once; nothing on another day; nothing twice; nothing signed when every
  send failed; the preview to one member.
