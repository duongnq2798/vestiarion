# Autonomy ladder, step 1: agreement by decision and by vendor

Date: 2026-10-26. Status: built. Branch `feat/autonomy-ladder`. No migration.

## Why

Shadow mode measures one number: how often a person agreed with the agent's decisions. The workspace report then
suggests a live slice, and an owner ticks the vendors to pay in real USDC on Arc mainnet. One overall rate does not
say where the agent already decides as the owner would. An agent that pays well and holds badly, or that is right about
one supplier and wrong about another, shows the same 80%.

Step 1 of the autonomy ladder measures agreement per category, with the number of verdicts behind each figure, so an
owner can see where the agent already decides as they would before handing it more. It only measures. It grants
nothing, changes no setting and moves no money.

## The rules (decided here)

Code comments and test names cite the ids, for example "(autonomy ladder AL4)".

- **AL1. One definition of agreement.** Agreement here is the shadow-mode verdict and nothing else: a row of
  `decision_verdicts` (migration 0084), Agree or Disagree on one of the agent's decisions. It is counted with
  `agreementRate` (`src/lib/verdict-rate.ts`), the function the console's shadow mode panel, the workspace report, the
  shared report and /open already use. Other agreement figures exist and are not this one:
  - the model against the written policy (`agreedWithReference` on every AP decision entry, the research note's figure);
  - the agent against what the business recorded paying (`compareActuals`, the report's **Agent and business agreed**);
  - /open's flags upheld and approval resolutions (`open_outcomes`).

  Where the figures show, the definition is said in words, and the report names **Agent vs what really happened** as
  the different figure, since both sit on the same page.
- **AL2. Two categories.**
  - **By decision kind**: the action of the decision the verdict is about, which is what `decision_verdicts.agent_action`
    stores (`giveVerdict` copies it from the entry). In plain words, reusing the product's own: Pay (`ap_pay`),
    Schedule (`ap_schedule`), Hold (`ap_hold`), Flag for review (`ap_flag_fraud`; "flag it for review" is how the
    decision trail and the landing say it) and Ask for details (`ap_request_info`; "Asked for details" in the agent's
    activity).
  - **By vendor**: the payable's counterparty. The live slice already moves vendors one at a time from shadow mode to
    Arc mainnet (`src/lib/live-slice.ts`), so a vendor is the unit an owner can act on today.

  There is no bill category anywhere in the schema, and none is invented.
- **AL3. Which verdicts count.** The same ones as the report's **Your verdicts**: verdicts on the agent's decisions
  about the workspace's payables (`buildReport`'s filter in `src/lib/workspace-report.ts`), with sample data left out.
  - A verdict whose decision or payable is not among the facts read is not counted.
  - Sample counterparties are left out always, even while the report falls back to counting sample data because the
    workspace has no real bill yet. A sample vendor is not one an owner can hand anything to, and the live slice never
    carries one. In every other case the rows add up to the report's **Your verdicts**.
  - n is the number of verdicts given in a category. Each decision takes one verdict, and a bill decided twice can carry
    two, so the figures say "verdicts" (decisions), never "bills".
- **AL4. Too few to tell.** Below `VERDICTS_BEFORE_LIVE` (5, the shadow mode done-when that the report's first
  readiness step already uses) verdicts in a category, a row shows its count and **Too few to tell yet**, never a
  percentage: its `rate` is null and `enough` false. At 5 or more it shows the rate and the agreed count. There is no
  other threshold. Nothing says or implies that the agent may now do more anywhere: no colour for a good rate, no
  "ready" mark.
- **AL5. A stable order, said.**
  - Decision kinds come in the agent's own order (`AGENT_DECISION_ACTIONS`: Pay, Schedule, Hold, Flag for review, Ask
    for details), only those with a verdict. An action outside that list, which no verdict can carry today, would come
    last by its id, labelled "Another decision".
  - Vendors come most verdicts first, then by name, then by id, so equal rows never swap between two loads. The report
    says "Most verdicts first".
- **AL6. Pure, and no read of its own.** `src/lib/autonomy-ladder.ts` is pure and browser-safe:
  - `ladderVerdicts(facts)` joins each verdict to its decision's kind and its payable's counterparty (id, name, sample
    flag);
  - `autonomyLadder(verdicts)` returns the totals and the rows `{ key, label, given, agreed, disagreed, rate, enough }`
    by kind and by vendor.

  The report page already reads every verdict, every agent decision and every payable with its counterparty, inside
  the workspace's scope and a page at a time (`readReportFacts`). The ladder is worked out from those same facts, so it
  adds no query, no migration and no SQL function. It has no failure of its own: when those facts cannot be read, the
  report shows its section's error state, as it always has (workspace report R7), rather than a ladder with rows
  missing. Nothing crosses workspaces, and nothing reaches /open.
- **AL7. In the report.** Under **Before a live slice**, after its steps and above **Start the live slice**, while shadow
  mode is on (the steps show only then):
  - a heading, **How often you agreed, by decision and by vendor**;
  - the definition in one paragraph (AL1, AL3, AL4);
  - two tables, **By decision** and **By vendor**, each with its count of verdicts and either the rate with "N of M" or
    **Too few to tell yet**.

  Before any verdict on a real bill it says **No verdict on a real bill yet**. The steps, their numbering and their
  ticks are unchanged. On a phone each row stacks its name and count over its figure, as the currency report's tables
  do, so nothing scrolls sideways at 375 px.
- **AL8. In the live slice's vendor picker.** Each vendor's own row says, beside its checkbox, how often the owner
  agreed with the agent on its bills: "83% agreed, from 6 verdicts", "2 verdicts: too few to tell yet", or "No verdicts
  yet". The vendors keep their order (by name) and every existing word. A vendor with no payment limit, which cannot go,
  shows it too. A line above the list says where the figures come from.
- **AL9. Not in the shared report.** The shared report keeps its one agreement figure, which these rows add up to
  (AL3). Step 1 is a decision aid for the owner about what to hand over, not a claim to an outside reader. A shared copy
  already lists each decided bill's newest decision with its verdict. Per-vendor rows would also need the share's name
  rules (labels or names) applied a second time, for a figure an outsider cannot act on.
- **AL10. Nowhere else.** Not /open (whose figures are cross-workspace aggregates with their own privacy rules and
  their own method text), not the console's shadow mode panel, and not the weekly brief.

## Later steps (planned, not built)

Planned, so that step 1's rows are read for what they are: a measurement.
- A later step may let an owner move one decision kind or one vendor from "waits for my verdict" to "the agent pays on
  its own, within its limits", inside a workspace.
- It would use the rows here as the evidence shown at that moment.

None of this exists. Today the only ways to give the agent more room are the ones the product already has: turning
shadow mode off, the live slice, a payee's payment limit and the agent's spending limit.

## Where it is

- `src/lib/autonomy-ladder.ts`: `ladderVerdicts`, `autonomyLadder`, `LadderRow`, `AutonomyLadder`, `decisionKindLabel`.
- `src/components/vx/AgreementLadder.tsx`: the report's block (AL7).
- `src/components/vx/WorkspaceReport.tsx`: `ReportReadiness` takes `ladder` and shows the block after its steps.
- `src/components/vx/LiveSliceStart.tsx`: `agreement`, the per-vendor rows (AL8).
- `src/app/o/[slug]/report/page.tsx`: works the ladder out from the report's facts while the readiness steps show,
  and passes it to both.
- Tests: `tests/autonomy-ladder.test.ts` (the pure rules), `tests/autonomy-ladder-view.test.tsx` (the report's block
  and the page's wiring), `tests/live-slice-ui.test.tsx` (the picker).
- Docs: the shadow mode guide's **See how often you agreed** and **Before a live slice**; the report guide's **Your
  verdicts**, **How often you agreed** and **Start the live slice**, with their quoted words held to the code by
  `tests/docs-guides.test.ts`; ARCHITECTURE.md (shadow mode, the workspace report); README's Report line and shadow
  mode row; CHANGELOG.
- The report guide's picture of **Before a live slice** (`report-readiness.png`) is drawn without the ladder, as the
  docs shot renders the steps alone; the guide describes the ladder in words.

## What it does not do

- Grant, suggest or switch on anything. No setting reads these rows.
- Count verdicts on milestones (no code writes them), or any agreement but verdicts (AL1).
- Change the console's shadow mode panel, which counts every verdict row in the workspace (`readShadowSummary`).
