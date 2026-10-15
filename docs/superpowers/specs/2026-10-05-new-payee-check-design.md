# New payee check: two people before the first payment to an address

Date: 2026-10-05. Status: designed under the standing autonomy grant (partner, 2026-10-05: "ok làm new-payee check
tiếp đi"); rulings carry their cost if wrong.

## 1. Why

Today one person can make the agent pay a new address. A member adds a vendor with an address typed into the console,
adds a bill, and the agent pays it within the payment limit and the spending limit. No second person is ever involved.
The same holds when a member changes an address and confirms the change themselves: confirming needs `approval.decide`,
but nothing asks for someone else.

Paying a new or changed bank account on one person's word is the commonest supplier-payment fraud: a business email
compromise, or an insider's own account. Finance teams answer it with first-payment verification, so that a second
person stands behind any first payment to an account. It matters most with real money (mainnet readiness review), and
costs little now.

Addresses that come from outside the console already wait for a person: one sent through a payee link, a GitHub
`/payto`, or the API. This check closes the case the console leaves open.

## 2. Rulings

- **N1. A first payment.**
  - Amended 2026-10-15 (independent review): a first payment is keyed on the payee and the address together. A
    confirmed payment counts for the payee its invoice or milestone was for, so an address the workspace paid for
    someone else is still a first payment for this payee.
  - A payment to an address that has never received a confirmed payment from this workspace (`payment_intents.status =
    'confirmed'`, destination compared case-insensitively).
  - A payment in flight does not make an address paid.
  - Payables and milestones both count.
- **N2. Who stands behind an address.** This is read from the ledger, newest first:
  - The entry that set the counterparty's current address names who gave it:
    - `counterparty_address_changed` (`to` is the address): a member (`by`), or the payee when `by` is null (a payee
      link, GitHub);
    - `create_counterparty` (`address` is the address): its `by`.
  - A later `counterparty_address_confirmed` for that address names who confirmed it.
  - An address with no such entry (set by a script) has no known giver, and counts as one person.
  - Amended 2026-10-15 (independent review): an address the payee sent also names the member who asked for it. For a
    payee link, the `by` of its signed `payee_link_created` entry, or its `payee_links` row (`created_by`) only when
    that entry is missing. For `/payto` on GitHub, the `by` of the `github_bounty_attached` entry of the pull request
    the comment was on: the member the bounty acts as. That member counts as having given the address for N3 and N4,
    so a confirmation by them alone is not a second party, and they may not approve its first payment unless they are
    the sole approver. When no member can be named, nothing is a second party: a person approves it. `addressBy`
    stays `"payee"`; N6's record adds `linkCreatedBy` or `bountyBy`.
  - Amended 2026-10-15 (independent review, round 2): a GitHub login is tied to no member, and every bounty acts as the
    member who connected GitHub, whoever typed it. So for an address sent with `/payto`, and for any address whose giver
    no entry names, no confirmation counts as a second party (N3), and the members who confirmed it are left out of
    approving its first payment beside its giver (N4), unless they are the sole approver. A bounty typed by its own pull
    request's author names no member.
  - Amended 2026-10-15 (independent review, round 3): for such an address the rule is exactly two different members:
    one confirms it on Counterparties, and a different one approves its first payment. Whoever confirmed it is left out,
    and the member a bounty acts as is not, so two approvers are never both left out. An approval that would confirm the
    address itself never counts: while no member's confirmation is on record, one approver alone is refused ("Someone
    else must confirm this address on Counterparties before its first payment."), unless they are the sole approver.
    N6's record adds `unanswered: true`.
- **N3. Two parties before the agent pays a new address.**
  - The agent makes a first payment on its own only when two different parties stand behind the address: the payee
    gave it and a member confirmed it, or one member gave it and another member confirmed it.
  - Otherwise code holds the payment with the rule `counterparty.new_payee`, for a payable and a milestone release
    alike.
  - For a payable it speaks after the address check and the three-way match, so the bill's own gaps are asked first.
  - Cost if wrong: the first bill of every vendor a member typed in waits for a second person, as first-payment
    verification intends.
- **N4. A person's payment.**
  - Approve and pay in Approvals refuses a first payment to an address the person gave themselves, as does Pay now on a
    milestone, unless they are the workspace's sole approver (as for an invoice they entered).
  - The card says why: "You gave this payee's address, so someone else must approve its first payment."
  - Cost if wrong: in a two-person workspace, the other person approves the first payment to a vendor one of them added.
  - Amended 2026-10-15 (independent review): for a payee's address, the member who asked for it is refused in words
    that say so ("You asked for this address with a payee link", or that a GitHub bounty acting as them did). When the
    sole approver pays a first payment to an address they gave or asked for, the ledger entry records
    `addressGiverApproved: true` and its summary says so.
- **N5. Wherever payments are real.**
  - The check applies when the workspace's payments go through Circle: its chain provider is live.
  - Payments are real in a live workspace, and also in a sandbox that has connected Circle but not yet gone live. Real
    payments are switched on by readable Circle credentials, not by `orgs.mode` (mainnet readiness review §1).
  - In a simulated workspace nothing real moves, so the check does not apply, and sample data keeps its one-minute
    demonstration.
- **N6. The ledger.**
  - A decision on a first payment records `observed.newPayee: { addressBy, confirmedBy, twoParties }`.
  - `addressBy` is a member id, `"payee"`, or null when not known.
  - For an address sent through a payee link, `linkCreatedBy` names the member who created the link, when known.
  - The model is not told: this is code's rule, like the spending limit, and the decision's own record shows it.
- **N7. After the first payment.**
  - Once the address has received a confirmed payment, the agent pays it on its own; every other check stays.
  - A payable held only as a new payee is decided again by the follow-up once its address has been paid by another
    payment.
- **N8. Not in this change.**
  - A second member confirming an address typed into the console, on Counterparties, before any bill. Today the way
    through is the first payment's approval.
  - Database enforcement of N4: the self-approval rule lives in `claim_invoice_decision`, while this one is checked by
    the approval action.

## 3. Testing

- **Rule:**
  - first payment or not, case-insensitive;
  - giver and confirmer from the newest entries;
  - payee plus member, and two members, pass;
  - one member as giver and confirmer, a giver with no confirmation, and an unknown giver hold.
- **AP stage:**
  - held, with the rule and `observed.newPayee`, in a live workspace;
  - paid when two parties stand behind it, or the address was paid before;
  - unchecked in a sandbox;
  - order: the address check and the match come first.
- **Contractor stage:** a first release held the same way.
- **Approvals:**
  - the giver is refused, unless sole approver;
  - another person may pay;
  - the card says why.
- **Follow-up:** reopens a payable held as a new payee once its address has been paid.
- **Copy:** next step, few words, what the agent does on its own, decision trail.

## 4. Rollout

- No migration.
- Proof in demo-wp or testnet-2:
  - add a vendor with a typed address and a small bill: the agent holds it as `counterparty.new_payee`;
  - the member who added it cannot approve it, and another person (or the sole approver) approves;
  - a second bill to the same vendor is then paid by the agent on its own.
