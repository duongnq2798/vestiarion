# Autonomy ladder, step 2: earned vendors

Date: 2026-10-28. Status: built. Step 2 (AL11-AL20), branch `feat/earned-vendors`, needs migration 0146. Step 3
(AL21-AL30, below), branch `feat/earned-vendor-payments`, needs no migration of its own: 0146 holds its switch.

## Why

Step 1 (`docs/superpowers/specs/2026-10-26-autonomy-ladder-design.md`, AL1-AL10) measures how often a person agreed with
the agent in shadow mode, by decision kind and by vendor. A rate says how often, not whether the agreement is recent or
unbroken: a vendor at 90% may have had its one Disagree yesterday.

Step 2 lets an owner say what "trusted" means for a vendor, as a rule, and shows with evidence which vendors meet it:
**N agreed verdicts in a row** on the agent's decisions to pay or schedule the vendor's bills, counted again from zero
after anything that should shake that trust. Every change of the rule, and every change of a vendor's status, is a
signed ledger entry, so the record of who was trusted, from when, and on which verdicts, exists before anything is ever
granted on it.

Step 2 grants nothing. No code reads a vendor's status to decide a payment: the agent decides exactly as before, and in
shadow mode every payment still waits for a verdict. Step 3 is where an owner may let the agent pay an earned vendor on
its own, in shadow mode on Arc testnet, with the verdict given after (AL21-AL30).

## Words used here

- **Counted decision**: an agent decision entry `ap_pay` or `ap_schedule` about one of the vendor's bills, with an Agree
  verdict (`decision_verdicts`, migration 0084).
- **Break**: something after which the count starts again (AL12).
- **Earned now**: what the facts say under the rule today.
- **Recorded earned**: the vendor's newest `vendor_earned` / `vendor_earned_lost` entry is `vendor_earned`.

Code comments and test names cite the ids, for example "(earned vendors AL12)".

## The rules

- **AL11. The rule.** One per workspace: `approval_policies.earned_vendor_streak`, a whole number from 5 to 50, null for
  no rule (the default). 5 is `VERDICTS_BEFORE_LIVE`, under which the ladder says too few to tell (AL4); 50 keeps the
  evidence of one entry short.
  - An owner sets it (`approval.policy`), in Settings, under **Earned vendors**, right after **Shadow mode**.
  - Refused on Arc mainnet (shadow mode runs on Arc testnet only, so there are no verdicts there), while a cycle runs
    (the cycle signs statuses as it starts), and before migration 0146 ("Not available in this workspace yet.").
  - Allowed whether or not shadow mode is on: verdicts given before it was turned off still count.
  - Turning it off also writes `earned_vendor_payments` false, which 0146's check requires (AL21).
- **AL12. What earns it.** For a rule `N`, a vendor is earned when at least `N` Agree verdicts were given on the agent's
  decisions to **pay or schedule** its bills, every one on a decision made after the vendor's last break.
  - A **break** is the newest of:
    - a Disagree on any decision about one of its bills, at the time the verdict was given
      (`decision_verdicts.decided_at`), so a late Disagree on an old decision breaks it now;
    - a decision on one of its bills that ended **flagged** (the model's flag, or code's duplicate or high-risk rule),
      at the decision's time;
    - a decision on one of its bills that a **check on the vendor or its bill** stopped, at the decision's time: any
      `counterparty.*` or `invoice.*` rule, or `obligation.duplicate_reference` (`breaksEarning`).
  - The workspace's own limits and rails never break it: `workspace.*` (two approvals, the spending limit, the limit on
    Arc), `project.budget_exceeded`, `fx.*`, `bridge.*`, `treasury.*`, `payout.bank_needs_person`, a cash shortfall, the
    pause, and the shadow-mode hold itself.
  - Agreed Hold and Ask for details verdicts neither count nor break. A decision with no verdict does not count; it
    breaks only if it ended flagged or a check on the vendor or its bill stopped it, as above, verdict or not. A
    decision that is itself a break never counts, even with an Agree.
  - A verdict whose decision or bill is not among the facts read is left out, as in the ladder (AL3).
- **AL13. Who can earn it.** A counterparty with role `vendor`, not sample data, whose `payment_limit` (the risk-tiered
  figure the agent enforces) is above 0. Any other payee "cannot", saying why: not a vendor (`not_a_vendor`); screened
  high risk (`high_risk`, from `risk_level`), since screening keeps a high-risk payee's limit at 0 whatever its owner set
  (`paymentLimitForRisk`), so asking for a limit would be wrong; or no payment limit (`no_payment_limit`).
- **AL14. Pure.** `src/lib/earned-vendors.ts` works the statuses out from facts the report already reads, with four
  fields added to that read (the verdict's time; the payee's role, screening and payment limit). Browser-safe, with no
  read of its own, as AL6. `earnedVendors(facts, streak)` returns one status per non-sample payee with a decision on its bills, in
  the ladder's vendor order (AL5): `earned` (how many agreed in a row, the counted decisions newest first, from and to,
  the break before them), `counting` (how many of `N`, the break) or `cannot` (why).
- **AL15. The record.** Each change of a vendor's status is one signed entry, `vendor_earned` or `vendor_earned_lost`,
  actor `system`, domain `compliance`, written strictly (`appendLedgerEntry`). A status whose entry could not be signed
  is not recorded, and the next sync signs it. Statuses are not stored anywhere else.
- **AL16. When statuses are signed.** `syncEarnedVendors` signs only the difference between what the facts say now and
  each vendor's newest signed status; a second run in a row signs nothing. It runs:
  - after each verdict is kept (`giveVerdictAction`), best effort: a failure is logged and never undoes the verdict;
  - inside the rule change (AL17);
  - at the start of the AP stage of a shadow workspace with bills to decide, best effort: a failure is logged and
    changes none of the stage's outcomes. A stage with nothing to decide signs nothing, so the report says a vendor
    earned but not signed yet "is recorded at your next verdict, or when the agent next decides a bill". From step 3
    the stage's gate runs it (AL22), and a sync that fails grants none (AL24).

  With no rule it reads the rule and the record, never the facts, and signs `vendor_earned_lost` (`rule_off`) for every
  vendor still recorded earned: the rule change that turned it off does, and a loss it could not sign is signed by
  whichever sync runs next, as AL15 says. Setting a rule where there was none first runs that sync while there is still
  no rule, and is refused ("The change could not be signed in the ledger, so nothing changed. Try again in a moment.")
  with nothing written when that sync fails or leaves a vendor recorded earned, so no vendor's earned status runs on
  across a time with no rule into the new one. Before 0146 it reads the rule and stops.

  A vendor recorded earned that is no longer earned is signed lost with why: the break, when it came after the vendor
  was recorded earned (`disagreed`, `flagged`, `code_stop`, with the decision, and the rule that flagged or stopped it);
  `high_risk`, `no_payment_limit` or `not_a_vendor`; otherwise `rule_changed`.
- **AL17. Rule changes are signed strictly.** `earned_vendor_rule_changed` `{ by, from, to }`, actor `human`, domain
  `system`. The signing key is checked before anything is written (`assertLedgerCanSign`); if the entry still cannot be
  signed, the change is put back and refused ("The change could not be signed in the ledger, so nothing changed. Try
  again in a moment."). As the mirror address, it is put back only from its own write (an update guarded by the value
  it wrote), so a change another owner made since stays.
  - Should the put-back fail too, that is logged and the owner reads "That did not work. Try again in a moment.",
    never that nothing changed, and Settings is read again, so it shows the rule in force.
  - That rule is then in force without its entry until it is signed: every change first reads the newest
    `earned_vendor_rule_changed`, and when its `to` is not the rule in force (or there is none and a rule is in force),
    signs the missing entry before anything else, `from` that `to` and `by` the owner asking. Asking for the rule in
    force again signs it rather than being refused as unchanged ("It is set to that already."), as the mirror address
    is recorded when asked again; a different change signs it first, so the ledger's rules follow one another. A
    missing entry that cannot be signed refuses the change, with nothing written.
- **AL18. In the report.** Under **How often you agreed**, while shadow mode is on (the readiness steps show): **Earned
  vendors**.
  - With no rule: "No rule is set. An owner sets one in Settings, under Earned vendors."
  - With one: the rule in words, then each vendor of the ladder's **By vendor** rows with its status: earned with the
    dates and **The verdicts behind it** (each decision's day, kind, amount and Agreed); earned but not signed yet;
    how many of `N` since what broke it; or why it cannot.
  - A vendor shows as earned only when it is both earned now and recorded earned.
  - The ladder's own rows keep no colour and no mark (AL4 kept). The rule and the record are read best effort: a read
    that fails, or a database without 0146, leaves the block out.
- **AL19. In the live slice picker.** "Earned under your rule" beside the agreement words of a vendor that is earned now
  and recorded earned, with a line above the list saying what it means. Display only: nothing is ticked.
- **AL20. Grants nothing.** No code reads a vendor's status, or `earned_vendor_payments`, to decide a payment.
  - The ladder's sentence "It only measures: nothing here changes what the agent may do." stays true.
  - Not on /open, the shared report, or the console's shadow mode panel (AL9, AL10).
  - The three entry kinds reach webhooks and `GET /api/v1/ledger`, so the API changelog lists them.
  - Step 3 ends this for one case, and only behind the owner's switch: the AP stage's gate reads the status and the
    switch to pay an earned vendor on its own in shadow mode (AL22). Being earned, with the switch off, still changes
    nothing; the ladder's sentence becomes "It only measures. What earning changes is under Earned vendors." once a
    rule is set (AL28).

## Data: migration 0146

`supabase/migrations/0146_earned_vendors.sql`, two columns on the existing tenant table `approval_policies` (its grants
and policies are 0076's and stay as they are):
- `earned_vendor_streak smallint`, null by default, with the named check
  `approval_policies_earned_vendor_streak_check` (null, or 5 to 50);
- `earned_vendor_payments boolean not null default false`, with the named check
  `approval_policies_earned_vendor_payments_check` (never true without a rule). Read only from step 3 (AL21).

Both checks are added only when missing, so the file runs again unchanged. It ends with `notify pgrst, 'reload schema'`
and a commented down section. No table, function or index.

Before 0146 runs, `readEarnedVendorRule` reads the missing columns (42703, PGRST204) as no rule and not ready: Settings
says "Not available in this workspace yet.", the report leaves the block out, and every sync stops at its one read.

## Ledger entries

| Action | Actor / domain | Detail |
|---|---|---|
| `earned_vendor_rule_changed` | human / system | `{ by, from, to }`, each a whole number from 5 to 50, or null for no rule |
| `vendor_earned` | system / compliance | `{ counterpartyId, streak, agreed, evidence, from, to, since, trigger }`: `evidence` the counted decisions' entry seqs, newest first, at most 50; `from` and `to` the oldest and newest of their times; `since` the break before them `{ kind, at, decisionSeq, rule }` or null; `trigger` `verdict`, `rule` or `cycle` |
| `vendor_earned_lost` | system / compliance | `{ counterpartyId, streak, because, decisionSeq, rule, trigger }`: `streak` null when the rule is off; `because` `disagreed`, `flagged`, `code_stop`, `rule_changed`, `rule_off`, `high_risk`, `no_payment_limit` or `not_a_vendor`; `decisionSeq` the decision of a break, else null; `rule` the rule that flagged or stopped it, else null (always for `disagreed`, and for the model's own flag) |
| `earned_vendor_payments_changed` (step 3) | human / system | `{ by, from, to }`, booleans: the owner's switch (AL21) |
| `ap_pay` (step 3, existing) | agent / ap | gains `earned: { recordSeq, streak, agreed }` when the agent carried it out on its own for an earned vendor (AL27); `shadow: true` stays |

A vendor's newest `vendor_earned` or `vendor_earned_lost` entry is its last signed status; while no rule is in force
(the newest `earned_vendor_rule_changed` has `to: null`), no vendor is earned, whatever that entry says. The newest
`earned_vendor_rule_changed` names the rule in force, except after a change that could be neither signed nor put back,
until an owner's next change signs it (AL17); a status signed meanwhile carries the rule it was signed under in
`streak`. The entries are read through `GET /api/v1/ledger`, webhooks and the report. A bill's evidence does not list
them: the evidence read keeps only the entries its steps cite, and a payment made on its own names the `vendor_earned`
entry behind it in its own `ap_pay` entry (`earned.recordSeq`, AL27), which the evidence cites. No detail carries an
email. While no rule is in force the switch is off too (0146's check), whatever its newest
`earned_vendor_payments_changed` says; the rule's turning off signs the switch's entry after its own (AL21).

## Where it is

- `supabase/migrations/0146_earned_vendors.sql`.
- `src/lib/earned-vendors.ts` (pure): `EARNED_STREAK_MIN`, `EARNED_STREAK_MAX`, `COUNTED_ACTIONS`, `breaksEarning`,
  `earnedRuleFromRow`, `earnedVendors`, `earnedChanges`, and the words Settings, the report and the entries use.
- `src/lib/earned-vendors-store.ts` (server): `readEarnedVendorRule`, `changeEarnedVendorRule`, `readEarnedFacts`,
  `readEarnedRecord`, `syncEarnedVendors`.
- `src/app/actions/earned-vendors.ts`: `setEarnedVendorRuleAction`.
- `src/components/EarnedVendorsPanel.tsx`: the Settings section.
- `src/components/vx/EarnedVendors.tsx`: the report's block; `ReportReadiness` shows it after the ladder.
- `src/components/vx/LiveSliceStart.tsx`: `earned`, the picker's mark.
- `src/lib/workspace-report-read.ts`: the verdict's `decided_at`, the payee's `role`, `risk_level` and `payment_limit`.
- `src/app/actions/verdicts.ts` and `runApStage` (`src/lib/agent/orchestrator.ts`): the sync after a verdict and at
  the stage's start.
- Step 3: `src/lib/agent/earned-gate.ts` (`earnedGateFor`, `earnedGate`, `NO_EARNED`, `EARNED_PAID_NOTE`), built in
  `runApStage` and asked in `decideApPayable`; `changeEarnedVendorPayments` and `setEarnedVendorPaymentsAction`; the
  switch in `EarnedVendorsPanel`; `earnedPayments` in `ShadowModePanel`, `capabilityOf`, `shellStatus` and the
  workspace status; `earned` on a bill's `Decision` (`map.ts`), `earnedPaidWhy` and "Give your verdict" on Bills;
  `onItsOwn` in the report's facts and `decidedBy`; `waiting` and `paused` on an earned status.
- Tests: `tests/earned-vendors.test.ts`, `tests/earned-vendors-store.test.ts`, `tests/earned-vendors-migration.test.ts`,
  `tests/earned-vendors-actions.test.ts`, `tests/earned-vendors-panel.test.tsx`, `tests/earned-vendors-view.test.tsx`,
  `tests/earned-vendors-cycle.test.ts`, `tests/verdict-actions.test.ts`. The Quality Lab (39 of 39) and the shadow
  replay (37 same, 9 cannot rebuild, 0 wrong) are unchanged: their fake answers no rule and an empty record, so the
  sync signs nothing.
- Step 3's tests: `tests/earned-gate.test.ts`, `tests/ap-stage-earned.test.ts` (on `tests/support/ap-harness.ts`, whose
  `earned` hands the stage a gate), `tests/earned-vendors-paid-view.test.tsx`, the switch in
  `tests/earned-vendors-store.test.ts`, `tests/earned-vendors-actions.test.ts` and `tests/earned-vendors-panel.test.tsx`,
  waiting in `tests/earned-vendors.test.ts`, and `tests/quality-lab-earned.test.ts`. The Quality Lab is 43 of 43; the
  shadow replay is unchanged.
- Docs: the shadow mode guide's **Earned vendors** and **What the ledger records**; the report guide's **Earned
  vendors** and **Start the live slice**; the API changelog; ARCHITECTURE.md (shadow mode); CHANGELOG.

## Step 3: earned vendors paid on their own, in shadow mode

Built (AL21-AL30), branch `feat/earned-vendor-payments`, on step 2. No migration: the switch is 0146's
`earned_vendor_payments`. Before 0146 runs, the rule and the switch read as off and not ready, so step 3 is inert.

Step 3 adds one owner's switch. With it on, in a shadow-mode workspace on Arc testnet, an AP `pay` decision about a
vendor that is earned now and recorded earned, which passed every guardrail and every check after them, is carried out
as a live workspace carries it out, instead of being held for a verdict. The person gives the verdict after. In shadow
mode the business still pays its real supplier itself: what the agent pays this way is the bill's amount in test USDC
on Arc testnet, to the address on file, or simulated in a workspace whose payments are.

- **AL21. The switch.** `approval_policies.earned_vendor_payments`, off by default. An owner (`approval.policy`) turns it
  on in Settings, inside **Earned vendors**, under **Pay earned vendors on their own**, after a confirmation that says
  what it pays (test USDC on Arc testnet, or simulated) and that at most 3 of a vendor's payments wait at once; and off
  with **Make them wait for my verdict**, at once. The switch shows only under a rule.
  - On is refused without a rule ("Set a rule first: how many agreed verdicts in a row a vendor needs.") and without
    an agent spending limit ("Set the agent's spending limit first, in Settings: the agent's own payments always count
    against it."), read with `readOutflowBudget`. On or off is refused on Arc mainnet, while a cycle runs, before 0146,
    and unchanged ("It is set to that already."), in step 2's words.
  - Signed strictly as `earned_vendor_payments_changed` `{ by, from, to }`, actor `human`, domain `system`, as the rule
    is (AL17): the key is checked before anything is written; a change whose entry cannot be signed is put back, only
    from its own write (an update guarded by the value it wrote), and refused; one that could not be put back either is
    logged, answered "That did not work. Try again in a moment.", and in force without its entry, so every change first
    reads the newest `earned_vendor_payments_changed` and, when it does not name the switch in force, signs the missing
    entry by the owner asking; asking for the switch in force again then signs it rather than being refused.
  - Turning the rule off turns the switch off in the same write (0146's check), as step 2 built it; the rule's change
    then also signs `earned_vendor_payments_changed` `{ from: true, to: false }` after its own entry. The rule is off
    either way, so that entry is signed best effort, and a failure is signed before the switch's next change.
  - Toasts: "The agent pays earned vendors on its own now, and you give your verdict after." / "Earned vendors'
    payments wait for your verdict again."
- **AL22. What it changes, and only that.** At the start of the AP stage of a shadow-mode workspace with bills to decide,
  the gate (`earnedGateFor`, `src/lib/agent/earned-gate.ts`) replaces step 2's bare sync: it signs the statuses as the
  sync does (AL16), then grants each vendor that is earned now and recorded earned, while the switch is on. It is asked
  at exactly one place, where the stage would hold a `pay` that passed every guardrail and obligation check for a
  verdict (`heldBecause: "shadow_verdict"`): with a grant, the payment takes the live path, `payApInvoiceIfNotPaused`,
  at the bill's amount to the address on file, counted against the agent's spending limit and enforced by the limit on
  Arc where the workspace has one. Its reasoning ends " [an earned vendor under the owner's rule: paid without waiting
  for a verdict; give yours after]", and the cycle's line reads "{name}: paid on its own, an earned vendor ({amount}
  USDC)". Schedules, holds, flags, requests for details, milestones (still held in shadow mode), the follow-up, the
  reconcile, Approvals and the verdict gate are unchanged. A payment held for a verdict before the switch was turned
  on stays held: only the agent's next decisions are paid this way. A live workspace never builds the gate.
- **AL23. Never more than live, never more for others.** For an earned vendor, a decision ends as it would in a live
  workspace on the same facts; for any other vendor, as it did before. The two Quality Lab invariants pin both (AL30).
  Known difference: the cash priority plan does not run in shadow mode, so an earned vendor's bill can be paid where a
  live workspace's plan would keep the cash for another bill; each bill's own cash check still holds it when the cash
  does not cover it.
- **AL24. Fail closed.** No vendor is granted for the stage when the workspace is on Arc mainnet, shadow mode is off,
  the rule or the switch is off, unreadable or missing (before 0146), no agent spending limit is set, the facts or the
  record cannot be read, or the vendor's `vendor_earned` entry could not be signed (it is then not recorded earned).
  Every payment then waits for a verdict, as before. The gate never throws into the stage: a failure is logged and
  grants none.
- **AL25. Lost in the stage.** A decision in the stage about a vendor the gate granted that breaks its status (flagged,
  or a check on the vendor or its bill stopped it, `breaksEarning`) takes the grant away for the rest of the stage at
  once, and `vendor_earned_lost` (`trigger: "cycle"`, `because` `flagged` or `code_stop`, `decisionSeq` the decision's
  entry, `rule`) is signed right after the decision's entry, best effort: when it cannot be, the next sync signs it. A
  Disagree given while a stage runs takes effect at the next stage.
- **AL26. At most 3 waiting.** `earnedVendors` counts, for an earned vendor, its payments the agent made on its own that
  are paid or on their way with no verdict yet (`waiting`), and only those made since shadow mode last started, since a
  verdict can no longer be given on one before; with 3 (`EARNED_WAITING_MAX`) it is `paused`, and its next payment
  waits for a verdict as before, until a person gives one. Each payment the gate lets through in a stage counts toward
  the 3 at once. The status stays earned; no entry is signed for the pause.
- **AL27. The record of each payment.** The `ap_pay` entry gains `earned: { recordSeq, streak, agreed }`, the
  `vendor_earned` entry that recorded the vendor earned, the rule, and the agreed verdicts in a row at the stage's
  start. It keeps `shadow: true` and has no `heldBecause` unless the live path held it (the pause, the cash). A verdict
  is offered on it as on any decision, and records only.
- **AL28. Words.** While the switch is on, every in-product sentence that says the agent pays nothing in shadow mode
  until a person agrees names the exception: Settings' **Shadow mode** ("..., except vendors that earned it under your
  rule, which it pays on its own and you review after."), the toast and the `shadow_mode_started` summary when shadow
  mode is turned on again, the workspace status's Payments and Shadow mode rows (`earnedPayments`, read by
  `shellStatus` in shadow mode, and by `capabilityOf`), and the report's **Earned vendors** ("The agent pays an earned
  vendor on its own, and you give your verdict after."). With the switch off it says "Earning changes nothing the agent
  may do unless an owner lets it pay earned vendors on its own, in Settings.", as Settings' explainer does. Once a rule
  is set, the ladder's last sentence reads "It only measures. What earning changes is under Earned vendors." Public
  copy (landing FAQ and Safety, Studios, README, the guides) says the exception once, plainly. On Bills, a bill paid
  this way reads "An earned vendor: paid without waiting for your verdict." and its next step is "Give your verdict"
  while one can be given.
- **AL29. The report says who paid.** A payment made by the agent's own decision (`onItsOwn`, read from
  `detail.earned`) is "agent" in `decidedBy` even after a later Agree. The report counts them (`paid.onItsOwn`), and its
  **Needed a person** tile, which in shadow mode says "In shadow mode, every payment waits for your verdict", says
  instead how many the agent paid on its own once there is one.
- **AL30. Quality Lab.** Four scenarios in the `switches` group (`switches-earned-vendor-paid`,
  `switches-not-earned-waits`, `switches-earned-address-changed`, `switches-earned-above-two-approvals`), the cap raised
  from 40 to 44 (Quality Lab QL2), and two invariants (`tests/quality-lab-earned.test.ts`, over the runner factored into
  `tests/support/quality-lab-runner.ts`): every scenario of a live workspace ends the same in shadow mode with the
  switch on and its vendor earned (both runs with an agent spending limit where the scenario sets none), and every
  scenario ends the same in shadow mode with the switch on and its vendor not earned. 43 scenarios, all right. The
  shadow replay runs with shadow mode off, so it builds no gate: 37 same, 9 cannot rebuild, 0 wrong, unchanged.

### Where step 3 differs from the plan

- The reasoning note and the Bills line do not name Arc testnet: a new workspace in shadow mode has no wallet, and its
  payments, these included, are simulated. The switch's confirmation says which (`earnedPaymentsConfirm`).
- `EarnedGate` has a third method, `paid`, so each payment the gate lets through counts toward the 3 in the same stage
  (AL26); the plan counted only the payments read as the stage started.
- `waiting` counts only payments made since shadow mode last started: a verdict cannot be given on one before, so
  counting it would pause the vendor for good.
- Turning the rule off also signs the switch's own entry (AL21), so the ledger names the switch off once it went off
  with the rule; an entry that could not be signed then is signed before the switch's next change.
- The bill's evidence chain does not cite the `vendor_earned` entry as a fact of its own: its decision step cites the
  `ap_pay` entry, whose `earned.recordSeq` names it, and the entry is read through the ledger and the report. Citing
  it in the chain is left for later.

## What it does not do

- Let the agent do anything it could not do before, with the switch off (AL20), or anything on Arc mainnet, in a live
  workspace, or past any rule or check, with it on (AL22-AL24).
- Count verdicts outside shadow mode, on milestones, or any agreement but verdicts (AL1).
- Carry a status to the live slice's workspace on Arc mainnet: the picker only marks it, and the owner still ticks.
- Change the ladder's rows, the console's shadow mode panel, /open or the shared report.
