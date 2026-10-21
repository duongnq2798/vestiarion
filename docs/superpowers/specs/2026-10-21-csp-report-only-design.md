# Content Security Policy, report-only

Date: 2026-10-21. Status: accepted.

## Why

The app sends no Content Security Policy, except `frame-ancestors 'none'` on the Chrome extension's sign-in page. The
security page says so under "What we do not claim". A policy limits what a page can load, where it can send data, which
site can frame it, and where its forms can go. If someone ever got a script onto a page, the policy is what stops it
loading more from elsewhere or sending a session's data away.

A policy that is wrong breaks pages: an analytics tag that never loads, a passkey wallet that cannot reach Circle, a
connect form that cannot reach the tool's consent screen. So it is sent report-only first. Browsers report what it
would have blocked and block nothing. Once the reports show it fits every page, it is enforced, a later change.

## What

**CSP1. The policy** (`contentSecurityPolicy`, `src/lib/security/csp.ts`):

| Directive | Sources |
|---|---|
| `default-src` | `'self'` |
| `script-src` | `'self'`, `'unsafe-inline'`, Google Tag Manager; `'unsafe-eval'` in development only |
| `style-src` | `'self'`, `'unsafe-inline'` |
| `img-src` | `'self'`, `data:`, `blob:`, Google Analytics and Tag Manager |
| `font-src` | `'self'`, `data:` |
| `media-src` | `'self'` |
| `connect-src` | `'self'`, Google Analytics, Circle's Iris (both networks), Circle's modular wallets client |
| `object-src` | `'none'` |
| `base-uri` | `'self'` |
| `form-action` | `'self'`, HubSpot, Asana, Pipedrive and Zoho's consent screens, Google sign-in, the deployment's Supabase |
| `frame-ancestors` | `'none'` |
| `report-uri`, `report-to` | `/api/csp-report`, the `csp` endpoint |

- Scripts and styles may be inline. Next.js inlines its own, and a nonce would make every page render per request, the
  static pages included. The policy still limits where scripts come from, where data goes, framing, plugins, `<base>`
  and forms.
- React uses `eval` in development for its error overlay, so development allows it. Production never does.
- Google Analytics' origins are the ones Google lists for a policy: the tag from `*.googletagmanager.com`, hits to
  `*.google-analytics.com` and `*.analytics.google.com`.

**CSP2. Each origin is held to the code that reaches it** (`tests/csp.test.ts`).
- The browser calls Circle's Iris for a transfer from another chain: its fees and its arrival. The test takes the Iris
  origin from each network's profile.
- A passkey wallet calls Circle's modular wallets client. The test takes its default URL from
  `src/lib/passkey-treasury.ts`. A deployment that sets `NEXT_PUBLIC_MODULAR_WALLETS_CLIENT_URL` or
  `NEXT_PUBLIC_MODULAR_WALLETS_MAINNET_CLIENT_URL` adds that origin.
- The connect pages for HubSpot, Asana, Pipedrive and Zoho CRM post to this deployment, which sends the person on to the
  tool's consent screen. Chrome checks the redirects after a form's submission against `form-action`. The test takes
  each origin from the connector's authorize URL.
- **Continue with Google** is a Server Action that sends the person to Supabase Auth, then Google. A browser that submits
  it before the page's script runs follows those redirects as a form submission. So `form-action` names Google's sign-in
  and the deployment's `NEXT_PUBLIC_SUPABASE_URL` origin.
- An environment value adds its `https:` origin only, never a path, a keyword or a wildcard.

**CSP3. The header.**
- `next.config.ts` sends `Content-Security-Policy-Report-Only` on every response, with
  `Reporting-Endpoints: csp="/api/csp-report"`.
- A browser with the Reporting API sends reports to the `report-to` endpoint; others use `report-uri`.
- The extension sign-in page keeps its enforced `frame-ancestors 'none'` beside it.
- The security page says the policy is report-only and allows inline scripts. `tests/security-page.test.tsx` holds it
  to the config.

**CSP4. The reports** (`POST /api/csp-report`).
- It reads both formats browsers send: `report-uri`'s `{"csp-report": {...}}`, and the Reporting API's array, of which it
  takes `csp-violation` reports only, at most 20 a request.
- Each violation is one line in the server log, `csp report-only {"directive":…,"blocked":…,"page":…}`:
  - the directive that would have blocked it;
  - the blocked origin, or the browser's keyword for what was not a web address (`inline`, `eval`, `data`);
  - the page's first path segment only (`/o`, `/p`, `/docs`).
- Nothing else is kept: not a full address, which can carry a payee link's token or a workspace's records; not the
  sample, which can carry what someone typed; not the referrer or the client's address. Nothing is stored.
- What a browser extension did (`chrome-extension:` and the like) is left out: it is not this app's to fix. Anything
  that does not read as a directive, an origin or a path segment is logged as `unknown`, never as given.
- Browsers send reports without cookies, so the route needs no session.
- 20 reports per client, then one every 3 seconds, and 300 a minute in all per instance (`takeCspReportToken`).
- A body over 64 KB answers 413 and one that is not JSON 400, with nothing logged.

## Not in this change

- **Enforcing it.** After a few days of production reports, the policy changes where they show it should, and the
  header becomes `Content-Security-Policy`.
- **Nonces or hashes.** Without `'unsafe-inline'` an injected inline script would be blocked too. That needs a nonce on
  each request, which ends static rendering, or Next.js's experimental hashes. Either can come later, report-only first.
- **Branch protection on `main`.** The repository's owner turns it on in GitHub; the security page changes when it is.

## Tests

`tests/csp.test.ts`:
- the policy's directives, `'unsafe-eval'` in development only;
- each origin held to the code (CSP2), a deployment's own origins, and a value that is not an `https:` URL left out;
- the header on every response, and only the extension page's policy enforced;
- both report formats, a batch's limit, other report types, extensions, and odd values;
- the route's 204 and log line, 400, 413 and the rate limit.

`tests/security-page.test.tsx` holds the page's sentence to the config.
