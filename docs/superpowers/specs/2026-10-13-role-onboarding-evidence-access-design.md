# Onboarding by role, and evidence links people can open

Two roadmap items in one change. **I01**: a founder or owner, an accountant and an approver each finish their first real
task without help, on a short path built for their role. **I24**: every place that opens evidence checks that the link
can be opened before it says "verified" or offers the link.

## Onboarding by role

**R1. The owner's checklist** is the console's Get started, extended: it opens with **Create the workspace** (done: the
console exists), then the first-bill path from the sandbox flow (**Add a supplier**, **Add or import a first bill**, **See
the agent's decision**), then **Set or confirm the limits**, before what paying on Arc needs (wallet, USDC, going live, the
first payment). A live workspace, or one with a wallet, keeps its order, with the limits before the first payment; shadow
mode asks for them after the first verdict. An admin follows the owner's checklist and sees an owner-only step as an
owner's ("View", "An owner of this workspace does this step"). The limits step is done once a person changed the agent's
spending limit or the two-approval figure (`agent_budget_changed`, `approval_policy_changed` with a human actor), or kept
them with **Keep these limits** (`agent.budget`), which records `limits_confirmed` for the workspace. Its body states the
figures in force.

**R2. The approver's checklist**, on the console and at the top of **Approvals**, where an approver lands: **Open
Approvals**, **Read why a bill is held** (its card says why), **Decide it, or send it back** (Approve and pay, Reject,
Return to agent, or a verdict). Opening Approvals records `approvals_opened`, and `held_reason_seen` when a bill waits
there. Deciding is read from the signed ledger (`approval_given`, `approval_paid`, `approval_rejected`,
`approval_returned`, `decision_verdict`, `milestone_approval_given`, `milestone_approval_paid`, `milestone_closed` with
`detail.by` the person), and ticks the two steps before it.

**R3. The accountant's checklist**, on the accountant console, where an accountant lands: **Open the accountant
console**, **Open one workspace's queue** (Only this one), **Book one payment or apply one receipt**, **Download the
month's hand-off**. Opening the console records `accountant_console_opened` in each workspace where the person is an
accountant, read and written in that workspace's scope as them; narrowing it records `accountant_queue_opened` there.
Booking is `accounting_payment_approved`, applying `ar_payment_applied` (a person's, never the agent's match), the
hand-off `handoff_exported`, each by the person. The booking step opens the bookings review where a payment waits for
this accountant, otherwise the Receivables tab. A step is done if it was done in any of their workspaces. A viewer has no
checklist.

**R4. Ticked because it happened; dismissed for good.** No step has a box to tick. Acts that leave no other row are
marks in `onboarding_marks` (migration 0114: one row per workspace, member and mark, select and insert only for the
tenant role, under the two tenant policies, cascading with the workspace and the account). A page that is opened never
writes while it renders: it ticks the visit's steps itself, and records their marks from the browser once it is shown,
through a Server Action that checks the session and the role again. **Don't show again** records
`dismissed_owner`, `dismissed_approver` or `dismissed_accountant`, only for the checklist the person's role sees, and it
never comes back. Before 0114 runs, every read answers "not set up" (42P01, PGRST205, 42703): the checklists show from
the other rows, without Don't show again or Keep these limits.

**R5. Never more than the role may do.** Every step names the permission it takes (`needs`, from `roles.ts` and the
command map). For an owner, an approver and an accountant, no step of any variant needs a permission the role lacks;
for an admin, a step only an owner may take is shown as the owner's and never offered. `tests/role-checklists.test.ts`
holds every variant to it.

**R6. An invited member lands on their first step.** Accepting an invitation (by link or from /onboarding) redirects an
approver to Approvals, an accountant to the accountant console, and anyone else to the console.

## Evidence links people can open

**E1. Checked before "verified".** The evidence chain's given links (a milestone's pull request, the comment a bounty
was attached with, the evidence a milestone was verified by hand with) and the Contractors cards' links are checked
before the page labels them. A link that can't be opened (deleted, a private repository the workspace's own GitHub
connection does not reach, access refused, an expired signed link) is shown as **Can't be opened** with the reason when it is known, is never offered as a link, and a fact
resting on it is never counted as verified (it reads **Could not open**). A link the check did not reach, or not on the
allow-list, is not verified either. Bills' documents and deal costs' documents are never kept (a bill keeps its
document's SHA-256 only, a cost only whether it has one), and a payee receipt's link is never stored: nothing there can
be opened, so nothing there is offered.

**E2. The allow-list, and no SSRF.** Server-side checks go only to services Vestiarion already works with: GitHub's API
for a pull request or a comment on github.com, at an address built from the link's checked parts (never the link
itself), and the workspace's own Supabase storage for a signed link to it. Refused without any request: other schemes,
credentials in the link, ports, IP literals in any notation, local names (localhost, .local, .internal, single labels),
other hosts and look-alikes. Before each request the address is checked again, its host resolved, and the request
dropped unless every address is public; redirects are not followed, except GitHub's API to itself, once.

**E3. Words.** A link that opens: "Checked by Vestiarion". One that can't be opened: "Can't be opened: <reason>". One not
on the allow-list: "Not checked by Vestiarion", still shown as given, with no referrer and nofollow. One the service did
not answer about: "Could not open". On a Contractors card: "merged PR, can't be opened" and the reason, or "<host>, not
checked".

**E4. Brief, and nothing leaks.** Results are kept in the server's memory per workspace and link: five minutes for a
link that opens, two for one that can't, thirty seconds for no answer. GitHub is asked with the workspace's own GitHub
connection where the repository is in it, else the deployment's token. A private repository the workspace's own
connection reads opens: its people open it on GitHub, and a merged pull request in it stays verified. One seen only
through the deployment's token, or a 403 to that token, reads as "GitHub does not show it publicly", as a deleted one
does, after as many requests (a comment's repository is asked first) and kept as long, so the check says nothing the
workspace could not see. Storage is asked with the link's own signature and nothing else. The member's session goes to
no other host, and no link with its token is logged. At most 25 links are checked per page.

## Screenshots

In `docs/superpowers/specs/role-onboarding-shots/`, from a production build in headless Edge, at 1440 and 390 px
(`<nn-name>-<width>.png`), through `/docs-shots/onboarding/<state>` (answers only with `DOCS_SCREENSHOTS=1`; sample data
in `src/app/docs-shots/onboarding-fixture.ts`):

- `01-owner`: the owner's checklist after the agent's first decision, **Set or confirm the limits** next with **Keep
  these limits**, and the Agent spending limit panel it opens.
- `02-approver`: Approvals as an approver who opened it while a bill waits, **Decide it, or send it back** next, above the
  held bill's card.
- `03-accountant`: the accountant console with the accountant's checklist, **Open one workspace's queue** next.
- `04-evidence`: a milestone's evidence whose pull request is in a private repository the workspace's GitHub connection
  does not reach: **Can't be opened** with why, the fact **Could not open**, the bounty comment checked; below, the
  Contractors cards with the same link and a hand verification's link **not checked**.
