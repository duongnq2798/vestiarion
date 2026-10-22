# Screening health

Date: 2026-10-22. Status: accepted.

## Why

Name screening uses one OpenSanctions hosted-API key (`OPENSANCTIONS_API_KEY`) that expires on Oct 30. When a key stops
working, nothing breaks loudly, and the header still says "Screening: Live":
- every live lookup fails with HTTP 401 or 403;
- existing counterparties keep their last verdict;
- new counterparties are held as unscreened.

After a new key is set there is no way to prove it works on production without screening a real person or adding a
counterparty, and passive proof can take more than a day (12 live checks in 7 days). This change makes the key's health
visible and checkable.

## Rules

**SH1. Check the key on production, writing nothing.** A platform-team page, `/admin/screening`
(`src/app/admin/screening/page.tsx`), gated by `growthTeamUser()` as `/admin/growth` is, and `notFound()` for anyone
else. Its one action, `checkScreeningNowAction` (`src/app/admin/screening/actions.ts`), asks the gate again itself.
- **Check now** runs `runScreeningCheck` (`src/lib/screening/check.ts`, the structured core `checkScreening` and
  `npm run screening:check` now print from) against one fixed fictitious company name, "Zenith Trading Example LLC"
  (`HEALTH_CHECK_NAME`), sent to the provider only. Never on page load: each lookup is a metered call.
- **What it shows:** provider and URL origin; whether a key is set; which variable set is in use (`OPENSANCTIONS_*` or
  `SCREENING_*`, from `screeningVariableSet` in `src/lib/config.ts`); OK or the HTTP status with what it means; the time
  taken; and the verdict. The page also shows the setup (`screeningSetup`) without calling the provider, and why no
  lookup can be made when the settings would stop the app at start.
- **What it writes:** one `console.info` line for `vercel logs`, `screening check: provider=… origin=… ok=… status=…
  ms=…` (`screeningCheckLogLine`). Never the key or the full URL: a provider's own error is shown with the key and every
  address but its origin taken out (`redactScreeningSecrets`), on the page and in the command alike.
- **What it never does:** create a counterparty, write a `compliance_checks` row, or touch the ledger.

**SH2. Typed failures.** `yenteProvider` (`src/lib/screening/providers.ts`) throws `ScreeningHttpError`, carrying the
HTTP status and its kind, with the same message as before (`<label> screening failed with HTTP <status>`), so callers
and SH1 can tell these apart:
- 401/403: the key is refused (`key_refused`);
- 429: over quota (`over_quota`);
- 5xx: provider down (`provider_down`);
- any other status: `other`.

`applyScreening` keeps the provider's error as its wrapper's `cause`, and `screeningHttpFailure` finds it behind one.
`failureKindOfNote` reads the kind back from a failed check's recorded note.

**SH3. The last successful live lookup.** A live check here means a lookup of the screening provider: a
`compliance_checks` row with `screening_mode = 'live'` and a source other than `ofac-sdn` (`OFAC_ADDRESS_SOURCE`,
`src/lib/sanctioned-wallets.ts`). A verdict on a payout address on OFAC's list (sanctioned wallets SW4) is written as
live, since OFAC's own list decided it, but it calls no provider, so it says nothing about the key and every read below
leaves it out. Its `live` mode still decides when a counterparty is due for screening.
- **The admin page.** It also shows, platform-wide: the last complete live check, and the last failed live check with
  its note's first 120 characters, plus counts over 24 h and 7 d, from those rows. `platformDb()` reaches no tenant table, so this is `screening_health()` (migration 0139), a
  security-definer function for the service role only, read by `readPlatformScreeningHealth`
  (`src/lib/screening/platform-health.ts`), which only the team's page imports. It names each workspace by its slug: no
  counterparty, no person. The note is shown with the deployment's keys and addresses taken out, and with what its HTTP
  status means. Before 0139 runs, the page says the platform read is not there yet; Check now still works.
- **Per workspace.** Owners and admins of a workspace that screens live see, on the Compliance page beside the latest
  sweep, "Last successful live screening: <time>" (`lastLiveSuccessLine`, `src/lib/screening/health.ts`), read in the
  workspace's own scope. "none yet" when there is none, "could not be read" when the read fails.

**SH4. The header stops saying Live when lookups fail.** `shellStatus` reads the workspace's newest live check, in
scope (`readNewestLiveCheck`), as SH3 counts them: provider lookups, never an OFAC address verdict, so a sweep that
finds a listed address while every name lookup fails still says the last lookup failed:
- when it failed, the screening fact reads "Live, last lookup failed" in the held tone;
- when it succeeded or there is none, the fact is "Live" as today;
- when it cannot be read, "Live" as today (the configured fact; nothing is paid on it), logged.

The read is one `limit 1` query, run at the same time as the shadow mode read, and not at all for a workspace that does
not screen live. Migration 0139 adds the partial index `compliance_checks_live_newest (org_id, created_at desc) where
screening_mode = 'live'` it reads from (the source filter is applied on top of it); before it runs, the same query reads
the same rows through the `org_id` index.

After a key is changed, Check now (SH1) proves it but writes no check, so a workspace's header keeps saying "Live, last
lookup failed", and Compliance its old time, until that workspace's next live lookup: its next agent cycle. The runbook
says so (SH5).

**SH5. A runbook.** In `docs/self-hosting.md`, "Changing the screening key", with a pointer on `/admin/screening`; the
workspace guide names the new header value. How to rotate the key:
1. Run `npm run screening:check` locally with the new key.
2. Replace only the value of `OPENSANCTIONS_API_KEY` in Vercel Production, keeping `OPENSANCTIONS_API_URL`. Setting any
   `SCREENING_*` variable alone switches to the new set and fails at start.
3. Redeploy.
4. Use Check now on `/admin/screening`.
5. Read `vercel logs`.

Never print the key.

## Migration

`0139_screening_health.sql`: the two partial indexes on live checks (`compliance_checks_live_newest` by workspace,
`compliance_checks_live_recent` by time) and `screening_health()`, whose four reads leave out `source = 'ofac-sdn'`
(SH3); the indexes keep the plain `screening_mode = 'live'` predicate. Additive and idempotent. The code works before it
runs: the header and Compliance read the same rows without the index, and the admin page says its platform read is not
there yet.

## Not in this change

- A second, overlapping key.
- An expiry date in config.
- Holding payments when a verdict is old.
- Any /api/v1 change: `GET /api/v1/status` still reports screening as configured.
- A throttle on Check now beyond its button waiting for the answer: it is for the platform team only.

## Tests

- SH2 typed errors, with their messages unchanged, found behind a wrapper, and read back from a note
  (`tests/screening-health.test.ts`).
- SH1 (`tests/screening-health-access.test.ts`, `tests/access-gates.test.ts`):
  - the gate: notFound off the team and when the gate cannot be read, the action refused before any lookup;
  - the action's output shape;
  - nothing written: no table, no function but the gate, no workspace database, one log line;
  - key and URL never in the output or logs, with a fake provider whose error quotes both.
- SH3: the reads' queries are live-mode only and leave out OFAC address verdicts, so a newer one never hides the older
  provider lookup (`tests/shell-status.test.ts`); `screening_health()` counts live provider lookups only, never an
  `ofac-sdn` row, a sandbox's included, and runs for the service role only (`tests/screening-health-migration.test.ts`);
  the platform read is used on the admin page only; and the Compliance line is shown to owners and admins of a live
  workspace only, with no read for anyone else, in the sweep's callout or on its own
  (`tests/compliance-page-screening-line.test.tsx`).
- SH4: the header's tone and words for a failed newest check, for an ok one, and for none (`tests/workspace-status.test.ts`,
  `tests/shell-status.test.ts`), a failed lookup still said when an OFAC address verdict is newer, and no read where
  screening is not live.
- The runbook's commands match `package.json` scripts, its variable names are the config's, and its page and log line
  are the code's (`tests/screening-runbook.test.ts`).
