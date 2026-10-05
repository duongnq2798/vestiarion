# Two approvals above a limit

Date: 2026-10-05. Status: designed under the standing autonomy grant (partner's brief, 2026-10-05: after each feature,
take the next highest-impact one; fix what is not yet safe for real money). Phase 2 of the mainnet plan ("Trần cho khoản
do người duyệt; trên mức đó cần hai người"), built on Arc testnet first. Rulings carry their cost if wrong.

## 1. Why

One person's approval pays any amount. Approve and pay, and Pay now on a milestone, are not held by the agent's
spending limit or the contract on Arc, and an approved payable is not held by its payee's limit either. The agent itself
pays alone up to the payee's limit and its spending limit, which a workspace may set high or not at all.

Finance teams answer this with dual control (the four-eyes rule): above a figure the business chooses, a payment needs
two people's approval, whoever started it. Real money makes it necessary; a business letting an agent near its cash
asks for it first. It is also the control a reviewer looks for: no single person, and no model, moves a large sum alone,
and the signed ledger shows who stood behind each payment.

## 2. Rulings

- **T1. The setting.**
  - `approval_policies.two_approvals_above`: one figure per workspace, in USDC, or null (off, the default).
  - Only an owner changes it (new permission `approval.policy`: owners). Every member sees it on Settings, under
    Security, as "Two approvals".
  - Turning it on, or lowering it, needs at least two members who may approve payments (owners, admins, approvers).
    With fewer it is refused: "Two approvals need two people who can approve payments. Add an approver on Members
    first." Raising it or turning it off is always allowed.
  - Refused while a cycle is running, as the agent's spending limit is: a cycle reads the figure once, when it starts.
  - Each change is signed as `approval_policy_changed` (actor `human`, domain `system`): `{ by, from, to }`.
  - Cost if wrong: an owner can still turn it off and then approve alone. The ledger shows both steps.
- **T2. What it covers.**
  - Every payment to a payee: a payable, and a contractor milestone (bounties and Pay a freelancer are milestones),
    whoever starts it: the agent, or a person in the console or Slack.
  - Not the workspace's own money moving between its own wallets: reserve sweeps and redemptions, Gateway funding,
    swaps, and the agent's service budget.
  - "Above" is strictly greater than the figure.
  - The amount weighed is in USDC: a USDC payment's amount; a EURC payment's USDC value as the agent last weighed it
    (`usdcValue` on its decision). A EURC payment with no USDC value counts as above, since its value is not known.
  - Cost if wrong: a EURC payable's value moves with the rate after its decision; the value it was weighed at decides.
- **T3. The agent never pays above it.**
  - AP stage: `enforceApGuardrails` holds a `pay` or `schedule` whose USDC value is above the figure, with the rule
    `workspace.two_approvals` and status `held`. The reasoning ends "[guardrail override: payments above X USDC need
    two people's approval in this workspace — payment refused before execution; two people approve it in Approvals]".
  - It speaks after the counterparty's and the invoice's own checks (duplicate, risk, client, address, match, new
    payee, rate, payee limit, the route to another chain) and before the agent's spending limit, the contract on Arc
    and any EURC swap: no room is used and no swap is made for a payment the agent may not make.
  - Contractor stage: a release above the figure is held the same way, after the new payee check and before the
    spending limit.
  - The figure is read once per cycle. A decision under the rule records `observed.twoApprovalsAbove`.
  - The follow-up decides again a payable or milestone held by this rule once the figure no longer covers it (raised or
    turned off).
- **T4. A person's approval above it.**
  - Approve and pay on a payable, and Pay now on a held milestone, from the console or Slack.
  - Below the figure nothing changes: one approval pays.
  - Above it, an approval is recorded and nothing is sent, unless another person's approval of the same payment is on
    file; then this approval pays it.
  - An approval is of a payment: its amount, currency and the payee's address at the time. One that no longer agrees
    with the payment counts for nothing.
  - A person approves a payment once: "You approved this already. Another person who can approve payments must
    approve it to pay."
  - Every check of a single approval applies to each approval: payments switched off, high risk, the address the card
    showed, a first payment's giver. The funds check comes with the approval that pays.
- **T5. Who gives the two approvals.**
  - Members who may approve payments, other than whoever entered it and, for a first payment to an address, whoever
    gave the address.
  - When fewer than two such members exist, those people may approve too. Two different people are still needed, and
    the paying entry records `fewApprovers: true`.
  - A workspace with one approver can never pay above the figure: one person cannot be two. The card says to raise the
    figure or add an approver. (Turning it on needs two approvers; this happens only when one leaves.)
  - In the database, `claim_invoice_decision` also lets the person who entered an invoice claim its approval when
    another person's open approval of it is on file: they give the second approval. The two-approval rule itself is
    checked by the approval action, as the new payee check is.
  - Cost if wrong: in a workspace with two approvers, whoever entered a bill above the figure gives one of its two
    approvals.
- **T6. Approvals are used once.**
  - The approval that pays claims the payment, and the open approvals are marked used.
  - A transfer that then fails needs two approvals again to be sent again.
  - A transfer already sent is only recorded: approving it needs one person and moves nothing. A send Circle never
    answered counts as a new payment, since it may be sent again.
  - Reject, Return to agent and Close without paying clear the open approvals.
  - Cost if wrong: after a failed transfer, two people approve again.
- **T7. The ledger.**
  - A recorded approval: `approval_given` (domain `ap`) or `milestone_approval_given` (domain `contractor`), summary
    "Approved 120 USDC to Northwind; one more approval pays it (payments above 100 USDC need two)". Its `detail`:
    `{ by, invoiceId | milestoneId, counterpartyId, amount, currency, address, usdcValue?, twoApprovalsAbove }`, with
    the surface's provenance.
  - The approval that pays: `approval_paid` or `milestone_approval_paid` add `approvals: [{ by, at }, …]`, the earlier
    first, and `twoApprovalsAbove`.
- **T8. Where a person sees it.**
  - Approvals card, above the figure: "Payments above X USDC need two approvals." then "No one has approved it yet." or
    "Approved by {email} at {time}. One more approval pays it."
  - The button reads Approve while it will not pay yet, and Approve and pay when it will; the confirm dialog says which.
  - Disabled, with the reason beside it: "You approved it"; "You created this invoice" or "You gave this payee's
    address" as today, when enough others may approve; "Needs a second approver" for the only approver.
  - Contractors: a held milestone above the figure says the same in its row, and Pay now reads Approve until it pays.
  - Settings, Security, Two approvals: the figure or Off, how many people can approve payments, and for an owner a form
    to set it or turn it off.
  - Slack: the reply says whether the approval paid, or is recorded and one more pays it.
- **T9. Not in this change.**
  - Telling the other approvers, by email or Slack, that an approval waits for them. Approvals and the held notice show
    it.
  - Different figures per role.
  - A ceiling on the cross-chain fee a person approves, today at most the payment itself.
  - Database enforcement of T4 and T5 beyond the claim in T5.

## 3. Testing

- **Rule:** USDC above, at and under the figure; EURC by its USDC value; EURC with none counts as above; off.
- **Migration:** both tables isolated by workspace; `approvers_besides` counts and excludes; the creator's claim passes
  only with another person's open approval; re-running is idempotent.
- **Setting:** owner only; two approvers needed to turn on or lower; raising and turning off allowed; refused during a
  cycle; signed.
- **Guardrail:** pay and schedule held above; payee limit speaks first; the spending limit and a swap never meet it;
  EURC weighed at its USDC value.
- **AP and contractor stages:** held with the rule and `observed.twoApprovalsAbove`; paid under the figure.
- **Follow-up:** a payable and a milestone held by the rule reopen once the figure is raised or off.
- **Approvals:**
  - the first approval is recorded and sends nothing; the second, by someone else, pays and uses both;
  - the same person is refused;
  - an approval of a different amount or address counts for nothing;
  - whoever entered it is refused when two others can approve, and allowed when they cannot;
  - the only approver is refused;
  - a transfer already sent is recorded by one person;
  - Reject and Return clear the approvals;
  - milestones: the same core cases.
- **Surfaces:** the command outcome and the Slack reply; the card's states; the settings panel.
- **Docs:** the guide's quotes match the source.

## 4. Rollout

- Migration `0076_two_approvals.sql` (the partner runs it before the merge).
- Proof in testnet-2, with a second member who may approve:
  - an owner sets Two approvals above 1 USDC;
  - a 2 USDC payable: the agent holds it as `workspace.two_approvals`;
  - one member approves: recorded as `approval_given`, nothing sent;
  - the other approves: paid on Arc testnet, and `approval_paid` names both approvals.
