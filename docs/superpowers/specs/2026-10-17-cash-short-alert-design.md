# Telling the owner before the cash runs short

Date: 2026-10-17. Status: building.

## Problem

The agent sees a shortfall coming. Since #418 it holds a scheduled bill days ahead when the cash will not cover it,
and the more-time and customer discount stages act on bills held for want of cash. The owner learns of it only by
looking: the console's cash outlook says "The wallet runs short on Oct 23", and Telegram or Slack say so when someone
sends `/today`. Each hold is told as it happens, one bill at a time, but nothing says how much is missing, by when,
and what the agent is already doing about it. A small business owner can act on that: move money in, chase a
customer, call the supplier. The agent should say it once, when it matters, and again only when it changes.

## Design

**S1. The figures are the console's.** A new cycle stage, `cash_alert`, after `term_requests`, works out the cash
outlook exactly as the console and `/today` do (`cashOutlook`, from the same rows): the operating USDC and the reserve,
less every open USDC payable on its day (a scheduled one on the day it is set for, a held one on its due day), less
every open milestone today, over 30 days, counting no receivable. From it, code reads:
- `shortOn`: the first day the wallet runs short, and `shortBy`, how short that day;
- `lowestOn` and `need`: the day it is shortest within the 30 days, and how short then, which is what the wallet
  needs to pay everything due through it;
- `expectedBy`: the receivables expected on or before `lowestOn`, never counted until they arrive, and whether they
  would cover it.

**S2. What the agent is doing about it.** The alert also says how many bills are held for want of cash and for how
much, and how many requests for more time and customer discounts are open. Each read is best effort: a table not
there yet counts as none.

**S3. Told once, and again when it changes.** The stage signs `cash_short_ahead` with the figures when the wallet runs
short and the last alert was none, or a `cash_short_cleared`; or the short day came earlier; or the need grew by 1 USDC
and a tenth since the last alert; or 7 days passed with it still short. When the wallet no longer runs short after an
alert, it signs `cash_short_cleared`. Nothing else is signed, so a cycle every few minutes says nothing new. Short by
under a cent neither alerts nor clears (review of #420).

**S4. Where it is told.** Both actions join the activity feed, so the console's toasts and the connected Telegram chats
and Slack channel tell them in the same cycle: "Cash runs short on Oct 23: 139.97 USDC short that day, 229.97 USDC
by Oct 25 to pay everything due." with a line on customers' money and what the agent did, and a link to the payment
plan. A cleared alert says "The cash covers everything due in the next 30 days again." The alert is a warning, not a
decision: it takes its own tone, `notice`, so it is not counted among what waits for a person (review of #420).

**S5. Where it is not.** Not in shadow mode, where the business pays its bills in its own money and the wallet only
mirrors them. Not while the agent is paused: the cycle does not run. Code only: no model decides it.

## Out of scope

- Email to owners: the waiting digest stays as it is.
- Suggesting where the money should come from beyond what the agent already does.

## Tests

- `cashShortOf` over outlooks: never short, short on a day with a deeper day after, receivables before and after.
- `alertDue`: first alert, unchanged, earlier day, need grown, weekly reminder, cleared, nothing after a clear.
- The stage: signs once, not again on the same figures, clears; skips shadow mode; best-effort counts.
- Activity items for both actions.
