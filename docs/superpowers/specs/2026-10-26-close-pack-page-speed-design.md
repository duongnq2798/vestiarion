# Monthly close pack: page speed

Date: 2026-10-26. Status: accepted.

## Why

The monthly close pack (`/o/<slug>/evidence/close-pack?month=YYYY-MM`) was slow to open. Measured on production on
Oct 26, the team workspace's October 2026 pack: 20 payments, 62 signed entries cited. The workspace holds only 825
ledger entries, 10 compliance checks and 20 payment intents, so no single query is slow.

| Open | First byte | Whole response |
| --- | --- | --- |
| First navigation | 80 ms (`loading.tsx` streams a skeleton) | 4.85 s |
| Three reloads right after | | 1.43 s, 1.38 s, 0.90 s |
| An earlier visit, likely a cold instance | | about 8.8 s |

The HTML was 581 KB for about 32 KB of visible text: 311 KB of it the React Server Components payload
(`self.__next_f`), 217 KB the `<main>` markup. Nothing in the code timed a request, so where the time went had to be
read from the code:

- **Reads in a line.** Before anything in the workspace's scope, `requireMembership` reads the session, the membership
  and, on an instance that has not touched the workspace for an hour, its activity; `inOrg` reads the org row. The pack
  then read in waves, each waiting for the slowest read of the one before: the payments and six other reads; then the
  bills, the milestones and the invoices' own addresses (`readDocumentPayTo`, whose hundreds of ids went one after
  another); then the payees and four ledger reads; then one screening read per payee and time, ten at a time, each ten
  waiting for its slowest. The header's shadow mode was read after all of it. Against a database that answers in
  waves, two payments took 5 rounds in scope; eleven to twenty payees and times took 6.
- **Reads the page did not use.** The header needs the simulated day, the clock and the last cycle. `stats()` read
  those and also every paid bill and milestone, and counted every agent ledger entry and every flagged bill exactly.
- **Each signature check started from the PEM.** `verifyEntry` decoded and hashed every key for every entry and
  imported the key again each time: 62 entries, 62 imports.
- **Markup per card.** One payment's card was 9.5 KB of markup for 1.6 KB of text: 48% class attributes and 24% inline
  icons, seven per card (six check badges and the explorer link), each a whole SVG. The RSC payload carries the same
  tree again, since React needs it to hydrate, and each lucide icon is a client component whose drawing travels in that
  payload as its props, once per icon. No pack, entry or other large value is passed to a client component.
- **A function of its own.** The page was the only one under `src/app/o` with `maxDuration = 120`.

## What

**CS1. The same bytes.** The page, the CSV and JSON download (`/api/evidence/close-pack`), `GET
/api/v1/close-packs/{month}` and the Google Sheets export all read through `readClosePack`, and each gets exactly what it
got before: `buildClosePack` is given the same inputs, both times it is called (the build sorts entries by `seq` and
rows by `confirmed_at` itself, so the order reads answer in does not matter). `tests/close-pack-read.test.ts` builds
the pack through `readClosePack` and through a frozen copy of the reader before this change
(`tests/support/close-pack-read-before.ts`) from the same data, and holds that the inputs, the pack and the signed
JSON's bytes are equal: a plain month, a month with a customer's invoice paid in it, verdicts and checks just before
and after each payment's time, the same month when the payees' checks fill a page, and 150 payees.
`tests/close-pack-build.test.ts` and the export tests pass unchanged.

**CS2. Each read starts when what it needs is in.** `readClosePack` keeps a promise per read and chains each dependent
read with `.then`, as the Bills page does (docs/superpowers/specs/2026-10-22-bills-page-parallel-reads-design.md):
- first, together: the payments, the month's escrow moves, the payee lock's changes, the first sweep that checked
  payout addresses, the ledger's head, the members and, for an API key, the workspace's name;
- the moment the payments answer: the bills, their documents' addresses, the entries naming them and the verdicts on
  them; the milestones and their entries once the escrow moves are in too. The entries and the verdicts are asked for
  by every invoice a payment names, so they need not wait for the bills to say which are payable; those naming a
  customer's invoice are dropped before the pack is built (a string `detail.invoiceId` or `detail.subjectId` among the
  payables' ids), which leaves exactly what the reads by the payables' ids answered;
- the moment the bills and milestones answer: the payees and their address entries, and with them the screening
  (CS3).

Three rounds in scope instead of five, six with eleven to twenty payees and times, and one more for each ten after. A
read that fails still fails the pack with the same error; the reads already in flight run to their end and are not
used.

**CS3. The screening in as few reads as possible.** Each settled payment's screening is its payee's newest complete
check at or before its anchor (CP8). `screeningAnchors` now takes only what it reads (the network, month, time,
payments, bills, milestones and entries), and only entries naming a bill or a milestone change an anchor, each of which
the reads by `invoiceId` and `milestoneId` return; so the anchors are known as soon as those are in, and the screening
is read beside the payees. Then:
- one read per hundred payees: their complete checks with `created_at` at or before the latest of their times, newest
  first, a tie going to the larger `id`, a page of 1000 (`counterparty_id, risk_level, source, screening_mode,
  created_at`);
- for each payee and time, the first of that payee's rows at or before the time: what the read for that payee and
  time alone answers. Times are compared to the microsecond, as Postgres compares them (`2026-01-05T10:00:00.123457`
  is after `.123456`, which `Date.parse` cannot tell apart);
- a hundred payees whose read failed, filled its page (an older check could lie past it), or held a time written in a
  form that does not parse are read one payee and time at a time, as before, ten in flight (a pool, no longer batches
  that wait for their slowest). A failure there marks only that payee and time's payments "could not be read", as
  before.

The read for one payee and time now also orders by `id`, so a tie on `created_at`, which the database used to settle
as it liked, goes to the same check both ways. With today's data a month's screening is one read.

**CS4. The page's reads together.** The page's `Promise.all` now holds the pack, the header's clock, `shellStatus()`
and the Google Sheets view, all inside the workspace's scope (`status={status}`, as Bills does). The clock is
`shellClock()` (`src/lib/queries.ts`): the simulated day and the last `cycle_complete`, two reads, with the clock mode.
`stats()` reads the clock through it, so the two never disagree. The page counts no ledger entry and reads no paid
bill.

**CS5. The invoices' own addresses at once.** `readDocumentPayTo` asks for every hundred ids at once, then takes the
answers in order: none before 0136 when the first hundred to fail failed for the missing column, a throw when it
failed otherwise, exactly as when the hundreds were asked for one after another. The agent's stage, approvals, chat
decisions and Slack, which read it too, answer the same.

**CS6. Each key prepared once.** `verifyEntry` and `verifySignedLink` keep their behaviour and answers. The keys object
they are given is filed once (each PEM decoded, its id recomputed from its SHA-256) and each key imported for Ed25519
the first time an entry needs it, in a `WeakMap` keyed by that object: held as long as the object is, so one per
request on the server, and filed again if its keys were changed since. The reader builds one keys object per read, so
a pack of 62 entries imports each key once. The same code runs in the reader's browser.

**CS7. One timing line.** Each page render logs `close_pack_timing` with a JSON object `{ stage: "page", auth, scope,
reads, total, pack }`, and each `readClosePack` `{ stage: "read", reads, screening, verify, build, total, payments,
entries, cited, screeningReads }`: whole milliseconds per stage (`auth` is `requireMembership`, `scope` is `inOrg`'s
org read before the page's code runs, `reads` everything read, `screening` the screening reads alone, `verify` the
signature checks, `build` both builds) and counts. `pack` is false when the page's reads were spent. It names no
workspace, person, record or month; Vercel files the line under its request.

**CS8. Less to send.** The view (`src/components/ClosePackView.tsx`) now draws each icon it shows once, as an SVG
`<symbol>` (`IconSheet`), and each check badge and explorer link points at it with `<use>` (`IconUse`); the badge's own
icon slot takes it (`EvidenceLabel`'s new `icon`). A `<use>` draws nothing where its symbol is not on the page, so the
sheet is drawn with whatever shows the icons: the report draws one for the whole pack, and the card exported on its
own (`ClosePackPayment`, which the accountants guide's screenshot shows without the rest of the pack) draws one for its
own icons; the month's list of cards and the escrow moves, which point at the report's, are no longer exported. The
facts' label and value styles are set once on each list (`FACTS`) rather than on each of a card's eleven facts.
Nothing the person sees, prints or downloads changes: the words beside each icon, the visible text (34,035 characters
for twenty cards, before and after) and the files are the same. Measured by rendering `ClosePackView` to static markup with `tests/support/close-pack-fixtures.ts`'s `samplePack`:

| | Before | After |
| --- | --- | --- |
| The sample pack (3 cards) | 38,942 bytes | 34,248 bytes |
| Twenty cards, as the production month had | 204,279 bytes | 157,657 bytes (-23%) |
| One card, in a pack of twenty | about 9.5 KB | about 7.3 KB |
| Inline SVG in twenty cards | 50,025 bytes | 17,863 bytes |

The RSC payload carries the same tree, so it shrinks with it: serialising the twenty cards' element tree the way the
payload does (host elements as JSON, client components as references with their props, inside a string) gave about
273 KB before and 234 KB after. That is an estimate, not a measurement of the payload Next sends.

**CS9. The same function setting as the other heavy pages.** The page now exports `maxDuration = 300`, as Bills,
counterparties and the report do; every other workspace page uses the default. Vercel builds routes whose function
settings differ as separate functions where it must, and a function only this page uses is warm only when this page
was opened recently, which for a monthly page is seldom. Sharing the setting of Bills, the most used workspace page,
lets the page share its warm function where Vercel groups them. Export to Google Sheets, a Server Action of the page,
still starts no call to Google after 90 seconds (close pack Sheets GS12), well within 300. This is a hypothesis, not a
finding: Bills, counterparties and the report also sit apart from the default pages, and Bills is fast, so a setting
of its own may not be what made the close pack slow on a first open. It is checked after deploy (below), and costs
nothing if wrong.

**CS10. No migration.** No table, column, function or index is added. Indexes that would serve the close pack later,
as one additive migration with no code change:
- `compliance_checks (org_id, counterparty_id, created_at desc) where status = 'complete'`: the screening read filters
  by payee and time, and `counterparty_id` has no index (only `org_id`, and `created_at` for live checks).
- Expression indexes on `ledger_entries (org_id, (detail->>'subjectId'))` and `(org_id, (detail->>'counterpartyId'))`,
  and one on `(org_id, action)`: the verdicts, the payees' address entries, the payee lock's changes, the first sweep
  and the escrow moves filter the workspace's whole ledger today.
- `payment_intents (org_id, confirmed_at)`, with `created_at` and `submitted_at`: the month's payments.

At today's sizes each of these reads filters at most the workspace's 825 entries, 10 checks or 20 payments, found
through `org_id`'s index: that is not where the seconds went, which were in the rounds between reads. They matter once a
workspace holds tens of thousands of entries.

## Rounds

Against a database that answers every request at once once none has arrived for a moment
(`tests/close-pack-page-parallel.test.ts`), the page's reads in the workspace's scope:

| | Before | After |
| --- | --- | --- |
| Rounds, two payments | 5 | 3 |
| Rounds, eleven to twenty payees and times | 6 | 3 |
| Screening requests, 20 payments to 20 payees | 20 | 1 |
| Requests for the header | 6 (two of them exact counts) | 2 |

Before the scope come `requireMembership`'s two or three reads and `inOrg`'s org row, as on every workspace page, so on
production a page of 20 payments goes from about nine or ten rounds to six or seven.

## Not in this change

- Suspense around the pack. `loading.tsx` already streams a first frame; a boundary changes what shows first, not when
  the page is done (as for Bills).
- The rounds before the scope (`requireMembership`, `inOrg`), which every workspace page shares.
- The Google Sheets view's three reads one after another (connector ready, connection, last export). They run beside the
  pack and take no more rounds than it does.
- Remembering a pack, or a signature's check, across requests: a pack carries the time it was read, and an instance's
  memory is not shared. The keys are prepared once per request (CS6), never across.
- The other workspace pages, whose headers still read `stats()`; `shellClock()` is there for them.
- The shell's own markup and payload, shared by every page.
- Indexes (CS10), and anything under `/api/v1`: the bytes it answers do not change, so the API changelog has no entry.

## Checking it on production

After deploy, open the team workspace's October 2026 pack once, then three times in a row, and read the lines:
`npx vercel logs` for the deployment, filtered on `close_pack_timing`.
- `read.reads` should be about three database round trips, `read.screeningReads` 1 and `read.verify` a few
  milliseconds; `page.auth` and `page.scope` say what the scope costs before it.
- A first open whose `page.total` is far above the reloads', with the reads alike, is a cold start (CS9): compare the
  function and its init time in the request log with the Bills page's.
- The HTML should be well under the 581 KB measured, with the visible text the same.

## Tests

- `tests/close-pack-read.test.ts`: the screening is one read per hundred payees (`[100, 50]` for 150), its filter and
  columns; each payment's check picked to the microsecond; a tie taken by the larger id, read at once or alone; one read
  per payee and time, never more than ten in flight, when a hundred payees' checks fill a page; a failed read of many
  then one payee's failed read marks only that payment; the entries and verdicts read by every invoice a payment names
  and built from the payables' alone; the same inputs, pack and bytes as the reader before (CS1); one timing line naming
  no one. Its other pins hold as before: every request carries `org_id`, ids go a hundred at a time, paged reads.
- `tests/close-pack-page-parallel.test.ts`: the first reads, the header's included, in the first round; the bills, their
  entries and verdicts in the second; the payees, their address entries and the screening in the third; three rounds in
  all; the header reads no count and no paid bill; one timing line for the page and one for its read.
- `tests/close-pack-page.test.tsx`: `maxDuration = 300`, as Bills, counterparties and the report; the pack, `shellClock`,
  `shellStatus` and the Sheets view in one `Promise.all`, no `stats()`; each icon drawn once and each badge and link
  pointing at it; each check's kind still in words; the card exported on its own drawing each icon it points at, once;
  twenty cards in under 165,000 bytes of markup.
- `tests/docs-screenshots.test.tsx`: the accountants guide's screenshot of a card draws every icon the card points at.
- `tests/mainnet-copy-pages.test.tsx`: the close pack page, like Bills, hands the header `shellStatus()` read with its
  other reads inside the scope.
- `tests/receipts-verify.test.ts`: one import for many entries checked with one keys object, the same answers; a keys
  object given other keys is read again.
- `tests/invoice-pay-to.test.tsx`: every hundred asked for at once; the first hundred that failed decides, as before.
- `tests/queries-stats.test.ts`, `tests/tenant-scope-lib.test.ts`: `shellClock()` reads the day and the last cycle and
  nothing else, agrees with `stats()`, and refuses outside a workspace.
