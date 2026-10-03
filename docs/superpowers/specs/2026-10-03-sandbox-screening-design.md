# A sandbox screens against the bundled list

Date: 2026-10-03. Status: implemented on `fix/sandbox-bundled-screening`. Decided under the standing autonomy grant.

## 1. The problem

Screening chose its source for the whole deployment: with `OPENSANCTIONS_API_URL` set, every workspace called
OpenSanctions, sandboxes included. The hosted API is metered per call (the trial key allows 50 a month, a paid key
costs €0.10 a call). In October one sandbox with sample data used 12 calls of the first 51: six counterparties,
screened twice. Every person trying Vestiarion with sample data costs at least six more. Once the quota is used up,
counterparties added in live workspaces cannot be screened, and since #151 the agent pays them nothing.

A sandbox simulates its payments. Its counterparties gain nothing from a metered sanctions service.

## 2. Rulings

- **R1 — by workspace mode.** A live workspace screens against the configured service, as before. A sandbox screens
  against the bundled list, whatever the deployment configures: `orgConfig` gives a sandbox no screening URL and no key.
- **R2 — every cycle.** The bundled list costs nothing, so a sandbox re-screens every cycle, the bundled default
  (`rescreenIntervalHours` 0). A live workspace keeps the deployment's interval (`COMPLIANCE_RESCREEN_HOURS`).
- **R3 — verdicts from the other source are due.** `isScreeningDue` already treats a verdict from another source as
  due, so a sandbox counterparty screened by OpenSanctions earlier is screened again against the list on the next cycle.
- **R4 — the sample data is unchanged.** None of its names match the bundled list, as none matched OpenSanctions:
  all six screen clear either way, so the sample tour keeps its outcomes.
- **R5 — said where it shows.** The console's status strip already reads the workspace's mode ("bundled list" in a
  sandbox); `/api/v1/status` reports `screening: "simulate"` for a sandbox (changelog); the privacy page says names of
  a sandbox's counterparties are sent nowhere.

## 3. Rollout

1. Merge. No migration.
2. The next cycle of a sandbox records `compliance_sweep` with the bundled source and no calls to OpenSanctions; the
   OpenSanctions usage page shows calls from live workspaces only.
