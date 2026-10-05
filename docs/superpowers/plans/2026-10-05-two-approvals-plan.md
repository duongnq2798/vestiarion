# Two approvals above a limit: implementation plan

> For agentic workers: executed inline (superpowers:executing-plans), test first in every task.

**Goal:** above a figure the workspace's owner sets, no payment to a payee leaves on one approval: the agent holds it,
and two different people approve it.

**Architecture:** one figure per workspace (`approval_policies`), approvals of a payment as rows (`payment_approvals`)
bound to its amount, currency and address. The agent's guardrails hold above the figure; Approve and pay and Pay now
record a first approval and pay on the second. A definer function counts the approvers a rule leaves; the invoice claim
lets whoever entered it give the second approval.

**Tech stack:** Next.js 16, Supabase (RLS, PostgREST), vitest with recorded fakes and PGlite.

**Spec:** `docs/superpowers/specs/2026-10-05-two-approvals-design.md`

## Global constraints

- Copy: plain sentences; "Arc testnet" said plainly; no field names in what a person reads.
- Migrations are idempotent (`scripts/migrate.ts` re-runs every file); the partner runs `0076` before the merge.
- Every new tenant table is listed in `TENANT_TABLES`.
- A ledger entry after a decision is best effort (`appendLedgerEntryBestEffort`); the agent's own entries are not.
- Docs change in the same PR: guide, changelog (new ledger actions reach webhooks), ARCHITECTURE, README.

## Review focus

1. Two people racing the two approvals of one payment: exactly one transfer, both approvals used.
2. An approval given for one amount or address, then the bill or address changes: it counts for nothing.
3. A transfer already sent, above the figure: recorded by one person, never blocked or sent again.
4. EURC above the figure by its USDC value, or with no value: held, and two approvals asked.
5. A workspace whose second approver left: nothing above the figure can be paid, and the card says why.

## Tasks

### Task 1: Migration 0076

- Create `supabase/migrations/0076_two_approvals.sql`:
  - `approval_policies (org_id pk → orgs on delete cascade, two_approvals_above numeric(20,6) > 0 or null, updated_by, updated_at)`,
    RLS as `agent_budgets`;
  - `payment_approvals (id, org_id, source_type in ('invoice','milestone'), source_id, approved_by → auth.users on delete cascade, amount, currency, address, approved_at, used_at)`,
    a unique open approval per person and payment, RLS as above;
  - `approvers_besides(p_org_id uuid, p_excluded uuid[]) returns integer`, definer, tenant and service role;
  - `claim_invoice_decision`: 0061's body plus "or another person's open approval of it is on file" for the creator.
- Add both tables to `TENANT_TABLES`.
- Test `tests/two-approvals-migration.test.ts`: isolation, constraint, count with exclusions, the creator's claim with and
  without another person's open approval, idempotent re-run.

### Task 2: The rule and the setting

- `src/lib/two-approvals.ts` (pure, browser-safe): `TWO_APPROVALS_RULE`, `needsTwoApprovals({ amount, currency, usdcValue }, above)`,
  `parseTwoApprovalsForm(value)`, sentences.
- `src/lib/approval-policy.ts`: `readTwoApprovalsAbove(client)`, `changeTwoApprovals({ actorId, value })` (unchanged,
  invalid, too few approvers to turn on or lower, cycle running; ledger `approval_policy_changed`).
- Permission `approval.policy` (owners).
- Tests: `tests/two-approvals.test.ts`, `tests/approval-policy.test.ts`.

### Task 3: The agent holds above the figure

- `enforceApGuardrails`: `twoApprovalsAbove` input, rule `workspace.two_approvals`, after the route checks and before the
  spending limit.
- AP stage: read once per stage (injectable), pass it, record `observed.twoApprovalsAbove` when set.
- Contractor stage: the same hold after the new payee check.
- Tests: `tests/guardrails.test.ts`, `tests/ap-stage.test.ts`, contractor stage test.

### Task 4: Follow-up

- `DecisionFacts.heldForTwoApprovals` (the USDC value held), `FrozenInvoice.twoApprovalsAbove`; milestone equivalents.
- Reopen once the figure is off or no longer covers it; the orchestrator reads the figure only when something waits on it.
- Tests: `tests/follow-up.test.ts` and the orchestrator follow-up tests.

### Task 5: Approvals of a payment

- `src/lib/agent/second-approval.ts`: `approvalsOf(source)`, `standing(approvals, payment)`, `giveApproval`,
  `useApprovals`, `clearApprovals`, `mayApprove({ actorId, excluded, needed })` through `approvers_besides`.
- Tests: `tests/second-approval.test.ts`.

### Task 6: Approve and pay, Reject, Return

- `approveAndPay`: above the figure (and not a transfer already sent), check eligibility, record the approval, count the
  standing approvals by others; fewer than one other: return `{ status: "approved" }` with `approval_given`; otherwise
  claim, use the approvals, pay, and add `approvals` and `twoApprovalsAbove` to `approval_paid`.
- `rejectInvoice` and `returnInvoice` clear open approvals.
- Commands and Slack: the new outcome's words.
- Tests: `tests/approvals*.test.ts`, commands and Slack tests.

### Task 7: Pay now on a milestone

- `payHeldMilestone` and `closeMilestone` as Task 6; `heldReason` kind `two_approvals`.
- Tests: `tests/milestone-decisions.test.ts`.

### Task 8: What a person sees

- `WaitingPayable.twoApprovals`; `ApprovalCard` states and button words; Approvals page passes approvers.
- `HeldMilestoneActions` and Contractors page likewise.
- Settings, Security: `TwoApprovalsPanel` and its action.
- `next-step.ts` sentences for the rule.
- Tests: component tests for the card, the milestone actions and the panel.

### Task 9: Docs and the whole suite

- Guide (first payment: approvals and a new subsection), changelog entry, ARCHITECTURE, README.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`.
