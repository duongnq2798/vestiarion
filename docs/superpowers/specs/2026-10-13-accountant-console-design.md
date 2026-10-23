# Accountant console and usage metering

Date: 2026-10-13. Roadmap: F29 (a console for accountants and finance partners) with I30 (metering per workspace and
action) folded in.

## Problem

An outside accountant who looks after several small businesses has to open each workspace to know where something needs
attention. Nothing told them which client has a payment past its day, a payment to book in Xero, a customer who says it
paid, or a broken connector, and nothing let a business invite them without also letting them move money. Separately, a
workspace had no single place saying what it used (model calls, Circle transfers, x402 purchases, emails, connector
syncs) or which limit stopped something and who must act.

## Decisions

**A1. A new role, `accountant`.** Reusing a role did not fit the permission map: a viewer cannot book or apply money
received, an approver decides payments (the separation an accountant should not cross), and an admin manages members,
integrations and treasury. The accountant holds:

- `workspace.read`: everything an approver or viewer reads, the ledger, report and audit export included;
- `accounting.book`: approving bookings of payments made on Arc in Xero (the permission was split out for this in
  write-back W6);
- `receivables.reconcile`, new: applying money received to receivables and reversing it, and replying to and closing what
  a customer said on its statement link. Owners and admins hold it too; before, these were `records.write`, which only
  owners and admins held, so nothing changes for anyone else.

It decides no payment, pauses nothing, adds no bill or receivable, makes no statement link, and changes no treasury,
limit, integration, API key, webhook or member. Owners and admins may grant it (it ranks with the approver); an
accountant grants nothing. "Unless the owner grants more" is a role change on Members: one person holds one role per
workspace. Migration 0112 adds the value to both role checks, once, so every existing membership and invitation keeps its
role, and redefines `role_rank` and `can_assign_role` (an unknown role is now refused, never let through as null). The
SQL functions that name the deciding roles stay as they are, so the database refuses an accountant's pause or decision
too.

A Xero connection's consent names who approves what is booked. Version `xero-2026-10-13` names the accountant; a
connection agreed under an earlier version keeps "an owner or admin" until it is reconnected, and an accountant's booking
there is refused with whom to ask.

**A2. Membership-gated, per workspace, as the person.** No service-role read across tenants. The console lists the
person's own memberships, read per request from the session's user id, and reads each workspace inside
`withOrg(orgId, ..., { userId })`, through its tenant client, whose token names that workspace and that person. A
SECURITY DEFINER portfolio function was the alternative; the tenant client per workspace keeps row-level security as the
second line on every read and needs no new privileged SQL.

**A3. One queue, routed.** Items: payments waiting for a decision, held payments past their decide-by day (#331), payments
to book in Xero (accounting write-back W6; QuickBooks books nothing yet), receivables overdue, customers who say they paid or dispute an invoice
(#333), connector problems, and limits reached (U3). Each names its workspace, its own amount in its own currency, how
long it has been open, and who acts: "You can ..." when the viewer's role may, or which roles may. What the viewer can act
on comes first, then by kind, then the oldest. Since Oct 22, 2026 it also holds bills waiting for an accountant's co-sign
and addresses to confirm (`2026-10-22-accountant-queue-design.md`).

**A4. Where it is.** `/accountant`, behind the session. The workspaces page links it for anyone in more than one workspace
or an accountant in one.

**A5. No sums of money.** The console counts items. It never adds balances or amounts across items, currencies or
workspaces.

**A6. KPI: time to triage.** Items open per age bucket across the person's workspaces: under a day, 1 to 3, 4 to 7, 8 to
30, over 30 days.

**A7. Hand-off export.** `GET /api/accountant/handoff?org=<slug>&format=csv|json&month=YYYY-MM` (last full month by
default). The audit export's gate and brake pattern (#65): cross-site refused, session, membership read afresh (a removed
member gets the 404 of a stranger), 10 a person per 10 minutes counted from `handoff_exported` entries. Contents: the
month's decisions from the signed ledger with their numbers and hashes, the payments created or confirmed in it, the
bookings paid in it, and the open items now, with the ledger's head so the audit export verifies the decisions. Nothing
is stored, so removing a member cuts access at once, as their API keys are revoked with the membership (#174).

**U1. One row per use.** `usage_events` (tenant table, RLS, append-only for the tenant role): kind, the app's own word
for what it was for, provider, model, quantity, tokens, a cost with its currency, ok. Written through the workspace's
tenant client, best effort, never in the way of what it records; nothing outside a workspace's scope; never an address, a
payee's amount or an email's words.

**U2. Cost where known.** A model call's cost is its reported tokens at the model's price: Claude's list prices are built
in; any other model's comes from `AGENT_LLM_PRICES`, or stays unknown. An x402 purchase costs its price in USDC; a Circle
transfer its chain-reported fee. Costs are summed exactly per currency and never across currencies.

**U3. Limits never fail silently.** Settings shows each limit the product already enforces (a sandbox's 20 cycles a day,
the agent's spending limit, the payee history checks' daily most and Gateway balance, 50 invitations a day, a connector to
reconnect) with where the workspace stands, what stops when it is reached, and who acts. A reached one is said at the top
of the section and in the accountant console.

**U4. Display, not billing.** Nothing reads usage to charge or to stop anything.

## Screenshots

In `docs/superpowers/specs/accountant-console-shots/`, from a production build in headless Edge, at 1440 and 390 px
(`<nn-name>-<width>.png`), through `/docs-shots/accountant/<state>` (answers only with `DOCS_SCREENSHOTS=1`; sample data
in `src/app/docs-shots/accountant-fixture.ts`, on Oct 13, 2026):

- `01-console`: an accountant invited to three workspaces (Harbor Bakery, Lumen Studio, Pine Dental). Open items by age;
  a card per workspace with its counts, Open workspace and the hand-off downloads; the queue, with what the accountant
  can act on first (a customer who says it paid, a dispute, payments to book, an overdue receivable) and then what waits
  on others (a payment past its decide-by day, a flagged payment, a Xero connection to reconnect, the agent's spending
  limit reached).
- `02-console-mine`: the same, narrowed to Yours to act on.
- `03-usage`: a workspace's Usage this month: model calls with tokens and their cost in US dollars, Circle transfers with
  their fees, x402 purchases in USDC, emails and connector syncs by purpose, and the limits, the agent's spending limit
  stopped with who acts.
- `04-invite`: Members, an owner inviting with the accountant role chosen, the form saying what an accountant may do, and
  an accountant among the members.

## Verification

- `tests/accountant-portfolio.test.ts`: three of four, every tenant request's token, removal.
- `tests/accountants-migration.test.ts`: roles kept, who may grant the accountant, refusals, usage rows' isolation.
- `tests/accountant-handoff.test.ts`, `tests/usage-model.test.ts`, `tests/usage-record.test.ts`, `tests/roles.test.ts`,
  the command tests for bookings, allocations and customer requests.
