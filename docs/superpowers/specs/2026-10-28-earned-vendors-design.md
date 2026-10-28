# Autonomy ladder, step 2: earned vendors

Date: 2026-10-28. Status: built (AL11-AL20); step 3 planned (AL21-AL30, below). Branch `feat/earned-vendors`. Needs
migration 0146.

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
shadow mode every payment still waits for a verdict. Step 3, the next pull request, is where an owner may let the agent
pay an earned vendor on Arc testnet without waiting.

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
  - Agreed Hold and Ask for details verdicts neither count nor break. A decision with no verdict neither counts nor
    breaks. A decision that is itself a break never counts, even with an Agree.
  - A verdict whose decision or bill is not among the facts read is left out, as in the ladder (AL3).
- **AL13. Who can earn it.** A counterparty with role `vendor`, not sample data, whose `payment_limit` (the risk-tiered
  figure the agent enforces) is above 0. Any other payee "cannot", saying why: no payment limit, or not a vendor.
- **AL14. Pure.** `src/lib/earned-vendors.ts` works the statuses out from facts the report already reads, with three
  fields added to that read (the verdict's time; the payee's role and payment limit). Browser-safe, with no read of its
  own, as AL6. `earnedVendors(facts, streak)` returns one status per non-sample payee with a decision on its bills, in
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
    changes none of the stage's outcomes.

  With no rule it reads the rule and stops: one read. Only the rule change that turned it off also signs
  `vendor_earned_lost` (`rule_off`) for every vendor recorded earned. One that could not be signed then stays recorded
  earned, which nothing shows while no rule is set; once a rule is set again it is signed as lost, or left earned if it
  still is.

  A vendor recorded earned that is no longer earned is signed lost with why: the break, when it came after the vendor
  was recorded earned (`disagreed`, `flagged`, `code_stop`, with the decision and rule); `no_payment_limit` or
  `not_a_vendor`; otherwise `rule_changed`.
- **AL17. Rule changes are signed strictly.** `earned_vendor_rule_changed` `{ by, from, to }`, actor `human`, domain
  `system`. The signing key is checked before anything is written (`assertLedgerCanSign`); if the entry still cannot be
  signed, the change is put back and refused ("The change could not be signed in the ledger, so nothing changed. Try
  again in a moment."), so no rule is in force without its entry.
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

## Data: migration 0146

`supabase/migrations/0146_earned_vendors.sql`, two columns on the existing tenant table `approval_policies` (its grants
and policies are 0076's and stay as they are):
- `earned_vendor_streak smallint`, null by default, with the named check
  `approval_policies_earned_vendor_streak_check` (null, or 5 to 50);
- `earned_vendor_payments boolean not null default false`, with the named check
  `approval_policies_earned_vendor_payments_check` (never true without a rule). Read only from step 3.

Both checks are added only when missing, so the file runs again unchanged. It ends with `notify pgrst, 'reload schema'`
and a commented down section. No table, function or index.

Before 0146 runs, `readEarnedVendorRule` reads the missing columns (42703, PGRST204) as no rule and not ready: Settings
says "Not available in this workspace yet.", the report leaves the block out, and every sync stops at its one read.

## Ledger entries

| Action | Actor / domain | Detail |
|---|---|---|
| `earned_vendor_rule_changed` | human / system | `{ by, from, to }`, each a whole number from 5 to 50, or null for no rule |
| `vendor_earned` | system / compliance | `{ counterpartyId, streak, agreed, evidence, from, to, since, trigger }`: `evidence` the counted decisions' entry seqs, newest first, at most 50; `from` and `to` the oldest and newest of their times; `since` the break before them `{ kind, at, decisionSeq, rule }` or null; `trigger` `verdict`, `rule` or `cycle` |
| `vendor_earned_lost` | system / compliance | `{ counterpartyId, streak, because, decisionSeq, rule, trigger }`: `streak` null when the rule is off; `because` `disagreed`, `flagged`, `code_stop`, `rule_changed`, `rule_off`, `no_payment_limit` or `not_a_vendor`; `decisionSeq` and `rule` for a break, else null |

Both per-vendor kinds are added to the counterparty entries the evidence read collects (`COMPLIANCE_ACTIONS`). No
detail carries an email.

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
- `src/lib/workspace-report-read.ts`: the verdict's `decided_at`, the payee's `role` and `payment_limit`.
- `src/app/actions/verdicts.ts` and `runApStage` (`src/lib/agent/orchestrator.ts`): the sync after a verdict and at
  the stage's start.
- Tests: `tests/earned-vendors.test.ts`, `tests/earned-vendors-store.test.ts`, `tests/earned-vendors-migration.test.ts`,
  `tests/earned-vendors-actions.test.ts`, `tests/earned-vendors-panel.test.tsx`, `tests/earned-vendors-view.test.tsx`,
  `tests/earned-vendors-cycle.test.ts`, `tests/verdict-actions.test.ts`. The Quality Lab (39 of 39) and the shadow
  replay (37 same, 9 cannot rebuild, 0 wrong) are unchanged: their fake answers no rule, so the sync stops at its read.
- Docs: the shadow mode guide's **Earned vendors** and **What the ledger records**; the report guide's **Earned
  vendors** and **Start the live slice**; the API changelog; ARCHITECTURE.md (shadow mode); CHANGELOG.

## Step 3 (planned, next pull request)

Planned, not built. Nothing below exists in this pull request.

- **AL21. The switch.** `earned_vendor_payments` (already in 0146), off by default: an owner turns it on in the Earned
  vendors section after a confirmation. Refused without a rule, on Arc mainnet, while a cycle runs, before 0146 and
  without an agent spending limit. Signed strictly as `earned_vendor_payments_changed` and put back if the entry fails.
- **AL22. What it would change.** In a shadow workspace with the switch on, a `pay` decision that passed every check,
  for a vendor earned now and recorded earned, would be carried out on Arc testnet as in a live workspace instead of
  held for a verdict, counted against the agent's spending limit. Schedules, holds, flags, requests and milestones stay
  as they are.
- **AL23. Never more than live.** An earned vendor's bill would end as it would in a live workspace on the same facts;
  any other vendor's as today.
- **AL24. Fail closed.** Anything unreadable or missing (rule, switch, facts, record, signing key, spending limit) and
  every payment waits for a verdict, as today.
- **AL25. Lost in the stage.** A decision that breaks it during a stage takes the status away for the rest of that
  stage.
- **AL26. At most 3 waiting.** With 3 of a vendor's payments made on its own still waiting for a verdict, its next one
  waits.
- **AL27. The record of each payment.** The `ap_pay` entry would carry `earned: { recordSeq, streak, agreed }`.
- **AL28. Words.** Every in-product sentence saying nothing is paid in shadow mode until a person agrees would name the
  exception while the switch is on.
- **AL29. The report says who paid.** A payment made on the agent's own decision stays "The agent" after a later Agree.
- **AL30. Quality Lab.** Four scenarios and two invariants: never more than live, and nothing changes for vendors that
  have not earned it.

## What it does not do

- Let the agent do anything it could not do before (AL20).
- Count verdicts outside shadow mode, on milestones, or any agreement but verdicts (AL1).
- Carry a status to the live slice's workspace on Arc mainnet: the picker only marks it, and the owner still ticks.
- Change the ladder's rows, the console's shadow mode panel, /open or the shared report.
