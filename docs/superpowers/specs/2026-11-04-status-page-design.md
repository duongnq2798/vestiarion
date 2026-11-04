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
- `README.md`: the last round as a table, so GitHub shows it at `https://github.com/duongnq2798/vestiarion/tree/status`
  even while vestiarion.xyz itself does not answer, with what an old time means and where to report a problem;
- `vercel.json`: `{"git":{"deploymentEnabled":false}}`, so Vercel builds nothing for the branch. Checked on Nov 4 with
  a throwaway branch holding only that file and a README: no deployment and no commit status after two minutes, nor
  after an hour, where a pull request's branch gets one within seconds.

The branch is replaced, not added to, so it never holds more than one commit, and nothing reaches `main`. Upptime, a
status page run from GitHub Actions, also keeps its data in its own repository. The check still reads only public
pages of production (PC10); it now also writes this one branch.

SP2. **The file.** `status.json`:

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
  reason as the job log gives it (PC2), clipped to 120 characters.
- A week of rounds is about 270 KB with every page passing, about 520 KB with every page timing out, and about 1.5 MB
  with every page failing with a 120-character reason, under the page's 3 MB limit on what it reads.
- It holds what the job log holds: public addresses, times and reasons. No token, no secret, no visitor's data.

SP3. **How a round is published.** Through GitHub's REST API, with the job's own `GITHUB_TOKEN`: one call makes a tree
of the three files, one a commit with no parent, and one moves `refs/heads/status` to it, by force, or makes it when
GitHub answers that it does not exist (422 or 404). The script names that one ref and no other. Every request carries
the token and a 15-second deadline, follows no redirect, and keeps nothing of GitHub's answer but its status and, when
it took the call, its body. A refusal is logged by its step and status, never with the token or GitHub's answer. A
round that could not be published is a warning in the log, never a failed run (PC9 is unchanged): the next round
publishes everything again. The script publishes only with `--publish-status`, which the workflow passes; a run on a
laptop or in a test publishes nothing.

SP4. **The history.** When a run starts, the script reads `status.json` back from the branch through the API, by its
full ref, with the same token, and goes on from it, keeping its rounds of the last 7 days. Each round is appended, and
rounds older than 7 days are dropped. So the history survives the Actions cache being emptied.
- **No branch yet** (GitHub answers 404 for the file, and 404 for the branch's ref): the history starts empty.
- **Unanswered** (GitHub does not answer, answers an error, or answers 404 for the file of a branch that exists): the
  history is unknown, so nothing is published and the rounds wait in memory. The read is tried again before each
  round's publish. After 6 unanswered reads, the run's start included, about an hour of rounds, the history starts again
  from the rounds waiting, with a warning, so a branch GitHub cannot read never keeps the page paused.
- **Not a file the script writes**: dropped with a warning, starting from this run.
- A run cut short loses the rounds it had not published yet: at most its last, unless GitHub was refusing the
  publishes or leaving the read unanswered.

SP5. **The workflow, and what its token can do.** `.github/workflows/synthetic-check.yml` gives its one job
`contents: write`, in place of `contents: read`, and passes `GITHUB_TOKEN` and `--publish-status` to the script.
- The permission is the repository's, not the branch's. `main` is protected: a pull request whose CI `verify` passed,
  admins included, with no approval required. So the token cannot push to `main`, but it could merge a pull request
  whose `verify` passed, a fork's included, and it could write, or delete, any branch that is not protected, push a
  tag or create a release. The release workflow publishes only a tag on a commit of `main` whose `verify` passed.
- So only the script's own step is given the token. The job no longer runs `actions/checkout`, which takes the token
  by default: a `curl` step fetches the script alone, at the run's commit, from the public repository, with no token.
  The two cache actions, which are given no token, are pinned to a commit rather than a tag that could move. The
  script itself comes from `main`, which only a pull request whose `verify` passed changes.
- The job installs nothing, and the script still uses Node's built-ins only.

SP6. **The page.** `/status`, public, in the sitemap and the footer's Resources group, after Open numbers.
- **Words.** It speaks of a monitor that checks pages: on a product that pays bills, "2 of 10 checks failing" reads as
  payments. Times checked, never "rounds".
- **Read for each visit.** The page is rendered for each visit (`connection()`), and reads
  `https://raw.githubusercontent.com/duongnq2798/vestiarion/refs/heads/status/status.json` for it, with no copy kept by
  the app (`cache: "no-store"`): a copy served stale after a quiet spell would call a running monitor paused. GitHub
  keeps the file up to 5 minutes, so the page is at most about 5 minutes behind the last check.
- **The headline:** "All 10 pages up" when every page was up at the last check; "1 of 10 pages failing" with which;
  or, when the last check is more than 25 minutes old, "Monitoring paused since Nov 4, 2026, 12:10 UTC". Paused says
  why: GitHub is set to start the monitor every hour, each run checks for almost 6 hours, and GitHub has started runs
  hours late. It says that does not mean Vestiarion is down.
- **Each page:** its name (the landing page, the open numbers, the docs, each free tool by its title, robots.txt, the
  sitemap), its address, its last result and time, and how many times it was up of the times checked in the last 24
  hours and 7 days, with how many of the monitor's 10-minute slots had no check. While paused, each shows "Up at
  11:25 UTC" or "Failed at 11:25 UTC" in a neutral badge, never as the page's state now. Pages that failed at the last
  check come first.
- **The hour strip:** the last 24 hours, one cell an hour: up every check (a shorter green bar), a failure (a full red
  bar) or not checked (a shorter hatched bar), so colour is never alone, with a legend, and a sentence for screen
  readers that names the hours with a failure. An hour with no check is never shown as up.
- **Coverage:** how many of the monitor's 10-minute slots had a check in the last 24 hours and 7 days, against the 144
  and 1,008 there are. Slots, not checks: a run can start right after the last ends, so checks alone can count more.
  When the results kept begin inside a window, as in the first week after the branch first appeared (Nov 4, 2026,
  14:49 UTC), the slots are counted from the oldest result kept, which the page names: before it nothing was published,
  so nothing the page could know of was missed.
- **Incidents:** each time a page failed twice in a row, the rule the team is told by (PC5), from its first failure to
  the check it was up again, or "Still failing" ("Failing when monitoring paused" while paused), with the first
  reason. One already failing in the oldest result kept says so. A single failure is not an incident; it shows in its
  hour.
- **What it covers:** the public pages only, from outside Vestiarion's hosting. Not the API (it needs a key), signed-in
  pages, the agent's work, payments, Circle or Arc. It links GitHub Issues to report a problem.
- **No results:** before the branch exists GitHub answers 404, and the page says no results are published yet. When the
  file cannot be read, or is not one the script writes, it says the results could not be read right now, that this does
  not mean Vestiarion is down, and links the branch. Either way it answers 200.

SP7. **Reading the file in the app.** `src/lib/status/file.ts` parses `status.json` strictly: a version other than 1, a
field of the wrong type, a time that is not an ISO time, a result that is not `[1, ms]` or `[0, ms, reason]`, or a
reason over 120 characters refuses the whole file. The summary (headline, slots, hours, incidents) is a pure function
of the file and the time of the read (`src/lib/status/summary.ts`), tested apart from the page.
`tests/status-page.test.tsx` writes each file with the script's own functions and reads it with the app's parser, so
the two cannot drift, and holds the script's reason limit and pause time equal to the app's.

## Known limits

- **The page reads GitHub.** It is at most about 5 minutes behind the last check, and the checks pause when GitHub
  starts no run, for up to about 3 hours so far. The page says when the last check was, and counts the slots that had
  one. If raw.githubusercontent.com does not answer, the page says the results could not be read, though production may
  be fine.
- **History is 7 days.** An incident older than that is gone from the page.
- **The check's token can do more than publish** (SP5): merge a pull request whose `verify` passed, write or delete an
  unprotected branch, push a tag. Only the script's step holds it. Narrowing it further needs the owner: rulesets on
  tags and other branches, an approval required on `main`, or publishing to a separate repository with a token that
  reaches only that one.
- **A fork** must be public for the `curl` step, protect its own `main` before giving the job this permission, and name
  its own repository in `STATUS_FILE_URL` (`src/lib/status/file.ts`) and `GITHUB_URL` (`src/lib/site-links.ts`).
- **A change to the script reaches the running checks only with a newer run** (PC3, PC4): the branch first appears up
  to about 7 hours after this is merged, unless the workflow is run by hand and the older run cancelled, as "What the
  owner adds" in the production check's spec says. Until then the page says no results are published yet.

## Out of scope

Checks of the API or signed-in pages; a history longer than 7 days; email or RSS subscriptions; a status badge.

## Tests

- `tests/synthetic-check.test.ts`: a round kept as `[1, ms]` or `[0, ms, reason]` with the reason clipped; rounds older
  than 7 days dropped; the file; the README for a mixed and an empty history, its links and its escaping of a reason
  that quotes a link or an image; reading back only a file the script wrote; the publish calls (a tree of the three
  files, a commit with no parent, the one ref moved by force, or made when it does not exist) against a fake GitHub,
  with the token sent and never logged; a refusal reported by its step and status; the history read back, none before
  the branch exists, unanswered for a 404 of a branch that exists, dropped when it is not one; rounds waiting while
  the read goes unanswered and published once it is answered; the history started again after 6 unanswered reads; a
  refused publish logged and the run not failed; no publish without `--publish-status` or a token; the workflow's
  `contents: write`, its token given to the script's step alone, its `curl` of the script, its actions pinned to a
  commit, and the one ref the script names.
- `tests/status-page.test.tsx`: the parser refusing each kind of bad file; the read missing, unreadable or read, with
  no copy kept; a week of every page failing with the longest reason under the read's limit; each page's name; the
  headline for up, failing, paused and no results; slots counted for coverage; the hour cells; incidents from two
  failures running, ended or ongoing, already failing at the oldest result, and none from one; the page for each state,
  never "checks" counted on their own, failing pages first, the Issues link, and the per-visit render.
- `/status` in the sitemap and the footer: `tests/docs-content.test.ts` and `tests/site-footer.test.tsx`.
