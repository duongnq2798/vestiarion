# Held milestones decided again

Date: 2026-10-01. Status: in progress (design decided under the standing autonomy grant; rulings
below carry their cost if wrong).

## 1. Why

The contractor stage decides only `verified` milestones. One the agent held (over the contractor's
limit, a high-risk contractor, the model's own hold, or the agent paused) stayed `held` for good:
milestones have no approval inbox, so the only way out was for a person to revoke the
verification and verify it again. Raising the contractor's limit, the obvious fix for a hold over
it, did nothing. Invoices have had the opposite since the follow-up stage: a frozen invoice whose
facts changed goes back to the decision loop.

## 2. What changes

- **The follow-up stage reopens held milestones** whose facts changed since the agent held them,
  setting them back to `verified`; the contractor stage, which runs after it, decides them in the
  same cycle. Ledger: `milestone_reopened` (domain `contractor`), with what changed.
- **Raising a counterparty's limit raises a cycle event** (`limit_raised`), so a payment held over
  the old limit is decided again within a minute rather than at the next scheduled cycle.

## 3. Rulings

- **R1 — the facts compared** are the ones the milestone decision reasons from: the contractor's
  risk level and payment limit, and the milestone's verification source; plus whether it was held
  only because the agent was paused (`execution.heldBecause = "agent_paused"`). A paused agent
  runs no cycle, so the first cycle after it resumes reopens those. Cost if wrong: a reopen too few
  or too many, each one model call.
- **R2 — reopen only, no escalation.** A held milestone has no approval path to escalate to, and
  deciding identical facts again would repeat the same answer at the cost of a model call every
  cycle. A held milestone whose facts did not change stays held.
- **R3 — the facts come from the latest milestone decision entry**, newest first. Entries without
  a decision (verification, reopening) carry none. A held milestone with no recorded decision is
  reopened once, as invoices are, rather than left held on an assumption.
- **R4 — the write is a compare-and-set on `held`**, like the invoices': if a person revoked the
  verification meanwhile, their change stands and nothing is recorded for that milestone.
- **R5 — `limit_raised` only when it can unblock something:** the configured limit went up from a
  set value and screening allows more than zero. A lower limit, or one a high-risk counterparty
  gets none of, raises nothing, so it never spends a sandbox's daily cycles for nothing.
- **R6 — milestones only follow invoices' reopen rule, not their stale escalation**, which needs
  the approvals inbox (R2).

## 4. Pieces

- `src/lib/agent/follow-up.ts` — `planMilestoneFollowUp(milestone, atDecision)` (pure).
- `src/lib/agent/orchestrator.ts` — `followUpHeldMilestones(orgDb)`, called at the end of the
  follow-up stage.
- `src/lib/agent/cycle-soon.ts` — the `limit_raised` event kind; `src/app/actions/intake.ts` raises it.
- `content/docs/guides/pay-a-contractor.mdx` and `content/docs/changelog.mdx`.

## 5. Tests

- Unit: each fact that reopens; every change listed; nothing changed waits; no facts reopens.
- Stage seam (fake PostgREST): reads held, verified milestones and the contractor ledger newest
  first; skips entries without a decision; compare-and-set on `held`; `milestone_reopened` with
  the changes; nothing written when a person changed the milestone meanwhile; no ledger read when
  nothing is held.
- Action: `limit_raised` only for a raise screening allows some of; not for a lower limit, a
  high-risk one, or a refused change.

## 6. Rollout

No migration. In testnet-2: a contractor with a 1 USDC limit, a 2 USDC milestone verified → held
over the limit (`milestone_hold`, code refusal) → raise the limit to 5 → within a minute
`milestone_reopened` and `milestone_release`, paid on Arc testnet. Record here in §7.

## 7. Rollout record

(pending)
