# Write API part 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `POST /api/v1/milestones` and `POST /api/v1/payee-links` as commands every surface shares, check a write key's issuer at every write, and ship them through the OpenAPI document, MCP, SDK 0.2.0 and the docs.

**Architecture:**
- Each new write is a command in `src/lib/commands`. Its console action and its API route both call it.
- A new `guardApiWrite` builds the API actor from the key's issuer, read now, and refuses an issuer who cannot add records.
- The routes reuse part 1's pipeline: guard, body, shape schema, form schema, idempotency, handler. The payee link skips idempotency, because its answer holds a secret.

**Tech Stack:** Next.js 16 route handlers, zod 4, Supabase via `db()`/`platformDb()`, vitest with `tests/support/fake-supabase`, the SDK in `sdk/` (zero dependencies).

**Spec:** `docs/superpowers/specs/2026-10-03-write-api-part-2-design.md`

## Global Constraints

- No migration. Nothing here moves money or verifies work. The API never approves (part 1 R3; spec W2).
- A payee link's token is never stored, logged or put in a ledger entry. Only its SHA-256 is kept (spec W3).
- An address set through a payee link waits for a member's confirmation. That is unchanged.
- Copy says "Arc testnet" plainly, with no disclaimers. Commit messages stay neutral.
- `npm run verify` must be green. `npx tsc --noEmit` is checked by its exit code, never piped.
- The 0.1.0 tarball stays byte for byte. 0.2.0 is new.

## Review Focus

- **An issuer moved from admin to approver.** Their key's write must answer 403 on every write route, including the existing invoice and counterparty routes. A read must still answer 200. This is pinned in Task 1.
- **A payee link answer replayed from `api_idempotency`.** No row may be written for this route, even when `Idempotency-Key` is sent. This is pinned in Task 4.
- **A client chosen as a milestone's contractor, or as a link's payee.** Both answer 400 naming the field, from the API and from the console alike. This is pinned in Tasks 2 and 3.
- **A milestone whose evidence is a GitHub pull request.** It is stored as the canonical URL, and a cycle starts only when a GitHub token is configured. This is pinned in Task 2.
- **The console's existing behavior.** The Add milestone and Create link messages are unchanged, and the existing action tests pass untouched. This is pinned in Tasks 2 and 3.

---

### Task 1: The write guard reads the issuer (W5)

**Files:**
- Modify: `src/lib/api/guard.ts`. Add `guardApiWrite(request)`, which returns `{ denied } | { key, actor }`.
- Modify: `src/app/api/v1/invoices/route.ts` and `src/app/api/v1/counterparties/route.ts`. Both use `guardApiWrite`. The invoice route uses `actor.mode` and drops its own `orgs` read.
- Test: `tests/api-write-issuer.test.ts` (new). Update the fakes in the existing write tests so they answer the membership read.

**Interfaces:**
- Produces: `guardApiWrite(request: Request): Promise<{ denied: NextResponse } | { key: AuthenticatedKey; actor: Actor }>`. The actor's surface is `{ kind: "api", apiKeyId }`, and its role holds `records.write`.

- [ ] Write the failing tests in `tests/api-write-issuer.test.ts`. They drive `POST /api/v1/invoices` and `POST /api/v1/counterparties` with a write key and a membership role taken from a table:

  | Issuer | Expected |
  |---|---|
  | `admin` | 201 |
  | `owner` | 201 |
  | `approver` | 403 `forbidden`, "This key's issuer can no longer add records in this workspace." No insert, no ledger entry, no `api_idempotency` request. |
  | `viewer` | 403, as for `approver` |
  | no membership row | 403, as for `approver` |
  | membership read errors | 500 `internal`, nothing written |

  `GET /api/v1/invoices` with the approver issuer's key answers 200.
- [ ] Run `npx vitest run tests/api-write-issuer.test.ts`. Expected: FAIL. The approver gets 201.
- [ ] Implement `guardApiWrite`:
  - call `guardApiRequest(request, { scope: "write" })`;
  - then, inside try/catch, call `memberActor(key.orgId, key.createdBy, { kind: "api", apiKeyId: key.keyId })`;
  - a null `createdBy`, a null actor, or `!can(actor.role, "records.write")` answers 403;
  - a throw answers `apiError("internal", INTERNAL_MESSAGE)` and is logged.

  Switch both POST routes to it, and have the invoice route take `actor.mode`.
- [ ] Run the new test and the existing write tests: `npx vitest run tests/api-write-issuer.test.ts tests/api-write-invoices.test.ts tests/api-write-counterparties.test.ts tests/api-key-scope.test.ts tests/sdk-contract.test.ts tests/mcp-call.test.ts`. Add a `memberships` row (`role: "admin"`) to each fake that now needs it. Expected: PASS.
- [ ] Commit: "Check a write key's issuer at every write".

### Task 2: `milestone.add` (W2, W4)

**Files:**
- Modify: `src/lib/intake-validation.ts`. It gains `milestoneInputSchema`, moved from `src/app/actions/milestones.ts`, unchanged.
- Create: `src/lib/milestones/create.ts` with `createMilestone`.
- Modify: `src/lib/commands/policy.ts`, which gains `"milestone.add": "records.write"`, and `SURFACE_COMMANDS.api`, which gains it.
- Modify: `src/lib/commands/milestones.ts` with `addMilestone`, and `src/lib/commands/index.ts` to export it.
- Modify: `src/app/actions/milestones.ts`. `createMilestoneAction` calls `addMilestone(consoleActor(auth), …)`.
- Test: `tests/commands-milestone-add.test.ts` (new). The existing `tests/milestone-intake-action.test.ts` stays as it is.

**Interfaces:**
- `MilestoneInput = z.output<typeof milestoneInputSchema>`, which is `{ contractorId, title, amount: string, evidence: string | null }`.
- `createMilestone(input: { actorId: string; milestone: MilestoneInput; provenance?: Provenance })`. It returns one of:
  - `{ ok: true; id: string; contractorName: string; pullRequest: boolean }`;
  - `{ ok: false; reason: "not_found" | "client" }`.
- `addMilestone(actor: Actor, input: { milestone: MilestoneInput })` returns `CommandOutcome<{ milestoneId: string; contractorName: string }>`. Its refusal codes are `contractor_not_found`, `client` and `failed`.

- [ ] Write the failing tests. Each test names the case and what it expects.
  - **Console actor, admin:** inserts `{ contractor_id, title, amount, verification_source }`, then `create_milestone` with no `via`. A GitHub URL is stored canonical.
  - **API actor:** the entry has `via: "api"` and `apiKeyId`.
  - **Approver:** refused `forbidden`.
  - **Telegram or Slack surface:** refused `surface`.
  - **A client:** refused `client` with "A client is not paid for milestones. Choose a contractor or vendor." No insert.
  - **Unknown contractor:** refused `contractor_not_found` with "Contractor not found."
  - **A pull request link and a GitHub token:** `runCycleSoon` with `milestone_added`, and the console's "checks the pull request" message.
  - **No token:** no cycle, and the "Verify it once the work is delivered" message.
  - **Insert throws:** refused `failed`.
- [ ] Run `npx vitest run tests/commands-milestone-add.test.ts`. Expected: FAIL, because `addMilestone` is not exported.
- [ ] Implement. The command's messages are the console's current ones, word for word. Move the action onto the command, and keep its result type `{ ok, message }` with `revalidateOrgPages()` on success, through `consoleAnswer`.
- [ ] Run `npx vitest run tests/commands-milestone-add.test.ts tests/milestone-intake-action.test.ts tests/commands-milestones.test.ts`. Expected: PASS.
- [ ] Commit: "Add a milestone through one command for every surface".

### Task 3: `payee_link.create` (W3, W4)

**Files:**
- Modify: `src/lib/platform/payee-links.ts`. `createPayeeLink` takes `provenance?: Provenance`, which is spread into the entry's `detail`.
- Create: `src/lib/commands/payee-links.ts` with `issuePayeeLink`. Export it from `index.ts`.
- Modify: `src/lib/commands/policy.ts` with `"payee_link.create": "records.write"`. API surface only, besides the console.
- Modify: `src/app/actions/payee-links.ts`. `createPayeeLinkAction` calls the command.
- Test: `tests/commands-payee-link.test.ts` (new). The existing `tests/payee-links-actions.test.tsx` stays as it is.

**Interfaces:**
- `issuePayeeLink(actor, { counterpartyId })` returns `CommandOutcome<{ linkId; counterpartyId; url; expiresAt }>`.
  - Refused `client`: "A payee link is for a vendor or a contractor the agent pays."
  - Refused `counterparty_not_found`: "Counterparty not found."
  - Refused `failed`: `TRY_AGAIN`.
  - Done: "Link created. Copy it now: it is shown only once."

- [ ] Write the failing tests.
  - **Console actor:** the `create_payee_link` RPC is called with `p_by` = the user. The entry has no `via`. The `url` is `${publicOrigin()}/payee/vxp_…`.
  - **API actor:** the entry has `via: "api"` and `apiKeyId`. The entry never contains the token.
  - **Approver:** refused `forbidden`.
  - **Telegram:** refused `surface`.
  - **A client:** refused `client`, with no RPC call.
  - **Unknown:** refused `counterparty_not_found`.
  - **RPC throws:** refused `failed`.
- [ ] Run it. Expected: FAIL.
- [ ] Implement, and move the action onto the command, keeping its result `{ ok, message, url?, expiresAt? }`.
- [ ] Run `npx vitest run tests/commands-payee-link.test.ts tests/payee-links-actions.test.tsx tests/payee-links.test.ts`. Expected: PASS.
- [ ] Commit: "Issue a payee link through one command for every surface".

### Task 4: The two routes and their operations (W1, W3, W6, W7)

**Files:**
- Modify: `src/lib/api/schemas.ts` with `CreateMilestoneBodySchema`, `PayeeLinkSchema` and `CreatePayeeLinkBodySchema`.
- Modify: `src/lib/api/milestones.ts` with `MILESTONE_SELECT`, used by the GET route too.
- Modify: `src/lib/api/openapi.ts`:
  - operations `create-milestone` (with `idempotencyKey("ci-bounty-pr-1234")`) and `create-payee-link` (no header param);
  - `DocOperation.destructive?: true`, set on `create-payee-link`;
  - the document's description updated.
- Create: `content/docs/examples/create-milestone.json` and `content/docs/examples/create-payee-link.json`.
- Modify: `src/app/api/v1/milestones/route.ts` (POST). Create: `src/app/api/v1/payee-links/route.ts` (POST).
- Test: `tests/api-write-milestones.test.ts` and `tests/api-write-payee-links.test.ts` (new). The existing `tests/openapi.test.ts` and `tests/api-contract.test.ts` must pass, with their route lists updated if they enumerate routes.

**Interfaces:**
- Consumes `guardApiWrite`, `addMilestone`, `issuePayeeLink`, `withIdempotency`, `readJsonBody` and `invalidBody`.
- The milestone body's field `verificationSource` maps to the form's `evidence`: `invalidBody(error, { evidence: "verificationSource" })`.

- [ ] Write the failing route tests.
  - **Milestones:**
    - `201`, parsing against `operationById("create-milestone").response`;
    - `400` for a 2-character title (`title: …`) and for an http link (`verificationSource: The evidence link must start with https://`);
    - `400` for an unknown field, a client contractor or an unknown contractor;
    - a replay with the same key gives `Idempotent-Replayed: true`;
    - a 403 for an approver issuer.
  - **Payee links:**
    - `201` with `{ id, counterpartyId, url, expiresAt }` and `cache-control: no-store`;
    - no request to `api_idempotency` when `Idempotency-Key` is sent;
    - two requests make two RPC calls;
    - `400` for a client, an unknown counterparty, or a missing `counterpartyId`.
- [ ] Run them. Expected: FAIL with 405, because there is no POST export or route yet.
- [ ] Implement the schemas, operations, examples and routes.
- [ ] Run `npx vitest run tests/api-write-milestones.test.ts tests/api-write-payee-links.test.ts tests/openapi.test.ts tests/api-contract.test.ts tests/api-schemas.test.ts`. Expected: PASS.
- [ ] Commit: "Add milestones and payee links through the API".

### Task 5: MCP tools (W7)

**Files:**
- Modify: `src/lib/mcp/tools.ts`. The `idempotencyKey` note goes only on a write that takes the header. A destructive operation gets `destructiveHint: true`.
- Test: extend `tests/mcp-tools.test.ts`.

- [ ] Failing tests:
  - `create_milestone` is annotated as a write, and its description mentions `idempotencyKey`;
  - `create_payee_link` has `destructiveHint: true`, its description does not mention `idempotencyKey`, and its input schema has no `idempotencyKey`.
- [ ] Implement. Run `npx vitest run tests/mcp-tools.test.ts tests/mcp-call.test.ts tests/mcp-route.test.ts`. Expected: PASS.
- [ ] Commit: "Describe the new write tools to MCP clients".

### Task 6: SDK 0.2.0 (W8)

**Files:**
- Modify: `scripts/lib/sdk-types.ts` with the named types `CreateMilestoneInput`, `PayeeLink`, `CreatePayeeLinkInput`, and `Milestone` with `same` `CreateMilestoneResponse.data`.
- Regenerate `sdk/src/types.ts` with `npm run sdk:types`.
- Modify: `sdk/src/client.ts`, which gains `milestones.create` and `payeeLinks.create`. Modify `sdk/src/index.ts` exports.
- Modify: `sdk/package.json` and `sdk/src/version.ts` to 0.2.0, and `sdk/README.md`.
- Create: `public/sdk/vestiarion-sdk-0.2.0.tgz` with `npm run sdk:pack`.
- Test: `tests/sdk-client.test.ts` (calls table), `tests/sdk-contract.test.ts` (both methods in process) and `tests/sdk-package.test.ts`.

- [ ] Add the two operations to the SDK client test's call table and to the contract test. Run them. Expected: FAIL, because there is no method.
- [ ] Implement, regenerate, bump, then pack.
- [ ] Run `npx vitest run tests/sdk-*.test.ts`. Expected: PASS, with the 0.1.0 tarball still present and unchanged.
- [ ] Commit: "SDK 0.2.0: add milestones and payee links".

### Task 7: Docs (W7)

**Files:**
- Create: `content/docs/guides/api-milestones.mdx`. Register it where the guides are registered (`src/lib/docs/nav.ts` and `content.ts`).
- Modify:
  - `content/docs/changelog.mdx` (a new entry on top);
  - `content/docs/get-started/authentication.mdx` (Scopes);
  - `content/docs/api.mdx`;
  - `content/docs/ai-integration/mcp.mdx`;
  - `content/docs/get-started/sdk.mdx` (0.2.0 and the new methods);
  - `content/docs/guides/api-invoices.mdx` (a link to the new guide);
  - `README.md`;
  - `ARCHITECTURE.md`.
- Test: the existing docs tests, such as `tests/docs-guides.test.ts` and `tests/sdk-docs.test.ts`. Add assertions where a test lists the guides or the operations.

- [ ] Write the guide and the edits. Grep for stale text: "two write operations", "counterparties and invoices", "0.1.0" and "create_counterparty and create_invoice".
- [ ] Run `npx vitest run tests/docs-*.test.ts tests/sdk-docs.test.ts`. Expected: PASS.
- [ ] Commit: "Document milestones and payee links in the API".

### Task 8: Whole-branch verification

- [ ] Run `npm run verify > <workspace>/verify.log 2>&1` and read the tail. Expected: every test file passes.
- [ ] Run `npm run build`. Expected: success, with `/api/v1/payee-links` in the route list.
- [ ] Do the final review as the executing-plans skill says.
