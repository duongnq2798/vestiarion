# A Zapier integration for Vestiarion (2026-11-06)

Status: building on branch `feat/zapier`. No migration. One addition to `/api/v1`: the ledger can be read newest first.

Plan item of Nov 4 (`docs/gtm/23-plan-den-30-11.md`): "a Zapier private beta: triggers Agent decision and Payment
status changed, action Create bill". The integrations spec (`2026-10-03-integrations-design.md`) put Zapier after the
write API, and the n8n node (`2026-11-03-n8n-node-design.md`) is the same idea for n8n. The Zapier integration is
registered (Platform UI, private, integration 249314) and built here with the Zapier Platform CLI.

## Why

Most small businesses that automate anything do it in Zapier:
- a new invoice in Gmail, a form or a sheet becomes a bill;
- a paid bill or an agent's decision becomes a row in a sheet, a message in Slack, or a task.

Today that takes Webhooks by Zapier, a key pasted into a header and a Code step to page the ledger. An integration
makes each of those one step, with the workspace's own key.

## Rules

Code comments and test names cite the ids, for example "(Zapier Z4)".

**Z1. The ledger newest first** (`GET /api/v1/ledger?order=desc`).
- A Zapier polling trigger asks for the newest items each time, and keeps no cursor between polls. The ledger answers
  oldest first, so the newest entry is on its last page.
- `order` is `asc`, the default and what every caller gets today, or `desc`: the newest `limit` entries, newest first,
  with `domain` and `actor` as before.
- `order=desc` takes no `cursor`: it is for "what is newest", not for paging back. A cursor with it answers `400`, since
  a watermark read the other way round would skip or repeat entries. Its `page.nextCursor` is `null` and
  `page.hasMore` says whether older entries exist. Any other `order` answers `400`.
- The OpenAPI document, the API reference page, the developer changelog and the Postman collection's "List the agent's
  decisions" step say so. The SDK and the MCP tool keep reading oldest first; a later SDK may take `order`.

**Z2. One integration, in `zapier/`.**
- Plain JavaScript (CommonJS), as the Zapier CLI's templates are, on `zapier-platform-core` 19.2.1, with the CLI pinned
  beside it as a dev dependency so `npx zapier` is the version the tests ran with.
- Private: invited users only. Nothing here asks for Zapier's public review.
- The Platform UI's integration is linked with `zapier link`; `.zapierapprc` (the integration's id) is committed, and
  no key or deploy key is.

**Z3. Authentication: the workspace's API key.**
- Custom auth with two fields: **API Key** (password), sent as `Authorization: Bearer`; and **Base URL**, optional,
  `https://www.vestiarion.xyz` when empty. Plain http is refused except to localhost, so the key never crosses a network
  in the clear (as n8n N4).
- The test reads `GET /api/v1/status`; the connection is labelled with the workspace's `businessName`.
- A `401` asks the user to reconnect; any other error carries the API's own `error.message` and `error.code`, and a
  `429` its `Retry-After` (Zapier's `ThrottledError`).

**Z4. Triggers, all polling the ledger newest first (Z1).** Zapier de-duplicates on `id`, the entry's id.

| Trigger | Reads | Keeps |
|---|---|---|
| **New Agent Decision** | `order=desc&actor=agent&limit=100`, optional `domain` | every entry |
| **Bill Paid** | `order=desc&domain=ap&limit=200` | `ap_pay` whose `execution.resultingStatus` is `paid`; `approval_paid` whose `status` is `paid` |
| **New Ledger Entry** | `order=desc&limit=100`, optional `domain` and `actor` | entries whose `action` is one of the optional comma list |

- Each record is the API's entry, plus fields a Zap can map without reading `detail`: `reasoning` (the agent's), and
  where the entry names them `invoiceId`, `milestoneId`, `counterpartyId`, `amount`, `currency` and `txRef`.
- **Bill Paid** says who paid (`paidBy`: `agent` or `human`) and is the "payment status changed" the plan asked for, at
  the change people act on. A bill held or flagged is a New Agent Decision.
- A poll reads one page. More than a page of matching entries between two polls is possible only in a very busy
  workspace; the guide says how often Zapier polls.
- Instant triggers need an API to add and remove a webhook endpoint, which does not exist: Settings adds endpoints by
  hand. Later, with that API.

**Z5. The action: Create Bill** (`POST /api/v1/invoices`, `direction: payable`).
- **Counterparty**, a dynamic dropdown of the workspace's vendors and contractors (a hidden trigger over `GET
  /api/v1/counterparties`, the first 200), or an id typed or mapped. **Amount** as text, so `1250.50` stays exact. **Due Date**,
  sent as `YYYY-MM-DD`. **Currency** USDC (default) or EURC. Optional: PO reference, goods received, memo, an early
  payment discount (percent and deadline, both or neither), and an idempotency key, sent as `Idempotency-Key`.
- It adds a bill for the agent to decide, as one typed into the console with every guardrail. It never approves or pays:
  no key can.

**Z6. Nothing in the integration holds data.** It keeps nothing between runs and sends the key only to the Base URL.

**Z7. Tests** (`zapier/test/`, vitest, `zapier-platform-core`'s app tester with `fetch` stubbed): the auth test and its
label, the http refusal, each trigger's query and its filters, the field mapping, the error mapping, and Create Bill's
body. `zapier validate` runs in CI. The route test holds Z1.

**Z8. CI and publishing.** A `zapier` job in `ci.yml`, beside the `n8n` job: `npm ci`, `npm test`, `npx zapier
validate`. Pushing a version (`zapier push`) needs the owner's deploy key and is done by hand, never in CI.

**Z9. Docs.** `content/docs/get-started/zapier.mdx`, beside the n8n guide: connect a key, the triggers and the action,
how often Zapier polls, and that the integration is private and joined by invitation. README's integrations, the
developer changelog (Z1), CHANGELOG `[Unreleased]` and ARCHITECTURE.

## Out of scope

- Instant (REST hook) triggers, until the API can add a webhook endpoint.
- Make: the same API serves it; later.
- Making the integration public, which is Zapier's review and needs users first.
