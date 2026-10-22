# Waiting for the accountant (2026-10-22)

## Why

Accountant co-sign (`2026-10-22-accountant-cosign-design.md`) lets an owner make the accountant the second key on bills
above the two-approvals figure, and lets the accountant confirm changed addresses. An accountant who keeps the books of
several businesses found that work only by opening each workspace's Approvals and Counterparties. The accountant console
(`/accountant`) is where they look first, and it listed every held bill to an accountant as "Payment waiting for a
decision", "Waiting on an owner, admin or approver", even one they could co-sign.

## Rules

**AQ1. One shared answer to "can this person co-sign this bill now?"** `src/lib/cosign-state.ts` holds a pure function
and a batch read. The pure part lives in `src/lib/cosign-state-rules.ts`, which `cosign-state.ts` re-exports, as
`payee-lock.ts` re-exports `payee-lock-rules.ts`: the approval card is a client component and imports the rule and its
words without the server's modules. Both the console and the Approvals card use them, so neither promises a co-sign that
`approveAndPay({ cosign: true })` would refuse.
- **Pure.** `cosignState(facts, viewerId)` returns one of:
  - `{ state: "can_cosign", above, approvals }`, with the figure and how many others approved it (0 or 1), for the
    console's words;
  - `{ state: "cosigned" }`: the viewer's co-sign stands;
  - `{ state: "not_needed" }`: below the figure, a transfer already exists, or approvals already suffice. Approvals
    suffice with two standing approvals, or with one standing approval that is itself a co-sign by another accountant,
    since accountants fill one approval at most;
  - `{ state: "blocked", reason }`, the refusal `approveAndPay` meets first, in its order, in plain words, one of:
    - "Waiting for a verdict in shadow mode";
    - "Someone disagreed with it in shadow mode", which `verdictGate` refuses as `verdict_disagreed`;
    - "Being decided right now";
    - "Screened high risk";
    - "The payee is frozen";
    - "Confirm the address first", for an unconfirmed address under the payee lock;
    - "Waiting for the payee lock's wait to end".
- **Batch read.** `readCosignStates(viewerId, payables)` reads in the workspace in scope only (`db()`, never the service
  role). For many bills it makes a handful of requests, each only as far as an answer is still open:
  - the figure with the payee lock in one read (`readPaymentPolicies`; a failure throws, and the caller names the part
    as unread);
  - a EURC bill's recorded USDC value (`ledger_entries_for_targets`, EURC bills only), or unknown, which counts as above,
    as the agent weighs it;
  - the bills' payment intents (`transferExists`);
  - standing approvals (`twoApprovalsFacts("invoice", …)`, nobody left out);
  - which lone standing approval is a co-sign: `deciders_among` for those givers, once (before migration 0138 the
    function is missing and nothing co-signs);
  - frozen payees (`readFrozenPayees`);
  - while the payee lock is on, the payees paid to a bank account (exempt, as `approveAndPay` exempts them) and every
    other payee's address state in one read, with `payeeLockRefusal`'s semantics;
  - shadow-mode verdicts (`verdictHolds`, a new read beside `awaitingVerdicts` that also lists the bills someone
    disagreed with, from the same two requests), for held or claimed bills only.

  It never reads quotes, balances or Circle. It never calls `listWaitingPayables`.
- **What it leaves to the card.** A first payment from which the accountant is left out, because they confirmed an
  address no member answers for alone, is not computed; nor is a bill the accountant entered (an accountant adds no
  records, so only after a role change), nor the refusals a held bill rarely meets (payments switched off, a sanctioned
  address, a payee off the network). The card's own refusal then explains it.

**AQ2. The console's new kinds.** In `src/lib/accountant/triage.ts`:
- `cosign`: "Waiting for your co-sign" / "Bills waiting for your co-sign". The permission is `approval.cosign`, doing
  "co-sign it", so the item reads "You can co-sign it". Placed right after `decision`.
- `confirm_address`: "Address to confirm" / "Addresses to confirm". The permission is `approval.cosign` for an accountant
  and `approval.decide` otherwise (`permissionFor(kind, limit, role)`); doing "confirm it", so the item reads "You can
  confirm it". Placed after `cosign`.

Both have a tone in `AccountantConsole.tsx` KIND_TONE (`agent`, `held`).

**AQ3. Refine, never duplicate.** In `decisionItems` (`src/lib/accountant/read.ts`):
- **Which items.** Only when the viewer's role in that workspace is `accountant` and `readAccountantCosign` is on,
  `readCosignStates` is read for the payable rows (the select gains `counterparty_id` and the payee's `risk_level` and
  `address`, which bind an approval and are never shown); milestones are never co-signed. A row whose state is
  `can_cosign` becomes kind `cosign` instead of `decision` or `past_decide_by`. It keeps the same `since`, so a bill past
  its decide-by day still ages from that day, and the same href (`/o/{slug}/approvals#` + `approvalAnchor`).
- **Detail.** The item's detail says the figure ("Payments above 500 USDC need two approvals.") and whether one approval
  is given ("One approval is given." or "No one has approved it yet."), then the decide-by words the decision item had.
- **Other states.** `cosigned` stays a decision item whose detail leads with "You co-signed it. An owner, admin or
  approver pays it." A `blocked` state stays a decision item whose detail leads with the reason. Both keep the decision
  item's own words after, so its decide-by day is not lost. `not_needed` stays as it is today.
- **Failure.** If the co-sign read fails, the plain decision items stand, and "bills to co-sign" is added to the
  workspace's unread list.
- **Counts.** One item per bill, keyed `{slug}:{kind}:{id}`. Card counts, age buckets and "you can act on" count it once.

**AQ4. Addresses to confirm.** A new part, "addresses to confirm", in `readWorkspaceTriage`, for a viewer who may
confirm: `approval.decide`, or an accountant while co-signing is on.
- **What it reads.** Counterparties with `address_changed_at` set, newest change first, up to ROWS (200), filtered with
  `addressUnconfirmed`. Frozen ones (`readFrozenPayees`, none before migration 0137) are unfrozen first: to an
  accountant or an approver they say "Waiting on an owner or admin of this workspace" and are not actionable; to an owner
  or admin, who unfreezes (`records.write`), they say "You can unfreeze it once you have checked with them, then confirm
  it".
- **The item.** `since` is `address_changed_at`; href `/o/{slug}/counterparties#counterparty-{id}` (`counterpartyPath`);
  the title is the payee's name. There is no amount, and the detail never includes the address: "Its address changed on
  Oct 12, 2026. The agent pays nothing to it until someone confirms it.", or for a frozen payee, that its contact said
  they did not make the change and it is unfrozen before it is confirmed.
- **Read once.** The co-sign setting is read once per workspace, for an accountant only, and shared by both parts as a
  promise, so the parts still run side by side. A failure there means co-signing is treated as off, and "the co-sign
  setting" is added to the unread list.

**AQ5. The Approvals card agrees with the console.** The approvals page reads `readCosignStates` for the waiting
payables when `canCosign`, best effort, and passes each card its state.
- `ApprovalCard` shows Co-sign only for `can_cosign`.
- For `blocked` it shows the reason in place of the button; "Confirm the address first" links the payee's row on
  Counterparties. For `not_needed` it shows nothing of the co-sign, and the card's usual "Ask … to decide it" follows.
- `cosigned` keeps "You co-signed it. …".
- When the states could not be read, the card offers Co-sign on any bill above the figure, as before, and the server
  refuses what it must.

This fixes the card, which offered Co-sign on a bill held for a shadow-mode verdict that the server then refused with
`verdict_needed`.

**AQ6. The hand-off and the ledger.**
- Co-signs (`approval_given` with `detail.cosign === true`) count among a person's decisions in the hand-off's Decisions
  section: the read asks for `approval_given` with `cosign:detail->>cosign` and keeps only the co-signs, so a first
  approval that paid nothing yet is still left out. A co-sign carries `cosign: true` in the JSON and `co-sign` in the
  CSV's detail column.
- The new kinds appear in the hand-off's open items, with their titles.
- Nothing new is signed.

**AQ7. Tenancy and privacy.**
- Every read is the workspace's own, through `withOrg`, as today; no member list is read to name who approved.
- No payee address appears in an item.

**AQ8. Copy.**
- The /accountant header, and its docs-shots twins (the accountant and onboarding states), mention bills to co-sign and
  addresses to confirm.
- The accountants guide's queue table gains both kinds, quoting the titles exactly; tests/docs-guides pins them, the
  blocked reasons and the header.
- The guide's "Co-sign a larger bill" section says the console lists them, and that Co-sign shows only where it counts.

## Not in this change

- An email or chat message to the accountant: a separate item.
- A getting-started step for co-signing.
- Milestones.
- Re-shot pictures of the console: the sample data (`src/app/docs-shots/accountant-fixture.ts`) gains a bill to co-sign
  and an address to confirm in Harbor Bakery, for the next shoot.

## Tests

- `tests/cosign-state.test.ts`: pure `cosignState`, every state and reason, the server's order when several apply,
  another accountant's standing co-sign and a EURC bill with no recorded value; `readCosignStates` against fakeSupabase:
  only tenant tables and functions, each naming the workspace, one read when two approvals are off, an approval that no
  longer agrees, before 0138, the payee lock (a bank-paid payee exempt, one address read), verdicts waiting and
  disagreed, a claim in progress, EURC weighing, a figure that cannot be read; `verdictHolds`.
- `tests/accountant-portfolio.test.ts`: an accountant in a co-sign-on workspace gets `cosign` items in place of
  `decision` ones, one per bill, read through the workspace's tenant token; a past decide-by day still ages it; a
  co-signed and a blocked bill say so; another role, or co-signing off, gets today's items without a co-sign read; a
  failed co-sign read leaves the decision items and names the part; an unread setting counts as off; address items, with
  frozen ones not actionable, and an owner's to unfreeze.
- `tests/accountant-triage.test.ts`: the new kinds' wording, rank and filters.
- `tests/approval-card-cosign.test.tsx`: Co-sign only for `can_cosign`, each blocked reason shown in its place, nothing
  for `not_needed`, the address link.
- `tests/accountant-handoff-build.test.ts`: a co-sign under Decisions, a first approval left out, the CSV label, the new
  kinds in the open items.
- `tests/docs-guides.test.ts`: the guide's quotes and the header copy on the page and its pictures.
