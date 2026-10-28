# Production check every 10 minutes, told on Discord

Date: 2026-10-28. Status: built.

## Problem

Nothing tells the team when production stops answering. The scheduled jobs are called by Supabase Cron, and checking
them means SQL (`supabase/cron/watches.sql`); the Discord, Slack, Telegram and email notices are each workspace's own;
there is no error tracker and no health route. A page that answered 500, or a free tool whose page lost its content,
was found only when someone opened it.

A check run inside the deployment cannot report that deployment down, and one run by the database stops with the
database. GitHub's 5- and 10-minute schedules started only a few times a day here (`tests/supabase-cron.test.ts`), and
that test refuses any GitHub schedule more often than hourly.

## Decision

PC1. What is checked. Each round opens these public addresses on production, `https://www.vestiarion.xyz`, with `GET`:

| Address | Status | Must contain | Must not contain | Budget |
|---|---|---|---|---|
| `/` | 200 | `Your AI agent for bills and payments` (the hero, `src/components/landing/Hero.tsx`) | | 8 s |
| `/open` | 200 | `Vestiarion, in production` (`src/app/open/page.tsx`) | `numbers could not be read right now` | 8 s |
| `/docs` | 200 | `Vestiarion docs` (its title, `src/app/docs/[[...slug]]/page.tsx`) | | 4 s |
| `/check-address` | 200 | `Check an address before you pay it` (its heading) | | 4 s |
| `/payment-terms` | 200 | `Payment terms calculator` (its heading) | | 4 s |
| `/check-vendor` | 200 | `Check your vendors against OFAC` (its heading, up to the apostrophe) | | 4 s |
| `/check-bills` | 200 | `Check your bill list for duplicates and deadlines` (its heading) | | 4 s |
| `/robots.txt` | 200 | `Sitemap:` and `/sitemap.xml` (it names the sitemap) | | 4 s |
| `/sitemap.xml` | 200 | `<urlset` and each free tool's `<path></loc>` (it lists the free tools) | | 4 s |

The landing and the open numbers read the database on every request (`force-dynamic`), so their budget is longer.
`/open` still answers 200 when a read fails, with "The ... numbers could not be read right now.", so that text is a
failure. The budgets are first guesses: each round's times are in the job log, to set them from after a week.

PC2. A check fails on any of: no answer within 15 seconds (the body included), a status other than the one expected (a
redirect is not followed, so a 3xx is a failure, with where it pointed), a "must contain" text missing, a "must not
contain" text present, or a time over its budget. The reason says which, in a few words: "answered 500, expected 200",
`missing "Vestiarion docs"`, "took 9.1 s, over its 4 s budget".

PC3. Each page's text is still in the source it comes from, and none holds an apostrophe, a quote, `&`, `<` or `>`,
which React escapes in the page's HTML. Every free tool in `FREE_TOOLS` (`src/lib/free-tools.ts`) is checked, and the
sitemap check looks for each one's own entry. `tests/synthetic-check.test.ts` holds all three, so a copy edit or a new
free tool fails CI instead of alerting the team.

PC4. When it runs. `.github/workflows/synthetic-check.yml` runs on an hourly schedule, at 7 minutes past (a digits-only
minute, as `tests/supabase-cron.test.ts` requires), and by hand. A run checks every 10 minutes for 5 hours 45 minutes,
in one job of at most 355 minutes (GitHub ends a job at 6 hours). Its concurrency group, `synthetic-check`, never
cancels a running run: an hourly start that comes meanwhile waits as the group's one pending run, and begins when the
running one ends. So rounds stay 10 minutes apart as long as GitHub starts the hourly schedule once in about 6 hours.

PC5. When the team is told. A check that fails two rounds running is told once, in that round's single "failing" post,
which lists every check that reached its second failure in the round, each with its reason and the time it started
failing. A check still failing after that is not told again. A told check that passes is told once more, in that
round's single "passing again" post, with the time it passed and how long it was down. A check that fails once and then
passes is never told. So a whole-site outage is one post, not nine.

PC6. How it is told. Each post goes to the team's private Discord channel through a channel webhook, only to
`https://discord.com/api/webhooks/{id}/{token}` rebuilt from the secret as the product's own parser does
(`parseDiscordWebhookUrl`), with `?wait=true`, a 10-second deadline and no redirect followed. The body is the content
alone, at most 2,000 characters, with no mention parsed (`allowed_mentions.parse` empty) and embeds suppressed (flag
4). Each post carries the production origin and the run's link, since GitHub's job logs need a sign-in. A post Discord
does not take leaves its checks as they were: a failing check is told in the next round, and a check passing again is
told then with the time it first passed.

PC7. The one secret. `MONITOR_DISCORD_WEBHOOK_URL`, a repository secret in GitHub Actions. The script never prints it,
or any part of it. When it is missing, or is not a Discord webhook URL, the checks still run, the log says at the start
that no alert can be sent, and each post that was due says in the log that it could not be sent, with what it would have
said.

PC8. The state. Per check, the failing rounds in a row, when it started failing, whether the team was told, and when it
passed again: in `.synthetic-state.json`, written after every round (so a cancelled run keeps its last round), kept
between runs in the Actions cache (restored from the newest, saved under the run's own key, even after a failure or a
cancel). No database. A missing file starts from no failures; an unreadable one does too, with a warning.

PC9. A run fails only when the check itself could not do its job: a post that was due and could not be sent (no secret,
not a Discord URL, or Discord refused it), or an unreadable state file. Failing pages do not fail the run, so GitHub
emails its actor about a broken monitor, never once per failing page.

PC10. Reads only. Plain `GET`s of public pages with the header `User-Agent: vestiarion-synthetic-check
(+https://github.com/duongnq2798/vestiarion)`, which Vercel's logs can filter on; no cookie, no token, no write. It
runs no JavaScript, and the only analytics in the app is Google Analytics in the browser, so no probe counts as a
visit. Database reads: the landing and `/open` each read it about 144 times a day.

PC11. Where it runs: GitHub's servers, outside Vercel and Supabase. A fork checks nothing unless its repository variable
`SYNTHETIC_ORIGIN` names its own deployment, which it then checks instead of production.

PC12. `scripts/synthetic-check.mjs` uses Node's built-ins only (`fetch`, `AbortSignal.timeout`, `fs`): the workflow checks
out that one file, without credentials, and installs nothing, as the release workflow runs `release-check.mjs`. Its
checks, the verdict, the alert rule and the post are pure exported functions, tested with a server on loopback.

## What the owner adds

In Discord, on the team's own server: a private channel's settings > Integrations > Webhooks > New Webhook > Copy
Webhook URL. In GitHub: the repository's Settings > Secrets and variables > Actions > New repository secret, named
`MONITOR_DISCORD_WEBHOOK_URL`. Then run the workflow once by hand from the Actions tab to see the first round.

## Known limits

- If GitHub Actions is down, or starts no hourly run for about 6 hours, rounds pause, and nothing says so: silence on
  the channel means every check passing, or no check running. The Actions tab shows the runs.
- A change to the script reaches the loop at the next run, up to 6 hours later; cancelling the running run applies it
  at the next start.
- Hourly starts that wait behind a running run and are replaced by a newer one show as cancelled in the Actions tab.
- GitHub turns off a public repository's schedules after 60 days with no activity.
- If Vercel's firewall ever challenges GitHub's runners, the checks fail with 403 or 429 and the team is told.
- The health of the jobs Supabase Cron runs (a route answering 500 to pg_net) is still read with SQL only.

## Out of scope

A public status page; a daily "all passing" post; checks that need a key or reach the API (`/api/v1`).

## Tests

`tests/synthetic-check.test.ts`: the addresses checked, each text against its source and Next.js's robots and sitemap
output, the verdict for each kind of failure, the alert rule round by round, posts refused and retried, the post's body,
the secret never in the log, the command with no secret, a loop of rounds, an unreadable state file, and the workflow's
schedule, concurrency, permissions, secret and checkout.
