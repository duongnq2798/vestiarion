# A person's order for which bill first

Date: 2026-10-18. Status: built. Branch `feat/priority-order`. No migration. Builds on
2026-10-18-cash-priority-design.md.

## Why

When the cash cannot cover every bill due soon, the agent chooses the order and says why. A person often knows
something the bills do not: a supplier who already called, a service that matters more this month. Until now the only
way to change the agent's choice was to pay or hold bills one at a time in Approvals, and the next plan could choose
again. The order should be visible where the plan is, and a person should be able to set it.

## The rules (decided here)

- **O1. Where.** The **Payment plan** tab shows **Which bill first** whenever the agent's latest order still covers the
  bills competing for the cash now (the same bills: its fingerprint matches).
  - Each bill shows its place, payee, amount, due day, whether it is paid first or waits, and the reason.
  - It also says who set the order (the agent, or a person with their email) and when, and what the written policy's
    order would pay first.
- **O2. Who.** Owners, admins and approvers (`approval.decide`), as for approving the plan's days. Every other member
  reads it. Not in shadow mode, where there is no order. As for a plan's day (payment plan P10), whoever entered a bill
  does not move it into the part the cash covers on their own, unless they are the only approver.
- **O3. Setting it.** A person moves bills up or down and saves. Before signing, the server reads the competing bills
  again, with the same code the cycle uses.
  - It refuses when they changed (a different fingerprint), when a newer order was signed since the one shown (its
    signing time is sent back with the order), when the order does not name each of them once, or while a cycle is
    running. The page then shows the plan as it is now, and the refusal is toasted.
  - It then signs `cash_priority_set` as the person (actor `human`, `decisionMode: "person"`, `by`), with the order,
    which bills the cash covers today, the written policy's order and the order it replaced. It starts a cycle.
- **O4. The agent keeps it.** While the bills are the same, each cycle applies the person's order to the cash there is
  (`planFrom`), with no model call, even when the cash changes how far it reaches.
  - When bills leave it (paid, or past the window) and every bill left is one it had, at the same amount and due day,
    the order goes on for them (`carriedOrder`), signed again for those bills as the person's (`carried: true`, not told
    again in the activity feed).
  - When a bill is added or one changes, the agent orders them again, and the model is given the person's earlier order
    for the bills it had (`aPersonsEarlierOrder`) to keep unless their facts changed. The person may set it again.
  - Code still keeps bills only while the cash lasts: a person's order never pays more than the wallet holds, and every
    payment passes every check.
- **O5. Reopening.** A bill the person moved into the part the cash covers, held for want of cash, is reopened and decided
  now. The reopen guard now skips only a bill already kept under the same bills and held again (a guardrail's hold),
  never one that waited under them.
- **O6. Told.** The activity toasts, Telegram and Slack say "A member set which bills the cash goes to first: pays …
  first; … waits." A bill it makes wait is held with "a person chose to pay others first", not the agent's reason, which
  may contradict the order; under a person's order the Payment plan shows the agent's reasons as its earlier notes.

## Not in this change

- Pinning one bill first for good, across changes to the bills.
- Choosing an order on the Approvals screen.
