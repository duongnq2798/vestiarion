# Plan: try a rule on past decisions

Spec: `docs/superpowers/specs/2026-10-10-policy-replay-design.md`. Test first at every step; commit and push after each.

1. **Pure replay** (`src/lib/policy-replay.ts`, `tests/policy-replay.test.ts`).
   - Parse a ledger entry into recorded facts (bill or milestone, amount and USDC value, counterparty, risk, recorded
     rule, payment made, shadow, cross-chain, contract check).
   - Stage orders for a bill and a milestone; fixed stages read from the recorded rule (P4).
   - Figure stages: payment limit for the recorded risk, two approvals, spending limit against running totals (P5).
   - Running totals per column with a low and high end, warm-up from the six days before the window, bills paid
     earlier (P6).
   - Outcomes, the five counts, `withCandidate`, `replaySummary` (P8).
2. **Reader** (`src/lib/policy-replay-read.ts`, `tests/policy-replay-read.test.ts`).
   - Parse the candidate with `parseLimitInput`, `parseTwoApprovalsForm`, `parseBudgetForm`; refuse an unchanged one.
   - Read figures in force, the window's agent decisions in pages, bill and milestone names; build the view.
3. **Apply path** (library and actions, with their tests).
   - `changeCounterpartyLimit`, `changeTwoApprovals`, `changeAgentBudget`: optional `expected` (stale refusal) and
     `replay` (in `detail.replay`).
   - The three actions: when the form carries `replayDays`, replay on the server, pass both.
   - `tryRuleAction` (read-only), authorized by the setting's permission.
4. **UI** (`src/components/RuleTrial.tsx`) in **Edit limit**, **Two approvals** and the spending limit dialog; a docs
   shot of a result; component test.
5. **Docs**: `content/docs/guides/try-a-rule.mdx` (nav, content map, quoted strings test), first-payment guide's three
   sections, README safety table, ARCHITECTURE.md, screenshot.
6. `npm run verify`, `npm run build`, browser check of the docs shot, PR.
