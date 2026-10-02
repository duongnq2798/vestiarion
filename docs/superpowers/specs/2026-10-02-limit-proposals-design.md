# The agent learns from people's overrides

Date: 2026-10-02. Status: shipped with this PR (design decided under the standing autonomy grant;
rulings below carry their cost if wrong). Roadmap A7.

## 1. Why

When the agent holds a payment because it is above the counterparty's payment limit, a person
decides it in Approvals. If people keep approving the same counterparty above its limit, the limit
is wrong, not the payments. Today the agent never notices: it holds the next one the same way, and
a person approves it again.

In testnet-2, people approved three payments to Centronex above its 2 USDC limit in three days:
3 USDC on Sep 30, 5 USDC on Sep 30, and 5 USDC on Oct 2. The agent held each one first.

## 2. What it does

- Every cycle, a new stage, **proposals**, looks for a counterparty whose payments people have
  approved above its limit repeatedly.
- For each one it asks the model whether to propose a higher limit, and which. Code bounds the
  answer.
- An open proposal shows in **Approvals** under **Suggested by the agent**: the new limit, why, and
  each approval it rests on. An owner or admin chooses **Accept**, which changes the limit as an
  edit on Counterparties would, or **Dismiss**.
- Each step is signed.

## 3. Rulings

- **R1 — what counts as an override above the limit.**
  - It must be a payable a person approved and paid (`approval_paid`) in the last 30 days.
  - The agent's last decision on it must have recorded an amount (its USDC value, for EURC) above
    the counterparty's payment limit then. It does not matter whether the model held it or code
    refused it.
  - It must still be above the counterparty's configured limit now; a limit since raised has
    answered it.
- **R2 — when a proposal is considered.** All of the following:
  - at least 2 such overrides;
  - no payable above the limit rejected for that counterparty in the same 30 days;
  - the counterparty is screened clear (a medium or high tier sets its limit, not the people's
    approvals);
  - it is a vendor or contractor;
  - no proposal for it is open;
  - after a dismissal, at least one new override since.
- **R3 — the model decides, code bounds.**
  - The model is shown the counterparty, its limit and performance history, each override (amount,
    date, what the agent did and why), and any rejection.
  - It answers `propose` or `no_change`, a new limit, and its reasoning.
  - Code accepts a new limit only between the largest override and twice it, and above the current
    limit. Anything else becomes the reference answer.
  - The reference (the fallback, and what the model is scored against): propose the largest
    override plus 10%, rounded up (to 0.1 below 1 USDC, to 1 below 100, to 10 above).
- **R4 — accepting is an ordinary limit change.**
  - Accept goes through the same code as editing the limit on Counterparties. That code refuses
    while a cycle runs, sets the current limit from the counterparty's risk, and starts a cycle so
    held payments are decided again (`limit_raised`).
  - If someone changed the limit since the proposal, it is marked superseded instead.
  - Proposals and their decisions are signed: `policy_proposal_made` (agent),
    `policy_proposal_accepted` and `policy_proposal_dismissed` (person).
- **R5 — only owners and admins decide**, as for any limit change (`records.write`). Every member
  sees the suggestion.

## 4. Storage

`policy_proposals` (migration 0056), tenant-scoped: one row per proposal, of kind `raise_limit`,
with:
- the counterparty, the limit it would replace and the one it proposes;
- its evidence (the overrides it rests on) and its reasoning;
- the decision mode that made it;
- its status: `open`, `accepted`, `dismissed` or `superseded`;
- who decided it and when.

At most one is open per counterparty.
