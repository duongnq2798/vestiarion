# Review every screening match

Date: 2026-10-02. Status: shipped with this PR (design decided under the standing autonomy grant;
rulings below carry their cost if wrong). Follows the dismiss screening match design (2026-10-01).

## 1. Why

On testnet-2, Quoc Duong's screening matched "Dương Trung Quốc". A person chose Not this person; the
re-screen then matched "John Quoc Duong"; dismissed, it matched "Tan Guoqiang". OpenSanctions returns 19
candidates for "Quoc Duong", all scored at or above its 0.7 match threshold (five at 0.909), most of
them plainly other people. A dismissal covers one entity, so the counterparty needed 19 reviews, one
page load each.

Worse, screening asked the service for its default five candidates. After five dismissals, the five
returned were all dismissed and the verdict read **clear**, while 14 matches were never looked at. A
sanctions hit ranked sixth would have been missed.

## 2. Rulings

- **R1. Never fewer candidates than the dismissed ones plus 25.** Screening asks for
  `dismissed + 25` (at most 200), so a dismissed match can never crowd out one that is not. Clear
  means no undismissed candidate came back.
- **R2. The counterparty keeps every match left to review.** `counterparties.risk_matches` (migration
  0060): the undismissed candidates of the latest live screening, best first, at most 25, each
  `{ id, caption, score, topics }`. Null for a clear verdict, a bundled one, or one from before.
- **R3. One review dismisses every match listed.** The box says how many other people the name
  matched; Not this person lists each one with its score and topics, and one reason dismisses them
  all. Each is recorded in `screening_dismissals` on its own; one signed `screening_match_dismissed`
  entry names them all in `detail.matchedEntities`, the verdict's match first in the existing fields.
  A match not listed (beyond 25, or found later) still counts.
- **R4. Stale pages are refused**, as before: the verdict's match must be among the ids sent, and each
  id among the matches kept. A verdict from before the list was kept dismisses only its own match.
- **R5. Old verdicts are screened again first.** A live match with no kept list offers Screen again,
  which lists them.

## 3. What changes for an integrator

`screening_match_dismissed` entries carry `detail.matchedEntities: [{ id, caption, score }]`, and one
entry can dismiss several matches. See `content/docs/changelog.mdx`.
