# Which bill first when the cash cannot cover them all

Date: 2026-10-18. Status: building.

## Problem

When the cash cannot cover every bill coming due, the agent pays them in date order: the bill due first takes the cash,
and the rest are held for want of cash. That is the written policy's answer, and it is often the wrong one. In our test
workspace on Oct 17 the wallet held 147.03 USDC against a 140 USDC render farm bill due Oct 22 and two 45 USDC bills,
GPU hosting and storage, due Oct 24 and 25. The render farm took the cash because it came first; the hosting and the
storage, the services a business stops without, were held. A finance person would have chosen differently, and said why.

The agent already acts on a shortfall: it holds a bill days ahead (#418), asks a supplier for more time (0128, 0130),
offers customers a discount to pay sooner (0129), and tells the owner how much is needed by when (#420). What it does not
do is choose which bills the cash it has should go to.

## Design

**P1. When there is a choice to make.** At the start of the AP stage, code gathers the bills competing for the same cash:
open USDC payables, pending, scheduled, or held for want of cash, due within 14 days or overdue, not paid to a bank
account. Committed cash is set aside first: payments in flight, verified milestones, which are released today, and a
scheduled bill a person moved from the payment plan, whose day is theirs. When
the competing bills add up to more than the operating USDC and the reserve left after that, there is a choice to make.
Otherwise nothing changes.

**P2. The model chooses the order; the written policy is its reference.** The model is given each bill: payee, amount,
due day and days left, whether it is a recurring payment and how often, its memo, an early-payment discount that would be
lost, its status, and what the supplier did with earlier requests for more time. It returns every bill, most important
first, with one sentence on each. The written policy's order (overdue first, then by due day, the smaller first on the
same day) is given as a reference, as everywhere else: follow it unless the facts say otherwise, and say why. Without a
model, the written policy decides. People read the reasons and the reasoning: they name each bill by its payee and what
it is, never by the short ref the model orders it by, and write amounts in USDC. A ref or a dollar amount the model
writes anyway is replaced with the bill's payee and amount in USDC before the plan is signed (live test, Oct 18). The
supplier history counts the requests the agent sent (`requestsTheAgentSent`), not requests "made", which the model read
as the supplier offering more time.

**P3. Code keeps it safe.** The order must name each bill once: code drops what it does not know, and appends in the
written policy's order any bill the model left out, and says so. Code then walks the order and keeps each bill while the
kept total fits the cash; the rest wait. The agent never pays more than it has, and a bill that waits is held for a
person, who can still pay it from Approvals.

**P4. What changes in the stage.**
- A kept bill held for want of cash is reopened (`invoice_reopened`, `followUp.reason: "cash_priority"`) and decided
  again this cycle.
- A waiting bill no longer counts, for the kept bills, among what falls due before them: the cash it would have taken is
  theirs. So a kept bill is scheduled or paid as usual, with every check. Every other bill still counts it.
- A waiting bill scheduled for later is decided now, and a waiting bill the stage decides is held: a model `pay` or
  `schedule` on it becomes a hold (`timingRule: "cash.priority"`), held for want of cash, so the follow-up reopens it once
  cash comes in, and the more-time and customer discount stages act on it. Its hold needs its own amount and the kept
  bills' before cash coming in reopens it, so a cent of yield never reopens it into the kept bills' cash.
- A kept bill held for want of cash again under the same plan is not reopened again (its decision records the plan's
  fingerprint); a kept bill a guardrail held drops out, since its latest decision, an `ap_schedule` among them, no longer
  holds it for cash.

**P5. Signed, and asked again only when the facts change.** The plan is signed as `cash_priority_set`: the cash, what
was set aside, each bill in the agent's order with its reason and whether it is kept, the reasoning, the written
policy's order, whether the model agreed with it, and a fingerprint of the competing bills (ids, amounts, due days).
Each cycle reuses the last plan, with no model call, while the fingerprint is the same and its order still splits the
bills the same way against the cash there is now. A changed or new bill, or cash enough to change the split, asks again;
a cent of yield does not.

**P6. Told.** The activity feed (console, Telegram, Slack) says it: "The cash cannot cover every bill: the agent pays
Cobalt Cloud 45.00 USDC and Cobalt Cloud 45.00 USDC first; Cobalt Cloud 140.00 USDC waits." with the reasoning's first
sentence, and a link to the payment plan. A waiting bill's card in Approvals says why it waits.

**P7. Where it does not run.** Shadow mode, where every decision waits for a person's verdict; EURC bills and bills paid
to a bank account, which do not draw on the operating USDC; a paused agent, which runs no cycle.

## Out of scope

- Paying part of a bill.
- A waiting bill a guardrail would flag (a duplicate, a high-risk payee) is held for cash before the guardrails see a
  payment, as with #418; it is flagged when it is decided again with the cash there.
- Late fees as a fact: no bill records them yet.

## Tests

- `competingBills`, `needsPlan`, `referenceOrder`, `boundOrder` (unknown, duplicate and missing refs), `planFrom` (fits
  the cash in order, skips a bill that does not fit and keeps a smaller one after it), the fingerprint.
- The AP stage: a plan from the model holds the bill due first and pays or schedules the ones it chose; a kept bill held
  for cash is reopened and decided; a waiting pending bill is held by code; the plan is signed once and reused while
  nothing changed; without a model the written policy's order; nothing when the cash covers every bill; nothing in
  shadow mode.
- The activity feed line.
