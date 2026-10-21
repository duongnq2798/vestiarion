# Screening providers

Date: 2026-10-21. Status: accepted.

## Why

Name screening calls OpenSanctions' matching API, wired into `screenName` (`src/lib/compliance.ts`) and read from
`OPENSANCTIONS_API_URL` and `OPENSANCTIONS_API_KEY`. The deployment's key is due to be changed by Oct 30, and the
partner is choosing which service and plan to buy. Two cases must not need a code change:
- a new key, or the same service on another plan or address;
- a self-hosted yente server (OpenSanctions' open-source matcher) in place of the hosted API.

Today both mean editing code that also decides payment authority. Another service later should be one file, behind
the same seam, with nothing else touched.

## What

**SP1. A provider is one object** (`src/lib/screening/providers.ts`): its id, the name the console shows, and
`screen(name, jurisdiction, dismissed)`, which returns the `ScreeningResult` the sweep already writes. The classifying
rules stay as they are: a strong sanctions match is high and takes payment authority away; a weaker one is medium.

**SP2. Two providers speak yente's match API.**
- `opensanctions`: OpenSanctions' hosted API, `https://api.opensanctions.org` by default. It needs a key.
- `yente`: any yente server at a URL the deployment names, with a key only if that server asks for one.
- Both send the same match query and read the same answer, so their verdicts are the same. Each records its own
  `source` (`opensanctions:yente` as before, `yente:self-hosted` for the other), so a verdict says where it came from.
  A failed check and the sweep's ledger entry record the same.

**SP3. The deployment picks it** (`src/lib/config.ts`):
- `SCREENING_PROVIDER`: `opensanctions` or `yente`. When absent, it is `opensanctions` if `OPENSANCTIONS_API_URL` is
  set, as today, and none otherwise.
- `SCREENING_API_URL` and `SCREENING_API_KEY` name the address and the key. `OPENSANCTIONS_API_URL` and
  `OPENSANCTIONS_API_KEY` still work when none of the three `SCREENING_*` names is set, so a deployment that sets
  nothing new behaves as before. The two sets never mix: a key is only sent to the address set beside it, and an
  address or key set without `SCREENING_PROVIDER` is refused.
- A provider named without what it needs (`opensanctions` with no key, `yente` with no URL) fails at start with a
  message naming the variable, as a pinned model provider does. A deployment never screens with a provider it did not
  configure.
- A sandbox still uses the bundled list, and a live workspace with no provider stays unscreened (payment safety K1).

**SP4. The console and the evidence name the provider.**
- `screeningSourceLabel` gives the provider's name.
- The evidence chain calls a live verdict from either provider screened by it.

**SP5. A key is checked before it is set.** `npm run screening:check -- "<name>"` screens one name with the provider
the environment names and prints the verdict, the top match and how long it took, never the key. Run it with a new key
before putting the key in the deployment.

## Not in this change

- A third service. Adding one is a file in `src/lib/screening/` and a line in the registry; it waits for the partner's
  choice and a key to test against.
- Changing the deployment's key, which is the partner's (by Oct 30).

## Tests

- The registry: the provider for each environment, the old variables still working, a provider without what it needs
  refused.
- Both yente providers: the query each sends (address, key header), the verdict each returns and its source, dismissed
  matches skipped, an HTTP failure and an invalid answer.
- `screenName` through the provider, the bundled list in a sandbox, and no verdict in a live workspace with none.
- The console label and the evidence chain for each provider.
- The check script's output, without the key.
