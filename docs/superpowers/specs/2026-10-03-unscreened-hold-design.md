# Hold payments to a counterparty never screened

Date: 2026-10-03. Status: implemented on `fix/hold-unscreened`. Decided under the standing autonomy grant; each
ruling carries its cost if wrong.

## 1. The problem

On 2026-10-02 at 22:13 UTC the OpenSanctions trial key reached its quota (50 requests a month), and every screening
since answered HTTP 429. A sweep that cannot screen keeps each counterparty's previous verdict, which is right for a
counterparty screened yesterday. A counterparty added while screening fails has no previous verdict: it stays
`unscreened`, its limit stays the configured one (`paymentLimitForRisk` lowers it only for medium and high), and no
guardrail looks at `unscreened`. So the agent could pay a counterparty no one had ever screened.

On 2026-10-03 all 22 counterparties of live workspaces had a live verdict, so nothing was paid that way; the gap is
for whoever adds one while screening is down.

## 2. The rule

The agent pays nothing to a counterparty that has never been screened. Its payable or milestone is held with the rule
`counterparty.unscreened`, and decided again once screening gives a verdict.

## 3. Rulings

- **R1 — only never screened.** The rule reads `risk_level = 'unscreened'`: a counterparty with no verdict at all. One
  whose re-screen failed keeps its previous verdict, as before.
- **R2 — order.** After a duplicate and after high risk, which are stronger reasons, and before the address and the
  limit: the limit of an unscreened counterparty means nothing yet.
- **R3 — `pay` and `schedule` alike,** as the other counterparty checks: scheduling is a commitment to pay.
- **R4 — milestones too.** A release to an unscreened contractor is held with the same rule.
- **R5 — a person may still pay.** Approve and pay, and Pay now on a held milestone, are not refused for it, as for a
  payment held over its limit: that is a person's decision, signed with their name. Cost if wrong: a person can pay an
  unscreened counterparty; the card says it is not screened yet.
- **R6 — it comes back by itself.** The follow-up stage already reopens a held payable or milestone when the
  counterparty's risk differs from the one it was decided on; `unscreened` becoming any verdict is such a change.
- **R7 — not the counterparty's fault.** A hold for this rule is one of ours, like a hold for our own limits: it does
  not lower the counterparty's performance score.
- **R8 — the Counterparties page says so.** A vendor or contractor with an address and no verdict reads
  **Not screened yet** instead of **Ready to pay**.

## 4. Records

- `guardrailRule` gains `counterparty.unscreened` (API and webhooks: the changelog lists it).
- No migration.

## 5. Rollout

1. Merge.
2. With screening working again, check the next sweep re-screens the counterparties that were due.
3. Optional: add a counterparty while screening fails (or in a test), and see its payable held with the rule.
