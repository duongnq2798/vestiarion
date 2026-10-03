# TypeScript SDK: a typed client for `/api/v1` and its webhooks

Date: 2026-10-03. Status: designed on `feat/ts-sdk`. Decided under the standing autonomy grant. This is the second part
of the API work; the first was the write API (`2026-10-03-write-api-design.md`).

## 1. Why

An integrator today reads the reference pages, copies a cURL or `fetch` sample, writes their own types, follows
`page.nextCursor` by hand, invents their own retry rules, and ports the webhook checks from the docs' snippets. Each of
those is a place to get it subtly wrong: a retry that adds a second invoice, a signature compared with `===`, a cursor
loop that drops the last page. The partner asked for an SDK ("cho có SDK luôn nhé"). It should make the right way the
easy way: typed calls, pagination that cannot drop a page, retries that cannot add a record twice, and webhook checks
that match the server's signing code.

## 2. Approaches considered

- **A. A thin, hand-written client over generated types (chosen).** One method per operation, written by hand for a
  good call site (`vestiarion.invoices.list({ status: "held" })`), with every payload type generated from the OpenAPI
  document. Zero runtime dependencies.
- **B. A generic client generated whole from the OpenAPI document** (openapi-fetch, orval). Less code, but the call
  site is the URL (`client.GET("/api/v1/invoices", …)`), and pagination, idempotency and webhooks are still ours to
  write.
- **C. Types only.** A `.d.ts` for people writing their own `fetch`. It leaves out the parts most likely to be wrong.

## 3. Rulings

- **R1. Package.**
  - `sdk/` in this repository, named `@vestiarion/sdk`, version `0.1.0`.
  - ESM only, zero runtime dependencies.
  - It uses `fetch` and Web Crypto alone, so it runs on Node 20 or later, Deno, Bun, Cloudflare Workers and Vercel's
    edge.
  - `sdk/src` is TypeScript, compiled to `dist` (JavaScript and `.d.ts`) with the repository's TypeScript.
  - The repository's own `tsc`, ESLint and Vitest cover `sdk/src` too.
- **R2. Distribution: a versioned tarball the site serves.**
  - `npm run sdk:pack` compiles the package and writes `public/sdk/vestiarion-sdk-<version>.tgz`. It refuses to
    overwrite a version that is already there.
  - The tarball is committed, so the bytes behind a URL never change and a lockfile's integrity hash keeps matching.
  - Install: `npm install https://www.vestiarion.xyz/sdk/vestiarion-sdk-0.1.0.tgz`. The same URL works with pnpm, Yarn
    and Bun.
  - `/sdk/:path*` is served with `X-Content-Type-Options: nosniff` and a year's immutable cache.
  - Publishing to the npm registry needs the partner's npm account. It is not part of this work, and the docs mention
    only the install that works today.
- **R3. Types are generated from the OpenAPI document.**
  - `npm run sdk:types` renders `sdk/src/types.ts` from `buildOpenApiDocument()` with a small generator,
    `scripts/lib/sdk-types.ts`.
  - The types are named by a table in the generator:
    - `Status`, `LedgerEntry`, `LedgerVerification`, `Invoice`, `Counterparty`, `CounterpartyDetail`, `Milestone`,
      `Treasury`, `Insights` and `Page`;
    - the bodies `CreateInvoiceInput` and `CreateCounterpartyInput`;
    - the query parameters `List…Params`;
    - `ApiErrorCode`.
  - Every field keeps its description as a doc comment.
  - A write's answer must have the same schema as its list's item. The generator checks this and throws otherwise:
    `Invoice` is one type.
  - The generator throws on a JSON Schema keyword it does not know, rather than emitting `unknown`.
- **R4. The client.**
  - `new Vestiarion({ apiKey, baseUrl?, fetch?, maxRetries?, timeoutMs? })`.
  - Defaults: base URL `https://www.vestiarion.xyz`, `globalThis.fetch`, 2 retries, 30 s per attempt.
  - One method per operation:
    - `status.get()`
    - `ledger.list(params)`, `ledger.listAll(params)`, `ledger.pages(params)`, `ledger.verify()`
    - `invoices.list/listAll/pages`, and `invoices.create(input, { idempotencyKey })`
    - `counterparties.list/listAll/pages`, `counterparties.get(id)`, and
      `counterparties.create(input, { idempotencyKey })`
    - `milestones.list/listAll/pages`
    - `treasury.get()`
    - `insights.get()`
  - A single resource is returned as the API's `data`. A `list` returns `{ data, page }`.
  - `listAll` yields every item, following `page.nextCursor` until there is none.
  - `pages` yields each page, so a ledger mirror can store the cursor it has processed, as the docs advise.
  - Every request sends `Authorization: Bearer <key>` and `User-Agent: vestiarion-sdk-js/<version>`. The key is
    never logged and never put in a URL.
  - An `apiKey` that is not shaped `vxk_<prefix>_<secret>` is refused when the client is constructed, with a
    `TypeError` that does not repeat the value.
- **R5. Errors.**
  - Every failure is a `VestiarionError` with:
    - `status`: the HTTP status, or 0 when no answer arrived;
    - `code`: one of the API's codes, or `network_error`, `timeout` or `invalid_response`;
    - the API's own `message`;
    - `retryAfter`: seconds, or null.
  - The SDK never throws anything else for a request.
- **R6. Retries, and why a write is never added twice.**
  - A request is retried up to `maxRetries` times after:
    - a network failure, or a timeout;
    - `429`: it waits `Retry-After`. When that is more than 60 seconds, it does not wait: the `429` is thrown, so a
      call never blocks for minutes;
    - `500`, `502`, `503` or `504`.
  - Waits between other retries back off exponentially, from 0.5 s up to 8 s, with jitter.
  - Every write carries an `Idempotency-Key`: the caller's when given (best: the record's id in their own system),
    otherwise a fresh UUID for that call. A retry of that call therefore repeats the same key and body, and can never
    add the record twice.
  - On a retry, a `409 conflict` can only mean the earlier attempt is still running, since the key and body are the
    same. The SDK waits and retries it. A `409` on the first attempt is the caller's own key reuse, and is thrown.
- **R7. Webhooks.**
  - `verifyWebhook({ secret, payload, signature, toleranceSeconds = 300, now? })`, where `now` is a `Date` and defaults
    to the current time. It checks the
    `Vestiarion-Signature` HMAC-SHA256 over `"<t>.<payload>"`, as `src/lib/webhooks/sign.ts` signs it:
    - any of several `v1` values may match, and other schemes are ignored;
    - it compares with Web Crypto's constant-time `verify`;
    - it rejects a timestamp outside the tolerance.
  - It returns the parsed, typed event (`ledger.appended` or `webhook.test`). Otherwise it throws a
    `WebhookVerificationError` whose `reason` is `missing`, `malformed`, `expired` or `mismatch`.
  - `verifyLedgerEntry(entry, keys)` checks an entry exactly as the receipt page's verifier
    (`src/lib/receipts/verify.ts`) does:
    - the body hash over the canonical JSON of `{ actor, domain, action, summary, detail }`;
    - a key filed under its true id, the first 16 hex characters of SHA-256 of its SPKI;
    - the Ed25519 signature over the 32 bytes of `bodyHash`;
    - the chain hash `sha256(prevHash + bodyHash + signature)`.
  - It answers `{ ok: true }`, `{ ok: false, reason }`, or `{ ok: null, reason }` when no known key can check it.
    `keys` is either a map of key id to PEM, or one PEM.
  - Both are exported from the package root and from `@vestiarion/sdk/webhooks`.
- **R8. Docs.**
  - A page, `get-started/sdk` ("TypeScript SDK"), after Quickstart. It covers:
    - the install;
    - reads, pagination and a write with its idempotency key;
    - errors and retries;
    - webhooks;
    - what the SDK sends.
  - A changelog entry, links from Quickstart and the API overview, and the README and ARCHITECTURE.
  - `sdk/README.md` ships in the package.
- **R9. Not in this work:** publishing to the npm registry, a Python SDK, a browser bundle, CommonJS, and any operation
  the API does not have.

## 4. Testing

- **Types:** `sdk/src/types.ts` equals what the generator renders from the current document. The generator throws on
  an unknown keyword and on a write whose answer differs from its list's item.
- **Coverage:** every operation in `OPERATIONS` has its SDK method. A new operation fails the suite until the SDK
  gains it.
- **Contract:** the SDK runs against the real route handlers in-process, through a `fetch` that dispatches to them,
  with the recorded fake database and a mocked key lookup. It proves:
  - query parameters, headers, bodies and the `Idempotency-Key` as the routes read them;
  - envelopes unwrapped;
  - the API's errors as `VestiarionError`;
  - `listAll` reading every page.
- **Retries:** with a fake `fetch` and a fake clock:
  - each retryable status, and `Retry-After`;
  - the cap at `maxRetries`;
  - a timeout;
  - a write retried with the same key and body;
  - a `409` retried only on a retry;
  - no retry for a `400`, `401`, `403` or `404`.
- **Webhooks:**
  - `verifyWebhook` against the repository's own `signWebhook`: genuine, tampered, expired, malformed, missing,
    several `v1`;
  - `verifyLedgerEntry` against entries signed exactly as `src/lib/ledger.ts` signs them, and agreeing with
    `src/lib/receipts/verify.ts` on the same entries.
- **Package:**
  - the committed tarball for the current version holds exactly a fresh build's files, `package.json` and the README;
  - `VERSION` equals `sdk/package.json`'s version;
  - the docs' install URL names the current version;
  - `next.config.ts` serves `/sdk/` as specified.

## 5. Rollout

1. Merge. Nothing in production changes but a new static file and a docs page.
2. In a scratch folder, `npm install https://www.vestiarion.xyz/sdk/vestiarion-sdk-0.1.0.tgz`.
3. With the read-and-write key from the write API rollout:
   - `status.get()`;
   - `invoices.listAll({ direction: "payable" })` reads every page;
   - `ledger.verify()`.
4. `verifyLedgerEntry` passes on an entry from a real `ledger.appended` delivery, with the PEM from the Audit page.
