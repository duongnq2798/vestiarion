# A EURC payable decided again when the rate changes what held it

Date: 2026-10-05. Status: designed under the standing autonomy grant (partner, 2026-10-05: "Hoàn thiện tính năng tự động
quyết định lại khi có tỷ giá"); rulings carry their cost if wrong.

## 1. Why

A EURC payable is weighed at its USDC value from a Circle Stablecoin Service quote, and paid in EURC, swapping USDC for it
when the wallet is short (EURC invoices design, EURC swap spec). On Arc testnet that route comes and goes: on 2026-10-05 it
answered from 00:48 to before 01:38 UTC, then not, then again from 01:46.

When there is no quote, the agent holds the payable, as it must. Today nothing decides it again when the quote comes back.
A person has to press Return to agent in Approvals. Loto's 0.5 EURC in demo-wp was held twice this way (#1423, #1434).

The full cycle runs every six hours, and the route can be gone again before the next one.

## 2. Rulings

- **F1. What counts as held for FX.**
  - It is read from the decision's own ledger entry, never from its reasoning text.
  - A payable qualifies only when its status is `held` and its latest decision records one of four blockers:
    - `no_rate`: a EURC payable decided with `fx: null`, so it had no USDC value;
    - `no_swap`: the wallet was short of EURC, a rate was there, and no swap could be offered because Circle gave no
      route, no answer, an unreadable quote, or a minimum short of what was needed;
    - `swap_cost`: a swap was offered but cost more than the 3% cap;
    - `over_limit`: its USDC value at the quoted rate was above the counterparty's payment limit.
  - A swap refused because a payment had already started is not an FX blocker.
  - A hold the model chose on its own is not an FX hold when it had a rate, a swap within the cap, and a value within
    the limit: no fact code checks would change.
- **F2. What clears each blocker.** Each is a deterministic threshold on one fresh quote:
  - `no_rate`: a rate is quoted;
  - `no_swap`: a swap can be offered;
  - `swap_cost`: the offered swap costs at most the cap;
  - `over_limit`: the amount at the new rate is within the counterparty's current limit.

  A move of the rate that crosses no threshold changes nothing.
- **F3. Where it is decided.**
  - The follow-up stage of every cycle re-checks the FX-held payables, with one quote each, and reopens a payable whose
    blocker cleared.
  - Every cycle includes the schedule, an event, and a person's Run cycle.
  - The AP stage then decides the payable in the same cycle with its own fresh quote, as for any reopened payable.
  - The reopen rule is a pure function of the recorded decision, the fresh quote, the current limit and the clock.
- **F4. Started without a person.**
  - A watcher, `POST /api/agent/fx-watch`, runs every 5 minutes from GitHub Actions. It is protected by the agent's
    bearer token, like the tick.
  - For each live, unpaused workspace, it finds the FX-held payables due a re-check and asks for one quote each.
  - It runs a cycle with the event `fx_changed` only when a blocker cleared.
  - With nothing waiting or nothing changed, it runs no cycle, writes nothing and calls no model.
- **F5. No loop.**
  - A payable reopened for FX is not re-checked again for 30 minutes, by the watcher or the follow-up. A route that
    flaps between the reopen and the AP stage's own quote cannot reopen it every 5 minutes.
  - Each reopen stays in the ledger.
- **F6. What the ledger says.**
  - `invoice_reopened` gains `reevaluation`, in this shape:
    `{ trigger, previousDecision: { seq, action, guardrailRule }, before: { rate, usdcValue, swapCostPercent }, after: { rate, usdcValue, swapCostPercent, quotedAt } }`.
  - `trigger` is one of `rate_available`, `swap_available`, `swap_cost_within_cap` or `value_within_limit`.
  - The AP decision that follows in the same cycle gains
    `reevaluation: { reopenedSeq, trigger, previousDecisionSeq, previousAction }`.
  - The decision's own `fx` is the rate it was decided at.
  - `cycle_complete` lists `fx_changed` in `events` when the watcher started the cycle.
- **F7. Safety.**
  - The watcher writes nothing itself.
  - The follow-up's reopen is a compare-and-set on `held`, as today, so a person's Return to agent, approval or
    rejection made at the same moment wins.
  - One cycle runs per workspace at a time (`runAgentCycle` refuses a second).
  - A payment keeps its idempotent intent, and a swap keeps its keyed row.
- **F8. Scope.**
  - The watcher covers live workspaces only, as the schedule does. A sandbox's FX-held payables are re-checked by any
    cycle it runs.
  - A scheduled EURC payable is already re-checked on its day.
  - A paid one never is.
- **F9. Bounds.**
  - The watcher probes at most 3 payables per workspace per run, and the follow-up at most 5 per cycle, oldest first.
  - A probe asks once, with the quote's 10-second timeout; the AP stage keeps its four asks.
- **F10. Not covered here.**
  - EURC arriving in the wallet. That is a balance read, a separate re-check, and it is listed in the mainnet readiness
    review.
  - A model's own hold with a rate (F1).
  - The swap's USDC falling below what is due within 7 days, which is a cash fact.

## 3. Testing

- **Classification:** each blocker from a recorded decision. Started payments, model holds with a rate, paid and
  scheduled decisions, and USDC payables give none.
- **Clearing:** each threshold, both sides of it. The current limit is used, not the recorded one.
- **Cooldown:** a payable reopened for FX less than 30 minutes ago is not due; one reopened earlier is.
- **Follow-up:** reopens with the change sentence and `reevaluation`. It waits when the quote still fails.
- **AP stage:** the decision records `reevaluation` and its own `fx`.
- **Watcher:**
  - no cycle when nothing waits, when the quote fails, or when in cooldown;
  - one cycle with `fx_changed` when a blocker cleared;
  - paused workspaces skipped; a running cycle reported, not raised;
  - probe bounds respected.
- **Route:** bearer token and rate limit.

## 4. Rollout

- No migration. GitHub Actions uses the secrets the other workflows use.
- Proof: Loto's 0.5 EURC in demo-wp, held at #1434 with `fx: null`. Once the route answers, the watcher should start a
  cycle that reopens it (`rate_available`) and decides it.
