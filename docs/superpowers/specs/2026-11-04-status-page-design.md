# A public status page, fed by the production check

Date: 2026-11-04. Status: built.

## Problem

The production check (`docs/superpowers/specs/2026-10-28-production-check-design.md`) opens production's public pages
from GitHub's servers every 10 minutes and tells the team on a private Discord channel. Nobody else sees it: a
visitor, a customer or a reviewer has no way to tell whether Vestiarion is up, or how it has been. The check's results
live in its job log, which needs a GitHub sign-in, and in a state file in the Actions cache, which nobody can read.

The page must be fed by that check, which runs outside Vercel and Supabase, and must not add a database table: no
migration runs in the week of Nov 4 to Nov 8.

## Decision

SP1. **Where the results go.** After each round, the check publishes the results of the last 7 days to the
repository's `status` branch. That branch holds one commit, replaced every round, with no parent and three files:
- `status.json`: the results (SP2);
- `README.md`: the same state as a table, so GitHub shows it at `https://github.com/duongnq2798/vestiarion/tree/status`
  even while vestiarion.xyz itself does not answer;
- `vercel.json`: `{"git":{"deploymentEnabled":false}}`, so Vercel builds nothing for the branch. Checked on Nov 4 with
  a throwaway branch holding only that file and a README: no deployment and no commit status after two minutes, nor
  after an hour, where a pull request's branch gets one within seconds.

The branch is replaced, not added to, so it never holds more than one commit, and nothing reaches `main`. This is how
Upptime, a status page run from GitHub Actions, keeps its data. The check keeps reading only public pages (PC10); it
now also writes this one branch.

SP2. **The file.** `status.json`, at most about 300 KB:

```json
{
  "version": 1,
  "source": "Vestiarion's production check, run from GitHub's servers outside Vercel and Supabase.",
  "origin": "https://www.vestiarion.xyz",
  "everyMinutes": 10,
  "updatedAt": "2026-11-04T12:10:17.490Z",
  "checks": [{ "path": "/", "budgetMs": 8000 }],
  "rounds": [{ "at": "2026-11-04T12:10:17.490Z", "results": { "/": [1, 4697], "/sitemap.xml": [0, 10030, "took 10.0 s, over its 4 s budget"] } }]
}
```

- `checks` is the list the last round ran, in its order. `rounds` is oldest first, every round of the last 7 days
  (about 1,008 when no run was missed). Each result is `[1, ms]` for a pass and `[0, ms, reason]` for a failure, the
  reason as the job log gives it (PC2), at most 200 characters.
- It holds what the job log holds: public addresses, times and reasons. No token, no secret, no visitor's data.

SP3. **How a round is published.** Through GitHub's REST API, with the job's own `GITHUB_TOKEN`: one call makes a tree
of the three files, one a commit with no parent, and one moves `refs/heads/status` to it, by force, or makes it when it
does not exist. The script names that one ref and no other. Every request carries the token and a 15-second deadline,
and a refusal is logged by its status alone, never with the token or GitHub's answer. A round that could not be
published is a warning in the log, never a failed run (PC9 is unchanged): the next round publishes everything again.
The script only publishes with `--publish-status`, which the workflow passes; a run on a laptop or in a test publishes
nothing.

SP4. **The history.** When a run starts, the script reads `status.json` back from the branch through the API, with the
same token, and goes on from it: its rounds of the last 7 days are kept, and anything it cannot read is dropped with a
warning, starting from no history. Each round is appended, and rounds older than 7 days are dropped. So the history
survives the Actions cache being emptied, and a run cut short loses at most its last round.

SP5. **The workflow.** `.github/workflows/synthetic-check.yml` gives its one job `contents: write`, in place of
`contents: read`, and passes `GITHUB_TOKEN` and `--publish-status` to the script. `main` is protected (a pull request
with a review and CI's `verify`, admins included), so this token cannot change `main`; it could push another branch or a
tag. The release workflow publishes only a tag on a commit of `main` whose `verify` passed, so a pushed tag alone
releases nothing. The job still checks out the script alone, without credentials, and installs nothing.

SP6. **The page.** `/status`, public, in the sitemap and the footer's Resources group, after Open numbers.
- It reads `https://raw.githubusercontent.com/duongnq2798/vestiarion/status/status.json`, kept 60 seconds
  (`revalidate`), and GitHub's own cache keeps it up to 5 minutes. So the page can be about 6 minutes behind the last
  round, and says when that round was.
- **The headline:** "All checks passing" when every check passed in the last round; "1 of 10 checks failing" with which;
  or, when the last round is more than 25 minutes old, "Checks paused since 12:10 UTC". Paused says why: GitHub starts
  the check's runs hourly, sometimes hours late, and the last result is shown until the next round.
- **Each check:** its name (the landing page, the open numbers, the docs, each free tool by its title, robots.txt, the
  sitemap), its address, its last result and time, and the share of rounds it passed in the last 24 hours and 7 days.
  A strip of the last 24 hours, one cell an hour, says for each hour whether the check passed every round, failed one,
  or was not checked. Hours with no round are shown as not checked, never as passing.
- **Coverage:** how many rounds ran in the last 24 hours and 7 days, against the 144 and 1,008 a round every 10 minutes
  makes, so the pauses show.
- **Incidents:** each time a check failed two rounds running, the rule the team is told by (PC5), from its first
  failing round to the round it passed again, or "still failing", with the first reason. A single failed round is not an
  incident; it shows in its hour's cell.
- **What it covers:** the public pages only, from outside Vercel and Supabase. Not the API (it needs a key), signed-in
  pages, the agent's cycles, payments, Circle or Arc. Each round's results are the job log's.
- When the file cannot be read or is not one the script writes, the page says the status could not be read right now,
  links the branch on GitHub, and still answers 200.

SP7. **Reading the file in the app.** `src/lib/status/` parses `status.json` strictly: a version other than 1, a field
of the wrong type, a time that is not an ISO time, a result that is not `[1, ms]` or `[0, ms, reason]` refuses the whole
file. The summary (headline, uptime, hours, coverage, incidents) is a pure function of the file and the time of the
read, tested apart from the page. `tests/status-page.test.ts` writes a file with the script's own functions and reads
it with the app's parser, so the two cannot drift.

## Known limits

- **The page is at most about 6 minutes behind the last round**, and the rounds pause when GitHub starts no run, for up
  to about 3 hours so far. The page says when the last round was, and counts the rounds that ran.
- **History is 7 days.** An incident older than that is gone from the page.
- **The check's token can push to any branch or tag but `main`** (SP5). Making that narrower needs the owner to add a
  ruleset that limits who creates tags, which this change does not do.
- **The page reads GitHub.** If raw.githubusercontent.com does not answer, the page says the status could not be read,
  though production may be fine.
- **A change to the script reaches the running checks only with a newer run** (PC3, PC4): the branch first appears up
  to about 7 hours after this is merged, unless the workflow is run by hand and the older run cancelled, as "What the
  owner adds" in the production check's spec says.

## Out of scope

Checks of the API or signed-in pages; a history longer than 7 days; email or RSS subscriptions; a status badge.

## Tests

- `tests/synthetic-check.test.ts`: a round appended and rounds older than 7 days dropped; the file and its README for a
  passing, a failing and an empty history; a reason clipped to 200 characters; the publish calls (tree, commit with no
  parent, the one ref moved by force or made) against a fake GitHub, with the token sent and never logged; a refused
  publish logged by status and the run not failed; history read back from the branch, and an unreadable one dropped;
  no publish without `--publish-status`; the workflow's `contents: write`, its token and its flag.
- `tests/status-page.test.ts`: the parser refusing each kind of bad file; the headline for passing, failing and paused;
  uptime and coverage over rounds with gaps; the hour cells; incidents from two failures running, ongoing or ended, and
  none from one; the page for each state and for an unreadable file; `/status` in the sitemap and the footer.
