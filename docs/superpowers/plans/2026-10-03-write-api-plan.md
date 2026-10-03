# Write API: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task.

**Goal:** a read-and-write API key adds counterparties and invoices through `POST /api/v1/counterparties` and
`POST /api/v1/invoices`, safely retried with `Idempotency-Key`. The agent decides every invoice as if it were typed in,
and an address set through the API waits for a person's confirmation.

**Architecture:**
- Migration 0066 widens the key scopes and adds `api_idempotency`.
- The key library learns `write` and returns the issuer.
- A shared `createCounterparty` (like `createInvoice`) serves the form and the API.
- The two `POST` handlers sit beside their `GET`s, behind the same guard, plus a write rate limit and an idempotency
  wrapper.
- The operation list grows `method`, `requestBody` and `scope`; OpenAPI, the reference pages, the samples and the MCP
  tools follow from it.

**Tech stack:** Next 16 route handlers, zod 4, vitest with `fakeSupabase` and PGlite.

**Spec:** `docs/superpowers/specs/2026-10-03-write-api-design.md`

## Global constraints

- The API never moves money and never approves. No update or delete operations.
- `write` never comes without `read`.
- The success envelope stays `{ data }`; errors stay `{ error: { code, message } }`. The one new code is `conflict`
  (409).
- No new runtime dependency.
- Every changed surface gets its docs and a changelog entry in the same PR.

## Review focus

1. **A leaked write key aims money at a new address.** It must not be able to: an API address is stored as an
   unconfirmed change, and the existing guardrail holds payments to it. Test in Task 7.
2. **The same `Idempotency-Key` sent twice at once.** Exactly one record may be created: the second gets 409 while
   the first is in flight. Test in Task 5.
3. **A write key used for another workspace's counterparty id.** It must get 400, not create an invoice linked
   across workspaces: `createInvoice` looks the counterparty up in the key's scope. Test in Task 8.
4. **A body over 64 KB, or one that is not JSON.** It must get 400 before anything is written. Test in Task 7.
5. **A read-only key through MCP.** It must get the 403 as a tool error, never a crash. Test in Task 10.

---

### Task 1: migration 0066

- Create `supabase/migrations/0066_api_write.sql`:
  - drop and re-add `api_keys_scopes_check` as `scopes <@ array['read','write']::text[] and 'read' = any(scopes)`;
  - create `api_idempotency` as in spec §4, with RLS on and access for `service_role` only;
  - make it re-runnable.
- Tests: `tests/api-write-migration.test.ts`, covering:
  - `{read}` and `{read,write}` accepted, `{write}` and `{read,admin}` refused;
  - `create_api_key` with `{read,write}`;
  - `api_idempotency` closed to `anon`, `authenticated` and the tenant;
  - cascade with the org;
  - a re-run.
- Update `tests/api-keys-migration.test.ts` wherever it pins `write` as refused.

### Task 2: the key library

- `src/lib/platform/api-keys.ts`:
  - `API_KEY_SCOPES = ["read", "write"]`;
  - `createApiKey({ orgId, actorId, name, write? })` issues `["read"]` or `["read", "write"]`;
  - `authenticateApiKey` also returns `createdBy: string | null` (`created_by`).
- Tests (extend `tests/api-keys.test.ts`):
  - write issued only when asked;
  - `api_key_created` records the scopes;
  - `createdBy` returned.

### Task 3: Settings

- `createApiKeyAction` reads `access` = `read` | `write` (anything else: read).
- `ApiKeysPanel` gets an "Access" choice, **Read only** (default) or **Read and write**, with a line saying a
  read-and-write key can add counterparties and invoices, never pay or approve. Each key's row shows its access.
- Tests: extend `tests/api-keys-actions.test.ts` and `tests/api-keys-panel.test.tsx`.

### Task 4: contract and guard

- `ApiErrorCode` gains `conflict` → 409.
- `rate-limit.ts` gains `takeApiWriteToken(keyId)`: 30 a minute per key (a capacity of 30, refilled one every 2 s).
- `guardApiRequest(request, { scope: "write" })` applies it after the scope check: `429` with `Retry-After: 60`.
- Tests: extend `tests/api-key-scope.test.ts`:
  - a read key on write gets 403;
  - the 31st write in a minute gets 429, while another key passes.

### Task 5: idempotency

- `src/lib/api/idempotency.ts`:
  - `withIdempotency(request, key: AuthenticatedKey, rawBody: string, run: () => Promise<NextResponse>): Promise<NextResponse>`;
  - no header: `run()`;
  - a malformed header (not 1–255 printable ASCII): 400.
- Flow on the platform client, `api_idempotency`:
  1. Claim with `insert … on conflict do nothing` (`upsert` with `ignoreDuplicates`), then read the row.
  2. Our claim: `run()`. Store `status` and `response` when the status is below 500; on a 5xx, delete the claim.
  3. A row with the same `request_hash` and a stored status: replay it, with `Idempotent-Replayed: true`.
  4. Same hash, still in flight: 409. A different hash: 409.
  5. A row older than 24 h is deleted and the claim tried once more.
- Add `api_idempotency` to `PLATFORM_TABLES`.
- Tests (`tests/api-idempotency.test.ts`, `fakeSupabase`):
  - replay;
  - conflict on a different body;
  - conflict in flight (Review focus 2);
  - 5xx releases the claim;
  - stale row replaced;
  - bad header 400.

### Task 6: shared counterparty creation

- `src/lib/counterparties/create.ts`:
  - `createCounterparty({ actorId, input, via?, apiKeyId? }): Promise<{ id, name, screening: { riskLevel } | { error } }>`;
  - `input` is `z.output<typeof counterpartyInputSchema>`;
  - it inserts, appends `create_counterparty` (with `via`, `apiKeyId` when given) and screens;
  - with `via: "api"` and an address, it sets `address_changed_at = now()` and leaves `address_confirmed_at` null.
- `createCounterpartyAction` uses it, and its existing tests pass unchanged.
- Tests: `tests/counterparty-create.test.ts`.

### Task 7: `POST /api/v1/counterparties`

- The JSON body schema maps to `counterpartyInputSchema` (with `paymentLimit` as a string or number). An address must
  be `0x` and 40 hex characters.
- Order of checks:
  1. the body is read once, with at most 64 KB, and invalid JSON or too large gets 400;
  2. the guard (`write`);
  3. idempotency;
  4. validation, giving 400 with "<field>: <message>";
  5. `createCounterparty({ via: "api" })`;
  6. 201 `{ data: mapCounterparty(row) }`.
- Tests (`tests/api-write-counterparties.test.ts`):
  - 201 shape;
  - address stored unconfirmed (Review focus 1);
  - `via: "api"` in the ledger;
  - 400 for invalid fields;
  - 400 for a non-JSON body and for one over 64 KB (Review focus 4);
  - 403 for a read key.

### Task 8: `POST /api/v1/invoices`

- The body is `{ direction = "payable", counterpartyId, amount, currency = "USDC", dueDate, memo?, poReference?,
  goodsReceived = false, earlyPayDiscount?: { percent, deadline } }`, mapped to `invoiceInputSchema`.
- `createInvoice({ actorId: key.createdBy, invoice, document: null, via: "api", apiKeyId })`:
  - `createInvoice` takes `via: "telegram" | "api"` and an optional `apiKeyId`;
  - `actorId` may be null (an issuer whose account is gone), and `created_by` is then null.
- A payable raises `runCycleSoon({ kind: "invoice_added", userId: createdBy })`.
- 201 `{ data }` in the `GET` shape: read the row back by id with the same select and mapping. The mapping is moved
  into `src/lib/api/invoices.ts` as `mapInvoice`.
- Tests (`tests/api-write-invoices.test.ts`):
  - 201 shape;
  - `created_by` is the issuer;
  - `via: "api"`;
  - the cycle is raised for a payable but not for a receivable;
  - 400 for an unknown counterparty or one from another workspace (Review focus 3);
  - the discount pair is validated.

### Task 9: operations, OpenAPI, samples, reference pages

- `DocOperation`:
  - `method: "get" | "post"`;
  - `scope: "read" | "write"`;
  - `requestBody?: z.ZodType`;
  - `status` (200 or 201).
- Two operations: `create-counterparty` and `create-invoice`, with examples. The `Idempotency-Key` header is
  documented as a parameter, `in: "header"`.
- The OpenAPI builder emits `requestBody`, the header and `201`.
- `sampleRequest`, for a `post`, sends the method, a JSON body (the example's) and an `Idempotency-Key`.
- The reference page:
  - shows the body schema tree;
  - shows no Try it for a `post`, with the sentence "Try it is off for operations that add records: run the sample
    with your own key.";
  - shows the scope.
- Tests:
  - `tests/openapi.test.ts`: operations and routes match one to one, by method;
  - samples include the body and the header;
  - the reference page shows no Try it for a write.

### Task 10: MCP

- Write tools are generated from operations with `scope: "write"`:
  - the input schema is the request body schema, plus an optional `idempotencyKey`;
  - the annotations are `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`,
    `openWorldHint: false`.
- `callOperation` posts JSON, with `Idempotency-Key` when given, to the `POST` handlers.
- Tests:
  - tools and operations match one to one, with the annotations by scope;
  - a write tool posts the body;
  - a read key gets `isError` with the 403 body (Review focus 5).

### Task 11: docs

- Authentication page: the scopes.
- New guide `guides/api-invoices`, plus its nav entry and loader.
- MCP page: write tools.
- API overview: the methods.
- Changelog, README, ARCHITECTURE.
- The quotes the guides test pins.

### Task 12: verify and ship

- `npm run verify`, `next build`, and a whole-branch self-review.
- Open the PR, and state the migration step for the partner.
