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
- **I3: a request's ledger insert must link the chain as `append_ledger_entry` links it.** The tenant may call that
  function, so it gains nothing by inserting directly. What matters is that no insert, from a bug or a stolen request
  token, adds an entry no chain step links.
  - A trigger on `ledger_entries` (`ledger_entries_linked`) checks every insert by the tenant role. It takes the
    workspace's ledger lock (the same key as the function's, so the two are one queue), reads the last entry, and refuses
    a row whose previous hash is not that entry's hash, or whose hash is not the chain step.
  - The chain step is computed as sha256 of the text, byte for byte what `digest()` gives in the function.
  - It stamps the time, as the function does through the column default.
  - The function, its grants and its chain step do not change. Neither does row-level security, which still refuses
    another workspace. The platform's own roles (migrations, the service role) write as before.
- **I4: the agent sends again on its own only what one approval may pay.** This covers a payment the agent never sent,
  in either path: the AP stage's resend of a `matched` payable, and the contractor stage's resend of a `verified`
  milestone, whose intent has no transfer.
  - It is weighed against the workspace's figure as the stages weigh a new payment: a EURC payable at the USDC value
    its latest decision recorded, and one whose value is not known is held.
  - The approval that pays a payment above the figure is stored too, as used, once the claim is made (after the earlier
    one is marked used, before anything is sent). Two people's approvals of the payment are then on record.
  - Above the figure, the agent sends it again only when two people's approvals of this payment were used to pay it:
    two different people, agreeing with its amount, currency and address. Otherwise it holds the payable or milestone
    for two people, with "[not resubmitted: payments above *X* USDC need two approvals — held for two people to
    approve]".
  - The ledger entry (`ap_reconcile` or `milestone_reconcile`) records `notResubmittedBecause: "workspace.two_approvals"`.
  - Two people then approve it on Approvals or Contractors, which looks for the earlier send first, as for any send
    Circle never answered.

## 3. Declined

- **A definer append and a revoked INSERT** (the first version of I3). The migration runner replays every file, each in
  its own transaction. Its replays of 0016 and 0017 recreate the append as its caller's while the tenant has no INSERT,
  so tenant appends would fail until 0018 granted it back, on every run. The trigger needs neither, and no older
  migration changes.

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
- I4 holds before the send is looked for on Circle, as the high-risk and address holds do: one Circle did take is
  recorded when two people approve it, since their approval looks for it first.
- Used approvals of an earlier attempt of the same payment count toward I4: two people did approve that payment.
- A `db:migrate` from a checkout without 0077 leaves the trigger in place: the runner never drops what a later file
  created.

## 6. Tests

- `tests/payment-integrity-migration.test.ts` (PGlite):
  - the claim with an approval of another amount, another currency, or by someone no longer allowed to approve;
  - `approvers_besides` for another workspace, and with a null;
  - a tenant's insert that does not follow the last entry, or whose hash is not the chain step, refused;
  - a linked one taken as the function would, at the time of the insert;
  - appends through the function linked as before;
  - another workspace still refused, and the platform's own roles still writing;
  - all of it again after every migration is replayed.
- `tests/approvals.test.ts`, `tests/milestone-decisions.test.ts`: the paying approval stored as used, after the claim.
- `tests/two-approvals-migration.test.ts`: another workspace now answers null.
- `tests/control-cycle.test.ts`, `tests/milestone-reconcile.test.ts`: the agent's resend above the figure, held without
  two used approvals, sent with them, and sent as before with no figure.
