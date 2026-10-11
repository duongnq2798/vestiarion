# The agent's earlier decisions on the landing

Date: 2026-10-11. Status: built (feat/recent-decisions). Builds on the landing's latest decision
(`2026-10-08-landing-owner-hero-design.md`) and the proof section of `2026-10-11-landing-clarity-design.md` (P1-P3).

## The problem

The proof section ("Don't take our word for it.") showed one decision: "The agent's latest decision", with who proposed
it, the written policy's answer, code's checks, its transaction and a signature check. A first-time visitor could not
tell from it whether the agent had made one decision or hundreds, whether it still runs, or whether it ever holds or
refuses a payment. The one decision shown on 2026-10-11 was a payment, so the section read as "the AI pays bills", which
is the opposite of the product's point: the model proposes, the rules decide.

The data to answer this was already in the ledger. A read-only look at production on 2026-10-11 (the same filter as
`latest_team_decision()`): 155 agent decisions in the team's live workspaces, 4 on Arc mainnet and 151 on Arc testnet;
61 in the past 7 days (4 mainnet, 57 testnet). They include payments, cash holds, code refusals (the cross-chain fee
above its cap, a first payment to a new address, the spending limit, a payee with no address), fraud flags, questions,
schedules and shadow mode verdicts. A bill held for cash is decided again each cycle, so many entries repeat one bill.

## What was considered

| Option | Clarity | Trust | Phone | Fits the page | Effort | Verdict |
|---|---|---|---|---|---|---|
| A. The latest-decision card rotating through recent ones (slide or fade) | Low: one at a time, gone before it is read | Low: motion on a finance page reads as a ticker; WCAG 2.2.2 needs pause controls | Fine | Poor | Medium (client JS, timers, pause on hover/focus) | Rejected |
| B. A recent payments table under the card | Medium | Medium: shows only what was paid, so it hides the holds and refusals that are the product | Poor (a table) | Dashboard-like | Low | Rejected |
| C. The card, then a short list of earlier decisions, in the same panel | High: scan the outcomes, read the reasons | High: holds and refusals beside payments, each on its network | Good (stacked rows) | Native (same badges, type, borders) | Low-medium | **Chosen** |
| Split panel (card left, list right) | Medium | High | Same as C | The card already has two columns (story, verification); a third crowds it | Medium | Rejected |
| Timeline with markers | Same as C | Same | Same | Markers add decoration, no information | Medium | Rejected |

Also decided against:
- **Autoplay, a ticker, polling, a "live" pulse.** The agent decides every few hours; a visit lasts minutes. The page is
  read as it loads (said in the section's intro), so nothing moves and nothing refreshes. The latest card's dot no longer
  pulses: a pulsing dot says "live", and it is not.
- **A network filter or two lists.** Five rows do not need a filter (client JS), and Arc mainnet has three bills ever, so
  two groups would be lopsided. Each row names its network and says real money or test money; the list never adds an
  amount up; the week's count gives each network its own number.
- **A signature check on every row.** One check, on the latest decision, shows the mechanism; the "Verify a ledger
  export yourself" guide covers the rest. Rows link to the chain where a transaction went out, which is the evidence a
  visitor can check without us.
- **Customers' decisions.** They stay private: the list is the team's own workspaces only, as the latest decision is.
  Showing customers' decisions, even anonymized, is a change of publication policy for the partner to decide (an opt-in,
  like the shared report).
- **A public page of every decision.** Not built; /open has the counts and /how-it-decides explains the loop.

## D1. Which decisions

`recent_team_decisions(p_limit)` (migration 0100) reads the same rows as `latest_team_decision()`: the agent's decision
actions (`ap_pay`, `ap_schedule`, `ap_hold`, `ap_request_info`, `ap_flag_fraud`, `milestone_release`, `milestone_hold`)
in live workspaces that are the founding one or created by a team member, never a customer's, a sandbox's, one whose
creator left, or one about a sample payee.

- One row per bill or milestone, its newest decision, so a bill held every cycle shows once.
- It looks at the newest 200 such decisions, so the read stays bounded; returns at most `p_limit` (1-12), newest first.
- `pastWeek`: the agent's decisions in those workspaces in the last 7 days, per network. A count of decisions (every
  entry, repeats included), never money, never the two networks added together.

Measured on production data on 2026-10-11 (run as a plain read-only select): 7 ms.

## D2. What each row carries

The fields of 0088 a page may show (action, amount, currency, network, model, policy agreement, code's verdict and rule,
why a hold held, the resulting status, the transaction, the pay-on date, a person's verdict, the confirmed payment that
followed), and nothing else: no summary, reasoning, names, bill or payee ids, no workspace id, no signature. The service
role alone may run it. `src/lib/platform/recent-decisions.ts` reads it at most once a minute; a failed read, or a
database without 0100, gives no list and the latest decision stands alone.

## D3. How a row reads

Three layers, all visible without a click:

1. **What came of it**, a tag with an icon and a word, in a column of its own from a tablet up so the eye runs down it:
   Paid, Confirming, Scheduled, Person agreed, Person disagreed, Awaiting a person, Refused by code, Flagged, Asked for
   details, Held. Read from the entry alone, in order: a confirmed payment (whoever sent it), a person's shadow mode
   verdict, code's refusal, then the model's own action. Never colour alone: every tag has its word.
2. **What and why**: the latest decision's own sentence ("Decided to pay a 0.50 USDC bill."), then why it did not go out
   ("Code refused it: the cross-chain fee was above its cap.", the rule in `rule-words.ts`), or, for one that went
   ahead, what was checked ("The written policy agreed; code checks passed."). Only what the entry recorded; no sentence
   when it recorded nothing.
3. **Where to check**: the network and "real money" (Arc mainnet) or "test money" (Arc testnet), the time ("8 h ago",
   with the UTC minute as its title), and "Transaction" to the network's explorer only when a transaction hash exists.

## D4. Layout

Inside the latest decision's panel, under it: "Earlier decisions" with "How the agent decides" at the right; the week's
count, "Newest first, one row per bill", and "Customers' decisions stay private: they are only counted, in the figures
below."; five rows, strictly older than the latest decision (a list read a moment later never shows the latest twice or a
newer one under it); then one line, "In shadow mode it decides on your own bills, with no wallet or funds to start. Try it
on your bills", to the landing's one call to action.

- Phone: tag and time on one line, the sentence, then network and transaction.
- Tablet: tag column; network and transaction under the sentence.
- Wide (lg): tag column, sentence, network and transaction at the right.
- The loading placeholder is as tall as the measured panel with five rows, so nothing below jumps.

## D5. Measurement

The landing's analytics (`data-cta`, `cta_click`) name each new click: `proof-try`, `proof-how-it-decides`,
`proof-transaction` (both the latest decision's and the rows'), `proof-signature`. No new provider.

## D6. Not changed

The latest decision's card, its signature check, the open numbers and their split of customers from the team and
mainnet from testnet. Nothing here touches payment, approval, signing or treasury code.

## Tests

`tests/recent-decisions-migration.test.ts` (PGlite: scope, one per bill, fields, week counts by network, limits,
grants), `tests/recent-decisions.test.ts` (outcomes, sentences, links, the read), `tests/landing-recent-decisions.test.tsx`
(rendered rows, ordering, links only with a transaction, counts never added, nothing without a latest decision).
