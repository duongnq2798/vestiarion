# Write API: add counterparties and invoices from your own system

Date: 2026-10-03. Status: designed on `feat/write-api`. Decided under the standing autonomy grant. This is the first
of two parts; the second is a TypeScript SDK over the same OpenAPI document.

## 1. Why

`/api/v1` only reads. Every record still enters through the console, a CSV, a document, or the Telegram bot. A business
that already has invoices somewhere else, such as an accounting tool, a billing script, or a CI job paying for merged
work, must retype them. An AI agent connected over MCP can read the workspace but cannot hand it an invoice to
decide. The API keys design reserved this (K2: "a key can later be issued for more without an audit of every
route"), and the docs spec named it as the next surface.

## 2. Approaches considered

- **A. `POST` on the existing resources (chosen).** `POST /api/v1/counterparties` and `POST /api/v1/invoices` beside
  their `GET`s, behind the same guard, described by the same operation list. The OpenAPI document, the reference pages,
  the code samples and the MCP tools all follow from it.
- **B. One RPC endpoint, `POST /api/v1/actions`.** Less routing, but it breaks the resource shape every reader and the
  generated docs rely on.
- **C. Calling the console's server actions.** They are bound to a signed-in session and to form data; an API key has
  neither.

## 3. Rulings

- **R1. A `write` scope, issued deliberately.**
  - A key is either read-only, as every key is today, or read and write. `write` never comes without `read`.
  - An owner or admin chooses this when creating the key in Settings. Existing keys stay read-only.
  - Migration 0066 widens the `api_keys` scope check to `{read}` or `{read, write}`.
  - `api_key_created` already records the scopes.
- **R2. Two write operations in v1.**
  - `POST /api/v1/counterparties` takes `{ name, role, address?, chain?, jurisdiction?, paymentLimit?, noticeEmail? }`,
    validated by the console form's own schema. The counterparty is screened as one added in the console, and the
    response is `201 { data }`, shaped as `GET /api/v1/counterparties` returns it.
  - `POST /api/v1/invoices` takes `{ direction?, counterpartyId, amount, currency?, dueDate, memo?, poReference?,
    goodsReceived?, earlyPayDiscount? }`, validated by the invoice form's schema. `amount` is a decimal string or a number,
    with at most 6 decimal places; `dueDate` is `YYYY-MM-DD`. It is added through the same
    `createInvoice` the form and the Telegram bot use. The response is `201 { data }`, shaped as
    `GET /api/v1/invoices` returns it. A payable starts the agent's cycle within seconds, as one added in the console
    does.
  - There are no update or delete operations in v1.
- **R3. The API never moves money and never approves.**
  - An invoice added through the API is decided by the agent with every guardrail, the workspace's spending limit and
    the contract on Arc, exactly like one typed in.
  - **An address the API sets waits for a person.** A counterparty created with an address is stored as an
    unconfirmed address change, as a payee link's address is. The agent holds payments to it
    (`counterparty.address_unconfirmed`) until an owner, admin or approver confirms it on Counterparties. A leaked key
    can therefore add records, but it cannot point the agent's money at a new address.
- **R4. A key acts for the person who issued it.**
  - The records it adds carry `created_by` = the key's issuer, so maker and checker still apply: the issuer cannot
    approve a held payable their own key added, unless they are the workspace's only approver.
  - The ledger entries are `create_counterparty` and `create_invoice`, actor `human`, `by` the issuer (null when the
    issuer's account is gone), with `via: "api"` and `apiKeyId`.
- **R5. `Idempotency-Key` makes a retry safe.**
  - The header is optional: 1–255 printable ASCII characters.
  - The first request with a given key in a workspace stores its outcome for 24 hours. A repeat with the same body gets
    the same status and body back, with `Idempotent-Replayed: true`. A repeat with a different body gets
    `409 conflict`, and so does a repeat while the first is still being handled.
  - A 5xx outcome is not stored, so retrying it runs the request again.
  - A body that fails validation is answered before the key is claimed, so nothing is kept for it. The client can fix
    the body and send it again with the same key, as with Stripe's keys. What fails once the write has started, such
    as a `counterpartyId` the workspace does not hold, is kept like any other outcome.
  - Outcomes live in `api_idempotency`, which only the service role reads or writes. A row older than 24 hours is
    replaced by the next request with that key.
- **R6. Writes are rate limited per key.** At most 30 writes a minute per key, counted on each instance. Over that, the
  answer is `429 rate_limited` with `Retry-After`.
- **R7. One new error code, `conflict` (409), for R5.**
  - A body that does not validate answers `400 invalid_request`, naming the field.
  - A `counterpartyId` the workspace does not hold also answers `400 invalid_request`.
  - A read-only key on a write operation answers `403 forbidden`.
- **R8. The documented surface follows the operation list.**
  - `DocOperation` gains `method: "post"`, a request body schema and the scope it needs.
  - The OpenAPI document describes the body and the `Idempotency-Key` header.
  - Each reference page shows the body as a schema tree, with cURL, JavaScript and Python samples that send a body and
    an `Idempotency-Key`.
  - A write operation's page has no "Try it" panel, because it would create real records. The page says so.
  - The Authentication page explains the two scopes.
  - A new guide, `guides/api-invoices`, shows a counterparty, its confirmation in the console, and then an invoice.
- **R9. MCP gains the two write operations as tools.**
  - The tools are `create_counterparty` and `create_invoice`, with the annotations `readOnlyHint: false`,
    `destructiveHint: false`, `idempotentHint: false` and `openWorldHint: false`. Each takes an optional
    `idempotencyKey`.
  - A read-only key that calls one gets the API's 403 back as a tool error.
  - The MCP page lists them and says they need a read-and-write key. This replaces MCP spec M5 ("no write tools") for
    these two operations only; approvals stay a person's.
- **R10. Webhooks are unchanged.** The new entries arrive as `ledger.appended`, with `via: "api"` in their detail.

## 4. Data (migration 0066)

- The `api_keys_scopes_check` constraint becomes `scopes <@ array['read','write'] and 'read' = any(scopes)`.
- `api_idempotency`:
  - columns `org_id` (on delete cascade), `idempotency_key`, `request_hash` (SHA-256 of the method, the path and the
    body), `status` (null while in flight), `response` (jsonb), `created_at`, `completed_at`;
  - primary key `(org_id, idempotency_key)`;
  - RLS on, no policy, service role only.

## 5. Testing

- Migration: the scope check accepts `{read}` and `{read, write}` and refuses `{write}` alone; `api_idempotency` is
  closed to `anon`, `authenticated` and the tenant, cascades with the org, and survives a re-run.
- Guard: a write operation refuses a read-only key with 403. The write limit answers 429 after 30 writes a minute from
  one key, and not for another key.
- Routes:
  - 201 with the payload shape;
  - 400 for an invalid body, naming the field;
  - 400 for an unknown counterparty;
  - an address stored as unconfirmed;
  - `created_by` set to the issuer, and `via: "api"` in the ledger;
  - a replay with the same body, a 409 with a different body, a 409 while in flight;
  - a 5xx outcome not stored.
- OpenAPI, docs and MCP: operations and routes match one to one, methods included; samples send the body; tools and
  operations match one to one, with write tools annotated as writes.
- Settings: a key can be created read-only or read-and-write, and the list shows which.

## 6. Rollout

1. The partner applies migration 0066, then we merge.
2. In testnet-2, Settings: create a read-and-write key.
3. `POST /api/v1/counterparties` with an address: the counterparty appears with its address waiting for confirmation.
   Confirm it in the console.
4. `POST /api/v1/invoices` for it, with a PO and goods received, due today: the agent decides within a minute and
   pays, recorded as `via: "api"`. Repeat the same request with its `Idempotency-Key`: no second invoice.
5. Record the entries and the transaction here.
