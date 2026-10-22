# Enforce the Content Security Policy

Date: 2026-10-22. Status: accepted.

## Why

The policy went out report-only on 2026-10-21 (`2026-10-21-csp-report-only-design.md`), to learn from production
before blocking anything. The day of reports since holds 13 violations, all `script-src` `eval` or `wasm-eval`, on
`/`, `/docs`, `/check-address` and `/o`.

None of them is the site's own code:
- the scripts those pages load call neither `eval`, `new Function` nor WebAssembly;
- Zod's speed check runs `new Function("")` inside a `try` and falls back when it is refused;
- the libraries loaded inside a workspace compile WebAssembly only in a module the app never imports.

What is left is browser extensions running code in the page. Nothing the site itself needs was reported, so the policy
can be enforced.

## What

**CE1. A production build enforces the policy**, as `Content-Security-Policy`, except `form-action`.
- `form-action` stays report-only, sent beside it as `Content-Security-Policy-Report-Only` with the same report
  endpoint.
- A tool's consent screen may send the person on to a sign-in host before they agree: Intuit's, Xero's, HubSpot's EU
  one. Chrome checks a form submission's redirects against `form-action`. A blocked one would stop that connection, and
  only reports from real connections show those hosts.
- `REPORT_ONLY_DIRECTIVES` names it, and `cspHeaders` builds both headers.

**CE2. Where it stays report-only.**
- Development (`next dev`), and anything not a production build, sends all of it report-only, as before.
- So does a deployment with `DOCS_SCREENSHOTS=1`: `scripts/marketplace-images.mjs` frames those pages from a local file,
  and `frame-ancestors 'none'` would stop it.
- The extension sign-in page keeps its own enforced `frame-ancestors 'none'`.

**CE3. The reports say whether the browser blocked.**
- `/api/csp-report` logs `csp report {"directive","blocked","page","disposition"}`.
- `disposition` is `enforce` or `report`, as the browser says, and `unknown` otherwise.

## Not in this change

- Enforcing `form-action`, once reports from real connections show every host a consent screen passes through.
- Nonces or hashes, so `'unsafe-inline'` can go.

## Tests

- `tests/csp.test.ts`:
  - the production headers enforce everything but `form-action`, which is report-only, and together cover the whole
    policy;
  - development, tests and `DOCS_SCREENSHOTS=1` send it all report-only;
  - the config sends `cspHeaders`;
  - a report's disposition.
- `tests/security-page.test.tsx`: the security page says the policy is enforced but for `form-action`, with inline
  scripts allowed.
