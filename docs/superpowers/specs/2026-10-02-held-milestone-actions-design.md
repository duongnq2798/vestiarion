# Held milestone actions: what a held milestone waits for, Pay now, Close without paying

Date: 2026-10-02. Status: shipped with this PR (design decided under the standing autonomy grant;
rulings below carry their cost if wrong).

## 1. Why

On Contractors, **Needs you** listed held milestones with nothing to do about them. A held payable
has Approvals (Approve and pay, Reject, Return); a held milestone had none. The agent reopens a held
milestone when the facts it was held for change (a raised limit, a cleared screening), but three
cases had no way out at all:

- Circle failed the transfer (the first batch, `ESTIMATION_ERROR`): nothing moved, the agent never
  sends a failed payment again, and nothing about the milestone changes to reopen it.
- The agent chose to hold it, and the person disagrees.
- The work will never be paid (paid another way, cancelled): it sits in Needs you for good.

## 2. Rulings

- **R1. Each held row says what it waits for.** A few words on the row ("Circle did not send it",
  "Limit lowered by a screening match"), and once opened, one sentence with a link to where it is
  settled (Counterparties, or the spending limit on Treasury). Worst first: a transfer that may
  still settle; high risk; above the limit (a screening cut named as such); an address no one has
  confirmed, or none; a failed transfer; an escrow note; the pause; the spending limit; the agent's
  own hold. `heldReason` in `src/lib/agent/milestone-decisions.ts` is the one rule; the row and the
  action read it.
- **R2. Pay now.** By anyone holding `approval.decide`, as Approve and pay on a payable. It is
  refused before anything else when the agent's release would be: high risk, above the limit, no
  address or an unconfirmed one; and when the operating account holds less than a new transfer. It
  is not held by the pause or the agent's spending limit (a person's payment, as on Approvals). It
  is released exactly as the agent releases it (from escrow when locked there), and it is the one
  milestone caller that passes `retryTerminalFailure`: a transfer Circle ended in a terminal
  failure is sent again, alone, as its next attempt; one that may still settle is only reconciled.
  Overriding a hold the agent chose (its own hold, or its spending limit) needs someone other than
  whoever added the milestone; sending again a release the agent decided does not, since that
  decision already passed every check. Signed `milestone_approval_paid` (actor `human`).
- **R3. Close without paying.** A reason is required (1 to 500 characters). Refused while a
  transfer for it may still settle, and while its USDC is locked in escrow (refund the hold first).
  The milestone becomes `closed`, with `closed_at`, `closed_by` and `close_reason`; it is final: it
  is never verified again, by hand or by GitHub, and the agent never sees it. Signed
  `milestone_closed` (actor `human`).
- **R4. One person at a time.** `claim_milestone_decision` (migration 0059) is the compare-and-set:
  it stamps `decision_claimed_by` and `decision_claimed_at` on a `held` milestone, refused while
  another claim is under 10 minutes old. The milestone stays `held` while claimed, so the contractor
  stage (which decides only `verified` ones) never meets it, and the agent's follow-up does not
  reopen a claimed one. Pay now's final write is a compare-and-set on `held`; a transfer that went
  out is kept by its payment intent whatever happens to that write.

## 3. What changes for an integrator

- `/api/v1/milestones`: `status` may be `closed`; each milestone has `closedAt` and `closeReason`.
- Two ledger actions, delivered to webhooks like every entry: `milestone_approval_paid` and
  `milestone_closed`. See `content/docs/changelog.mdx`.

## 4. Not done

- A pending milestone that will never be verified cannot be closed yet; only a held one.
- `open_outcomes` counts a person's decisions on payables only, not on milestones.
