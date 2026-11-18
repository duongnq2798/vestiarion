# The public figures' shared cache (2026-11-19)

## Why

`/open`, the landing and `/studios` read production on every request, through five database functions:
`open_numbers`, `open_first_payments`, `open_outcomes` and `open_verdicts` for the open numbers (one call of each per
network), and `landing_team_journeys`, `latest_team_decision` and `recent_team_decisions` for the landing's evidence.
Each module kept what it read for a minute, but per Vercel instance, so most requests still reached the database.

Migration 0150 (Nov 17) cut `open_outcomes`'s buffers by 95%, yet the pages stayed slow. Measured on production on
Nov 18, read-only:
- Warm, `open_outcomes` runs in 90-132 ms. The first call on a fresh PostgREST backend takes about 1.9 s, and under
  light traffic most calls land on a fresh one: the youngest backend was 79 s old.
- At the edge, the p50 was 2,809 ms for `open_outcomes`, 1,089 ms for `open_numbers` and about 650 ms for the small
  functions. The means since the Nov 17 snapshot, about 2,150 / 967 / 700 / 977 / 188 ms, show only
  `recent_team_decisions` improved.

The cost is the cold connection, not the query plan. `/open` waits on eight calls before it answers, so a visitor
after a quiet spell pays it on every load.

## What

**PF1. One cache for every instance.** Each reader goes through `publicRead` (`src/lib/platform/public-cache.ts`),
which wraps Next.js's `unstable_cache`. On Vercel its entries are kept in the data cache, shared by every instance of
the deployment in the region (the functions run only in `hnd1`). The open numbers keep one entry per function, period
and network, so the landing's three documents are the ones `/open` reads, and one function that fails is read again
without the others. The landing's three evidence readers keep their whole result, after the workspace's id is
stripped, since a team journey with a schedule makes a second read in the workspace's scope.

**PF2. Fresh for a minute, then served while it is read again.** An entry answers for 60 seconds, the minute the pages
have always kept their figures. After that, the next request is answered from it at once and a new read runs behind
it (stale-while-revalidate). So the first visit after a quiet spell no longer waits on a cold connection, and the
figures it is shown can be older than a minute. The copy says so instead of promising "up to a minute old":
- `/open` says figures are kept a minute between reads, can be older after a quiet spell, and that the time at its
  head ("Live · read …") says when they were read. Its method says the same, and its lede no longer says the figures
  are read "when this page loads".
- The landing says "Figures read from Vestiarion's production database at <time>", not "as this page loaded".
- In practice the production check (`scripts/synthetic-check.mjs`) loads `/` and `/open` every 10 minutes, which reads
  their entries again, so the figures seldom trail by more than that.

**PF3. A failure is never kept.** A reader throws on an error, so `unstable_cache` stores nothing, and the next request
reads again. A refresh that fails behind a served entry leaves the entry in place: the figures stay those last read,
never a zero. Each page's own fallback is unchanged: a network whose numbers cannot be read says so, a function that
cannot be read gives dashes, and the landing's evidence goes without the part it could not read. Documents are checked
on every read, never before they are kept.

**PF4. Kept per deployment.** The key holds `VERCEL_DEPLOYMENT_ID`, so an entry written by one deployment's code is
never read by another's, which may expect another shape. Without it (self-hosting), the key holds the reader's own
source, as Next.js's does by default. A rolling period (7 or 30 days) is keyed by its name and its start is worked out
when its document is read, so it is the same entry on every request.

**PF5. Outside Next.js, a direct read.** `npm run numbers` and the tests run without Next.js's cache, so `publicRead`
calls the reader itself; Next.js compiles `NEXT_RUNTIME` into its server bundles, which is how it tells them apart.

## Not chosen

- **`use cache` / `use cache: remote`** (Next.js 16's recommended model) needs `cacheComponents`, a switch for the whole
  app that rules out the `dynamic` route option every one of these pages uses. Too wide a change for one cache.
- **A snapshot table refreshed by Supabase Cron** would make every read a single-row select and be the freshest. It
  needs a migration and a schedule, which are the partner's, and the cold connection would still be paid on a fresh
  backend, only for a cheaper statement. It stays the next step if the shared cache is not enough.
- **A warm-up schedule** calling the pages every minute would keep a backend warm, at 1,440 database reads a day for
  pages that see far fewer visitors.

## Measured

On production from Vietnam on Nov 18, with `curl`: five rounds 3 minutes apart, each one load after the idle gap and one
right after it, total time. Before, 17:07-17:19 UTC; after, from 18:04 UTC, once #614 was deployed.

| | `/open` after idle | `/open` warm | `/` after idle | `/` warm |
| --- | --- | --- | --- | --- |
| Before, each round | 0.70, 2.61, 0.58, 3.93, 3.98 s | 1.00, 0.73, 0.66, 0.72, 1.09 s | 3.43, 1.96, 1.11, 0.74, 0.91 s | 1.21, 0.97, 0.90, 0.72, 0.81 s |
| After, each round | 0.89, 0.86, 0.98, 0.79, 0.85 s | 0.84, 0.66, 0.76, 0.68, 0.71 s | 1.23, 0.68, 0.84, 0.75, 0.68 s | 0.65, 0.75, 0.71, 0.69, 0.65 s |
| Median, before → after | 2.61 → 0.86 s | 0.73 → 0.71 s | 1.11 → 0.75 s | 0.90 → 0.69 s |

- The first load after a quiet spell now costs about what a warm one does. Before, it took 0.6 to 4.0 s, depending on
  whether it reached an instance whose memo was still fresh.
- Concurrent loads of `/open` showed one read time per instance before (two among eight, 17:31:58 and 17:32:11), and
  one read time across all twelve after (18:04:12.746507). The twelve took 1.5-2.7 s each: twelve function instances
  starting at once right after a deploy. That start is not the database's, and no data cache saves it.
- A load at 18:17:12, three minutes past the round before, was answered in 0.85 s, and the entry was read again behind
  it: the next loads showed 18:17:13.978058 (PF2).
- No runtime log line from 18:00 to 18:40 UTC: no read failed and no refresh failed.
