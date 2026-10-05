# Payment integrity: what the two-approvals review left

Date: 2026-10-05. Status: implemented on `fix/payment-integrity`. Phase 2 of the mainnet plan, the part the two-approvals
work (#208) deferred. On Arc testnet.

## 1. The problem

The two-approvals review found five places where the database or the agent trusted more than it should.

- **The claim lets the person who entered a payable approve it on a weaker approval than the app checks.**
  `claim_invoice_decision` lets them claim it when any other person's open approval exists. The app counts only an
  approval of this payment, by someone who may still approve payments. The database should say the same.
- **`approvers_besides` answers 0 for another workspace than the token's, and counts no one when the list holds a
  null.** The app fails closed on a non-number, but a 0 reads as "no one else can approve", which lets whoever entered a
  payment give one of its two approvals. The app filters nulls before calling. The function should not depend on that.
- **The tenant role can insert into `ledger_entries` directly.** Every append should go through
  `append_ledger_entry`, which links the hash chain. A direct insert, from a bug or a stolen request token, would put an
  entry in the ledger that no chain step links.
- **The agent resends a payment Circle never took without the two-approvals check.** It happens when the figure was
  set or lowered after the first send, or when one person approved before there was a figure. A payment above the
  figure then leaves on no one's second approval.
- **A resend sends what the request asks, not what the intent recorded.** This one is considered below and declined.

## 2. Rulings

- **I1: the claim counts only an approval that agrees and stands.** Whoever entered a payable may claim its approval
  only when another person's open approval of it has the same amount and currency, and that person may still approve
  payments in the workspace (`approvers_among`). Otherwise the claim refuses with `self_approval`, as before.
- **I2: `approvers_besides` answers null for another workspace.** That is, a token naming a workspace other than
  `p_org_id`. It ignores nulls in the list. The app already throws on anything but a number, so a mismatch fails
  closed.
- **I3: the ledger is appended only through `append_ledger_entry`.**
  - The tenant role keeps SELECT on `ledger_entries` and loses INSERT.
  - `append_ledger_entry` becomes `security definer`, so it can still insert, and refuses a `p_org_id` other than the
    token's workspace (`request_org_id()`). The server's own service-role calls, whose token names no workspace, append
    as before.
  - It pins `search_path` to `extensions, public` and names its table: `digest()` resolves in `extensions` on Supabase
    and in `public` on a local database, and nothing a tenant creates can stand in for it.
  - Its chain step is unchanged: the same lock per workspace, the same previous hash, the same sha256.
- **I4: the agent sends again on its own only what one approval may pay.** This covers a payment the agent never sent,
  in either path: the AP stage's resend of a `matched` payable, and the contractor stage's resend of a `verified`
  milestone, whose intent has no transfer.
  - It is weighed against the workspace's figure as the stages weigh a new payment: a EURC payable at its USDC value,
    and one whose value is not known is held.
  - Above the figure, the agent sends it again only when two people's approvals of this payment were used to pay it:
    two different people, agreeing with its amount, currency and address. Otherwise it holds the payable or milestone
    for two people, with "[not resubmitted: payments above *X* USDC need two approvals — held for two people to
    approve]".
  - The ledger entry (`ap_reconcile` or `milestone_reconcile`) records `notResubmittedBecause: "workspace.two_approvals"`.
  - Two people then approve it on Approvals or Contractors, which looks for the earlier send first, as for any send
    Circle never answered.

## 3. Declined

- **"A resend sends what the intent recorded."** The agent's resend is already refused when the payee's address
  changed and no one confirmed it (`resubmissionBlocker`). A person's Approve and pay sends to the address they were
  shown, and refuses one that changed after the page loaded. A rule that the request must match the intent's first
  attempt would refuse a person's retry, after a terminal failure, to a payee's corrected address.
  - Cost if wrong: a resend under the same key with another amount. An invoice's amount does not change once it is
    decided.

## 4. What does not change

- What the AP and contractor stages decide for a new payment, and the two-approvals rule itself.
- Who may read the ledger, and the shape of its entries.

## 5. Known limits

- A payable held under I4 is not reopened by the follow-up stage when the figure is raised or turned off: its hold is a
  reconciliation's, not a decision's. A person approves it, or returns it to the agent.
- I3 holds only once migration 0077 has run. A later `db:migrate` from a checkout without 0077 restores the old grant
  and function together, which still work (the migration runner replays every file).

## 6. Tests

- `tests/payment-integrity-migration.test.ts` (PGlite):
  - the claim with an approval of another amount, another currency, or by someone no longer allowed to approve;
  - `approvers_besides` for another workspace, and with a null;
  - a tenant's direct insert refused, its append linked as before, another workspace's append refused, and the
    service role's append.
- `tests/two-approvals-migration.test.ts`: another workspace now answers null.
- `tests/control-cycle.test.ts`, `tests/milestone-reconcile.test.ts`: the agent's resend above the figure, held without
  two used approvals, sent with them, and sent as before with no figure.
