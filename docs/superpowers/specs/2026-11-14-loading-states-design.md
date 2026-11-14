# Loading states: one system for every wait

Date: 2026-11-14. Status: L1-L7 built in the first pull request; the audit's per-screen gaps (L8) in the second.

## Why

An audit of `src/app` and `src/components` (226 client files) found the primitives sound (`Button loading`, `SubmitButton`, `useActionForm`, `Skeleton`, `ProgressBar`, the workspace's `loading.tsx` and `error.tsx`) but used unevenly:

- every busy button showed its spinner at once, so a toggle that answers in 80 ms blinked, and a button without an icon grew wider while busy;
- a filter, a sort, a tab or a page outside a workspace gave no sign a click had been taken until the next page arrived;
- a form whose action never answered (a dropped connection, a deploy) threw, and the whole section gave way to its error screen; outside a workspace there was no error screen at all, so the browser's bare one showed;
- the agent's status line in every workspace header stopped updating for good behind one hung request, and never said so;
- about 30 controls start work with no busy state, and a few leave a conflicting action clickable while a payment goes out (L8).

## Rules

- **L1, a button's work.** A button that can be busy passes `loading` from its first render (`false` included), or is a `SubmitButton`. It is disabled and `aria-busy` the moment the work starts, so it cannot be pressed twice. Only such a button carries the client part (`ButtonBusy`); every other one stays plain markup.
- **L2, when to show it.** Work shows as running only after `BUSY_DELAY_MS` (150 ms); once shown it stays for at least `BUSY_MIN_MS` (500 ms). Work already running on the first render shows at once. A busy button keeps its colour, so during the delay nothing changes on screen. One hook, `useBusyIndicator`, decides this for every indicator.
- **L3, no jump.** A busy button keeps at least the width it had until its spinner has gone. A section's skeleton is drawn in the page's frame and spacing.
- **L4, following a link.** `NavigationProgress`, in the root layout, draws a 2 px agent-blue bar along the top when a plain click on a link to another page of this site (another path or query, same tab, no modifier, no download) has not landed after the delay. It creeps towards 90% while waiting, then fills and fades when the address changes; it gives up after 15 s if the address never does. `announceNavigation()` starts it for `router.push`. It is decorative (`aria-hidden`): the page or its skeleton says what it is. Under reduced motion it shows and fades without moving.
- **L5, long work.** `useSlowWork(active, ms)` says when work has run longer than usual, for a control that wants to say "This can take a minute". A wait with a known end uses `ProgressBar` with a value.
- **L6, failing without losing work.** `useActionForm` turns a call that throws into a refusal with `ACTION_UNANSWERED`, keeping the form's state and what was typed; a redirect or not-found from the action still goes to Next (`unstable_rethrow`). The action may have run, so the message sends the person to reload and look before trying again. Polling gives each request a timeout (`AbortSignal.timeout`) and keeps polling after a failure; the agent's status line adds "not updating, retrying" after three misses in a row and drops it at the next answer.
- **L7, error screens.** `error.tsx` at the root covers every page outside a workspace in the site's own header and footer, with `RetryButton` and a link to `/status`; `global-error.tsx` covers a failing root layout with its own `<html>` and styles; `o/[slug]/error.tsx` keeps its frame and now uses `RetryButton`. `RetryButton` runs `retry` in a transition and is busy until the part has been fetched again. The server's digest is shown as a log reference.
- **L8, applying it (second pull request).** The audit's per-screen gaps: sibling actions disabled while a payment goes out (Approvals: Return, Reject and Add details while Approve and pay runs; held milestones: Close while Pay runs); `loading` on ConfirmDialog triggers (Cancel deal, Remove cost, End plan, Create payable); the Getting started forms as `SubmitButton`s; sign out, the bills sort, New's "see it" link, the command palette, the docs search, `followLink` and the pages an action opens (a new deal or project, leaving a workspace) through `announceNavigation(href)`, which stays quiet for the page already open; treasury Skip and Refresh; the wallet's Refresh; the vendor check's Enter key while a check runs; the integration connect forms through `NativeSubmitButton`; `AutoRefresh` letting a refresh on its way finish before the next; a catch on Iris polling, Apply by hand and the vendor's document upload (`ACTION_UNANSWERED`); the captured text read again after a failure; the Bills tabs' spinner and the nav's dot through `useBusyIndicator`; `SiteLoading` as `loading.tsx` for the segments outside a workspace that read data (account, accountant, onboarding and the pages a link opens: pay, payee, statement, receipt, supplier, documents, offer, discount, more time, address change). The founder's pages, team only, keep the bar.

## Tests

`tests/ui-loading.test.tsx`: the delay and the minimum, a busy button (disabled at once, spinner after the delay, colour kept, width held and released), which clicks start the bar and its states, `announceNavigation` and the give-up, `answered` (refusal, pass-through, redirect), `RetryButton`, and the status line going stale and recovering. `tests/ui-button.test.tsx` keeps the server-rendered busy button.
