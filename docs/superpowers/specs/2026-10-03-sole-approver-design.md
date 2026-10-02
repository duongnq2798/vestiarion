# Sole approver

Date: 2026-10-03. Status: implemented on `fix/sole-approver`.

## 1. The problem

A person cannot approve a payable they entered, nor Pay now a held milestone they added when it overrides the
agent's own hold (control design D4; held milestone actions R2). The rule separates the person who enters a
payment from the person who lets it leave.

In a workspace with one person who can approve payments, there is nobody to separate. Everything that person
enters and the agent holds can never be approved: the card reads "You created this invoice", Approve and pay
is disabled, and the only ways forward are Reject, Return to agent with the same facts (held again), or inviting
a second account of their own just to click Approve. The first workspace opened by someone outside the team
stopped at exactly this point.

## 2. The rule

A person is the workspace's **sole approver** when their own membership's role holds `approval.decide`
(owner, admin, approver) and no other membership in the workspace does. An invitation not yet accepted is not
a membership and does not count.

A sole approver may approve a payable they entered and Pay now a held milestone they added. Nothing else
changes: a counterparty screened high risk is still refused, a milestone above its contractor's limit or with an
unconfirmed address is still refused, the funds check still runs, a transfer already sent is still only
reconciled, and two people still cannot decide one record at once.

As soon as a second member can approve, the separation applies again, to every record, without any setting.

## 3. Rulings

- **R1 — Where the rule lives.** The database is the gate for payables: `claim_invoice_decision` lets the
  creator's `approve` claim through only when `sole_approver(org, person)` is true, read in the same statement
  as the claim. Milestones have no self-approval check in the database (0059), so `payHeldMilestone` asks
  `sole_approver` before its claim, as it already checked the creator before.
- **R2 — `sole_approver(p_org_id, p_user_id)`** is security definer, because the tenant role has no access to
  memberships (0021). It answers one boolean, and only about the organization the caller's token names (the
  `agent_paused` pattern): a tenant token naming another organization gets false. Tenant role and service role
  may execute it.
- **R3 — Fail closed.** When `sole_approver` cannot be read (an error, or a database without 0061), the app
  treats the person as not the sole approver: the separation applies, as before this change. So the code can
  ship before the migration, and a migration replayed from a checkout without 0061 restores the stricter
  0025 rule rather than a looser one.
- **R4 — The ledger says so.** When a sole approver approves their own entry, `approval_paid` and
  `milestone_approval_paid` carry `soleApprover: true` in their detail, and their summary ends
  "(entered and approved by the workspace's only approver)". An approval by anyone else carries neither.
- **R5 — The screens say so.** The approval card and the held milestone row stop disabling the button for a sole
  approver and say instead that they entered it, that they are the only person here who can approve payments,
  and that the ledger records it. The confirm dialog repeats the last part. Everyone else sees what they saw
  before.
- **R6 — Approvals count as before.** A sole approver's approval is a person's approval in every figure:
  /open's escalations resolved, the agent's policy proposals (A7), the human-agreement figures.

**Cost if wrong:** in a one-person workspace, nobody checks the person who enters a payment before it leaves.
That was already true in practice (a second account of their own lifts the rule), each such approval is now
named in the signed ledger, and adding a second approver restores the separation at once.

## 4. Migration 0061

`0061_sole_approver.sql`: creates `sole_approver`, redefines `claim_invoice_decision` with the sole-approver
exception in both its claim and its error branch, and keeps the grants. Additive and idempotent. 0061 sorts after
0025, so every full replay ends with this definition.

## 5. Rollout

1. Merge (the code fails closed until 0061 is applied).
2. Apply 0061; probe: `sole_approver` is security definer with an empty search path, executable by
   `vestiarion_tenant` and `service_role` only; `claim_invoice_decision` has one overload.
3. In a workspace with one owner: add a payable the agent holds, approve and pay it as that owner; check the
   `approval_paid` entry carries `soleApprover: true`, and the transfer on Arc testnet.
4. Record the result here.
