# Shadow mode SM1a: the switch, the hold, verdicts and the agreement rate

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A testnet workspace in shadow mode pays nothing without a person. Each agent decision gets a verdict, and
agreeing to a payment pays it on Arc testnet. The console shows how often people agreed.

**Architecture:**
- A one-row tenant table (`shadow_modes`) is the switch. The agent reads it once per stage, like the two-approvals
  figure.
- A payment that passes every guardrail is held with `execution.heldBecause: "shadow_verdict"`. It is not a guardrail
  block.
- Verdicts are rows in `decision_verdicts`, unique per decision entry, plus a signed `decision_verdict` entry.
- Agree and pay runs `approveAndPay`. Disagree can return or reject the payable.
- Cards read verdicts by entry seq.

**Tech stack:**
- Next.js app router server actions;
- Supabase (PostgREST, RLS, tenant role `vestiarion_tenant`);
- vitest with the fake PostgREST in `tests/support`.

**Spec:** docs/superpowers/specs/2026-10-07-shadow-mode-design.md (S1–S5, S9).

## Global Constraints

- Shadow mode is for Arc testnet only. On Arc mainnet it is refused: "Shadow mode runs on Arc testnet."
- Who may act:
  - turning it on or off takes `approval.policy` (owner);
  - a verdict takes `approval.decide` (owner, admin, approver).
- Neither switch runs while a cycle runs.
- A disagreement needs a reason of 1–280 characters. An agreement may carry one of up to 280.
- A payment held in shadow mode is not a guardrail block: `guardrailBlocked` stays false.
- A verdict entry names its payable `subjectId`, never `invoiceId`.
- Product copy says "Arc testnet" plainly, with no "no real money" disclaimers. Code, docs and commits stay in English.
- Migration `0084_shadow_mode.sql`:
  - is idempotent;
  - follows 0076's RLS and grant pattern;
  - is run by the partner before merge.

## Review Focus

1. A verdict given twice, from two tabs, writes one row and one entry. The second answers with what was given.
2. A verdict on an entry that is not an agent decision is refused, as is one on a decision written before shadow mode
   started.
3. Agree and pay on a payable that is no longer held for a verdict (paid, returned, or rejected meanwhile) records the
   agreement and pays nothing.
4. Turning shadow mode off leaves payables held for a verdict held, for a person to decide.
5. The follow-up stage never reopens a payable held for a verdict, whatever changed.

## Tasks

### Task 1: Migration 0084

**File:** `supabase/migrations/0084_shadow_mode.sql`.
- `shadow_modes(org_id uuid pk → orgs on delete cascade, currency text not null check (~ '^[A-Z]{3}$'), started_by uuid →
  auth.users on delete set null, started_at timestamptz not null default now())`.
- `decision_verdicts(id uuid pk default gen_random_uuid(), org_id uuid not null → orgs on delete cascade, entry_seq
  bigint not null, subject text not null check in ('invoice','milestone'), subject_id uuid not null, agent_action text
  not null, verdict text not null check in ('agree','disagree'), reason text check (null or 1..280 chars), decided_by
  uuid → auth.users on delete set null, decided_at timestamptz not null default now(), unique (org_id, entry_seq))`.
- On `invoices`, add `original_currency text`, `original_amount numeric(24,6)`, `fx_rate numeric(24,12)`, `fx_source
  text` and `fx_at timestamptz`, with a check that all five are null or all are set:
  - currency `~ '^[A-Z]{3}$'`, never USDC or EURC;
  - amount > 0;
  - rate > 0.
- On `counterparties`, add `mirror_wallet_id text`.
- Both tables get RLS, `tenant_isolation` and `tenant_isolation_guard` policies, and grants exactly as 0076.

**Test:** `tests/migration-0084.test.ts` reads the file and asserts:
- each statement is guarded (`if not exists`, or `drop … if exists` before create);
- both tables enable RLS and carry both policies;
- the five invoice columns and their check are present.

### Task 2: The switch

**Files:**
- `src/lib/shadow-mode.ts`;
- `src/app/actions/shadow-mode.ts`;
- `src/components/ShadowModePanel.tsx`;
- `src/app/o/[slug]/settings/page.tsx`.

**Interfaces:**
- `export interface ShadowMode { currency: string; startedAt: string; startedBy: string | null }`
- `export async function readShadowMode(orgDb: OrgDb): Promise<ShadowMode | null>`. It throws when unreadable, as
  `readTwoApprovalsAbove` does.
- `export async function startShadowMode(input: { actorId: string; currency: string }): Promise<ShadowMode>`. It
  refuses:
  - `invalid_currency`: not three letters, or USDC or EURC;
  - `mainnet`;
  - `already_on`;
  - `cycle_running`.

  It upserts the row and writes `shadow_mode_started` `{ by, currency }` (actor human, domain system).
- `export async function endShadowMode(input: { actorId: string }): Promise<void>`. It refuses `already_off` and
  `cycle_running`, deletes the row, and writes `shadow_mode_ended` `{ by, currency }`.
- `export class ShadowModeError extends Error { code }`, with messages in plain words.
- `SHADOW_CURRENCIES`: the panel's list, VND first, then USD, EUR, GBP, SGD, THB, IDR, PHP, MYR, JPY, KRW, INR, AUD,
  CAD. Any three-letter code is accepted on the server.

**Tests:** `tests/shadow-mode.test.ts`, with the fake PostgREST. It covers:
- start, then read;
- start twice is refused;
- end, then read gives null;
- end twice is refused;
- mainnet is refused;
- `cycle_running` is refused;
- USDC is refused;
- the ledger entries.

Panel markup goes in `tests/shadow-mode-panel.test.tsx`:
- off: the currency select and **Turn on shadow mode**;
- on: "Shadow mode is on, in VND, since …" and **Turn off shadow mode**;
- a viewer who is not the owner sees the state and no button.

### Task 3: The hold

**Files:**
- `src/lib/agent/orchestrator.ts`: the AP stage and the milestone stage.
- `src/lib/agent/follow-up.ts`, together with the decision facts read in the orchestrator.
- `src/components/vx/map.ts`: the held reason.

**Rules:**
- AP stage:
  - Read `shadow` once per stage, like `twoApprovalsAbove`; the input override is `input.shadow`.
  - In `decideApPayable`, when `ctx.shadow` is set, the action is `pay` and the guardrail did not block, send nothing.
  - The status is `held`, with the reasoning suffix " [shadow mode: held for a person to agree; nothing is paid until
    they do]".
  - The ledger gets `execution.heldBecause: "shadow_verdict"`.
  - `metrics.recordInvoice(status, false)`.
- Milestone stage: a release that passes every check is held the same way, with `heldBecause: "shadow_verdict"`.
- Follow-up:
  - `DecisionFacts.heldForVerdict` comes from `heldBecause`.
  - `planFollowUp` and `planMilestoneFollowUp` never reopen one; they wait or escalate by age.
- Card: a held payable whose entry says `shadow_verdict` reads "Shadow mode: nothing is paid until a person agrees."

**Tests:**
- `tests/shadow-mode-hold.test.ts`, with orchestrator AP and milestone fixtures as the two-approvals tests build them:
  - a pay decision in shadow mode is held and sends no transfer;
  - outside shadow mode it pays;
  - a guardrail block keeps its rule.
- `tests/follow-up*.test.ts` additions: a held-for-verdict payable with changed facts waits.

### Task 4: Verdicts

**Files:**
- `src/lib/verdicts.ts`;
- `src/app/actions/verdicts.ts`.

**Interfaces:**
- `export type Verdict = "agree" | "disagree"`
- `export const AGENT_DECISION_ACTIONS = ["ap_pay", "ap_schedule", "ap_hold", "ap_flag_fraud", "ap_request_info"]`
- `export async function giveVerdict(input: { actorId: string; entrySeq: number; verdict: Verdict; reason?: string;
  then?: "pay" | "return" | "reject" }): Promise<{ given: { verdict: Verdict; reason: string | null }; already: boolean;
  payment?: { status: string; note: string } }>`

  The checks run in this order:
  1. Shadow mode is on, or `not_in_shadow`.
  2. The entry exists in this workspace, its actor is the agent, its action is in the list, and it names an
     `invoiceId`; or `not_a_decision`.
  3. `entry.ts >= startedAt`, or `before_shadow`.
  4. The reason rules (`reason_required`, `reason_too_long`).
  5. Insert the row. On a unique conflict, return the existing verdict with `already: true` and do nothing else.
  6. Write `decision_verdict` `{ by, entrySeq, subject: "invoice", subjectId, agentAction, verdict, reason }`.
  7. Then:
     - `pay`: only with agree, and only when the payable is still held with `shadow_verdict` as its newest decision's
       `heldBecause`; then `approveAndPay`.
     - `return` or `reject`: only with disagree; they run `returnInvoice` or `rejectInvoice` with the reason.
- `export async function readVerdicts(orgDb: OrgDb, entrySeqs: number[]): Promise<Map<number, { verdict: Verdict;
  reason: string | null; by: string | null; at: string }>>`
- `export async function readAgreement(orgDb: OrgDb): Promise<{ agreed: number; disagreed: number }>`
- `src/components/vx/map.ts` `matchingEntry` skips `decision_verdict`.

**Tests:** `tests/verdicts.test.ts` covers each refusal, the once-only behaviour, agree-and-pay calling `approveAndPay`
only when held for a verdict, disagree with return or reject, and the agreement count.

### Task 5: What a person sees

**Files:**
- `src/components/vx/types.ts`: `Decision.verdict`.
- `src/components/vx/map.ts`: build the verdict view from the newest agent decision entry.
- `src/components/VerdictControl.tsx`.
- `src/components/ApprovalCard.tsx`.
- Console and invoices pages.
- `src/components/ShadowModeSummary.tsx`.

**View:**

```ts
export interface VerdictView {
  entrySeq: number;
  agentAction: string;
  given: { verdict: "agree" | "disagree"; reason: string | null } | null;
  /** Shadow mode is on, the decision came after it started, and the viewer may decide payments. */
  open: boolean;
  /** Held for this verdict: Agree pays. */
  heldForVerdict: boolean;
}
```

**Rules:**
- Card footer:
  - given: "You agreed." or "You disagreed: {reason}";
  - otherwise, if open: **Agree** and **Disagree**;
  - if heldForVerdict: **Agree and pay** and **Disagree**. The Disagree dialog asks for a reason (required) and offers
    **Decide it again later** and **Do not pay it**.
- ApprovalCard: for a payable held for a verdict, show the verdict control instead of Approve, Reject and Return.
- Console: the shadow panel shows "You agreed with N of M decisions (P%)." and "K decisions wait for your verdict." It
  appears only in shadow mode.

**Tests:**
- `tests/verdict-control.test.tsx` covers the markup in each state.
- Additions to the map tests: the view is built from the agent entry, and a newer `decision_verdict` entry does not
  replace the card.

### Task 6: Docs

- `content/docs/guides/shadow-mode.mdx` is a new guide:
  - what it is;
  - turning it on;
  - verdicts;
  - Agree and pay;
  - the rate;
  - messages.
  It is linked from the guides nav, and its quoted strings go in `tests/docs-guides.test.ts`.
- `content/docs/changelog.mdx` gets an entry for:
  - `shadow_mode_started` and `shadow_mode_ended`;
  - `decision_verdict`;
  - `ap_pay` with `execution.heldBecause: "shadow_verdict"`;
  - the milestone hold.
- ARCHITECTURE gets a "Shadow mode" section. The README gets a line.
