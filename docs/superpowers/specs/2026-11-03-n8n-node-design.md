# An n8n community node for Vestiarion (2026-11-03)

Status: building on branch `feat/n8n-node`. No migration, no change to `/api/v1` or the webhooks.

Plan item of Nov 2 (`docs/gtm/23-plan-den-30-11.md`): "[TH] n8n community node: create a bill, receive the agent's
decision". The integrations spec (`2026-10-03-integrations-design.md`) listed n8n beside Zapier and Make, "after the write
API". The write API and signed webhooks both exist now.

## Why

Small businesses and their bookkeepers glue their tools together in n8n:
- a new invoice in an inbox, a form or a spreadsheet becomes a bill;
- a decision becomes a message in Slack or Telegram, a row in a sheet, or a ticket.

Today, doing that with Vestiarion means an HTTP Request node, a key pasted into a header, and signature checking written
by hand in a Code node. A node packages all three.

## Rules

Code comments and test names cite the ids, for example "(n8n N4)".

**N1. One package, two nodes and one credential.**
- `@vestiarion/n8n-nodes-vestiarion`, under the `vestiarion` npm organization that owns the SDK and the CLI.
- It lives in `n8n/`, in n8n's starter layout (`credentials/`, `nodes/<Node>/`, `icons/`). n8n's package scanner
  lints that layout.
- **The credential, Vestiarion API:**
  - API Key, sent as `Authorization: Bearer`;
  - Base URL, `https://www.vestiarion.xyz` by default;
  - Webhook Signing Secret, used by the trigger alone and never sent anywhere.
  - Its test reads `GET /api/v1/status`.
- **The Vestiarion node:** an action node, usable as an AI agent's tool.
- **The Vestiarion Trigger:** a webhook trigger.

**N2. The Vestiarion node's operations are API operations, and nothing else.**

| Resource | Operation | API |
|---|---|---|
| Bill | Create | `POST /api/v1/invoices`, `direction: payable` |
| Bill | Get Many | `GET /api/v1/invoices?direction=payable`, filters `status`, `counterpartyId` |
| Counterparty | Get | `GET /api/v1/counterparties/{id}` |
| Counterparty | Get Many | `GET /api/v1/counterparties`, filters `role`, `riskLevel` |
| Decision | Get Many | `GET /api/v1/ledger?actor=agent`, option `domain`, `cursor` |
| Workspace | Get Status | `GET /api/v1/status` |

- No operation approves, rejects or pays: no key can.
- A bill the node adds is decided by the agent as one typed into the console, with every guardrail.
- A receivable, a milestone and a payee link can be added by the API, but are left for a later version. Bills are what
  this plan item asks for.

**N3. Creating a bill.**
- The counterparty is a resource locator: chosen from the workspace's list (a search over each page of `GET
  /api/v1/counterparties`, by name) or given by its ID (a UUID).
- Amount is a string, so `1250.50` stays exact. The due date is a date, sent as `YYYY-MM-DD`. Currency is USDC or EURC.
- Additional fields: PO reference, goods received, memo, an early-payment discount (percent and deadline, both or
  neither), and an idempotency key.
- The idempotency key, when given, is sent as `Idempotency-Key`, so a rerun of the same workflow item cannot add the bill
  twice. Without one nothing is sent: n8n's own retry would then add a second bill, and the field's description says to
  use the source record's id.
- The node checks only what it must to build the body: an amount, a day, a counterparty, a whole discount. The API's own
  checks (a counterparty of another workspace, more than 6 decimals, a deadline after the due date) answer `400`, which
  the node shows with the API's message.

**N4. Requests and errors.**
- Every request goes through `this.helpers.httpRequestWithAuthentication` with the credential, and reads the full
  response with `ignoreHttpStatusErrors`.
- A status that is not 2xx becomes a `NodeApiError`:
  - `message` is the API's `error.message`;
  - `description` is `HTTP <status> <code>`, plus `Retry after <n> s.` when a `429` says when;
  - `httpCode` is the status.
- Continue On Fail outputs `{ error }` for the item and goes on. Every item keeps its `pairedItem`.
- Get Many reads one page at a time up to the limit, or every page with Return All, and stops at a cursor it has seen.
- Decision: Get Many reads the ledger oldest first, as the API does. Each entry carries `cursor`, the cursor to resume
  after its page, so a scheduled workflow can store the last one and read only what is new. A resumed read returns the
  last page again, as the API says: de-duplicate on `seq`.

**N5. The trigger takes only what Vestiarion signed.**
- Each delivery's `Vestiarion-Signature` (`t=<unix seconds>,v1=<hex>`) must be the HMAC-SHA256 of `<t>.<raw body>`
  under the credential's signing secret, `whsec_` included.
  - It is checked over the raw bytes n8n received (`rawBody`), never a re-serialised body.
  - The comparison is constant-time (`node:crypto` `timingSafeEqual`), and any one of several `v1` values may match.
  - The time must be within 300 seconds of now.
- A delivery that does not verify is answered `401` with the reason, and starts nothing.
- A credential with no signing secret fails the run with "The credential has no Webhook Signing Secret". It never
  falls back to taking unsigned deliveries.
- The test signs with the server's own `signWebhook` (`src/lib/webhooks/sign.ts`), so the node is held to what the app
  sends.

**N6. The trigger's filters.**
- **Events:** Agent Decisions (`entry.actor === "agent"`, the default) or Every Ledger Entry.
- **Domains:** any of ap, ar, contractor, treasury, compliance and system, or all.
- **Actions:** a comma-separated list, or all.
- **Include Test Deliveries:** on by default, so Settings' **Send test** starts the workflow. A test delivery carries no
  `entry`.
- A signed delivery the filters leave out is answered `200`, so Vestiarion counts it delivered and does not retry. It
  starts nothing. So is an event type the node does not know.
- A delivery that passes starts the workflow with the body as it was signed: `{ id, type, createdAt, workspace, entry }`.
  `id` is the same on every retry, and the docs say to de-duplicate on it.

**N7. Adding the endpoint by hand.**
- The API has no endpoint to add a webhook endpoint (`content/docs/get-started/cli.mdx`: "The API does not list webhook
  endpoints"). So an owner or an admin adds the node's Production URL in the workspace's Settings, under Webhooks, and
  pastes the signing secret into the credential. The node's notice says so.
- n8n's lint requires `checkExists`, `create` and `delete`. Each answers `true` and does nothing, with a comment saying
  why.
- To try the trigger: add the Test URL, choose **Listen for test event**, then **Send test** in Settings.
- Settings takes only an HTTPS URL on port 443 at a public address (`src/lib/webhooks/safe-url.ts`). n8n Cloud installs
  only verified nodes, so until verification (N10) the trigger needs a self-hosted n8n with a public HTTPS `WEBHOOK_URL`.
  The docs say so, and point an n8n the internet cannot reach at a Schedule Trigger with Decision: Get Many.

**N8. n8n's rules for community nodes.**
- MIT. No runtime `dependencies`; `n8n-workflow` is a peer dependency.
- The `n8n` field lists `dist/` paths. Imports are n8n-workflow, `node:crypto` and relative files only. No `process`,
  file system, environment or timers.
- Built with `n8n-node build` and linted with `n8n-node lint`, n8n's own tooling (`@n8n/node-cli` 0.54.6, strict).
- Every lint warning is fixed, the icon's light and dark variants included.

**N9. Tests and the real n8n.**
- `n8n/test/` (vitest, run in `n8n/`) covers every operation's request and output against the API's recorded examples
  (`content/docs/examples`): errors and 429, Continue On Fail, paging and cursor loops, the counterparty search, the
  signature cases and every filter.
- Before merge, the packed tarball is installed into a real n8n 2.45.7 as a community package and run end to end:
  - a Manual Trigger, then a bill through Vestiarion: Create against a local stand-in API;
  - the trigger, active, given a delivery signed by `signWebhook`, which then passes the item to an HTTP Request node;
  - an unsigned delivery, refused.
  The result is recorded under "As built".

**N10. CI and the package.**
- `n8n/` has its own `package.json` and lock. Its tooling pulls about 560 MB, the AI SDK under `@n8n/node-cli`
  included, so the root does not install it.
- A separate CI job installs it (`npm ci --prefix n8n`), then lints, builds and tests it, beside `verify`.
- The root's typecheck, lint and tests leave `n8n/` out.
- `npm run n8n:pack` builds it and packs `public/n8n/vestiarion-n8n-nodes-vestiarion-<version>.tgz`, committed, as the
  SDK and the CLI are. 0.1.0 is published by the partner from that file.
- n8n's verified listing, for n8n Cloud, needs a publish from GitHub Actions with provenance and a review of up to 4
  weeks. That is a follow-up: until then, a self-hosted n8n installs the package by name under **Settings > Community
  nodes**.

**N11. Docs.**
- A new page, `content/docs/get-started/n8n.mdx`: install, credentials, each operation, the trigger's setup and filters,
  and two example workflows.
- `n8n/README.md`, the package's own page on npm.
- README's developer table, ARCHITECTURE, `docs/RELEASING.md` (its own version line), and `CHANGELOG.md` under
  [Unreleased].
- No API change, so no entry in `content/docs/changelog.mdx`.

## What it does not do

- No polling trigger. Polling would page the whole ledger on its first run; the signed webhook is instant and already
  there. A scheduled workflow with Decision: Get Many and its `cursor` covers an n8n that the internet cannot reach.
- No approval, no payment, no write beyond a bill.
- No secret is logged or sent: the API key goes in a header, and the signing secret stays in n8n.

## As built

**The real n8n run (N9), Nov 3.**
- Setup:
  - n8n 2.45.7 from npm, Node 24.12, on Windows, with its own user folder.
  - The packed `public/n8n/vestiarion-n8n-nodes-vestiarion-0.1.0.tgz` was installed into that folder's
    `.n8n/nodes`, as **Install** under **Community nodes** places it, with peers left to n8n.
  - n8n logged "Loaded all credentials and nodes from @vestiarion/n8n-nodes-vestiarion" (1 credential, 2 nodes).
  - A local stand-in API answered from `content/docs/examples` and recorded every request.
- **The action node** (`n8n execute`, Manual Trigger, then Bill: Create, Decision: Get Many, Workspace: Get Status), exit 0:
  - `POST /api/v1/invoices` with `Authorization: Bearer`, `Idempotency-Key: e2e-inv-1` and `{ direction: payable,
    counterpartyId, amount: "1250.50", currency: USDC, dueDate: "2026-11-30", poReference: "PO-4012", goodsReceived:
    true }`;
  - `GET /api/v1/ledger?actor=agent&domain=ap&limit=1`;
  - `GET /api/v1/status`.
- **The trigger** (published workflow, Agent Decisions in `ap`, then an HTTP Request node posting the item to the stand-in).
  Deliveries were signed by the app's `signWebhook`:

  | Delivery | n8n answered | Next node |
  |---|---|---|
  | agent `ap_hold`, signed | 200 | got the delivery, `entry.detail.decision.reasoning` included |
  | unsigned | 401 "The delivery has no Vestiarion-Signature header." | nothing |
  | signed over another body | 401 "The signature does not match the body under this signing secret." | nothing |
  | a person's entry, signed | 200 `{ received: true, started: false }` | nothing |
  | a treasury entry, signed | 200 `{ received: true, started: false }` | nothing |
  | `webhook.test`, signed | 200 | got the delivery |

- At start, n8n 2.45 warns that `N8N_UNVERIFIED_PACKAGES_ENABLED` will default to `false` in a future version. The
  docs tell a self-hosted owner to set it to `true` to install this package until it is verified.
