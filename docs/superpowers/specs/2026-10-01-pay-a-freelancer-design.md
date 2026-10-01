# Pay a freelancer in one step

Date: 2026-10-01. Status: in progress (design decided under the standing autonomy grant; rulings
below carry their cost if wrong).

## 1. Why

Paying someone for delivered work takes six separate steps today:

1. add a counterparty with a limit;
2. make a payee link and copy it;
3. send the link yourself;
4. add a milestone or invoice;
5. verify it;
6. confirm the address once the payee has added it.

The first real users we are onboarding are small businesses paying a freelancer for a batch of
work (social posts, thumbnails). Each extra step is a place they stop. Two more gaps sit inside
that path:

- nobody is told when the payee adds their address;
- a live workspace's agent can try to pay a contractor who has no address yet. The live provider
  refuses the transfer, and the milestone ends up held.

## 2. What it does

On **Contractors**, an owner or admin fills one form, **Pay a freelancer**:

- name;
- email (optional);
- what they delivered;
- amount in USDC;
- a link to the work (optional).

**Set up payment** then:

1. Adds the freelancer as a contractor, with the amount as their payment limit, and screens them.
2. Adds a milestone for the work, already verified by the person filling the form, who is
   confirming that the work was delivered.
3. Makes a payee link and emails it to the freelancer, or shows it to copy when no email was given
   or email is not configured.

When the freelancer adds their address through the link:

1. Each member who can confirm addresses gets an email asking them to confirm it on
   Counterparties.
2. Confirming starts a cycle (`address_confirmed`).
3. The agent releases the milestone within a minute, paid on Arc testnet.

## 3. Rulings

- **R1 — a milestone, not an invoice.** Pay for delivered work is what milestones are for, and
  milestones need no purchase order. An invoice without a purchase order goes to `request_info`
  under the AP policy. Cost if wrong: the payment shows on Contractors rather than AP / AR.
- **R2 — the person setting up the payment verifies the work**, with the note "Delivered work
  confirmed when the payment was set up". This is the same `verify_milestone_manual` they could
  make by hand: the business attests delivery. It is recorded as theirs.
- **R3 — the limit is the amount.** The agent can then release this payment, and a later, larger
  milestone for the same person is held until someone raises the limit.
- **R4 — the address still needs a member's confirmation** (payee links R1: a link that leaks
  cannot move money on its own). The flow does not skip it; it emails the people who can do it.
- **R5 — a live contractor with no address waits.** In a live workspace, the contractor stage
  skips a verified milestone whose contractor has no address yet: no model call and no ledger
  entry, as it already does for an unconfirmed address. A sandbox pays it simulated, as before.
- **R6 — always a new counterparty.** The form is for paying someone new. Paying someone already
  on file is the existing milestone form. Cost if wrong: a duplicate name on Counterparties.
- **R7 — emails are best effort.** A send that fails or is not configured never fails the setup.
  The link is shown to copy, and the form says whether it was emailed. The freelancer's email is
  not stored; only the ledger records that a link was sent to an address.
- **R8 — no new ledger actions or fields.** The setup writes the existing `create_counterparty`,
  `create_milestone`, `verify_milestone_manual` and `payee_link_created` entries, in that order.
  The API and webhooks are unchanged, so no changelog entry is needed.

## 4. Pieces

- `src/lib/pay-freelancer.ts`: `setUpFreelancerPayment(input)`, which composes the writes.
- `src/app/actions/pay-freelancer.ts`: the action, which needs `records.write`.
- `src/components/intake/PayFreelancerForm.tsx`: the form, and the link once it is made.
- `src/lib/email/payee-link.ts`: the freelancer's email; `src/lib/email/payee-address.ts`: the
  confirm-it email; and the send after `submitPayeeAddress` succeeds.
- `src/lib/agent/orchestrator.ts`: the R5 skip.
- `content/docs/guides/pay-a-contractor.mdx`: a section for the one-step path.

## 5. Tests

- Library against fake PostgREST:
  - the four writes and their ledger entries, in order;
  - the limit equals the amount;
  - the milestone is verified;
  - the link is returned, and emailed when an email is given;
  - a failed email still returns the link.
- Action: authorization; validation messages; the result shape.
- Form: renders its fields; shows the link and whether it was emailed.
- Notification: after a payee submits, members who can confirm are emailed; nothing is emailed for
  an unchanged address; a failed send does not fail the submission.
- R5: a live contractor without an address waits; a sandbox one does not.

## 6. Rollout

No migration. In testnet-2:

1. Pay a freelancer 1 USDC with the partner's own second email.
2. Open the link and add an address.
3. Check that the confirm email arrives.
4. Confirm the address.
5. Expect the milestone to be paid on Arc testnet within a minute.

Record the outcome in §7.

## 7. Rollout record

(pending)
